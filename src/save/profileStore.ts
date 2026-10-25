import { createAllocation } from '../core/passives/allocation';
import { createProfile, type Profile } from '../core/progression/profile';
import type { KeyValueStorage } from '../platform/platform';
import { readSigned, writeSigned, type SignedRead } from './integrity';
import { defaultValidation, validateProfile, type SaveValidation } from './validate';

export type { MapValidation, SaveValidation } from './validate';

// Versioned profile persistence. Bump SAVE_VERSION and add a migration whenever the Profile shape changes.
//
// Every save is signed ({data, sig}, see integrity.ts) and written twice: the save and its backup (the last honest
// save). Loading: signature check → migrations → validation (validate.ts); signing happens on every write.

export const SAVE_KEY = 'arpg.profile';
export const SAVE_VERSION = 8;

interface SaveFile {
  version: number;
  profile: unknown;
}

/** migrations[n] upgrades a version-n profile to version n+1. */
const migrations: Record<number, (profile: unknown) => unknown> = {
  // v2: items. Characters get equipment, profile gets an item id counter; old stash had no real items.
  1: (data) => {
    const p = data as { characters?: Array<Record<string, unknown>>; stash?: unknown };
    return {
      ...p,
      characters: (p.characters ?? []).map((c) => ({ equipment: {}, ...c })),
      stash: { items: [] },
      nextItemId: 1,
    };
  },
  // v3: passive tree. Characters get an empty allocation (all points unspent).
  2: (data) => {
    const p = data as { characters?: Array<Record<string, unknown>> };
    return { ...p, characters: (p.characters ?? []).map((c) => ({ passives: createAllocation(), ...c })) };
  },
  // v4: class resource. Mana affixes became resource affixes (mana_flat → resource_flat, mana_regen → resource_regen)
  // in the stash and in every character's equipment; resource_regen values are rescaled ×0.6 (see v4Affix).
  3: (data) => {
    const p = data as { characters?: Array<Record<string, unknown>>; stash?: { items?: unknown[] } };
    const equipment = (eq: unknown): unknown =>
      typeof eq === 'object' && eq !== null ? Object.fromEntries(Object.entries(eq).map(([slot, item]) => [slot, v4Item(item)])) : eq;
    return {
      ...p,
      characters: (p.characters ?? []).map((c) => ({ ...c, equipment: equipment(c.equipment) })),
      ...(p.stash ? { stash: { ...p.stash, items: (p.stash.items ?? []).map((item) => v4Item(item)) } } : {}),
    };
  },
  // v5: skill levels. Characters get an empty skill record: every skill starts at level 1 with 0 XP.
  4: (data) => {
    const p = data as { characters?: Array<Record<string, unknown>> };
    return { ...p, characters: (p.characters ?? []).map((c) => ({ skills: {}, ...c })) };
  },
  // v6: skill modifiers (supports). Characters get an empty supports tab (no starter supports, designer decision 2026-10-23).
  5: (data) => {
    const p = data as { characters?: Array<Record<string, unknown>> };
    return { ...p, characters: (p.characters ?? []).map((c) => ({ supports: [], ...c })) };
  },
  // v7: map runs. Every hero gets a map ladder. New heroes start at map 1 (designer decision 2026-10-23); heroes from
  // before maps get every map up to their level (capped), so a level-20 hero is not sent back through 19 maps at the
  // low-map XP penalty. Cap frozen here (not read from data) so the migration never changes.
  6: (data) => {
    const p = data as { characters?: Array<Record<string, unknown>> };
    return {
      ...p,
      characters: (p.characters ?? []).map((c) => {
        const level = typeof c.level === 'number' && Number.isFinite(c.level) ? Math.floor(c.level) : 1;
        return { maps: { unlocked: Math.max(1, Math.min(level, V7_MAX_MAP)) }, ...c };
      }),
    };
  },
  // v8: stash overflow ("пошта", designer decision 2026-10-26). The stash gets an empty overflow list.
  7: (data) => {
    const p = data as { stash?: Record<string, unknown> };
    return typeof p.stash === 'object' && p.stash !== null ? { ...p, stash: { overflow: [], ...p.stash } } : p;
  },
};

const V7_MAX_MAP = 40;

const V4_AFFIX_RENAMES: Readonly<Record<string, string>> = { mana_flat: 'resource_flat', mana_regen: 'resource_regen' };
/**
 * v4 cut the resource regen tiers ×0.6 (balance pass). Stored values are rescaled and snapped to the roll step
 * (0.1) like generation does (rollValue), so e.g. 1.1 → 0.66 → 0.7; every old tier value lands inside its new tier.
 * Frozen here, not read from data, so the migration stays the same when data changes later.
 */
const V4_REGEN_SCALE = 0.6;
const V4_REGEN_STEP = 0.1;

/** One stored affix upgraded to v4: renamed, and the (renamed) resource regen value rescaled. */
function v4Affix(affix: unknown): unknown {
  if (typeof affix !== 'object' || affix === null) return affix;
  const a = affix as { affixId?: unknown; value?: unknown };
  const id = typeof a.affixId === 'string' ? (V4_AFFIX_RENAMES[a.affixId] ?? a.affixId) : a.affixId;
  let value = a.value;
  if (id === 'resource_regen' && typeof value === 'number') {
    value = Math.round((Math.round((value * V4_REGEN_SCALE) / V4_REGEN_STEP) * V4_REGEN_STEP) * 10000) / 10000;
  }
  return { ...affix, affixId: id, value };
}

/** A stored item with its affixes upgraded; anything that is not an item with an affix array is returned as is. */
function v4Item(item: unknown): unknown {
  if (typeof item !== 'object' || item === null) return item;
  const affixes = (item as { affixes?: unknown }).affixes;
  if (!Array.isArray(affixes)) return item;
  return { ...item, affixes: affixes.map(v4Affix) };
}

/** The backup slot: a signed copy of the last save the game wrote. */
export const BACKUP_KEY = `${SAVE_KEY}.backup`;
/** Unreadable or rejected stored data is kept here (for support), never loaded. */
export const BROKEN_KEY = `${SAVE_KEY}.broken`;

/**
 * How the stored save was accepted:
 * - `new`: nothing stored; `ok`: signature matches;
 * - `unsigned`: a save from before signatures, accepted once and signed at once (designer decision 2026-10-22);
 * - `restored`: the save was edited, broken or missing, the backup was loaded instead;
 * - `unverified`: the save was edited and no valid backup exists: its validated data was loaded and re-signed;
 * - `broken`: nothing loadable: a fresh profile (the stored data is kept under BROKEN_KEY; see LoadResult.readOnly).
 */
export type SaveIntegrity = 'new' | 'ok' | 'unsigned' | 'restored' | 'unverified' | 'broken';

export interface LoadResult {
  profile: Profile;
  integrity: SaveIntegrity;
  /** Set when stored data was rejected (unreadable, edited); the rejected copy is kept under this key. */
  backupKey?: string;
  /**
   * The storage holds a real save this build cannot load (a newer save version, or a save that fails to decode): the
   * profile is a fresh stand-in and must NOT be saved (the caller skips saveProfile), so the stored save and its
   * backup stay intact for the build that can read them. A copy is also kept under preservedKey (never overwritten).
   */
  readOnly?: boolean;
  preservedKey?: string;
}

/**
 * Loads the profile. Signature check first: a save whose signature does not match (hand-edited) rolls back to the
 * backup; an unsigned save from before signatures is accepted once, unless a signed backup exists (then the backup
 * wins: unsigned data next to a signed history means the signature was stripped). Then migrations, then validation
 * against the current data (`check` overrides parts of it, for tests). Any outcome other than `ok` / `new` / `broken`
 * writes the loaded profile back signed, so the save and the backup agree again.
 */
export function loadProfile(storage: KeyValueStorage, check: Partial<SaveValidation> = {}): LoadResult {
  const rules: SaveValidation = { ...defaultValidation, ...check };
  const main = readSigned(storage, SAVE_KEY);
  if (main.kind === 'signed') {
    const profile = decode(main.data, rules);
    if (profile) return { profile, integrity: 'ok' };
  }
  const backup = readSigned(storage, BACKUP_KEY);
  const restored = backup.kind === 'signed' ? decode(backup.data, rules) : undefined;
  if (main.kind === 'missing') {
    if (restored) return accept(storage, restored, 'restored');
    if (backup.kind !== 'signed') return { profile: createProfile(), integrity: 'new' };
    // Only a backup this build cannot read (a newer version): keep it untouched.
    return { profile: createProfile(), integrity: 'broken', readOnly: true, preservedKey: preserve(storage, backup) };
  }
  // Edited, unsigned, unreadable, or signed but not decodable (e.g. a newer game version): the backup comes first,
  // except for an unsigned save with no signed backup (accepted once).
  if (main.kind === 'unsigned' && !restored) {
    const profile = decode(main.data, rules);
    if (profile) return accept(storage, profile, 'unsigned');
  }
  const rejected = keepRejected(storage, main);
  if (restored) return accept(storage, restored, 'restored', rejected);
  if (main.kind === 'tampered') {
    const profile = decode(main.data, rules);
    if (profile) {
      console.warn('[save] signature mismatch and no valid backup: loading the validated save and re-signing it');
      return accept(storage, profile, 'unverified', rejected);
    }
  }
  const result: LoadResult = { profile: createProfile(), integrity: 'broken', backupKey: rejected };
  // A real save that cannot be loaded (rather than garbage) must survive: no saving over it.
  const real = looksLikeSave(main) ? main : backup.kind === 'signed' ? backup : undefined;
  if (real) {
    console.warn('[save] stored save cannot be loaded by this build (newer version?): progress will not be saved');
    return { ...result, readOnly: true, preservedKey: preserve(storage, real) };
  }
  return result;
}

export function saveProfile(storage: KeyValueStorage, profile: Profile): void {
  const file: SaveFile = { version: SAVE_VERSION, profile };
  writeSigned(storage, [SAVE_KEY, BACKUP_KEY], file);
}

function accept(storage: KeyValueStorage, profile: Profile, integrity: SaveIntegrity, backupKey?: string): LoadResult {
  saveProfile(storage, profile);
  return { profile, integrity, ...(backupKey ? { backupKey } : {}) };
}

/** Copies stored data that is not loaded as is to BROKEN_KEY (latest rejection); returns that key. */
function keepRejected(storage: KeyValueStorage, read: Exclude<SignedRead, { kind: 'missing' }>): string {
  storage.setItem(BROKEN_KEY, read.raw);
  return BROKEN_KEY;
}

/** Signed by the game, or an unsigned / edited payload with a save version: a real save, not garbage. */
function looksLikeSave(read: SignedRead): read is Exclude<SignedRead, { kind: 'missing' | 'corrupt' }> {
  if (read.kind === 'signed') return true;
  if (read.kind !== 'unsigned' && read.kind !== 'tampered') return false;
  const data = read.data as { version?: unknown } | null;
  return typeof data === 'object' && data !== null && typeof data.version === 'number';
}

/**
 * Keeps an unloadable save under `<BROKEN_KEY>.v<version>`, written only once per version (never overwritten), so a
 * later rejection cannot replace it. Returns the key.
 */
function preserve(storage: KeyValueStorage, read: Exclude<SignedRead, { kind: 'missing' | 'corrupt' }>): string {
  const version = (read.data as { version?: unknown } | null)?.version;
  const key = `${BROKEN_KEY}.v${typeof version === 'number' ? version : 'unknown'}`;
  if (storage.getItem(key) === null) storage.setItem(key, read.raw);
  return key;
}

/** A stored save file → a migrated, validated profile; undefined if it is not a readable save. */
function decode(data: unknown, rules: SaveValidation): Profile | undefined {
  try {
    const file = data as Partial<SaveFile> | null;
    if (typeof file !== 'object' || file === null) return undefined;
    if (typeof file.version !== 'number' || file.version > SAVE_VERSION) return undefined;
    let profile = file.profile;
    for (let v = file.version; v < SAVE_VERSION; v++) {
      const migrate = migrations[v];
      if (!migrate) return undefined;
      profile = migrate(profile);
    }
    return validateProfile(profile, rules);
  } catch {
    return undefined;
  }
}

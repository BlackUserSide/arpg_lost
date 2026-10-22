import { createAllocation, validateAllocation } from '../core/passives/allocation';
import type { PassiveAllocation, PassiveTreeData } from '../core/passives/types';
import { createProfile, type Profile } from '../core/progression/profile';
import { passiveTree } from '../data/passives';
import type { KeyValueStorage } from '../platform/platform';

// Versioned profile persistence. Bump SAVE_VERSION and add a migration whenever the Profile shape changes.

export const SAVE_KEY = 'arpg.profile';
export const SAVE_VERSION = 4;

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
};

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

export interface LoadResult {
  profile: Profile;
  /** Set when stored data could not be read; the broken copy is kept under this key. */
  backupKey?: string;
}

/** `tree` is used to validate passive allocations; a character with an invalid one gets a free full reset. */
export function loadProfile(storage: KeyValueStorage, tree: PassiveTreeData = passiveTree): LoadResult {
  const raw = storage.getItem(SAVE_KEY);
  if (!raw) return { profile: createProfile() };
  try {
    const file = JSON.parse(raw) as SaveFile;
    if (typeof file.version !== 'number' || file.version > SAVE_VERSION) throw new Error(`Unsupported save version: ${String(file.version)}`);
    let data = file.profile;
    for (let v = file.version; v < SAVE_VERSION; v++) {
      const migrate = migrations[v];
      if (!migrate) throw new Error(`No migration from version ${v}`);
      data = migrate(data);
    }
    const profile = normalize(data);
    resetInvalidPassives(profile, tree);
    return { profile };
  } catch {
    const backupKey = `${SAVE_KEY}.broken`;
    storage.setItem(backupKey, raw);
    return { profile: createProfile(), backupKey };
  }
}

export function saveProfile(storage: KeyValueStorage, profile: Profile): void {
  const file: SaveFile = { version: SAVE_VERSION, profile };
  storage.setItem(SAVE_KEY, JSON.stringify(file));
}

/** Fills fields missing from older or partial saves with defaults. */
function normalize(data: unknown): Profile {
  if (typeof data !== 'object' || data === null) throw new Error('Profile is not an object');
  const base = createProfile();
  const p = data as Partial<Profile>;
  if (!Array.isArray(p.characters)) throw new Error('Profile has no characters array');
  return {
    characters: p.characters.map((c) => ({ ...c, equipment: c.equipment ?? {}, passives: normalizePassives(c.passives) })),
    stash: p.stash ?? base.stash,
    currency: p.currency ?? base.currency,
    records: { ...base.records, ...p.records },
    nextCharacterId: p.nextCharacterId ?? p.characters.length + 1,
    nextItemId: p.nextItemId ?? 1,
  };
}

/** Fills a partial or malformed allocation with defaults (missing / non-array fields become empty). */
function normalizePassives(raw: unknown): PassiveAllocation {
  const p = { ...createAllocation(), ...(typeof raw === 'object' && raw !== null ? (raw as Partial<PassiveAllocation>) : {}) };
  return {
    nodes: Array.isArray(p.nodes) ? p.nodes.filter((id) => typeof id === 'string') : [],
    spec: typeof p.spec === 'string' ? p.spec : null,
    specNodes: Array.isArray(p.specNodes) ? p.specNodes.filter((id) => typeof id === 'string') : [],
  };
}

/** Allocations that no longer fit the tree (data change, tampering) are reset for free: wheel and spec. */
function resetInvalidPassives(profile: Profile, tree: PassiveTreeData): void {
  for (const character of profile.characters) {
    if (validateAllocation(tree, character) !== null) character.passives = createAllocation();
  }
}

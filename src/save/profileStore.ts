import { craftCount } from '../core/items/craft';
import type { Equipment } from '../core/items/equipment';
import type { Item, UniqueRoll, UniqueStatRoll } from '../core/items/types';
import { createAllocation, validateAllocation } from '../core/passives/allocation';
import type { PassiveAllocation, PassiveTreeData } from '../core/passives/types';
import { createProfile, type MapProgress, type Profile } from '../core/progression/profile';
import { passiveTree } from '../data/passives';
import { skillLevels } from '../data/skillLevels';
import { readSkillProgress, type SkillLevelRules, type SkillProgress } from '../core/skills/levels';
import { validateSockets } from '../core/supports/tab';
import type { SupportData, SupportItem } from '../core/supports/types';
import type { ClassDef } from '../core/world/content';
import { classes } from '../data/classes';
import { mapsData } from '../data/maps';
import { supportsData } from '../data/supports';
import type { KeyValueStorage } from '../platform/platform';

// Versioned profile persistence. Bump SAVE_VERSION and add a migration whenever the Profile shape changes.

export const SAVE_KEY = 'arpg.profile';
export const SAVE_VERSION = 7;

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

export interface LoadResult {
  profile: Profile;
  /** Set when stored data could not be read; the broken copy is kept under this key. */
  backupKey?: string;
}

/** Highest map a stored ladder may hold (RunRules.maxLinearMap); see normalizeMaps. */
export interface MapValidation {
  readonly maxLinearMap: number;
}

/** Data the supports tab is validated against on load (see normalizeSupports). */
export interface SupportValidation {
  readonly classes: Readonly<Record<string, ClassDef>>;
  readonly supports: SupportData;
}

/**
 * `tree` is used to validate passive allocations; a character with an invalid one gets a free full reset.
 * `supportCheck`: supports of unknown defs are dropped, tiers clamped, and socketed supports that are no longer valid
 * (unknown skill, bad slot, duplicate, lost compatibility) return to the tab.
 */
export function loadProfile(
  storage: KeyValueStorage,
  tree: PassiveTreeData = passiveTree,
  skillRules: SkillLevelRules = skillLevels.rules,
  supportCheck: SupportValidation = { classes, supports: supportsData },
  mapCheck: MapValidation = mapsData.rules,
): LoadResult {
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
    const profile = normalize(data, skillRules, supportCheck, mapCheck);
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
function normalize(data: unknown, skillRules: SkillLevelRules, supportCheck: SupportValidation, mapCheck: MapValidation): Profile {
  if (typeof data !== 'object' || data === null) throw new Error('Profile is not an object');
  const base = createProfile();
  const p = data as Partial<Profile>;
  if (!Array.isArray(p.characters)) throw new Error('Profile has no characters array');
  return {
    characters: p.characters.map((c) => ({
      ...c,
      equipment: normalizeEquipment(c.equipment),
      passives: normalizePassives(c.passives),
      skills: normalizeSkills(c.skills, skillRules),
      supports: normalizeSupports(c.supports, supportCheck.classes[c.classId], supportCheck.supports),
      maps: normalizeMaps(c.maps, mapCheck),
    })),
    // A stash without an item array (malformed / tampered) falls back to an empty one.
    stash: p.stash && Array.isArray(p.stash.items) ? { ...p.stash, items: p.stash.items.map(normalizeItem) } : base.stash,
    currency: p.currency ?? base.currency,
    records: { ...base.records, ...p.records },
    nextCharacterId: p.nextCharacterId ?? p.characters.length + 1,
    nextItemId: p.nextItemId ?? 1,
  };
}

/**
 * Optional item fields added without a version bump (older items need no migration):
 * - the crafting counter (Item.crafts, 0.3): a missing counter reads as 0; a present one is sanitized to a
 *   non-negative integer;
 * - the unique roll (Item.unique, 0.4): kept only on unique / legendary items and only with a string id
 *   (otherwise removed: the item stays, with no unique stats); malformed rolls (not an array, an entry without a
 *   whole tier ≥ 1 or a finite value) are all dropped, since rolls pair with stat lines by position. A unique id the
 *   data does not know is kept as is (no stats until it exists again; salvage works either way).
 */
// Clamping rolled values to their tier range belongs to the save-validation backlog item (roadmap 0.4).
function normalizeItem(item: Item): Item {
  if (typeof item !== 'object' || item === null) return item;
  let out = item;
  if (item.crafts !== undefined) out = { ...out, crafts: craftCount(item) };
  if ('unique' in item) {
    const { unique: raw, ...rest } = out;
    const unique = item.rarity === 'unique' || item.rarity === 'legendary' ? normalizeUniqueRoll(raw) : undefined;
    out = unique ? { ...rest, unique } : rest;
  }
  return out;
}

function normalizeUniqueRoll(raw: unknown): UniqueRoll | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { id, rolls } = raw as { id?: unknown; rolls?: unknown };
  if (typeof id !== 'string') return undefined;
  const valid = Array.isArray(rolls) && rolls.every(isStatRoll);
  return { id, rolls: valid ? (rolls as UniqueStatRoll[]).map((r) => ({ tier: r.tier, value: r.value })) : [] };
}

function isStatRoll(raw: unknown): raw is UniqueStatRoll {
  if (typeof raw !== 'object' || raw === null) return false;
  const { tier, value } = raw as { tier?: unknown; value?: unknown };
  return typeof tier === 'number' && Number.isInteger(tier) && tier >= 1 && typeof value === 'number' && Number.isFinite(value);
}

function normalizeEquipment(raw: Equipment | undefined): Equipment {
  if (typeof raw !== 'object' || raw === null) return {};
  return Object.fromEntries(Object.entries(raw).map(([slot, item]) => [slot, item ? normalizeItem(item) : item])) as Equipment;
}

/**
 * Skill records with level / xp sanitized (readSkillProgress: level clamped to 1..max, XP ≥ 0); malformed entries
 * are dropped (the skill reads as level 1). Other per-skill fields are kept for later additions (support slots).
 */
function normalizeSkills(raw: unknown, rules: SkillLevelRules): Record<string, SkillProgress> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, SkillProgress> = {};
  for (const [id, record] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
    out[id] = { ...(record as object), ...readSkillProgress(record, rules) };
  }
  return out;
}

/**
 * The supports tab, sanitized: entries without a string id, with an unknown def or duplicated ids are dropped; tiers
 * are clamped to the def's tiers (whole); malformed sockets are removed, then validateSockets returns every socketed
 * support that is no longer valid to the tab (designer decision 2026-10-23). Without class data nothing stays socketed.
 */
// Over-cap tabs (tampering) are kept as is; trimming them is part of the save-validation backlog item (roadmap 0.4).
function normalizeSupports(raw: unknown, classDef: ClassDef | undefined, data: SupportData): SupportItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SupportItem[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Partial<Record<keyof SupportItem, unknown>>;
    if (typeof e.id !== 'string' || ids.has(e.id) || typeof e.defId !== 'string') continue;
    const def = data.supports[e.defId];
    if (!def || def.tiers.length === 0) continue;
    const rawTier = typeof e.tier === 'number' && Number.isFinite(e.tier) ? Math.floor(e.tier) : 1;
    const item: SupportItem = { id: e.id, defId: e.defId, tier: Math.min(def.tiers.length, Math.max(1, rawTier)) };
    const socket = e.socket as { skillId?: unknown; slot?: unknown } | undefined;
    if (classDef && typeof socket === 'object' && socket !== null && typeof socket.skillId === 'string' && typeof socket.slot === 'number') {
      item.socket = { skillId: socket.skillId, slot: socket.slot };
    }
    ids.add(e.id);
    out.push(item);
  }
  if (classDef) validateSockets({ supports: out }, classDef, data);
  return out;
}

/**
 * The map ladder, sanitized: `unlocked` is a whole number in 1..maxLinearMap (missing / malformed → 1). Other fields
 * are kept for later additions (keys).
 */
function normalizeMaps(raw: unknown, check: MapValidation): MapProgress {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const value = typeof record.unlocked === 'number' && Number.isFinite(record.unlocked) ? Math.floor(record.unlocked) : 1;
  return { ...record, unlocked: Math.min(Math.max(1, check.maxLinearMap), Math.max(1, value)) };
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

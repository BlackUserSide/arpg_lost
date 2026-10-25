import { craftCount } from '../core/items/craft';
import { canEquip, type Equipment } from '../core/items/equipment';
import { hasAffixRules, salvageValue, tierOf, uniqueTierAt } from '../core/items/generate';
import { SALVAGE_CURRENCY, storeLoot } from '../core/items/inventory';
import { EQUIP_SLOTS, type AffixKind, type AffixTier, type EquipSlot, type Item, type ItemsData, type Rarity, type RolledAffix, type UniqueRoll, type UniqueStatRoll } from '../core/items/types';
import { createAllocation, validateAllocation } from '../core/passives/allocation';
import type { PassiveAllocation, PassiveTreeData } from '../core/passives/types';
import { grantXp, type ProgressionRules } from '../core/progression/levels';
import {
  addCurrency,
  CURRENCY_DECIMALS,
  createProfile,
  type CharacterRecord,
  type CharacterStats,
  type MapProgress,
  type Profile,
  type ProfileRecords,
  type ProfileRules,
} from '../core/progression/profile';
import { grantSkillXp, readSkillProgress, type SkillLevelRules, type SkillProgress } from '../core/skills/levels';
import { supportSalvageValue, validateSockets } from '../core/supports/tab';
import type { SupportData, SupportItem } from '../core/supports/types';
import type { ClassDef } from '../core/world/content';
import { classes } from '../data/classes';
import { itemsData } from '../data/items';
import { mapsData } from '../data/maps';
import { passiveTree } from '../data/passives';
import { profileRules } from '../data/profile';
import { progression } from '../data/progression';
import { skillLevels } from '../data/skillLevels';
import { supportsData } from '../data/supports';

// Save validation on load (roadmap 0.4 «Перевірка сейву при завантаженні», designer decision 2026-10-22): a migrated
// profile is checked against the current data and impossible values are reset or clamped, so a hand-edited or
// stale save cannot carry stats the game could never produce. Runs after migrations (the rules describe the current
// shape). Unknown extra fields are kept wherever they are harmless (forward compatibility).

/** Highest map a stored ladder may hold (RunRules.maxLinearMap); see normalizeMaps. */
export interface MapValidation {
  readonly maxLinearMap: number;
}

/** All data a save is validated against. */
export interface SaveValidation {
  readonly tree: PassiveTreeData;
  readonly progression: ProgressionRules;
  readonly skillRules: SkillLevelRules;
  readonly classes: Readonly<Record<string, ClassDef>>;
  readonly supports: SupportData;
  readonly maps: MapValidation;
  readonly items: ItemsData;
  readonly profileRules: ProfileRules;
}

export const defaultValidation: SaveValidation = {
  tree: passiveTree,
  progression,
  skillRules: skillLevels.rules,
  classes,
  supports: supportsData,
  maps: mapsData.rules,
  items: itemsData,
  profileRules,
};

const RARITIES: readonly Rarity[] = ['normal', 'magic', 'rare', 'unique', 'legendary'];
/** Same rounding as addCurrency (core/progression/profile). */
const CURRENCY_SCALE = 10 ** CURRENCY_DECIMALS;
/** Fallback name for a stored hero whose name is not a string (tampering only). */
const FALLBACK_NAME = 'Hero';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
/** A whole number ≥ `min`; anything else → `fallback`. */
const wholeAtLeast = (v: unknown, min: number, fallback: number): number => (isFiniteNumber(v) ? Math.max(min, Math.floor(v)) : fallback);

/**
 * A migrated profile, validated (see the rules on each helper). Throws only when the data has no profile shape at
 * all (not an object, no characters array); the caller treats that as a broken save.
 */
export function validateProfile(data: unknown, check: SaveValidation): Profile {
  if (!isRecord(data)) throw new Error('Profile is not an object');
  if (!Array.isArray(data.characters)) throw new Error('Profile has no characters array');
  const base = createProfile();
  const items = check.items;
  const rawStash = data.stash;
  // A stash without an item array (malformed / tampered) falls back to an empty one; so does a missing or malformed
  // overflow (its items are not kept: there is no array to read them from).
  const stash =
    isRecord(rawStash) && Array.isArray(rawStash.items)
      ? { ...rawStash, items: normalizeItems(rawStash.items, items), overflow: normalizeOverflow(rawStash.overflow, items) }
      : base.stash;

  const profile: Profile = {
    ...data,
    characters: [],
    stash,
    currency: normalizeCurrency(data.currency),
    records: normalizeRecords(data.records),
    nextCharacterId: 1,
    nextItemId: 1,
  };
  let shards = 0;
  const displaced: Item[] = [];
  for (const raw of data.characters) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.classId !== 'string') continue;
    const classDef = check.classes[raw.classId];
    const { level, xp } = normalizeHeroProgress(raw.level, raw.xp, check.progression);
    const supports = normalizeSupports(raw.supports, classDef, check.supports);
    shards += supports.shards;
    const equipment = normalizeEquipment(raw.equipment, { level, weaponType: classDef?.weaponType }, items, displaced);
    const character: CharacterRecord = {
      ...(raw as unknown as CharacterRecord),
      name: normalizeName(raw.name, check.profileRules),
      level,
      xp,
      stats: normalizeStats(raw.stats),
      equipment,
      passives: normalizePassives(raw.passives),
      skills: normalizeSkills(raw.skills, check.skillRules),
      supports: supports.items,
      maps: normalizeMaps(raw.maps, check.maps),
    };
    profile.characters.push(character);
  }
  // Items that cannot stay where they were worn go where new loot would (stash, else overflow), else to shards.
  for (const item of displaced) {
    if (storeLoot(profile, item, items) === null) shards += salvageValue(item, items);
  }
  if (shards > 0) addCurrency(profile, SALVAGE_CURRENCY, shards);
  profile.nextCharacterId = nextId(data.nextCharacterId, profile.characters.length + 1, profile.characters.map((c) => c.id));
  profile.nextItemId = nextId(data.nextItemId, 1, allItemIds(profile));
  resetInvalidPassives(profile, check.tree);
  return profile;
}

// ── Heroes ──

/**
 * Hero level: a whole number in 1..maxLevel (malformed → 1). XP: finite, ≥ 0 (else 0), 0 at max level. XP at or past
 * the next level (which grantXp never stores) goes through the level-up path (grantXp with nothing added), so a
 * cheaper curve after a rebalance turns the stored XP into levels instead of losing it.
 */
export function normalizeHeroProgress(rawLevel: unknown, rawXp: unknown, rules: ProgressionRules): { level: number; xp: number } {
  const progress = { level: clamp(wholeAtLeast(rawLevel, 1, 1), 1, rules.maxLevel), xp: isFiniteNumber(rawXp) ? Math.max(0, rawXp) : 0 };
  grantXp(progress, 0, rules);
  if (progress.level >= rules.maxLevel) progress.xp = 0;
  return progress;
}

/** A string, trimmed and cut to the name length rule; non-strings / empty → a fallback (tampering only). */
function normalizeName(raw: unknown, rules: ProfileRules): string {
  const name = typeof raw === 'string' ? raw.trim().slice(0, rules.nameMaxLength) : '';
  return name.length > 0 ? name : FALLBACK_NAME;
}

/** Counters are whole and ≥ 0, the longest run finite and ≥ 0; extra fields kept. */
function normalizeStats(raw: unknown): CharacterStats {
  const s = isRecord(raw) ? raw : {};
  return {
    ...s,
    runs: wholeAtLeast(s.runs, 0, 0),
    deaths: wholeAtLeast(s.deaths, 0, 0),
    kills: wholeAtLeast(s.kills, 0, 0),
    longestRun: isFiniteNumber(s.longestRun) ? Math.max(0, s.longestRun) : 0,
  };
}

/**
 * Skill records: level / XP sanitized like the hero's (readSkillProgress: level 1..max, XP ≥ 0, 0 at max; XP past
 * the next level levels up); malformed entries are dropped (the skill reads as level 1). Other per-skill fields are kept.
 */
function normalizeSkills(raw: unknown, rules: SkillLevelRules): Record<string, SkillProgress> {
  if (!isRecord(raw)) return {};
  const out: Record<string, SkillProgress> = {};
  for (const [id, record] of Object.entries(raw)) {
    if (!isRecord(record)) continue;
    const progress = readSkillProgress(record, rules);
    // XP past the next level goes through the level-up path (see normalizeHeroProgress).
    const xp = progress.xp;
    progress.xp = 0;
    grantSkillXp(progress, xp, rules);
    out[id] = { ...record, level: progress.level, xp: progress.xp };
  }
  return out;
}

/**
 * The map ladder: `unlocked` is a whole number in 1..maxLinearMap (missing / malformed → 1). Other fields are kept
 * for later additions (keys).
 */
function normalizeMaps(raw: unknown, check: MapValidation): MapProgress {
  const record = isRecord(raw) ? raw : {};
  return { ...record, unlocked: clamp(wholeAtLeast(record.unlocked, 1, 1), 1, Math.max(1, check.maxLinearMap)) };
}

/** Fills a partial or malformed allocation with defaults (missing / non-array fields become empty). */
function normalizePassives(raw: unknown): PassiveAllocation {
  const p = { ...createAllocation(), ...(isRecord(raw) ? (raw as Partial<PassiveAllocation>) : {}) };
  return {
    nodes: Array.isArray(p.nodes) ? p.nodes.filter((id) => typeof id === 'string') : [],
    spec: typeof p.spec === 'string' ? p.spec : null,
    specNodes: Array.isArray(p.specNodes) ? p.specNodes.filter((id) => typeof id === 'string') : [],
  };
}

/** Allocations that no longer fit the tree (data change, tampering, a level clamped down) are reset for free. */
function resetInvalidPassives(profile: Profile, tree: PassiveTreeData): void {
  for (const character of profile.characters) {
    if (validateAllocation(tree, character) !== null) character.passives = createAllocation();
  }
}

/**
 * The supports tab. Entries without a string id / defId and duplicated ids are dropped (a copy, not a support). A
 * support whose def is no longer in the data is salvaged into shards at its tier's value (roadmap 0.4: "розбирати
 * на осколки"). Tiers are clamped to the def's tiers (whole); malformed sockets are removed, then validateSockets
 * returns every socketed support that is no longer valid to the tab (designer decision 2026-10-23). A tab over
 * SupportRules.tabSize salvages its newest unsocketed supports (as a drop into a full tab would). Without class data
 * nothing stays socketed.
 */
export function normalizeSupports(raw: unknown, classDef: ClassDef | undefined, data: SupportData): { items: SupportItem[]; shards: number } {
  if (!Array.isArray(raw)) return { items: [], shards: 0 };
  const out: SupportItem[] = [];
  const ids = new Set<string>();
  let shards = 0;
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.defId !== 'string') continue;
    ids.add(entry.id);
    const rawTier = wholeAtLeast(entry.tier, 1, 1);
    const def = data.supports[entry.defId];
    if (!def || def.tiers.length === 0) {
      shards += supportSalvageValue({ defId: entry.defId, tier: clamp(rawTier, 1, Math.max(1, data.rules.salvage.length)) }, data);
      continue;
    }
    const item: SupportItem = { id: entry.id, defId: entry.defId, tier: clamp(rawTier, 1, def.tiers.length) };
    const socket = entry.socket;
    if (classDef && isRecord(socket) && typeof socket.skillId === 'string' && typeof socket.slot === 'number') {
      item.socket = { skillId: socket.skillId, slot: socket.slot };
    }
    out.push(item);
  }
  if (classDef) validateSockets({ supports: out }, classDef, data);
  const cap = Math.max(0, data.rules.tabSize);
  for (let i = out.length - 1; i >= 0 && out.length > cap; i--) {
    if (out[i]!.socket) continue;
    shards += supportSalvageValue(out.splice(i, 1)[0]!, data);
  }
  // Only reachable with a tab smaller than the socket count: salvage from the end regardless.
  while (out.length > cap) shards += supportSalvageValue(out.pop()!, data);
  return { items: out, shards };
}

// ── Items ──

/** Stash items: non-objects and entries without a string id / base id are dropped, the rest validated. */
function normalizeItems(raw: readonly unknown[], data: ItemsData): Item[] {
  return raw.filter(isItemShape).map((item) => normalizeItem(item, data));
}

function isItemShape(raw: unknown): raw is Item {
  return isRecord(raw) && typeof raw.id === 'string' && typeof raw.baseId === 'string';
}

/**
 * The stash overflow: not an array → empty; items of a rarity the overflow does not keep (LootRules.overflow.rarities)
 * are dropped; at most LootRules.overflow.size items, the oldest kept.
 */
function normalizeOverflow(raw: unknown, data: ItemsData): Item[] {
  if (!Array.isArray(raw)) return [];
  const check = data.rules.overflow;
  return normalizeItems(raw, data)
    .filter((item) => check.rarities.includes(item.rarity))
    .slice(0, Math.max(0, check.size));
}

/**
 * Equipped items, validated like stash items. An item that cannot be worn where it is (unknown slot key, wrong slot,
 * another class's weapon type, a second copy of the same unique) is pushed to `displaced` (the caller stores it as
 * loot). Items of a base the data no longer has stay where they are (they give nothing; salvage still works).
 */
function normalizeEquipment(
  raw: unknown,
  hero: { level: number; weaponType: ClassDef['weaponType'] | undefined },
  data: ItemsData,
  displaced: Item[],
): Equipment {
  if (!isRecord(raw)) return {};
  const out: Equipment = {};
  for (const [slot, rawItem] of Object.entries(raw)) {
    if (!isItemShape(rawItem)) continue;
    const item = normalizeItem(rawItem, data);
    if (!(EQUIP_SLOTS as readonly string[]).includes(slot)) {
      displaced.push(item);
      continue;
    }
    const target = slot as EquipSlot;
    if (data.bases[item.baseId] && hero.weaponType !== undefined) {
      // The level requirement is not checked on load (a soft rule that may change with balance): level Infinity.
      const error = canEquip(item, target, { level: Infinity, weaponType: hero.weaponType, equipment: out }, data);
      if (error !== null) {
        displaced.push(item);
        continue;
      }
    }
    out[target] = item;
  }
  return out;
}

/**
 * One stored item, validated against the item data:
 * - rarity: unknown → inferred (unique roll → unique, else by affix count); level: whole, ≥ 1; name: a string;
 * - the crafting counter (Item.crafts, 0.3): a present one is sanitized to a whole number ≥ 0 (missing reads as 0);
 * - affixes (known base only): unknown ids, malformed tiers, affixes that do not
 *   fit the base slot (not the defence requirement: see normalizeAffixes), a second affix of one group and affixes over the rarity's prefix /
 *   suffix / count caps are removed (normal, unique and legendary items carry none); a tier the item level cannot
 *   have is downgraded (fitTier); values are clamped to the tier;
 * - implicit, armour, energy shield: clamped to the base's ranges; non-finite ones removed;
 * - the unique roll (Item.unique, 0.4): kept only on unique / legendary items and only with a string id (otherwise
 *   removed); malformed rolls (not an array, an entry without a whole tier ≥ 1 or a finite value) are all dropped,
 *   since rolls pair with stat lines by position. For a known unique, extra rolls are dropped, a tier that does not
 *   fit the item level is downgraded (fitTier, else uniqueTierAt), values are clamped to the
 *   tier. A unique id the data does not know is kept as is (no stats until it exists again; salvage works).
 * Other fields are kept.
 */
export function normalizeItem(item: Item, data: ItemsData): Item {
  const raw = item as unknown as Record<string, unknown>;
  const rawUnique = raw.unique;
  const rest: Record<string, unknown> = { ...raw };
  delete rest.unique;
  delete rest.crafts;
  const base = data.bases[item.baseId];
  const level = wholeAtLeast(raw.level, 1, 1);
  const rawAffixes = Array.isArray(raw.affixes) ? (raw.affixes as unknown[]) : [];
  const unique =
    'unique' in item && (raw.rarity === 'unique' || raw.rarity === 'legendary' || !RARITIES.includes(raw.rarity as Rarity))
      ? normalizeUniqueRoll(rawUnique, level, data)
      : undefined;
  const rarity = RARITIES.includes(raw.rarity as Rarity) ? (raw.rarity as Rarity) : inferRarity(unique, rawAffixes.length, data);
  const out: Record<string, unknown> = {
    ...rest,
    level,
    rarity,
    name: typeof raw.name === 'string' ? raw.name : '',
    affixes: base ? normalizeAffixes(rawAffixes, rarity, level, base, data) : rawAffixes.filter(isAffixShape),
  };
  if (item.crafts !== undefined) out.crafts = craftCount(item);
  if (unique && (rarity === 'unique' || rarity === 'legendary')) out.unique = unique;
  if (base) {
    clampField(out, 'implicit', base.implicit?.range);
    clampField(out, 'armour', base.armour);
    clampField(out, 'energyShield', base.energyShield);
  }
  return out as unknown as Item;
}

function inferRarity(unique: UniqueRoll | undefined, affixCount: number, data: ItemsData): Rarity {
  if (unique) return 'unique';
  if (affixCount === 0) return 'normal';
  return affixCount <= data.rules.affixCount.magic.max ? 'magic' : 'rare';
}

/** A present numeric field: non-finite → removed; with a range, clamped to it. Missing fields stay missing. */
function clampField(out: Record<string, unknown>, key: string, range: { readonly min: number; readonly max: number } | undefined): void {
  if (!(key in out)) return;
  const value = out[key];
  if (!isFiniteNumber(value)) delete out[key];
  else if (range) out[key] = clamp(value, range.min, range.max);
}

function isAffixShape(raw: unknown): raw is RolledAffix {
  return isRecord(raw) && typeof raw.affixId === 'string' && isFiniteNumber(raw.tier) && isFiniteNumber(raw.value);
}

function normalizeAffixes(raw: readonly unknown[], rarity: Rarity, level: number, base: NonNullable<ItemsData['bases'][string]>, data: ItemsData): RolledAffix[] {
  if (!hasAffixRules(rarity)) return [];
  const caps: Record<AffixKind, number> = { prefix: data.rules.maxPrefixes[rarity], suffix: data.rules.maxSuffixes[rarity] };
  const used: Record<AffixKind, number> = { prefix: 0, suffix: 0 };
  const groups = new Set<string>();
  const out: RolledAffix[] = [];
  for (const entry of raw) {
    if (!isAffixShape(entry)) continue;
    const def = data.affixes[entry.affixId];
    // Slot only: the defence requirement (AffixDef.requires) is a drop rule added later; older items legitimately break it.
    if (!def || !def.slots.includes(base.slot) || groups.has(def.group) || used[def.kind] >= caps[def.kind]) continue;
    if (out.length >= data.rules.affixCount[rarity].max) break;
    const fit = fitTier(def, entry.tier, level);
    if (!fit) continue;
    groups.add(def.group);
    used[def.kind]++;
    out.push({ ...entry, tier: fit.number, value: clamp(entry.value, fit.tier.min, fit.tier.max) });
  }
  return out;
}

/**
 * The tier a stored tier number stands for at `level`: not a whole number ≥ 1 → none (garbage); past the worst tier
 * (the data lost a tier) → the worst; above what the item level unlocks → the best tier it unlocks (none unlocked →
 * none). Downgrading instead of removing keeps an honest item through a data change; the value is then clamped.
 */
function fitTier(def: { readonly tiers: readonly AffixTier[] }, stored: number, level: number): { tier: AffixTier; number: number } | undefined {
  if (!Number.isInteger(stored) || stored < 1 || def.tiers.length === 0) return undefined;
  const number = Math.min(stored, def.tiers.length);
  const tier = tierOf(def, number)!;
  if (tier.minLevel <= level) return { tier, number };
  for (let i = def.tiers.length - 1; i >= 0; i--) {
    const t = def.tiers[i]!;
    if (t.minLevel <= level) return { tier: t, number: def.tiers.length - i };
  }
  return undefined;
}

function normalizeUniqueRoll(raw: unknown, level: number, data: ItemsData): UniqueRoll | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const rolls = raw.rolls;
  if (!Array.isArray(rolls) || !rolls.every(isStatRoll)) return { id: raw.id, rolls: [] };
  const def = data.uniques[raw.id];
  if (!def) return { id: raw.id, rolls: rolls.map((r) => ({ tier: r.tier, value: r.value })) };
  const out: UniqueStatRoll[] = [];
  def.stats.forEach((line, i) => {
    const roll = rolls[i];
    if (!roll) return;
    // Below every tier a unique still rolls its worst one (uniqueTierAt), so that is the fallback here too.
    const fit = fitTier(line, roll.tier, level) ?? uniqueTierAt(line, level);
    // No tier at all in the data: keep the roll as stored, so later rolls stay paired with their lines.
    if (!fit) {
      out.push({ tier: roll.tier, value: roll.value });
      return;
    }
    out.push({ tier: fit.number, value: clamp(roll.value, fit.tier.min, fit.tier.max) });
  });
  return { id: raw.id, rolls: out };
}

function isStatRoll(raw: unknown): raw is UniqueStatRoll {
  if (!isRecord(raw)) return false;
  return isFiniteNumber(raw.tier) && Number.isInteger(raw.tier) && raw.tier >= 1 && isFiniteNumber(raw.value);
}

// ── Account ──

/** Every amount finite and ≥ 0 (rounded like addCurrency); entries that are not numbers are removed. */
function normalizeCurrency(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [id, amount] of Object.entries(raw)) {
    if (isFiniteNumber(amount)) out[id] = Math.round(Math.max(0, amount) * CURRENCY_SCALE) / CURRENCY_SCALE;
  }
  return out;
}

/** Counters whole and ≥ 0; the best clear time null or > 0; extra fields kept. */
function normalizeRecords(raw: unknown): ProfileRecords {
  const r = isRecord(raw) ? raw : {};
  return {
    ...r,
    bestMapLevel: wholeAtLeast(r.bestMapLevel, 0, 0),
    bossKills: wholeAtLeast(r.bossKills, 0, 0),
    bestClearTime: isFiniteNumber(r.bestClearTime) && r.bestClearTime > 0 ? r.bestClearTime : null,
    mostKillsInRun: wholeAtLeast(r.mostKillsInRun, 0, 0),
  };
}

/** Ids of every item and support in the profile. */
function allItemIds(profile: Profile): string[] {
  const ids = [...profile.stash.items, ...profile.stash.overflow].map((i) => i.id);
  for (const c of profile.characters) {
    for (const item of Object.values(c.equipment)) if (item) ids.push(item.id);
    for (const s of c.supports) ids.push(s.id);
  }
  return ids;
}

/**
 * The next id counter: whole and ≥ 1 (missing → `fallback`), and past every id already used ('c3', 'i12', 's7'), so a
 * stale or edited counter can never hand out an id twice.
 */
function nextId(raw: unknown, fallback: number, used: readonly string[]): number {
  let next = wholeAtLeast(raw, 1, Math.max(1, fallback));
  for (const id of used) {
    const match = /^[a-z](\d+)$/.exec(id);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

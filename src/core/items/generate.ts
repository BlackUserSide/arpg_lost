import type { Rng } from '../rng';
import type { PassiveMechanic } from '../passives/types';
import type { Modifier } from '../stats/types';
import type {
  AffixDef,
  AffixKind,
  AffixTier,
  BaseDef,
  Item,
  ItemsData,
  Rarity,
  RolledAffix,
  Slot,
  StatLine,
  UniqueDef,
  UniqueRarity,
  UniqueStatRoll,
  ValueRange,
  WeaponType,
} from './types';

/** Weighted pick; returns undefined for an empty or zero-weight list. Always consumes one draw. */
export function weightedPick<T>(rng: Rng, items: readonly T[], weight: (item: T) => number): T | undefined {
  const total = items.reduce((sum, item) => sum + Math.max(0, weight(item)), 0);
  let roll = rng.next() * total;
  if (total <= 0) return undefined;
  for (const item of items) {
    roll -= Math.max(0, weight(item));
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}

export function rollValue(rng: Rng, range: ValueRange): number {
  const steps = Math.round((range.max - range.min) / range.step);
  const value = range.min + rng.int(0, steps) * range.step;
  // Avoid float noise like 0.30000000000000004 in saves and tooltips.
  return Math.round(value * 10000) / 10000;
}

export type DropRarity = 'normal' | 'magic' | 'rare' | 'unique';

/**
 * Rolls normal / magic / rare / unique (one draw). `luck` > 0 shifts weight from normal towards magic and rare; the
 * unique weight is untouched by luck (designer decision 2026-10-25: the speed bonus does not raise the unique chance)
 * and multiplied by `uniqueWeightMultiplier` (boss loot).
 */
export function rollRarity(rng: Rng, data: ItemsData, luck = 0, uniqueWeightMultiplier = 1): DropRarity {
  const w = data.rules.rarityWeights;
  const shift = Math.min(w.normal, w.normal * luck);
  const options: Array<[DropRarity, number]> = [
    ['normal', w.normal - shift],
    ['magic', w.magic + shift * 0.7],
    ['rare', w.rare + shift * 0.3],
    ['unique', w.unique * Math.max(0, uniqueWeightMultiplier)],
  ];
  return weightedPick(rng, options, ([, weight]) => weight)?.[0] ?? 'normal';
}

export function availableBases(data: ItemsData, itemLevel: number, slot?: Slot): BaseDef[] {
  return Object.values(data.bases).filter((b) => b.level <= itemLevel && (!slot || b.slot === slot));
}

export interface GenerateOptions {
  readonly itemLevel: number;
  readonly rarity?: 'normal' | 'magic' | 'rare';
  readonly slot?: Slot;
  /** Rarity luck, see rollRarity. */
  readonly luck?: number;
  /** Multiplier on the unique rarity weight (boss loot), see rollRarity. Ignored when `rarity` is given. */
  readonly uniqueWeightMultiplier?: number;
  /**
   * The weapon type of the hero the loot is for (designer decision 2026-10-26: a unique weapon drops only for the
   * class that can wield it). A unique on a weapon base of another type is left out of the unique pick (uniquePool);
   * normal / magic / rare bases and non-weapon uniques are unaffected. Absent: no filter.
   */
  readonly uniqueWeaponType?: WeaponType;
}

/**
 * Generates a random item entirely from data. The caller supplies a unique id. Draw order: base, rarity; a unique
 * rarity then picks a unique by weight among those that can drop at the item level (and slot) and rolls it
 * (generateUnique; the base drawn first is then unused); with none available the item becomes rare.
 */
export function generateItem(rng: Rng, id: string, options: GenerateOptions, data: ItemsData): Item {
  const bases = availableBases(data, options.itemLevel, options.slot);
  const base = weightedPick(rng, bases, () => 1);
  if (!base) throw new Error(`No base for level ${options.itemLevel} ${options.slot ?? ''}`);
  const rolledRarity = options.rarity ?? rollRarity(rng, data, options.luck ?? 0, options.uniqueWeightMultiplier ?? 1);
  if (rolledRarity === 'unique') {
    const def = weightedPick(rng, uniquePool(data, 'unique', options.itemLevel, options.slot, options.uniqueWeaponType),(u) => u.weight);
    if (def) return generateUnique(rng, id, def, options.itemLevel, data);
  }
  const rarity = rolledRarity === 'unique' ? 'rare' : rolledRarity;

  const affixes: RolledAffix[] = [];
  if (rarity !== 'normal') {
    const count = data.rules.affixCount[rarity];
    fillAffixes(rng, affixes, rng.int(count.min, count.max), base, rarity, options.itemLevel, data);
  }

  const item: Item = {
    id,
    baseId: base.id,
    level: options.itemLevel,
    rarity,
    name: rarity === 'rare' ? rareName(rng, data) : '',
    affixes: sortAffixes(affixes, data),
    ...(base.implicit ? { implicit: rollValue(rng, base.implicit.range) } : {}),
    ...(base.armour ? { armour: rollValue(rng, base.armour) } : {}),
    ...(base.energyShield ? { energyShield: rollValue(rng, base.energyShield) } : {}),
  };
  return item;
}

/** Rarities that carry affixes, i.e. have affix counts and prefix / suffix caps in LootRules. */
export type AffixRarity = 'magic' | 'rare';

export function hasAffixRules(rarity: Rarity): rarity is AffixRarity {
  return rarity === 'magic' || rarity === 'rare';
}

/** Kinds that still have room on an item of `rarity` with these affixes (LootRules prefix / suffix caps). */
export function openAffixKinds(affixes: readonly RolledAffix[], rarity: AffixRarity, data: ItemsData): AffixKind[] {
  const used: Record<AffixKind, number> = { prefix: 0, suffix: 0 };
  for (const a of affixes) {
    const kind = data.affixes[a.affixId]?.kind;
    if (kind) used[kind]++;
  }
  const caps: Record<AffixKind, number> = { prefix: data.rules.maxPrefixes[rarity], suffix: data.rules.maxSuffixes[rarity] };
  return (['prefix', 'suffix'] as const).filter((k) => used[k] < caps[k]);
}

/**
 * Affixes that can roll on `base` at `itemLevel`: positive weight (zero-weight affixes never roll, so crafting must
 * not count them as available), allowed slot, defence requirement met, at least one tier unlocked,
 * kind in `kinds`, group not in `excludeGroups`. The same table and order serve drops and crafting.
 */
export function affixPool(
  data: ItemsData,
  base: BaseDef,
  itemLevel: number,
  kinds: readonly AffixKind[],
  excludeGroups: ReadonlySet<string>,
): AffixDef[] {
  return Object.values(data.affixes).filter(
    (a) =>
      a.weight > 0 &&
      a.slots.includes(base.slot) &&
      fitsDefence(a, base) &&
      !excludeGroups.has(a.group) &&
      kinds.includes(a.kind) &&
      a.tiers.some((t) => t.minLevel <= itemLevel),
  );
}

/** Groups already taken by these affixes (unknown affix ids are ignored). */
export function affixGroups(affixes: readonly RolledAffix[], data: ItemsData): Set<string> {
  const groups = new Set<string>();
  for (const a of affixes) {
    const def = data.affixes[a.affixId];
    if (def) groups.add(def.group);
  }
  return groups;
}

/**
 * Adds up to `count` random affixes to `affixes` (in place, unsorted) by drop weights, respecting prefix / suffix
 * caps of `rarity` and unique groups; stops early when nothing fits. Returns how many were added.
 */
export function fillAffixes(
  rng: Rng,
  affixes: RolledAffix[],
  count: number,
  base: BaseDef,
  rarity: AffixRarity,
  itemLevel: number,
  data: ItemsData,
): number {
  const groups = affixGroups(affixes, data);
  let added = 0;
  for (let i = 0; i < count; i++) {
    const pool = affixPool(data, base, itemLevel, openAffixKinds(affixes, rarity, data), groups);
    const affix = weightedPick(rng, pool, (a) => a.weight);
    if (!affix) break;
    groups.add(affix.group);
    affixes.push(rollAffix(rng, affix, itemLevel, data));
    added++;
  }
  return added;
}

function fitsDefence(affix: AffixDef, base: BaseDef): boolean {
  if (!affix.requires || (!base.armour && !base.energyShield)) return true;
  return Boolean(base[affix.requires]);
}

/** Rolls a tier (LootRules.tierWeights, among tiers unlocked at `itemLevel`) and a value inside it. */
export function rollAffix(rng: Rng, affix: AffixDef, itemLevel: number, data: ItemsData): RolledAffix {
  // Tiers available at this level, best first; better tiers get lower weights.
  const available = affix.tiers
    .map((tier, index) => ({ tier, number: affix.tiers.length - index }))
    .filter(({ tier }) => tier.minLevel <= itemLevel)
    .sort((a, b) => a.number - b.number);
  const weights = data.rules.tierWeights;
  const picked = weightedPick(rng, available, ({ number }) => weights[number - 1] ?? 1) ?? available[available.length - 1]!;
  return { affixId: affix.id, tier: picked.number, value: rollValue(rng, picked.tier) };
}

/** The tier definition of a rolled tier number (1 = best = last entry of AffixDef.tiers / UniqueStatLine.tiers). */
export function tierOf(affix: { readonly tiers: readonly AffixTier[] }, tier: number): AffixTier | undefined {
  return Number.isInteger(tier) && tier >= 1 ? affix.tiers[affix.tiers.length - tier] : undefined;
}

/** Prefixes first, otherwise in order. */
export function sortAffixes(affixes: readonly RolledAffix[], data: ItemsData): RolledAffix[] {
  const order = (r: RolledAffix): number => (data.affixes[r.affixId]?.kind === 'prefix' ? 0 : 1);
  return [...affixes].sort((a, b) => order(a) - order(b));
}

export function rareName(rng: Rng, data: ItemsData): string {
  const { first, second } = data.rules.rareNameWords;
  return `${first[rng.int(0, first.length - 1)] ?? 'Grim'} ${second[rng.int(0, second.length - 1)] ?? 'Relic'}`;
}

// ── Uniques and legendaries (docs/design/items.md, decisions 2026-10-25) ──

/** Minimum item level a unique drops at: its own level, else its base's (unknown base: never). */
export function uniqueLevel(def: UniqueDef, data: ItemsData): number {
  return def.level ?? data.bases[def.baseId]?.level ?? Infinity;
}

/**
 * Uniques of `rarity` that can drop at `itemLevel` (optionally only for `slot`): positive weight, known base, level
 * reached. With `weaponType`, uniques on a weapon base of another weapon type are left out (designer decision
 * 2026-10-26: unique weapons drop only for their class); non-weapon uniques stay. In data order (the order
 * weightedPick walks).
 */
export function uniquePool(data: ItemsData, rarity: UniqueRarity, itemLevel: number, slot?: Slot, weaponType?: WeaponType): UniqueDef[] {
  return Object.values(data.uniques).filter((u) => {
    const base = data.bases[u.baseId];
    return (
      u.rarity === rarity &&
      u.weight > 0 &&
      base !== undefined &&
      (!slot || base.slot === slot) &&
      (weaponType === undefined || !base.weapon || base.weapon.type === weaponType) &&
      uniqueLevel(u, data) <= itemLevel
    );
  });
}

/**
 * The tier a unique stat line rolls at `itemLevel`: the best one unlocked (deterministic, no draw; designer decision
 * 2026-10-25: the numbers grow with the item level). Below every tier: the worst. `number` 1 = best.
 */
export function uniqueTierAt(line: { readonly tiers: readonly AffixTier[] }, itemLevel: number): { readonly tier: AffixTier; readonly number: number } | undefined {
  let index = 0;
  for (let i = 0; i < line.tiers.length; i++) if (line.tiers[i]!.minLevel <= itemLevel) index = i;
  const tier = line.tiers[index];
  return tier ? { tier, number: line.tiers.length - index } : undefined;
}

/**
 * Rolls a unique / legendary item: one value per UniqueDef stat line inside its tier at `itemLevel` (uniqueTierAt),
 * then the base's implicit and defences as usual. No affixes, no rolled name. Draw order: stat lines, implicit,
 * armour, energy shield.
 */
export function generateUnique(rng: Rng, id: string, def: UniqueDef, itemLevel: number, data: ItemsData): Item {
  const base = data.bases[def.baseId];
  if (!base) throw new Error(`Unknown base ${def.baseId} of unique ${def.id}`);
  const rolls: UniqueStatRoll[] = [];
  for (const line of def.stats) {
    const at = uniqueTierAt(line, itemLevel);
    rolls.push(at ? { tier: at.number, value: rollValue(rng, at.tier) } : { tier: 1, value: 0 });
  }
  return {
    id,
    baseId: base.id,
    level: itemLevel,
    rarity: def.rarity,
    name: '',
    affixes: [],
    ...(base.implicit ? { implicit: rollValue(rng, base.implicit.range) } : {}),
    ...(base.armour ? { armour: rollValue(rng, base.armour) } : {}),
    ...(base.energyShield ? { energyShield: rollValue(rng, base.energyShield) } : {}),
    unique: { id: def.id, rolls },
  };
}

/** The UniqueDef of a unique / legendary item, or undefined (other rarities, unknown id). */
export function uniqueDefOf(item: Pick<Item, 'unique'>, data: ItemsData): UniqueDef | undefined {
  return item.unique ? data.uniques[item.unique.id] : undefined;
}

/** Mechanics an item brings while equipped: a known unique's UniqueDef.mechanics; none for other items. */
export function itemMechanics(item: Item, data: ItemsData): readonly PassiveMechanic[] {
  return uniqueDefOf(item, data)?.mechanics ?? [];
}

/**
 * Stat modifiers granted by an item: base defences, implicit, affixes; for a known unique also its rolled stat lines
 * (a line without a roll gives nothing), its effect modifiers and its costs.
 */
export function itemModifiers(item: Item, data: ItemsData): Modifier[] {
  const base = data.bases[item.baseId];
  if (!base) return [];
  const mods: Modifier[] = [];
  if (item.armour) mods.push({ stat: 'armour', kind: 'flat', value: item.armour });
  if (item.energyShield) mods.push({ stat: 'energyShield', kind: 'flat', value: item.energyShield });
  if (base.implicit && item.implicit !== undefined) mods.push(toModifier(base.implicit, item.implicit));
  for (const rolled of item.affixes) {
    const affix = data.affixes[rolled.affixId];
    if (affix) mods.push(toModifier(affix.line, rolled.value));
  }
  const unique = uniqueDefOf(item, data);
  if (unique) {
    unique.stats.forEach((line, i) => {
      const roll = item.unique?.rolls[i];
      if (roll) mods.push(toModifier(line, roll.value));
    });
    mods.push(...(unique.effectModifiers ?? []), ...(unique.costs ?? []));
  }
  return mods;
}

function toModifier(line: StatLine, value: number): Modifier {
  return {
    stat: line.stat,
    kind: line.kind,
    value,
    ...(line.tags ? { tags: line.tags } : {}),
    ...(line.damageType ? { damageType: line.damageType } : {}),
  };
}

export function salvageValue(item: Item, data: ItemsData): number {
  return data.rules.salvage[item.rarity as Rarity] ?? 0;
}

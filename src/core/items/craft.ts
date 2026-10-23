import type { Profile } from '../progression/profile';
import type { Rng } from '../rng';
import {
  affixGroups,
  affixPool,
  fillAffixes,
  hasAffixRules,
  openAffixKinds,
  rareName,
  rollAffix,
  rollValue,
  sortAffixes,
  tierOf,
  weightedPick,
  type AffixRarity,
} from './generate';
import type { AffixKind, BaseDef, EquipSlot, Item, ItemsData, Rarity, RolledAffix } from './types';

// Crafting (docs/design/crafting.md): operations on one stash or equipped item, paid in account currency, with a
// per-item counter that makes counted operations dearer. New affixes and tiers come from the drop tables
// (generate.ts). Pure functions over plain data; applyCraft mutates the profile. Reason codes only, no display text.

/** Rare crafting currency (docs/design/crafting.md, decision 2026-10-23). Drops from elites and bosses (0.4). */
export const ESSENCE_CURRENCY = 'essence';

/** Unique and legendary items are never craftable (their value is in the drop). */
export const CRAFTABLE_RARITIES: readonly Rarity[] = ['normal', 'magic', 'rare'];

export const CRAFT_OPS = ['upgradeRarity', 'addAffix', 'rerollAffix', 'rerollValues', 'removeAffix'] as const;
export type CraftOp = (typeof CRAFT_OPS)[number];

/** Currency id → amount. */
export type CraftCost = Readonly<Record<string, number>>;

/**
 * How the cost grows with the item's craft counter n:
 * - linear: base × (1 + perCraft × n)
 * - geometric: base × factor^n
 * Each amount is then rounded to the nearest integer.
 */
export type CostGrowth = { readonly kind: 'linear'; readonly perCraft: number } | { readonly kind: 'geometric'; readonly factor: number };

export interface CraftOpRules {
  /** Cost at craft counter 0. */
  readonly cost: CraftCost;
  /**
   * Overrides `cost` by the item's current rarity (counter 0), e.g. upgradeRarity: `magic` prices magic → rare
   * (designer decision 2026-10-23: that step costs more than normal → magic).
   */
  readonly costByRarity?: Readonly<Partial<Record<Rarity, CraftCost>>>;
  /** Counted operations bump the item's counter and their cost grows with it; uncounted ones cost `cost` forever. */
  readonly counted: boolean;
}

export interface CraftingRules {
  readonly ops: Readonly<Record<CraftOp, CraftOpRules>>;
  readonly growth: CostGrowth;
}

export interface CraftData {
  readonly items: ItemsData;
  readonly crafting: CraftingRules;
}

/** `index`: the chosen affix (position in Item.affixes) for rerollAffix / rerollValues / removeAffix. */
export interface CraftArgs {
  readonly index?: number;
}

export type CraftError =
  /** No item with that id in the stash or on any character. */
  | 'noItem'
  /** Unique / legendary. */
  | 'notCraftable'
  /** The item's base is not in the data. */
  | 'unknownBase'
  /** The operation does not apply to this rarity (upgrade from rare, add affix to a normal item). */
  | 'rarity'
  /** Missing or out-of-range affix index. */
  | 'badIndex'
  /** The chosen affix (or its tier) is not in the data. */
  | 'unknownAffix'
  /** No free affix slot (rarity max or prefix / suffix caps reached). */
  | 'noSlot'
  /** A slot is free but no affix in the table fits (slot, level, groups already on the item). */
  | 'noAffix'
  /** Removing would drop the item below its rarity's minimum affix count. */
  | 'minAffixes'
  /** Not enough of some currency in the cost. */
  | 'currency';

export type ItemLocation = { readonly where: 'stash'; readonly index: number } | { readonly where: 'equipped'; readonly characterId: string; readonly slot: EquipSlot };

export type CraftResult = { readonly ok: true; readonly item: Item; readonly cost: CraftCost } | { readonly ok: false; readonly error: CraftError };

/** The item's craft counter: missing or malformed reads as 0. */
export function craftCount(item: Item): number {
  const n = item.crafts;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** What `op` costs on this item right now. */
export function craftCost(item: Item, op: CraftOp, rules: CraftingRules): Record<string, number> {
  const opRules = rules.ops[op];
  const n = opRules.counted ? craftCount(item) : 0;
  const growth = rules.growth;
  const multiplier = growth.kind === 'linear' ? 1 + growth.perCraft * n : growth.factor ** n;
  const out: Record<string, number> = {};
  const baseCost = opRules.costByRarity?.[item.rarity] ?? opRules.cost;
  for (const [currency, base] of Object.entries(baseCost)) out[currency] = Math.round(base * multiplier);
  return out;
}

/** Finds an item by id in the stash or in any character's equipment. */
export function findItem(profile: Profile, itemId: string): { item: Item; location: ItemLocation } | undefined {
  const index = profile.stash.items.findIndex((i) => i.id === itemId);
  if (index >= 0) return { item: profile.stash.items[index]!, location: { where: 'stash', index } };
  for (const character of profile.characters) {
    for (const [slot, item] of Object.entries(character.equipment) as Array<[EquipSlot, Item | undefined]>) {
      if (item?.id === itemId) return { item, location: { where: 'equipped', characterId: character.id, slot } };
    }
  }
  return undefined;
}

/** Why `op` cannot be done on `item` now, or null. Structural reasons come before 'currency'. */
export function canCraft(profile: Profile, item: Item, op: CraftOp, args: CraftArgs, data: CraftData): CraftError | null {
  const error = checkItem(item, op, args, data.items);
  if (error) return error;
  const cost = craftCost(item, op, data.crafting);
  for (const [currency, amount] of Object.entries(cost)) {
    if (amount > 0 && (profile.currency[currency] ?? 0) < amount) return 'currency';
  }
  return null;
}

/**
 * Crafts on the item with `itemId` (stash or equipped): pays the cost, replaces the item with the crafted copy in
 * place, bumps its counter for counted operations. Equipment stats are derived from the equipped items on demand
 * (heroModifiers), so equipped items stay consistent. Nothing changes on error.
 */
export function applyCraft(profile: Profile, itemId: string, op: CraftOp, args: CraftArgs, rng: Rng, data: CraftData): CraftResult {
  const found = findItem(profile, itemId);
  if (!found) return { ok: false, error: 'noItem' };
  const { item, location } = found;
  const error = canCraft(profile, item, op, args, data);
  if (error) return { ok: false, error };
  const items = data.items;
  const base = items.bases[item.baseId]!;
  const cost = craftCost(item, op, data.crafting);

  let rarity = item.rarity;
  let name = item.name;
  let affixes: RolledAffix[] = [...item.affixes];
  const index = args.index ?? -1;
  switch (op) {
    case 'upgradeRarity': {
      const target: AffixRarity = item.rarity === 'normal' ? 'magic' : 'rare';
      fillAffixes(rng, affixes, Math.max(0, items.rules.affixCount[target].min - affixes.length), base, target, item.level, items);
      rarity = target;
      name = target === 'rare' ? rareName(rng, items) : '';
      break;
    }
    case 'addAffix':
      fillAffixes(rng, affixes, 1, base, item.rarity as AffixRarity, item.level, items);
      break;
    case 'rerollAffix': {
      const kind = items.affixes[affixes[index]!.affixId]!.kind;
      const pool = affixPool(items, base, item.level, [kind], affixGroups(affixes, items));
      // Non-empty: checked in checkItem. Same kind, so the prefix-first order holds.
      affixes[index] = rollAffix(rng, weightedPick(rng, pool, (a) => a.weight)!, item.level, items);
      break;
    }
    case 'rerollValues': {
      const rolled = affixes[index]!;
      const tier = tierOf(items.affixes[rolled.affixId]!, rolled.tier)!;
      affixes[index] = { ...rolled, value: rollValue(rng, tier) };
      break;
    }
    case 'removeAffix':
      affixes.splice(index, 1);
      break;
  }
  affixes = sortAffixes(affixes, items);

  for (const [currency, amount] of Object.entries(cost)) {
    if (amount > 0) profile.currency[currency] = (profile.currency[currency] ?? 0) - amount;
  }
  const crafted: Item = {
    ...item,
    rarity,
    name,
    affixes,
    ...(data.crafting.ops[op].counted ? { crafts: craftCount(item) + 1 } : {}),
  };
  if (location.where === 'stash') profile.stash.items[location.index] = crafted;
  else profile.characters.find((c) => c.id === location.characterId)!.equipment[location.slot] = crafted;
  return { ok: true, item: crafted, cost };
}

/** Rules that do not depend on currency. */
function checkItem(item: Item, op: CraftOp, args: CraftArgs, data: ItemsData): CraftError | null {
  if (!CRAFTABLE_RARITIES.includes(item.rarity)) return 'notCraftable';
  const base = data.bases[item.baseId];
  if (!base) return 'unknownBase';
  const rarity = item.rarity;

  if (op === 'upgradeRarity') {
    if (rarity === 'rare') return 'rarity';
    const target: AffixRarity = rarity === 'normal' ? 'magic' : 'rare';
    const need = data.rules.affixCount[target].min - item.affixes.length;
    if (need > 0 && maxAddable(item.affixes, target, base, item.level, data) < need) return 'noAffix';
    return null;
  }
  if (op === 'addAffix') {
    if (!hasAffixRules(rarity)) return 'rarity';
    const kinds = openAffixKinds(item.affixes, rarity, data);
    if (item.affixes.length >= data.rules.affixCount[rarity].max || kinds.length === 0) return 'noSlot';
    if (affixPool(data, base, item.level, kinds, affixGroups(item.affixes, data)).length === 0) return 'noAffix';
    return null;
  }

  // Operations on a chosen affix.
  const index = args.index;
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= item.affixes.length) return 'badIndex';
  const rolled = item.affixes[index]!;
  if (op === 'removeAffix') {
    const min = hasAffixRules(rarity) ? data.rules.affixCount[rarity].min : 0;
    return item.affixes.length - 1 < min ? 'minAffixes' : null;
  }
  const def = data.affixes[rolled.affixId];
  if (!def) return 'unknownAffix';
  if (op === 'rerollValues') return tierOf(def, rolled.tier) ? null : 'unknownAffix';
  // rerollAffix: another affix of the same kind whose group is not on the item yet (the chosen one's included).
  return affixPool(data, base, item.level, [def.kind], affixGroups(item.affixes, data)).length > 0 ? null : 'noAffix';
}

/**
 * Upper bound on how many affixes fillAffixes can add: per kind, the free slots or the distinct free groups,
 * whichever is smaller (exact when every group has a single kind, as in data/items).
 */
function maxAddable(affixes: readonly RolledAffix[], rarity: AffixRarity, base: BaseDef, level: number, data: ItemsData): number {
  const taken = affixGroups(affixes, data);
  const used: Record<AffixKind, number> = { prefix: 0, suffix: 0 };
  for (const a of affixes) {
    const kind = data.affixes[a.affixId]?.kind;
    if (kind) used[kind]++;
  }
  const caps: Record<AffixKind, number> = { prefix: data.rules.maxPrefixes[rarity], suffix: data.rules.maxSuffixes[rarity] };
  let total = 0;
  for (const kind of ['prefix', 'suffix'] as const) {
    const groups = new Set(affixPool(data, base, level, [kind], taken).map((a) => a.group));
    total += Math.min(Math.max(0, caps[kind] - used[kind]), groups.size);
  }
  return Math.min(total, data.rules.affixCount[rarity].max - affixes.length);
}

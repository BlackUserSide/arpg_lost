import type { BaseDamage } from '../combat/damage';
import type { PassiveMechanic } from '../passives/types';
import type { DamageType, Modifier, ModifierKind, StatId, Tag } from '../stats/types';

export const SLOTS = ['weapon', 'helmet', 'armour', 'gloves', 'boots', 'ring', 'amulet'] as const;
export type Slot = (typeof SLOTS)[number];

/** Where an item can be worn; rings have two places. */
export const EQUIP_SLOTS = ['weapon', 'helmet', 'armour', 'gloves', 'boots', 'ring1', 'ring2', 'amulet'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

export type Rarity = 'normal' | 'magic' | 'rare' | 'unique' | 'legendary';
export type AffixKind = 'prefix' | 'suffix';
export type WeaponType = 'sword' | 'crossbow' | 'wand';

/** Template for one stat line; the value comes from the roll. */
export interface StatLine {
  readonly stat: StatId;
  readonly kind: ModifierKind;
  readonly tags?: readonly Tag[];
  readonly damageType?: DamageType;
}

export interface ValueRange {
  readonly min: number;
  readonly max: number;
  /** Roll granularity: 1 for integers, 0.01 for fractions. */
  readonly step: number;
}

export interface AffixTier extends ValueRange {
  /** Minimum item level for this tier. */
  readonly minLevel: number;
}

export interface AffixDef {
  readonly id: string;
  /** Only one affix per group on an item. */
  readonly group: string;
  readonly kind: AffixKind;
  readonly slots: readonly Slot[];
  readonly weight: number;
  /** Defence-scaling affixes only roll on bases that have that defence (jewellery has none and is exempt). */
  readonly requires?: 'armour' | 'energyShield';
  readonly line: StatLine;
  /** Ordered from worst (T5) to best (T1) by minLevel. */
  readonly tiers: readonly AffixTier[];
}

export interface WeaponStats {
  readonly type: WeaponType;
  readonly damage: BaseDamage;
  readonly attacksPerSecond: number;
  readonly critChance: number;
}

export interface BaseDef {
  /** Also the key of its display name in the locale files (render). */
  readonly id: string;
  readonly slot: Slot;
  /** Minimum item level to drop. */
  readonly level: number;
  readonly implicit?: StatLine & { readonly range: ValueRange };
  readonly armour?: ValueRange;
  readonly energyShield?: ValueRange;
  readonly weapon?: WeaponStats;
}

/** Rarities of hand-made items (UniqueDef); they carry no affixes and are never crafted. */
export type UniqueRarity = 'unique' | 'legendary';

/** One fixed stat line of a unique: its value is rolled inside the best tier unlocked at the item level. */
export interface UniqueStatLine extends StatLine {
  /** Ordered from worst (T5) to best (T1) by minLevel, like AffixDef.tiers. */
  readonly tiers: readonly AffixTier[];
}

/**
 * A unique or legendary item (docs/design/items.md, decisions 2026-10-21 / 2026-10-25): a base (its defences,
 * implicit and weapon stats roll as usual), a fixed set of rolled stat lines, fixed effect modifiers, fixed costs
 * ("Ціна") and mechanics (the same PassiveMechanic carrier as keystones). Display text is keyed by id (render:
 * unique.<id>.name, unique.<id>.effect).
 */
export interface UniqueDef {
  readonly id: string;
  readonly rarity: UniqueRarity;
  readonly baseId: string;
  /** Minimum item level to drop; default: the base's level. */
  readonly level?: number;
  /** Drop weight inside its rarity's pool; 0 = never drops (a def may land before its mechanic works). */
  readonly weight: number;
  /** Rolled stat lines, in display order (Item.unique.rolls has one entry per line, same order). */
  readonly stats: readonly UniqueStatLine[];
  /** Fixed signature-effect modifiers (not rolled), e.g. "+50% more damage". */
  readonly effectModifiers?: readonly Modifier[];
  /** Fixed drawback modifiers (not rolled), shown as "Ціна" lines. */
  readonly costs?: readonly Modifier[];
  /** Mechanics the item brings while equipped (equipmentMechanics → heroMechanics). */
  readonly mechanics?: readonly PassiveMechanic[];
  /**
   * Where each placeholder of the effect text (unique.<id>.effect) takes its value from, so the wording can live in
   * the locale files while every number stays in this def. Read by render only; ignored by the simulation.
   */
  readonly effectParams?: Readonly<Record<string, UniqueTextParam>>;
}

/**
 * One placeholder value of a unique's effect text, read from the UniqueDef itself by a dot path (object keys and
 * array indices, e.g. 'mechanics.0.addOnHit.0.duration'):
 * - `path` + `format` 'number' (default): the number as is (sign dropped); a `count` placeholder also picks the plural.
 * - `path` + `format` 'percent': a fraction shown as a percentage (sign dropped: the wording says "less" / "more").
 * - `resourceOf`: a path to a skill id; the class resource of the class owning that skill (genitive form).
 * A path into effectModifiers marks that modifier as stated by the text (it gets no extra modifier line).
 */
export type UniqueTextParam =
  | { readonly path: string; readonly format?: 'number' | 'percent' }
  | { readonly resourceOf: string };

export interface LootRules {
  /**
   * Chest rarity weights (one draw). A `unique` pick with no unique available at the item level becomes rare.
   * Legendaries are not in this draw: they come only from bosses (RunRewardRules.chest.legendary).
   */
  readonly rarityWeights: Readonly<Record<'normal' | 'magic' | 'rare' | 'unique', number>>;
  readonly affixCount: Readonly<Record<'magic' | 'rare', { readonly min: number; readonly max: number }>>;
  readonly maxPrefixes: Readonly<Record<'magic' | 'rare', number>>;
  readonly maxSuffixes: Readonly<Record<'magic' | 'rare', number>>;
  /** Weight per tier, best tier first (T1, T2, ...). Higher tiers are rarer. */
  readonly tierWeights: readonly number[];
  readonly salvage: Readonly<Record<Rarity, number>>;
  readonly stashSize: number;
  /**
   * The stash overflow ("пошта", designer decision 2026-10-26): chest items of these rarities that do not fit a full
   * stash wait here (Profile.stash.overflow) instead of being salvaged, up to `size` items; other rarities are salvaged
   * as before. Over the cap the item is salvaged after all (see grantRunRewards).
   */
  readonly overflow: { readonly size: number; readonly rarities: readonly Rarity[] };
  /** Off until character levels exist (M3); requirements still show in tooltips. */
  readonly enforceLevelRequirement: boolean;
  /**
   * Leftover of the old arena rewards: no game code reads it any more (map runs use MapsData.rewards); kept only
   * because tools/sim/crafting.sim.ts models run income with it. Remove together with that sim input.
   */
  readonly arenaRewards: { readonly killsPerItem: number; readonly maxItems: number; readonly wavesPerItemLevel: number; readonly maxBonusLevels: number };
  /** Rare name words; each word is also its translation key in the locale files (item.rare.first.<word>). */
  readonly rareNameWords: { readonly first: readonly string[]; readonly second: readonly string[] };
}

export interface ItemsData {
  readonly bases: Readonly<Record<string, BaseDef>>;
  readonly affixes: Readonly<Record<string, AffixDef>>;
  readonly uniques: Readonly<Record<string, UniqueDef>>;
  readonly rules: LootRules;
}

export interface RolledAffix {
  readonly affixId: string;
  /** 1 = best. */
  readonly tier: number;
  readonly value: number;
}

/** A concrete item: plain JSON so it can be saved and later validated on a server. */
export interface Item {
  readonly id: string;
  readonly baseId: string;
  readonly level: number;
  readonly rarity: Rarity;
  /**
   * Rolled name of a rare item: two words from LootRules.rareNameWords ("Grim Ward"), which render translates word by
   * word. Empty for other rarities (render names them by their base); older saves may still hold an English base name.
   */
  readonly name: string;
  readonly implicit?: number;
  readonly armour?: number;
  readonly energyShield?: number;
  readonly affixes: readonly RolledAffix[];
  /**
   * Crafting operations done on this item that count towards its cost growth (docs/design/crafting.md; never
   * reset). Missing = 0, so dropped items and older saves need no migration. Read through craftCount (core/items/craft).
   */
  readonly crafts?: number;
  /**
   * Unique / legendary items: which UniqueDef and the rolled value of each of its stat lines (same order as
   * UniqueDef.stats; tier 1 = best). An id missing from the data (a removed unique) gives no unique stats or
   * mechanics; the item keeps its base and stays salvageable. Absent on other rarities.
   */
  readonly unique?: UniqueRoll;
}

export interface UniqueRoll {
  readonly id: string;
  readonly rolls: readonly UniqueStatRoll[];
}

export interface UniqueStatRoll {
  /** 1 = best. */
  readonly tier: number;
  readonly value: number;
}

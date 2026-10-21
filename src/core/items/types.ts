import type { BaseDamage } from '../combat/damage';
import type { DamageType, ModifierKind, StatId, Tag } from '../stats/types';

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
  readonly id: string;
  readonly name: string;
  readonly slot: Slot;
  /** Minimum item level to drop. */
  readonly level: number;
  readonly implicit?: StatLine & { readonly range: ValueRange };
  readonly armour?: ValueRange;
  readonly energyShield?: ValueRange;
  readonly weapon?: WeaponStats;
}

export interface LootRules {
  readonly rarityWeights: Readonly<Record<'normal' | 'magic' | 'rare', number>>;
  readonly affixCount: Readonly<Record<'magic' | 'rare', { readonly min: number; readonly max: number }>>;
  readonly maxPrefixes: Readonly<Record<'magic' | 'rare', number>>;
  readonly maxSuffixes: Readonly<Record<'magic' | 'rare', number>>;
  /** Weight per tier, best tier first (T1, T2, ...). Higher tiers are rarer. */
  readonly tierWeights: readonly number[];
  readonly salvage: Readonly<Record<Rarity, number>>;
  readonly stashSize: number;
  /** Off until character levels exist (M3); requirements still show in tooltips. */
  readonly enforceLevelRequirement: boolean;
  /** Temporary arena rewards until runs end with a chest (docs/design/maps.md). */
  readonly arenaRewards: { readonly killsPerItem: number; readonly maxItems: number; readonly wavesPerItemLevel: number; readonly maxItemLevel: number };
  readonly rareNameWords: { readonly first: readonly string[]; readonly second: readonly string[] };
}

export interface ItemsData {
  readonly bases: Readonly<Record<string, BaseDef>>;
  readonly affixes: Readonly<Record<string, AffixDef>>;
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
  readonly name: string;
  readonly implicit?: number;
  readonly armour?: number;
  readonly energyShield?: number;
  readonly affixes: readonly RolledAffix[];
}

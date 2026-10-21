import type { CombatConfig } from '../combat/config';
import type { BaseDamage } from '../combat/damage';
import type { ElementalType, SkillTag, StatId } from '../stats/types';

/** Hits targets inside a circular sector in front of the actor, closest first. */
export interface ArcShape {
  readonly kind: 'arc';
  readonly radius: number;
  readonly angleDeg: number;
  /** Omit for unlimited targets. */
  readonly maxTargets?: number;
}

export type ActionShape = ArcShape;

/** Basic attack or skill. Damage is weapon damage scaled by damageEffectiveness. */
export interface ActionDef {
  readonly id: string;
  readonly tags: readonly SkillTag[];
  readonly damageEffectiveness: number;
  readonly shape: ActionShape;
  readonly manaCost: number;
  /** Seconds; 0 = no cooldown. */
  readonly cooldown: number;
}

export interface WeaponDef {
  readonly damage: BaseDamage;
  readonly attacksPerSecond: number;
  readonly critChance: number;
}

export interface ClassDef {
  readonly id: string;
  readonly radius: number;
  readonly baseStats: Readonly<Partial<Record<StatId, number>>>;
  readonly weapon: WeaponDef;
  readonly basicAttack: ActionDef;
  /** Bound to skill slots 1..3 (RMB / Q / E). */
  readonly skills: readonly ActionDef[];
}

export interface MobDef {
  readonly id: string;
  readonly radius: number;
  readonly life: number;
  readonly armour: number;
  readonly resistances: Readonly<Record<ElementalType, number>>;
  readonly moveSpeed: number;
  readonly attack: {
    readonly damage: BaseDamage;
    /** Reach beyond touching distance. */
    readonly range: number;
    readonly interval: number;
    readonly critChance: number;
  };
}

export interface ArenaDef {
  readonly width: number;
  readonly height: number;
  readonly spawn: {
    readonly firstDelay: number;
    readonly interval: number;
    readonly batchStart: number;
    /** Extra mobs per batch for every following wave (fractional values accumulate). */
    readonly batchGrowth: number;
    readonly maxAlive: number;
    readonly mobIds: readonly string[];
  };
}

export interface Content {
  readonly combat: CombatConfig;
  readonly classes: Readonly<Record<string, ClassDef>>;
  readonly mobs: Readonly<Record<string, MobDef>>;
  readonly arena: ArenaDef;
}

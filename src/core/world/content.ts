import type { CombatConfig } from '../combat/config';
import type { BaseDamage } from '../combat/damage';
import type { WeaponType } from '../items/types';
import type { ProgressionRules } from '../progression/levels';
import type { ElementalType, Modifier, SkillTag, StatId } from '../stats/types';

/** Where the action's damage comes from. Attacks scale weapon damage; spells have their own base damage. */
export type DamageSpec =
  | { readonly source: 'weapon'; readonly effectiveness: number }
  | { readonly source: 'skill'; readonly base: BaseDamage; readonly critChance: number };

export type StatusId = 'stun' | 'slow';

export interface StatusEffect {
  readonly status: StatusId;
  readonly duration: number;
  /** Slow: fraction of speed removed (0.4 = 40% slower). */
  readonly magnitude?: number;
  /** Omit for a guaranteed status. */
  readonly chance?: number;
}

/** How the action reaches its targets. */
export type Delivery =
  /** Sector in front of the actor (360° = circle around the actor), closest first. */
  | { readonly kind: 'arc'; readonly radius: number; readonly angleDeg: number; readonly maxTargets?: number }
  /** `count` projectiles fanned over `spreadDeg`. Explodes on first hit / end of range if explodeRadius is set. */
  | {
      readonly kind: 'projectile';
      readonly count: number;
      readonly spreadDeg: number;
      readonly speed: number;
      readonly range: number;
      readonly radius: number;
      readonly pierce: number;
      readonly explodeRadius?: number;
    }
  /** Moves the actor along the facing; enemies within hitRadius of the path are hit once. */
  | { readonly kind: 'dash'; readonly distance: number; readonly speed: number; readonly hitRadius: number }
  /** Instantly moves to the aim point, at most `range` away. */
  | { readonly kind: 'teleport'; readonly range: number }
  /** Thrown towards the aim point; arms, then explodes when an enemy steps into triggerRadius or lifetime ends. */
  | {
      readonly kind: 'trap';
      readonly throwRange: number;
      readonly armTime: number;
      readonly triggerRadius: number;
      readonly explodeRadius: number;
      readonly lifetime: number;
    }
  /** No targets; only self effects. */
  | { readonly kind: 'self' };

export type SelfEffect =
  | { readonly kind: 'buff'; readonly id: string; readonly modifiers: readonly Modifier[]; readonly duration: number }
  | { readonly kind: 'invulnerable'; readonly duration: number };

/** Basic attack or skill. */
export interface ActionDef {
  readonly id: string;
  readonly tags: readonly SkillTag[];
  readonly manaCost: number;
  /** Seconds; 0 = no cooldown. */
  readonly cooldown: number;
  /** Base seconds per use for non-attacks (spells scale it by cast speed). Attacks use weapon attack speed. */
  readonly castTime?: number;
  readonly damage?: DamageSpec;
  readonly delivery: Delivery;
  readonly onHit?: readonly StatusEffect[];
  readonly selfEffects?: readonly SelfEffect[];
}

export interface WeaponDef {
  readonly damage: BaseDamage;
  readonly attacksPerSecond: number;
  readonly critChance: number;
}

export interface ClassDef {
  readonly id: string;
  readonly radius: number;
  /** The only weapon type this class can equip. */
  readonly weaponType: WeaponType;
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
  /** Base XP at area level 1; scaled by area level (core/progression/levels). */
  readonly xp: number;
  readonly armour: number;
  readonly resistances: Readonly<Record<ElementalType, number>>;
  readonly moveSpeed: number;
  /** Ranged mobs try to stay at this distance from the player. */
  readonly preferredRange?: number;
  readonly attack: {
    readonly damage: BaseDamage;
    /** Reach beyond touching distance (melee) or max shooting distance (ranged). */
    readonly range: number;
    readonly interval: number;
    readonly critChance: number;
    readonly projectile?: { readonly speed: number; readonly radius: number };
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
  readonly progression: ProgressionRules;
}

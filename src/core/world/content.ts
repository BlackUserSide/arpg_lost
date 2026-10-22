import type { CombatConfig } from '../combat/config';
import type { BaseDamage } from '../combat/damage';
import type { WeaponType } from '../items/types';
import type { ProgressionRules } from '../progression/levels';
import type { DamageType, ElementalType, Modifier, SkillTag, StatId } from '../stats/types';

/** Where the action's damage comes from. Attacks scale weapon damage; spells have their own base damage. */
export type DamageSpec =
  | { readonly source: 'weapon'; readonly effectiveness: number }
  | { readonly source: 'skill'; readonly base: BaseDamage; readonly critChance: number };

/**
 * Statuses combat implements (on MobState):
 * - stun / freeze: the mob cannot move or attack. Bosses are never frozen (see CombatConfig.bossFreezeSlow) and
 *   ordinary stuns only slow them (CombatConfig.bossStunSlow); only a full stun bar stuns a boss.
 * - slow: speed (movement and attack timer) reduced by its magnitude.
 * - ignite: fire damage over time; does not stack, the strongest (highest damage per second) applies.
 */
export const STATUS_IDS = ['stun', 'slow', 'ignite', 'freeze'] as const;
export type StatusId = (typeof STATUS_IDS)[number];

export interface StatusEffect {
  readonly status: StatusId;
  readonly duration: number;
  /**
   * Slow: fraction of speed removed (0.4 = 40% slower).
   * Ignite: fraction of the hit's damage (after crit, before the target's defences) dealt as fire over the
   * duration; scaled by igniteDamage, then reduced by the target's fire resistance.
   */
  readonly magnitude?: number;
  /** Omit for a guaranteed status. Ignite chance is scaled by the igniteChance stat. */
  readonly chance?: number;
  /** Applies only if the target already had this status before the hit (freeze: "already slowed"). */
  readonly requiresStatus?: StatusId;
  /** Applies only if the hit dealt damage of this type (ignite: "fire hits"). */
  readonly requiresDamageType?: DamageType;
  /** Freeze on a boss: duration of the slow that replaces the freeze; defaults to `duration`. */
  readonly bossDuration?: number;
}

/**
 * An explosion when a mob dies: lifeFraction × the dead mob's max life as `damageType` damage to the enemies
 * around it (mitigated by their defences; no crit, not scaled by hero damage modifiers). Used by passive
 * death explosions (Pyre, Shatter). The elite «Вибуховий» (0.4) will need a hostile-side target (the hero) and
 * an ignite strength owned by the def; not supported yet.
 */
export interface DeathExplosionDef {
  readonly radius: number;
  readonly lifeFraction: number;
  readonly damageType: DamageType;
  /** Guaranteed status on everyone hit; its strength comes from the hero's source of that status (ignite only). */
  readonly applyStatus?: StatusId;
}

/** Chain detonation of a trap: other hero traps within `radius` of its explosion explode after `delay` seconds. */
export interface TrapChain {
  readonly delay: number;
  readonly radius: number;
}

/** Slow aura of an armed trap: enemies within `radius` (+ their radius) are slowed by `slow` (fraction of speed removed). */
export interface TrapAura {
  readonly radius: number;
  readonly slow: number;
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
  /**
   * Thrown towards the aim point; arms, then explodes when an enemy steps into triggerRadius or lifetime ends.
   * Optional rules (usually granted by passives / supports through the skill resolver, see SkillGrants):
   * - maxActive: cap on the hero's active traps of every source; throwing past it removes the oldest one
   *   without exploding (placeTrap, actions.ts).
   * - chain: when this trap explodes, the hero's other traps within `radius` explode `delay` seconds later.
   * - aura: while armed, enemies within `radius` (+ their radius) are slowed by `slow` (MobState.auraSlow).
   */
  | {
      readonly kind: 'trap';
      readonly throwRange: number;
      readonly armTime: number;
      readonly triggerRadius: number;
      readonly explodeRadius: number;
      readonly lifetime: number;
      readonly maxActive?: number;
      readonly chain?: TrapChain;
      readonly aura?: TrapAura;
    }
  /** No targets; only self effects. */
  | { readonly kind: 'self' };

export type SelfEffect =
  | { readonly kind: 'buff'; readonly id: string; readonly modifiers: readonly Modifier[]; readonly duration: number }
  | { readonly kind: 'invulnerable'; readonly duration: number };

/** Basic attack or skill. */
export interface ActionDef {
  readonly id: string;
  /** Display name (Ukrainian). */
  readonly name?: string;
  readonly tags: readonly SkillTag[];
  /** Cost in the class resource (in life under bloodMagic, see actionCost). */
  readonly resourceCost: number;
  /** Seconds; 0 = no cooldown. With charges > 1: seconds to recharge one charge. */
  readonly cooldown: number;
  /**
   * Uses stored up to this many (default 1). Each use spends a charge; while not full, charges recharge one at a
   * time, each over `cooldown` (PlayerState.charges / cooldowns). Ignored for actions without a cooldown.
   */
  readonly charges?: number;
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

/**
 * Gain per enemy hit dealt by the hero's own actions. Only damage hits count (not ignite ticks or death explosions).
 * `maxHitsPerUse` caps the hits that grant resource per use of a counting action (one swing hitting 5 mobs with
 * cap 3 grants 3 × amount). The count restarts whenever a counting action is used (counterAttack included).
 */
export interface ResourceHitGain {
  /** Resource points per enemy hit. */
  readonly amount: number;
  /** Which hits count: only the hero's basic attack (counter-attacks included), or every action. */
  readonly source: 'basicAttack' | 'anyAction';
  readonly maxHitsPerUse: number;
}

/**
 * The class resource that pays for skills (docs/design/classes.md, «Ресурс класу»): Rage / Energy / Mana.
 * Max and passive regeneration are the stats `resource` / `resourceRegen` (class baseStats + gear, passives,
 * levels), so every "+resource" source works for any class. The rules below give each class its rhythm; the
 * optional ones can be mixed freely by a future class. Under bloodMagic max resource is 0, so nothing is gained.
 */
export interface ResourceDef {
  /** Resource id ('rage' | 'energy' | 'mana' today, any string later); render maps it to a display name. */
  readonly id: string;
  /** Fill at run start as a fraction of max (0 = empty, 1 = full). */
  readonly startFraction: number;
  /** True: a level-up refills the pool to max (like life). False: it keeps the current amount (capped at max). */
  readonly refillOnLevelUp: boolean;
  /** Gain from hits the hero deals. */
  readonly onHit?: ResourceHitGain;
  /**
   * Gain from damage the hero takes: (life + energy shield lost) / (max life + max energy shield) × perPoolFraction.
   * E.g. 50 = +5 for losing 10% of the pool.
   */
  readonly onDamageTaken?: { readonly perPoolFraction: number };
  /**
   * Drain once the hero has neither dealt nor taken a hit for `delay` seconds (PlayerState.combatIdle):
   * `perSecond` resource points per second until the next hit. Regeneration still applies while draining.
   */
  readonly decay?: { readonly delay: number; readonly perSecond: number };
  /**
   * True: resourceRegen applies only in combat (combatIdle below decay.delay); out of combat the pool only decays.
   * Without `decay` the hero always counts as in combat, so this has no effect.
   */
  readonly regenOnlyInCombat?: boolean;
}

export interface ClassDef {
  readonly id: string;
  readonly radius: number;
  /** The only weapon type this class can equip. */
  readonly weaponType: WeaponType;
  /** Base stats; `resource` / `resourceRegen` are the class resource's max and regeneration per second. */
  readonly baseStats: Readonly<Partial<Record<StatId, number>>>;
  /** The resource skills cost (ActionDef.resourceCost). */
  readonly resource: ResourceDef;
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
  /**
   * Bosses are not frozen or stunned (each becomes a strong slow; while it runs the boss counts as frozen /
   * stunned for conditions). Exception: a full stun bar stuns a boss (bossFillFactor, bossStunDuration).
   */
  readonly boss?: boolean;
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

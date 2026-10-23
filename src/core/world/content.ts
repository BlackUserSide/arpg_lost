import type { CombatConfig } from '../combat/config';
import type { BaseDamage } from '../combat/damage';
import type { WeaponType } from '../items/types';
import type { ProgressionRules } from '../progression/levels';
import type { SkillLevelData } from '../skills/levels';
import type { SupportData } from '../supports/types';
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
 * - bleed: physical damage over time (Bleed support); stacks up to the effect's maxStacks, every hit adds a stack
 *   and restarts the shared timer (designer decision 2026-10-23). See applyBleed (statuses.ts).
 */
export const STATUS_IDS = ['stun', 'slow', 'ignite', 'freeze', 'bleed'] as const;
export type StatusId = (typeof STATUS_IDS)[number];

export interface StatusEffect {
  readonly status: StatusId;
  readonly duration: number;
  /**
   * Slow: fraction of speed removed (0.4 = 40% slower).
   * Ignite: fraction of the hit's damage (after crit, before the target's defences) dealt as fire over the
   * duration; scaled by igniteDamage, then reduced by the target's fire resistance.
   * Bleed: fraction of the hit's damage (after crit, before defences) one stack deals as physical damage over
   * the duration (not reduced by armour: a damage over time).
   */
  readonly magnitude?: number;
  /** Bleed: most stacks a target can carry (default 1). */
  readonly maxStacks?: number;
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
  | { readonly kind: 'arc'; readonly radius: number; readonly angleDeg: number; readonly maxTargets?: number; readonly everyNth?: ArcEveryNth }
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
      readonly split?: ProjectileSplit;
    }
  /** Moves the actor along the facing; enemies within hitRadius of the path are hit once. */
  | { readonly kind: 'dash'; readonly distance: number; readonly speed: number; readonly hitRadius: number; readonly landing?: DashLanding }
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
  | { readonly kind: 'invulnerable'; readonly duration: number }
  /**
   * Leaves a decoy where the hero stands when the action starts (before a dash moves them). While it lasts, every
   * mob within tauntRadius of it targets the decoy instead of the hero (see Decoy). Bosses only for the first
   * `bossTauntDuration` seconds (omit: the whole duration; 0: never).
   */
  | { readonly kind: 'decoy'; readonly id: string; readonly duration: number; readonly tauntRadius: number; readonly bossTauntDuration?: number };

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
  /**
   * Stat modifiers of this action only (from skill changes: skill levels, later supports), added to the hero's
   * modifiers for its use time and its hits. Usually absent in class data; see SkillChangeSet.modifiers.
   */
  readonly modifiers?: readonly Modifier[];
  /**
   * Ground zone left where the action's area resolves: at the hero for arc actions (novas, swings), at the
   * explosion for projectiles and traps. Usually granted by skill changes (SkillGrants.groundZone).
   */
  readonly zone?: GroundZoneDef;
  /** Fraction of the life this action's hits remove that the hero leeches, on top of lifeLeech mechanics (supports). */
  readonly leech?: number;
  /** Increased stun bar fill of this action's hits; adds to stunBonus fillIncreased (supports). */
  readonly stunBarFillIncreased?: number;
  /** Lightning hopping from every impact (SkillGrants.chainHit). */
  readonly chainHit?: ChainHitDef;
  /** Chance to repeat the action (SkillGrants.echo). */
  readonly echo?: EchoDef;
  /** Hits push mobs away (SkillGrants.knockback). */
  readonly knockback?: KnockbackDef;
  /** Part of the action's damage converted to another type before scaling (Ignite support: part → fire). */
  readonly damageConversion?: DamageConversion;
}

/**
 * Damage conversion of a hit: `fraction` (0..1) of every other damage type (rolled base + flat added damage) becomes
 * `to`, before increased / more scaling, so modifiers of the new type apply to the converted part (and those of the
 * old type no longer do). Happens before crit and defences.
 */
export interface DamageConversion {
  readonly to: DamageType;
  readonly fraction: number;
}

/**
 * Chain Lightning: every impact of the action (an arc / explosion that hit someone, a projectile contact hit, a
 * dash path hit) releases a bolt from the first target hit. It hops up to `hops` times, each time to the nearest
 * living mob within `range` (+ its radius) of the previous one that neither the impact nor the bolt hit yet.
 * Each hop is a hit of the action at `effectiveness` × its rolled base damage, all of it converted to
 * `damageType` (so it grows with skill level, passives and damage modifiers, designer decision 2026-10-23); it
 * can crit, leech, gain resource and fill the stun bar, but applies no on-hit statuses, knockback or new chains.
 */
export interface ChainHitDef {
  /** Most mobs the bolt hits after the impact. */
  readonly hops: number;
  /** Max jump distance between the previous target and the next one (plus the next one's radius). */
  readonly range: number;
  /** Fraction of the action's rolled base damage each bolt hit deals. */
  readonly effectiveness: number;
  readonly damageType: DamageType;
}

/**
 * Echo: after the action is used, with `chance` it repeats `delay` seconds later: free (no cost, charge, cooldown
 * or action time), with the same aim and direction from the hero's position at that moment; it does not count as a
 * use (Cleave's every-N-th) and repeats the same swing angle. An echo never echoes again. Not for movement skills or
 * buffs (support compatibility, designer decision 2026-10-23).
 */
export interface EchoDef {
  readonly chance: number;
  readonly delay: number;
}

/**
 * Knockback: hits push the target `distance` away from the hero at `speed` (while pushed it neither moves nor
 * attacks). Elites are pushed `eliteMultiplier` × distance; bosses are never pushed (designer decision 2026-10-23).
 * Omit `chance` for every hit.
 */
export interface KnockbackDef {
  readonly distance: number;
  readonly speed: number;
  readonly eliteMultiplier: number;
  readonly chance?: number;
}

/** Every `every`-th use of an arc action swings `angleDeg` instead (PlayerState.useCounts counts the uses). */
export interface ArcEveryNth {
  readonly every: number;
  readonly angleDeg: number;
}

/**
 * When a dash ends (full distance or blocked), everyone within `radius` (+ their radius) of the hero is hit by the
 * dash action at `effectiveness` × its damage, with its on-hit statuses (stuns follow the usual boss rules).
 */
export interface DashLanding {
  readonly radius: number;
  readonly effectiveness: number;
}

/**
 * Where a hero projectile explodes (or, without explodeRadius, at the hit that consumes it), it splits into
 * `count` child projectiles fanned over `spreadDeg` around its direction. Children deal damageMultiplier × the
 * parent's damage, keep its tags, modifiers, on-hit statuses and cast snapshot, never split again and leave no
 * zone. They pass through (no contact hit with) the targets the parent's impact / explosion already hit, but
 * their own explosion, set off by another target or at the end of their range, can still splash those targets.
 * No split outside the arena.
 */
export interface ProjectileSplit {
  readonly count: number;
  readonly spreadDeg: number;
  readonly speed: number;
  readonly range: number;
  readonly radius: number;
  readonly explodeRadius?: number;
  readonly damageMultiplier: number;
}

/**
 * A ground zone (fire puddle, ice field; later supports and elites). Hero-side: it affects mobs only.
 * - tick: every `interval` seconds (first tick one interval after it appears) each living mob inside takes
 *   `damage` (rolled once per tick) scaled by the hero's increased / more damage modifiers (not flat added
 *   damage) with the action's tags and own modifiers; mitigated, no crit, no leech, no resource, no stun bar (a
 *   damage over time, like ignite). The action's ignite on-hit statuses (hero ignite sources) may apply; other
 *   on-hit statuses do not. See updateZones (zones.ts).
 * - slow: mobs inside are slowed like by a trap aura (MobState.auraSlow).
 */
export interface GroundZoneDef {
  /** Kind for render ('fire_puddle', 'ice_field'). */
  readonly id: string;
  readonly duration: number;
  /** Omit: the radius of the area that left the zone. */
  readonly radius?: number;
  readonly tick?: { readonly interval: number; readonly damage: BaseDamage };
  readonly slow?: number;
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
  /** Elite mob (docs/design/mobs.md, maps 0.4): knocked back less, drops supports more often. */
  readonly elite?: boolean;
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
  /** Skill levels and XP (docs/design/classes.md «Рівні скілів»). Absent: skills stay at level 1 and gain no XP. */
  readonly skillLevels?: SkillLevelData;
  /** Skill modifiers (docs/design/skill-modifiers.md). Absent: socketed supports do nothing and none drop. */
  readonly supports?: SupportData;
}

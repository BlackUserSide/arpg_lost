// Passive tree schema (docs/design/passives.md, docs/design/passives-wheel.md).
// Plain data: the tree lives in src/data/passives.ts, the hero's allocation is saved JSON.

import type { DeathExplosionDef, StatusId } from '../world/content';
import type { AddedStatus, SkillChangeSet, SkillGrants, SkillParamChange } from '../skills/types';
import type { DamageType, Modifier, SkillTag } from '../stats/types';
import type { SupportCompatibility } from '../supports/types';

/**
 * - `start`: a class start point (free, no bonus, never allocated; other classes cannot path through it).
 * - `small` / `notable` / `keystone`: wheel nodes, paid with passive points.
 * - `specEntry` / `specKeystone` / `spec`: specialization branch nodes, paid with spec points.
 */
export type PassiveNodeType = 'start' | 'small' | 'notable' | 'keystone' | 'specEntry' | 'specKeystone' | 'spec';

/** Polar layout hint for the tree screen: degrees counter-clockwise from +x (east, y up), radius in tree units. */
export interface PassiveNodePos {
  readonly angleDeg: number;
  readonly radius: number;
}

/** Hero state a conditional modifier depends on. Numbers come from data. */
export type PassiveCondition =
  /** The hero moved (incl. roll / teleport) within the last `seconds`. */
  | { readonly kind: 'movedWithin'; readonly seconds: number }
  /** The hero has not moved for at least `seconds`. */
  | { readonly kind: 'stationaryFor'; readonly seconds: number }
  /** Current life below this fraction of max life. */
  | { readonly kind: 'lifeBelow'; readonly fraction: number }
  /** The hit's target has this status. */
  | { readonly kind: 'targetHasStatus'; readonly status: PassiveStatusId }
  /** The hero holds at most `value` souls (PlayerState.souls; the souls mechanic, Devourer's Crown). */
  | { readonly kind: 'soulsAtMost'; readonly value: number }
  /** The hero's cheatDeath is recharging (PlayerState.cheatDeathCooldown > 0; Clock of the Last Moment). */
  | { readonly kind: 'cheatDeathRecharging' };

/** Statuses passives refer to (all implemented by combat). */
export type PassiveStatusId = StatusId;

/** Skill parameter vocabulary is shared with skill level effects and support modifiers (core/skills). */
export type { SkillParam, SkillParamChange } from '../skills/types';

/**
 * Mechanics that do not fit stat modifiers. Each kind is implemented by core in a later phase;
 * until then it is carried as data and ignored by the stat pipeline (see passiveMechanics()).
 */
export type PassiveMechanic =
  /** Skills cost life instead of the class resource (lifePerResource life per point); max resource is 0, resource stats and gains do nothing. */
  | { readonly kind: 'bloodMagic'; readonly lifePerResource: number }
  /** Every hit crits; the crit multiplier is fixed and multiplier bonuses are ignored. */
  | { readonly kind: 'alwaysCrit'; readonly critMultiplier: number }
  /** Base life (class + levels) becomes flat energy shield, max life is fixed, life regen goes to shield regen. */
  | { readonly kind: 'lifeToEnergyShield'; readonly maxLife: number; readonly lifeRegenToShield: boolean }
  /**
   * Every hit the hero deals restores `fraction` of its damage as life (instantly; the main recovery pool,
   * i.e. ES under lifeToEnergyShield). `maxPerSecond`: cap as a fraction of the pool's max per second
   * (a single burst restores at most one second's worth); omitted = uncapped. Several leeches add up.
   */
  | { readonly kind: 'lifeLeech'; readonly fraction: number; readonly maxPerSecond?: number }
  /**
   * Life potions restore `multiplier` × their normal amount (multipliers stack multiplicatively).
   * Consumed when potions are implemented (0.4); see lifePotionMultiplier().
   */
  | { readonly kind: 'lifePotionEffectiveness'; readonly multiplier: number }
  /** Stat modifiers active only while the condition holds. */
  | { readonly kind: 'conditionalModifiers'; readonly condition: PassiveCondition; readonly modifiers: readonly Modifier[] }
  /** More damage per fraction of missing life: more = min(max, missingLifeFraction × perMissingLife). */
  | { readonly kind: 'moreDamagePerMissingLife'; readonly perMissingLife: number; readonly max: number }
  /**
   * Changes skill parameters / adds effects: a SkillChangeSet (core/skills/types), resolved once per loadout.
   * Matches by skill id and/or by tags (all must be present); with neither, every action incl. the basic attack.
   */
  | {
      readonly kind: 'skillParams';
      readonly skillIds?: readonly string[];
      readonly tags?: readonly SkillTag[];
      readonly changes?: readonly SkillParamChange[];
      /** Extra modifiers granted by the skill's self buff. */
      readonly buffModifiers?: readonly Modifier[];
      /** Extra statuses applied on hit. */
      readonly addOnHit?: readonly (AddedStatus & { readonly status: PassiveStatusId })[];
      /** Duration changes for one on-hit status only (see SkillChangeSet.statusDurations). */
      readonly statusDurations?: NonNullable<SkillChangeSet['statusDurations']>;
      /** Damage conversion of the skill's hits (see SkillChangeSet.damageConversion); uniques (Heart of Winter). */
      readonly damageConversion?: NonNullable<SkillChangeSet['damageConversion']>;
      /** Class resource per enemy hit by the skill (see SkillChangeSet.resourcePerHit); uniques (Barrow Reaper). */
      readonly resourcePerHit?: number;
      /** Rules granted to the skill (SkillGrants); uniques: trap fan, burst, origin blast. */
      readonly grants?: SkillGrants;
      /** Fraction of current life paid per use (see SkillChangeSet.lifeCostFraction); uniques (Rift Ring). */
      readonly lifeCostFraction?: number;
    }
  /**
   * Hits fill the target's stun bar by baseFill + damage / maxLife × damageFill; full bar stuns and resets.
   * After decayDelay seconds without a hero hit on that mob the bar drains decayPerSecond (fraction of a full bar) per second.
   */
  | {
      readonly kind: 'stunBar';
      readonly baseFill: number;
      readonly damageFill: number;
      readonly stunDuration: number;
      readonly bossFillFactor: number;
      readonly bossStunDuration: number;
      readonly decayDelay: number;
      readonly decayPerSecond: number;
    }
  /** Increased stun bar fill and stun duration (all stuns). */
  | { readonly kind: 'stunBonus'; readonly fillIncreased: number; readonly durationIncreased: number }
  /** When hit in melee: retaliate with the basic attack at `effectiveness`, at most once per `cooldown` seconds. */
  | { readonly kind: 'counterAttack'; readonly effectiveness: number; readonly cooldown: number }
  /** Projectiles with these tags deal more damage by travelled distance: lerp 0 → maxMore over [minDistance, maxDistance]. */
  | { readonly kind: 'distanceDamage'; readonly tags: readonly SkillTag[]; readonly minDistance: number; readonly maxDistance: number; readonly maxMore: number }
  /** Trap skills get charges (each recharges over the cooldown), a cap on active traps and chain detonation. */
  | { readonly kind: 'trapCharges'; readonly charges: number; readonly maxActive: number; readonly chainDelay: number; readonly chainRadius: number }
  /** An armed trap slows enemies around it. */
  | { readonly kind: 'trapAura'; readonly radius: number; readonly slow: number }
  /**
   * Hits dealing `damageType` damage may ignite: damageFraction of the hit as fire over duration; strongest
   * ignite applies. Becomes an on-hit ignite status of every action (skillChangeSets), so delayed hits use the
   * cast-time snapshot. Chance / damage scale with the igniteChance / igniteDamage stats.
   */
  | { readonly kind: 'ignite'; readonly damageType: DamageType; readonly chance: number; readonly damageFraction: number; readonly duration: number }
  /** An enemy dying with `status` explodes (DeathExplosionDef). Explosion kills can chain; each mob explodes at most once. */
  | ({ readonly kind: 'deathExplosion'; readonly status: PassiveStatusId } & DeathExplosionDef)
  /** Increased radius of death explosions (all sources add up). */
  | { readonly kind: 'deathExplosionRadius'; readonly increased: number }
  /**
   * Hits from these skills freeze targets that were already slowed before the hit (duration scales with the
   * freezeDuration stat). Bosses get a strong slow for bossDuration instead (CombatConfig.bossFreezeSlow).
   */
  | { readonly kind: 'freezeSlowed'; readonly skillIds: readonly string[]; readonly duration: number; readonly bossDuration: number }
  /**
   * The hero's armour also reduces elemental hits, after resistance, as if it were `effectiveness` × the armour
   * (each elemental part of a hit separately, like physical). Several sources: the highest. Uniques (Iron Heart Oath).
   */
  | { readonly kind: 'elementalArmour'; readonly effectiveness: number }
  /**
   * A hero crit restores `fraction` of the max life recovery pool (ES under lifeToEnergyShield), at most once per
   * `interval` seconds (PlayerState.critHealCooldown). Several sources: fractions add up, the longest interval.
   * Uniques (Bloody Pupil).
   */
  | { readonly kind: 'lifeOnCrit'; readonly fraction: number; readonly interval: number }
  /**
   * Using one of `skillIds` makes the hero's next attack use (an action with the 'attack' tag) a guaranteed crit with
   * every hit of that use (PlayerState.nextAttackCrit); no time limit, consumed by that use. Uniques (Shadow Boots).
   */
  | { readonly kind: 'critAfterSkill'; readonly skillIds: readonly string[] }
  /**
   * Souls (Devourer's Crown): every non-minion mob death, whatever killed it, gives the hero a soul (PlayerState.souls,
   * 0 at run start, capped at `max`). At `max`, the next use of an action that fits `echoFor` (the rules of a support's
   * compatibility, checked against the effective action) is repeated once for free `echoDelay` seconds later (a
   * guaranteed echo, see updateEchoes; it replaces that use's Echo support roll). The souls are spent (back to 0) when
   * that echo fires, so the use and its echo both hit while the souls are held. Several sources: the first one counts.
   */
  | { readonly kind: 'souls'; readonly max: number; readonly echoDelay: number; readonly echoFor: SupportCompatibility }
  /**
   * Cheat death (Clock of the Last Moment): a hit or damage over time that would kill the hero (life + ES pool at 0)
   * leaves them at `life` instead (capped at max life; ES stays as the hit left it, i.e. empty), clears the hero's
   * ignite and stops time for the enemies for `stopDuration` seconds (WorldState.timeStop: mobs, mob projectiles,
   * hostile zones and wave spawns freeze; the hero acts normally). Then it recharges for `cooldown` seconds of world
   * time (PlayerState.cheatDeathCooldown; not shortened by cooldown recovery); ready at the start of every run.
   * Several sources: the first one counts. See cheatDeath.ts.
   */
  | { readonly kind: 'cheatDeath'; readonly life: number; readonly stopDuration: number; readonly cooldown: number };

export type PassiveMechanicKind = PassiveMechanic['kind'];

export interface PassiveNodeDef {
  /** Also the key of its display name in the locale files (render); start nodes are named after their class. */
  readonly id: string;
  readonly type: PassiveNodeType;
  /** Passive points for wheel nodes, spec points for spec nodes, 0 for starts. */
  readonly cost: number;
  readonly pos: PassiveNodePos;
  /** Start nodes: the class that starts here. */
  readonly classId?: string;
  /** Spec nodes: the branch they belong to. */
  readonly specId?: string;
  readonly modifiers?: readonly Modifier[];
  readonly mechanics?: readonly PassiveMechanic[];
  /** At most one node of a group can be allocated (e.g. Blood Magic vs Crystal Shell). */
  readonly exclusiveGroup?: string;
}

export interface SpecBranchDef {
  /** Also the key of its display name in the locale files (render). */
  readonly id: string;
  readonly classId: string;
}

/** cost = floor(base + level × perLevel). */
export interface RespecCost {
  readonly base: number;
  readonly perLevel: number;
}

export interface RespecRules {
  /** Currency id in profile.currency. */
  readonly currency: string;
  /** Every respec action is free while the hero level is below this. */
  readonly freeBelowLevel: number;
  /** Refund one node. */
  readonly node: RespecCost;
  /** Refund all wheel nodes. */
  readonly wheel: RespecCost;
  /** Drop the specialization and all spec nodes. */
  readonly spec: RespecCost;
}

export interface PassiveTreeData {
  readonly nodes: Readonly<Record<string, PassiveNodeDef>>;
  /** Undirected connections. */
  readonly edges: readonly (readonly [string, string])[];
  readonly specs: Readonly<Record<string, SpecBranchDef>>;
  readonly points: {
    /** Passive points per level above 1. */
    readonly perLevel: number;
    /** One spec point at each of these hero levels. */
    readonly specMilestones: readonly number[];
  };
  readonly respec: RespecRules;
}

/** A hero's allocation. Saved with the character. */
export interface PassiveAllocation {
  /** Allocated wheel nodes, in allocation order. */
  nodes: string[];
  /** Chosen specialization; set by the first spec node, cleared only by a spec change. */
  spec: string | null;
  /** Allocated spec branch nodes, in allocation order. */
  specNodes: string[];
}

/** What the passive rules need to know about the hero. CharacterRecord satisfies it. */
export interface PassiveHero {
  readonly classId: string;
  readonly level: number;
  passives: PassiveAllocation;
}

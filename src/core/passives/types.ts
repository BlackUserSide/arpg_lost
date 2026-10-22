// Passive tree schema (docs/design/passives.md, docs/design/passives-wheel.md).
// Plain data: the tree lives in src/data/passives.ts, the hero's allocation is saved JSON.

import type { StatusId } from '../world/content';
import type { DamageType, Modifier, SkillTag } from '../stats/types';

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
  | { readonly kind: 'targetHasStatus'; readonly status: PassiveStatusId };

/** Statuses passives refer to; `ignite` and `freeze` do not exist in combat yet. */
export type PassiveStatusId = StatusId | 'ignite' | 'freeze';

/** Skill parameters a passive can change. Implemented in a later phase. */
export type SkillParam =
  | 'cooldown'
  | 'buffDuration'
  | 'radius'
  | 'explodeRadius'
  | 'pierce'
  | 'range'
  | 'projectileSpeed'
  | 'armTime'
  | 'triggerRadius'
  | 'statusDuration';

/** `add` is an absolute delta, `increased` a fraction of the base value (0.25 = +25%). */
export interface SkillParamChange {
  readonly param: SkillParam;
  readonly add?: number;
  readonly increased?: number;
}

/**
 * Mechanics that do not fit stat modifiers. Each kind is implemented by core in a later phase;
 * until then it is carried as data and ignored by the stat pipeline (see passiveMechanics()).
 */
export type PassiveMechanic =
  /** Skills cost life instead of mana; max mana is 0 and mana stats do nothing. */
  | { readonly kind: 'bloodMagic'; readonly lifePerMana: number }
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
  /** Changes skill parameters / adds effects. Matches by skill id and/or by tags (all must be present). */
  | {
      readonly kind: 'skillParams';
      readonly skillIds?: readonly string[];
      readonly tags?: readonly SkillTag[];
      readonly changes?: readonly SkillParamChange[];
      /** Extra modifiers granted by the skill's self buff. */
      readonly buffModifiers?: readonly Modifier[];
      /** Extra statuses applied on hit. */
      readonly addOnHit?: readonly { readonly status: PassiveStatusId; readonly duration: number; readonly magnitude?: number }[];
    }
  /** Hits fill the target's stun bar by baseFill + damage / maxLife × damageFill; full bar stuns and resets. */
  | {
      readonly kind: 'stunBar';
      readonly baseFill: number;
      readonly damageFill: number;
      readonly stunDuration: number;
      readonly bossFillFactor: number;
      readonly bossStunDuration: number;
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
  /** Hits dealing `damageType` damage may ignite: damageFraction of the hit as fire over duration; strongest ignite applies. */
  | { readonly kind: 'ignite'; readonly damageType: DamageType; readonly chance: number; readonly damageFraction: number; readonly duration: number }
  /** Adds to ignite chance (absolute) and ignite damage (increased). */
  | { readonly kind: 'igniteBonus'; readonly chance: number; readonly damageIncreased: number }
  /** An enemy dying with `status` explodes for lifeFraction of its max life as `damageType` damage. */
  | {
      readonly kind: 'deathExplosion';
      readonly status: PassiveStatusId;
      readonly radius: number;
      readonly lifeFraction: number;
      readonly damageType: DamageType;
      readonly applyStatus?: PassiveStatusId;
    }
  /** Increased radius of death explosions. */
  | { readonly kind: 'deathExplosionRadius'; readonly increased: number }
  /** Hits from these skills freeze targets that are already slowed. */
  | { readonly kind: 'freezeSlowed'; readonly skillIds: readonly string[]; readonly duration: number; readonly bossDuration: number }
  /** Increased freeze duration. */
  | { readonly kind: 'freezeDuration'; readonly increased: number };

export type PassiveMechanicKind = PassiveMechanic['kind'];

export interface PassiveNodeDef {
  readonly id: string;
  /** Display name (Ukrainian, from the design doc). */
  readonly name: string;
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
  readonly id: string;
  readonly name: string;
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

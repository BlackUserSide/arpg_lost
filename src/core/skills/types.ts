// Skill parameter changes: one vocabulary for every source that alters a skill's definition
// (passive tree nodes, skill levels and their level-3 effects; support modifiers later, docs/design/skill-modifiers.md).

import type { DamageType, Modifier, SkillTag } from '../stats/types';
import type { ArcEveryNth, DashLanding, Delivery, GroundZoneDef, ProjectileSplit, SelfEffect, StatusId, TrapAura, TrapChain } from '../world/content';

/**
 * Skill parameters a change can target. Each maps onto fields of the action definition
 * (see SKILL_PARAM_TARGETS in params.ts); a param the action does not have is ignored.
 */
export type SkillParam =
  | 'cooldown'
  | 'charges'
  | 'buffDuration'
  | 'radius'
  | 'explodeRadius'
  | 'pierce'
  | 'range'
  | 'projectileSpeed'
  | 'armTime'
  | 'triggerRadius'
  | 'statusDuration';

/**
 * `add` is an absolute delta, `increased` a fraction of the base value (0.25 = +25%, −0.2 = 20% reduced).
 * All changes to one param from all sources combine like stats: (base + Σadd) × (1 + Σincreased), floored at 0.
 */
export interface SkillParamChange {
  readonly param: SkillParam;
  readonly add?: number;
  readonly increased?: number;
}

/**
 * A status added to a skill's hits; fields as in StatusEffect (core/world/content). `status` may name statuses
 * combat does not have; those are skipped.
 */
export interface AddedStatus {
  readonly status: string;
  readonly duration: number;
  readonly magnitude?: number;
  /** Omit for a guaranteed status. */
  readonly chance?: number;
  /** Only if the target already had this status before the hit. */
  readonly requiresStatus?: StatusId;
  /** Only if the hit dealt damage of this type. */
  readonly requiresDamageType?: DamageType;
  /** Freeze on a boss: duration of the replacing slow. */
  readonly bossDuration?: number;
}

/**
 * Rules a change set grants to its skills (absolute values, not deltas). Applied before param changes, so e.g. a
 * later `charges` +1 change adds to granted charges. Several sources: charges take the highest, maxActiveTraps the
 * lowest (the strictest cap), every other rule the first source; a rule the action already has in its data wins.
 * Delivery rules are ignored on other deliveries (trap rules on non-traps, everyNth on non-arcs, ...).
 */
export interface SkillGrants {
  readonly charges?: number;
  /** Cap on the hero's active traps (all trap sources count), see the trap Delivery. */
  readonly maxActiveTraps?: number;
  readonly trapChain?: TrapChain;
  readonly trapAura?: TrapAura;
  /** Arc actions: every N-th use swings a different angle (Cleave level 3: a 360° circle). */
  readonly everyNth?: ArcEveryNth;
  /** Dash actions: an area hit where the dash ends (Shield Charge level 3). Its radius follows the `radius` param. */
  readonly dashLanding?: DashLanding;
  /** Projectile actions: split into child projectiles where it explodes (Fireball level 3). */
  readonly projectileSplit?: ProjectileSplit;
  /** Any action with an area: leaves a ground zone (Explosive Trap / Frost Nova level 3). */
  readonly groundZone?: GroundZoneDef;
}

/**
 * One source of skill changes. Applies to an action if its id is in `skillIds` (when given), the action has all
 * of `tags` (when given) and its delivery kind is in `deliveries` (when given); with none of them it applies to
 * every action, basic attack included.
 */
export interface SkillChangeSet {
  readonly skillIds?: readonly string[];
  readonly tags?: readonly SkillTag[];
  /** Delivery kinds the set applies to (e.g. ['trap'] for "trap skills", which have no tag of their own). */
  readonly deliveries?: readonly Delivery['kind'][];
  readonly grants?: SkillGrants;
  readonly changes?: readonly SkillParamChange[];
  /**
   * Stat modifiers of the skill itself: they apply only to the matching action's own uses and hits (damage, crit,
   * attack / cast speed, on-hit status stats), on top of the hero's modifiers; their tags still have to match the
   * action. Skill levels use them for "+N% more damage per level"; supports will too.
   */
  readonly modifiers?: readonly Modifier[];
  /** Extra modifiers granted by every buff the skill applies to its user. */
  readonly buffModifiers?: readonly Modifier[];
  /** Extra self effects the skill applies when used (e.g. a decoy: Roll level 3). Not scaled by buffDuration. */
  readonly addSelfEffects?: readonly SelfEffect[];
  /** Extra statuses applied on hit. */
  readonly addOnHit?: readonly AddedStatus[];
  /**
   * Duration changes for one on-hit status only (e.g. stunBonus: "+30% stun duration"). Summed with the
   * `statusDuration` param for that status: (base + Σadd) × (1 + Σincreased), all sources in one sum.
   */
  readonly statusDurations?: readonly { readonly status: string; readonly add?: number; readonly increased?: number }[];
}

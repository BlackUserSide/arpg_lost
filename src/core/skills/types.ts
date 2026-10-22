// Skill parameter changes: one vocabulary for every source that alters a skill's definition
// (passive tree nodes now; skill level-3 effects and support modifiers later, docs/design/skill-modifiers.md).

import type { DamageType, Modifier, SkillTag } from '../stats/types';
import type { StatusId } from '../world/content';

/**
 * Skill parameters a change can target. Each maps onto fields of the action definition
 * (see SKILL_PARAM_TARGETS in params.ts); a param the action does not have is ignored.
 */
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
 * One source of skill changes. Applies to an action if its id is in `skillIds` (when given) and the action
 * has all of `tags` (when given); with neither it applies to every action, basic attack included.
 */
export interface SkillChangeSet {
  readonly skillIds?: readonly string[];
  readonly tags?: readonly SkillTag[];
  readonly changes?: readonly SkillParamChange[];
  /** Extra modifiers granted by every buff the skill applies to its user. */
  readonly buffModifiers?: readonly Modifier[];
  /** Extra statuses applied on hit. */
  readonly addOnHit?: readonly AddedStatus[];
  /**
   * Duration changes for one on-hit status only (e.g. stunBonus: "+30% stun duration"). Summed with the
   * `statusDuration` param for that status: (base + Σadd) × (1 + Σincreased), all sources in one sum.
   */
  readonly statusDurations?: readonly { readonly status: string; readonly add?: number; readonly increased?: number }[];
}

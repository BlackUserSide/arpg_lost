// Which passive mechanic kinds the simulation actually runs. Nodes with pending mechanics can be
// allocated (their stat modifiers apply), but the mechanic itself does nothing yet; the tree screen
// marks them "Ефект ще в розробці". Remove a kind from this list when core implements it.
// Implemented kinds live in src/core/world/passiveEffects.ts.

import type { PassiveCondition, PassiveMechanic, PassiveMechanicKind, PassiveNodeDef, PassiveStatusId } from './types';

export const PENDING_MECHANICS: ReadonlySet<PassiveMechanicKind> = new Set<PassiveMechanicKind>([
  'moreDamagePerMissingLife',
  'skillParams',
  'stunBar',
  'stunBonus',
  'counterAttack',
  'distanceDamage',
  'trapCharges',
  'trapAura',
  'ignite',
  'igniteBonus',
  'deathExplosion',
  'deathExplosionRadius',
  'freezeSlowed',
  'freezeDuration',
]);

/** Statuses combat does not have yet: `targetHasStatus` conditions on them never hold. */
export const PENDING_STATUSES: ReadonlySet<PassiveStatusId> = new Set<PassiveStatusId>(['ignite', 'freeze']);

export function isConditionPending(condition: PassiveCondition): boolean {
  return condition.kind === 'targetHasStatus' && PENDING_STATUSES.has(condition.status);
}

export function isMechanicPending(mechanic: PassiveMechanic): boolean {
  if (mechanic.kind === 'conditionalModifiers') return isConditionPending(mechanic.condition);
  return PENDING_MECHANICS.has(mechanic.kind);
}

/** True if any of the node's mechanics is not implemented yet. */
export function hasPendingMechanics(node: PassiveNodeDef): boolean {
  return (node.mechanics ?? []).some(isMechanicPending);
}

// Which passive mechanic kinds the simulation actually runs. Nodes with pending mechanics can be
// allocated (their stat modifiers apply), but the mechanic itself does nothing yet; the tree screen
// marks them "Ефект ще в розробці". Remove a kind from this list when core implements it.
// Implemented kinds live in src/core/world/passiveEffects.ts.

import type { PassiveCondition, PassiveMechanic, PassiveMechanicKind, PassiveNodeDef } from './types';

export const PENDING_MECHANICS: ReadonlySet<PassiveMechanicKind> = new Set<PassiveMechanicKind>([
  // Also the consumer of stunBonus.fillIncreased (stunBonus itself is live: its duration part applies to all stuns).
  'stunBar',
  'counterAttack',
  'distanceDamage',
  'trapCharges',
  'trapAura',
]);

/** True if a condition refers to something combat does not have yet. Every status exists now, so always false. */
export function isConditionPending(condition: PassiveCondition): boolean {
  void condition;
  return false;
}

export function isMechanicPending(mechanic: PassiveMechanic): boolean {
  if (mechanic.kind === 'conditionalModifiers') return isConditionPending(mechanic.condition);
  return PENDING_MECHANICS.has(mechanic.kind);
}

/** True if any of the node's mechanics is not implemented yet. */
export function hasPendingMechanics(node: PassiveNodeDef): boolean {
  return (node.mechanics ?? []).some(isMechanicPending);
}

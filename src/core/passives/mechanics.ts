// Which passive mechanic kinds the simulation actually runs. Nodes with pending mechanics can be
// allocated (their stat modifiers apply), but the mechanic itself does nothing yet; the tree screen
// marks them "Ефект ще в розробці". Remove a kind from this list when core implements it.

import type { PassiveMechanic, PassiveMechanicKind, PassiveNodeDef } from './types';

export const PENDING_MECHANICS: ReadonlySet<PassiveMechanicKind> = new Set<PassiveMechanicKind>([
  'bloodMagic',
  'alwaysCrit',
  'lifeToEnergyShield',
  'conditionalModifiers',
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

export function isMechanicPending(mechanic: PassiveMechanic): boolean {
  return PENDING_MECHANICS.has(mechanic.kind);
}

/** True if any of the node's mechanics is not implemented yet. */
export function hasPendingMechanics(node: PassiveNodeDef): boolean {
  return (node.mechanics ?? []).some(isMechanicPending);
}

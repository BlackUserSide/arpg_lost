import type { CombatConfig } from '../core/combat/config';

// See docs/design/combat.md.
export const combatConfig: CombatConfig = {
  resistanceCap: 0.75,
  critMultiplierBase: 1.5,
  armourK: 5,
  // PROPOSAL: cap not specified in design yet.
  armourMaxReduction: 0.9,
};

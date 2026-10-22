import type { CombatConfig } from '../core/combat/config';

// See docs/design/combat.md.
export const combatConfig: CombatConfig = {
  resistanceCap: 0.75,
  critMultiplierBase: 1.5,
  armourK: 5,
  // PROPOSAL: cap not specified in design yet.
  armourMaxReduction: 0.9,
  // Bosses are not frozen; a freeze becomes this slow for the boss freeze duration (designer decision 2026-10-22).
  bossFreezeSlow: 0.5,
  // PROPOSAL: bosses are not stunned by ordinary stuns; a stun becomes this slow for the stun's duration
  // ("сильне сповільнення", magnitude not specified; same as the freeze-slow).
  bossStunSlow: 0.5,
};

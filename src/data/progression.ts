import type { ProgressionRules } from '../core/progression/levels';

// See docs/design/progression.md. All numbers are PROPOSAL until balance pass.
// Pace target: level 2 after ~60 kills, ~10 after an hour (~15 runs), 40 after tens of hours.
export const progression: ProgressionRules = {
  maxLevel: 40,
  xpCurve: { base: 180, exponent: 1.2 },
  mobXpGrowth: 0.15,
  lowAreaPenalty: { startDiff: 2, multipliers: [0.8, 0.6, 0.4, 0.2], floor: 0.1 },
  mapClearBonus: 0.07,
  // No +resource per level (PROPOSAL): the resource sets each class's rhythm, and a flat +1/level stretched Energy
  // bursts by +48% at level 20 but Mana by +19% and only the Rage bank. Resource growth comes from gear and passives.
  perLevel: { life: 4 },
};

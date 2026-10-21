import type { ProgressionRules } from '../core/progression/levels';

// See docs/design/progression.md. All numbers are PROPOSAL until balance pass.
// Pace target: level 2 after ~60 kills, ~10 after an hour (~15 runs), 40 after tens of hours.
export const progression: ProgressionRules = {
  maxLevel: 40,
  xpCurve: { base: 180, exponent: 1.2 },
  mobXpGrowth: 0.15,
  lowAreaPenalty: { startDiff: 2, multipliers: [0.8, 0.6, 0.4, 0.2], floor: 0.1 },
  mapClearBonus: 0.07,
  perLevel: { life: 4, mana: 1 },
};

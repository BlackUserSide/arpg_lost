import type { LifePotionDef } from '../core/world/content';

// Life potion (docs/design/combat.md, decision 2026-10-26). PROPOSAL numbers: balance-analyst to tune.
export const lifePotion: LifePotionDef = {
  // ~40% of max life (ES under Crystal Shell) over 1 s; Bloodsucker halves it (passives data).
  healFraction: 0.4,
  duration: 1,
  // 3 charges, a run starts full.
  maxCharges: 3,
  // A charge per ~15 kills; elites and bosses count more (minions give nothing).
  pointsPerCharge: 15,
  killPoints: { normal: 1, elite: 5, boss: 15 },
};

// Mob growth with the map level (docs/design/mobs.md, decision 2026-10-25: "noticeably harder"). Pure functions over
// data (RunRules.mobScaling), so sims (tools/sim) can call them without a run.

import type { MobScale } from '../world/state';
import type { LevelCurve, RunRules } from './types';

/** A curve's multiplier at `level` (levels below 1 count as 1): (1 + linear × (L − 1)) × (1 + compound)^(L − 1). */
export function levelCurveMultiplier(curve: LevelCurve, level: number): number {
  const steps = Math.max(0, level - 1);
  return (1 + curve.linear * steps) * Math.pow(1 + curve.compound, steps);
}

/** Life, damage and armour multipliers of every mob on map `mapLevel` (× 1 on map 1). */
export function mobLevelScaling(rules: Pick<RunRules, 'mobScaling'>, mapLevel: number): MobScale {
  return {
    life: levelCurveMultiplier(rules.mobScaling.life, mapLevel),
    damage: levelCurveMultiplier(rules.mobScaling.damage, mapLevel),
    armour: levelCurveMultiplier(rules.mobScaling.armour, mapLevel),
  };
}

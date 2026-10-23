// Support drops (docs/design/skill-modifiers.md «Випадіння»): rare from every mob, more often from elites and
// bosses; the tier depends on the area (map) level like affix tiers on item level. Pure, seeded RNG only.

import { weightedPick } from '../items/generate';
import type { Rng } from '../rng';
import type { SupportData, SupportRef } from './types';

export type MobRank = 'normal' | 'elite' | 'boss';

/** Tiers (1-based) that can drop at this area level (SupportRules.tierMinLevel). */
export function availableSupportTiers(data: SupportData, areaLevel: number): number[] {
  const tiers: number[] = [];
  data.rules.tierMinLevel.forEach((min, i) => {
    if (min <= areaLevel) tiers.push(i + 1);
  });
  return tiers;
}

/**
 * Rolls a support for a fixed drop (no chance roll): a def by weight among supports with at least that many
 * tiers available, then a tier by SupportRules.tierWeights among the tiers the area level allows (capped by the
 * def's tier count). Draw order: def, tier. Undefined when nothing can drop.
 */
export function rollSupport(rng: Rng, data: SupportData, areaLevel: number): SupportRef | undefined {
  const tiers = availableSupportTiers(data, areaLevel);
  if (tiers.length === 0) return undefined;
  const defs = Object.values(data.supports).filter((d) => d.tiers.length > 0 && d.weight > 0);
  const def = weightedPick(rng, defs, (d) => d.weight);
  if (!def) return undefined;
  const allowed = tiers.filter((t) => t <= def.tiers.length);
  const tier = weightedPick(rng, allowed, (t) => data.rules.tierWeights[t - 1] ?? 0) ?? allowed[0];
  return tier === undefined ? undefined : { defId: def.id, tier };
}

/**
 * A kill's support drop: one chance roll by mob rank (SupportRules.dropChance), then rollSupport. Always consumes
 * the chance draw; the support draws only on a drop.
 */
export function rollSupportDrop(rng: Rng, data: SupportData, rank: MobRank, areaLevel: number): SupportRef | undefined {
  if (!rng.chance(data.rules.dropChance[rank])) return undefined;
  return rollSupport(rng, data, areaLevel);
}

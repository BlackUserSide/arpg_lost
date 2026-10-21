import type { Modifier, StatId, Tag } from './types';

export interface ModifierTotals {
  flat: number;
  /** Sum of increased fractions. */
  increased: number;
  /** Product of (1 + more) factors. */
  more: number;
}

export function matchesTags(mod: Modifier, context: ReadonlySet<Tag>): boolean {
  return (mod.tags ?? []).every((tag) => context.has(tag));
}

export function collectModifiers(mods: readonly Modifier[], stat: StatId, context: ReadonlySet<Tag>): ModifierTotals {
  const totals: ModifierTotals = { flat: 0, increased: 0, more: 1 };
  for (const mod of mods) {
    if (mod.stat !== stat || !matchesTags(mod, context)) continue;
    switch (mod.kind) {
      case 'flat':
        totals.flat += mod.value;
        break;
      case 'increased':
        totals.increased += mod.value;
        break;
      case 'more':
        totals.more *= Math.max(0, 1 + mod.value);
        break;
    }
  }
  return totals;
}

/** (base + flat) * (1 + Σincreased) * Π(1 + more). Multipliers never go below zero. */
export function applyTotals(base: number, totals: ModifierTotals): number {
  return (base + totals.flat) * Math.max(0, 1 + totals.increased) * totals.more;
}

export function computeStat(
  base: number,
  mods: readonly Modifier[],
  stat: StatId,
  context: Iterable<Tag> = [],
): number {
  return applyTotals(base, collectModifiers(mods, stat, new Set(context)));
}

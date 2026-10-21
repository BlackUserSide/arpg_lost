// Hero experience and levels (docs/design/progression.md). Pure functions over data-driven rules.

import type { Modifier, StatId } from '../stats/types';

export interface ProgressionRules {
  readonly maxLevel: number;
  /** XP to go from level L to L+1: round(base × L^exponent × (1 + mobXpGrowth × (L − 1))). */
  readonly xpCurve: { readonly base: number; readonly exponent: number };
  /** Mob XP grows with area level by this fraction per level above 1; the curve grows with it. */
  readonly mobXpGrowth: number;
  /** Area this many levels (or more) below the hero gives reduced XP. */
  readonly lowAreaPenalty: {
    readonly startDiff: number;
    /** XP multipliers for diff = startDiff, startDiff + 1, ... */
    readonly multipliers: readonly number[];
    /** Multiplier for any larger diff. */
    readonly floor: number;
  };
  /** Bonus for closing a map, as a fraction of the XP earned during the run. */
  readonly mapClearBonus: number;
  /** Flat stats gained per level above 1. */
  readonly perLevel: Readonly<Partial<Record<StatId, number>>>;
}

export interface HeroProgress {
  level: number;
  /** XP towards the next level. */
  xp: number;
}

export function xpToNextLevel(level: number, rules: ProgressionRules): number {
  if (level >= rules.maxLevel) return Infinity;
  const { base, exponent } = rules.xpCurve;
  return Math.round(base * level ** exponent * (1 + rules.mobXpGrowth * (level - 1)));
}

/** XP a mob with the given base XP gives in an area of this level. */
export function mobXp(baseXp: number, areaLevel: number, rules: ProgressionRules): number {
  return baseXp * (1 + rules.mobXpGrowth * (Math.max(1, areaLevel) - 1));
}

/** Multiplier for XP earned in an area below the hero's level. */
export function areaXpMultiplier(heroLevel: number, areaLevel: number, rules: ProgressionRules): number {
  const { startDiff, multipliers, floor } = rules.lowAreaPenalty;
  const diff = heroLevel - areaLevel;
  if (diff < startDiff) return 1;
  return multipliers[diff - startDiff] ?? floor;
}

export function mapClearBonusXp(runXp: number, rules: ProgressionRules): number {
  return runXp * rules.mapClearBonus;
}

/** Adds XP, levelling up as many times as it covers. XP stops at max level. Returns levels gained. */
export function grantXp(progress: HeroProgress, amount: number, rules: ProgressionRules): number {
  let gained = 0;
  if (progress.level >= rules.maxLevel) return 0;
  progress.xp += amount;
  while (progress.level < rules.maxLevel && progress.xp >= xpToNextLevel(progress.level, rules)) {
    progress.xp -= xpToNextLevel(progress.level, rules);
    progress.level++;
    gained++;
  }
  // DESIGN-TBD: XP past max level goes to the endgame; until then it is not kept.
  if (progress.level >= rules.maxLevel) progress.xp = 0;
  return gained;
}

/** Stats granted by the hero's level, as flat modifiers. */
export function levelModifiers(level: number, rules: ProgressionRules): Modifier[] {
  const levels = Math.max(0, level - 1);
  if (levels === 0) return [];
  return Object.entries(rules.perLevel).map(([stat, value]) => ({ stat: stat as StatId, kind: 'flat' as const, value: value * levels }));
}

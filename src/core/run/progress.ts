// Per-hero map ladder (docs/design/maps.md, decisions 2026-10-23): maps 1, 2, 3… in order; beating the boss of
// map N unlocks N + 1 (up to RunRules.maxLinearMap); any unlocked map can be replayed. Pure functions.

import type { CharacterRecord } from '../progression/profile';

type MapHero = Pick<CharacterRecord, 'maps'>;

/** Highest map the hero may enter (at least 1). */
export function unlockedMap(hero: MapHero): number {
  return Math.max(1, Math.floor(hero.maps.unlocked));
}

/** Every map the hero may enter, lowest first (hub list; the "To the dungeon" button takes the last). */
export function availableMaps(hero: MapHero): number[] {
  return Array.from({ length: unlockedMap(hero) }, (_, i) => i + 1);
}

export function canEnterMap(hero: MapHero, mapLevel: number): boolean {
  return Number.isInteger(mapLevel) && mapLevel >= 1 && mapLevel <= unlockedMap(hero);
}

/**
 * Records a won run on `mapLevel`: beating the highest unlocked map unlocks the next one, capped at `maxLinearMap`.
 * Replaying a lower map changes nothing. Returns the newly unlocked map, or null.
 */
export function unlockNextMap(hero: MapHero, mapLevel: number, maxLinearMap: number): number | null {
  const current = unlockedMap(hero);
  if (mapLevel < current || current >= maxLinearMap) return null;
  hero.maps.unlocked = Math.min(maxLinearMap, Math.floor(mapLevel) + 1);
  return hero.maps.unlocked > current ? hero.maps.unlocked : null;
}

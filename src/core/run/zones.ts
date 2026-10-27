// Map zones (docs/design/maps.md «Зони»): which band of map levels a map belongs to. Pure lookup over data.

import type { MapZone } from './types';

/**
 * The zone of map `mapLevel` (floored). A level below the first zone gets the first one, a level past the last zone
 * (maps beyond the linear ladder) keeps the last one; no zones: undefined.
 */
export function zoneAt(zones: readonly MapZone[], mapLevel: number): MapZone | undefined {
  const level = Math.floor(mapLevel);
  let first: MapZone | undefined;
  let last: MapZone | undefined;
  for (const z of zones) {
    if (level >= z.from && level <= z.to) return z;
    if (!first || z.from < first.from) first = z;
    if (!last || z.to > last.to) last = z;
  }
  if (!first || !last) return undefined;
  return level < first.from ? first : last;
}

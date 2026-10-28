import { zoneAt } from '../core/run/zones';
import { DEFAULT_ENVIRONMENT, environments, type EnvironmentLook } from '../data/environments';
import { mapsData } from '../data/maps';

// The look of a map: its zone (data/maps.ts zones, core zoneAt) picks an environment (data/environments.ts).

/** Environment of map `mapLevel`; the default one when the map has no zone or names an unknown environment. */
export function environmentAt(mapLevel: number): EnvironmentLook {
  const id = zoneAt(mapsData.zones ?? [], mapLevel)?.environment ?? DEFAULT_ENVIRONMENT;
  return environments[id] ?? environments[DEFAULT_ENVIRONMENT]!;
}

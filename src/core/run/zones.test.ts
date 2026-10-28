import { describe, expect, it } from 'vitest';
import type { MapZone } from './types';
import { zoneAt } from './zones';

const zones: MapZone[] = [
  { from: 1, to: 3, environment: 'light' },
  { from: 4, to: 6, environment: 'dark' },
  { from: 7, to: 9, environment: 'light' },
];

describe('zoneAt', () => {
  it('finds the zone holding the level, bounds inclusive', () => {
    expect(zoneAt(zones, 1)).toBe(zones[0]);
    expect(zoneAt(zones, 3)).toBe(zones[0]);
    expect(zoneAt(zones, 4)).toBe(zones[1]);
    expect(zoneAt(zones, 6)).toBe(zones[1]);
    expect(zoneAt(zones, 7)).toBe(zones[2]);
  });

  it('floors fractional levels', () => {
    expect(zoneAt(zones, 3.9)).toBe(zones[0]);
  });

  it('clamps levels outside every zone to the nearest end', () => {
    expect(zoneAt(zones, 0)).toBe(zones[0]);
    expect(zoneAt(zones, 10)).toBe(zones[2]);
    expect(zoneAt(zones, 99)).toBe(zones[2]);
  });

  it('no zones: undefined', () => {
    expect(zoneAt([], 5)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { fanOffsets } from './math';

/** Radians → degrees, rounded to 1e-9 (float noise of the conversion). */
const deg = (a: number): number => Math.round(((a * 180) / Math.PI) * 1e9) / 1e9;

describe('fanOffsets', () => {
  it('spreads count directions evenly over the spread, centred on 0', () => {
    const five = fanOffsets(5, 60);
    expect(five.map(deg)).toEqual([-30, -15, 0, 15, 30]);
    // The middle one is exactly straight ahead; the ends exactly ±spread / 2.
    expect(five[2]).toBe(0);
    expect(five[0]).toBe(-Math.PI / 6);
    expect(fanOffsets(2, 90)).toEqual([-Math.PI / 4, Math.PI / 4]);
  });

  it('one direction points straight ahead whatever the spread; none gives an empty fan', () => {
    expect(fanOffsets(1, 60)).toEqual([0]);
    expect(fanOffsets(0, 60)).toEqual([]);
  });
});

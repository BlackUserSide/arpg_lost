import { describe, expect, it } from 'vitest';
import { vec } from '../core/math';
import { directionRow, toScreen, toWorld } from './iso';

describe('iso projection', () => {
  it('round-trips world -> screen -> world', () => {
    for (const p of [vec(0, 0), vec(100, 0), vec(37, 512), vec(-20, 80)]) {
      const back = toWorld(toScreen(p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('screen up maps to world (-1, -1) direction', () => {
    const w = toWorld(vec(0, -1));
    expect(w.x).toBeLessThan(0);
    expect(w.x).toBeCloseTo(w.y, 9);
  });

  it('picks Flare sheet rows by screen direction', () => {
    expect(directionRow(toWorld(vec(-1, 0)))).toBe(0); // W
    expect(directionRow(toWorld(vec(0, -1)))).toBe(2); // N
    expect(directionRow(toWorld(vec(1, 0)))).toBe(4); // E
    expect(directionRow(toWorld(vec(0, 1)))).toBe(6); // S
    expect(directionRow(toWorld(vec(-1, 1)))).toBe(7); // SW
  });
});

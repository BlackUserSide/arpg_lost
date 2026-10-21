import { describe, expect, it } from 'vitest';
import { vec } from '../core/math';
import { directionRow, stickyDirectionRow, toScreen, toWorld } from './iso';

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

  it('keeps the current row near an octant edge, switches when clearly past it', () => {
    const at = (deg: number): ReturnType<typeof vec> => toWorld(vec(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)));
    // E row (4) is centred at 0°, SE row (5) at 45°; the edge is 22.5°.
    expect(directionRow(at(25))).toBe(5);
    expect(stickyDirectionRow(at(25), 4)).toBe(4);
    expect(stickyDirectionRow(at(35), 4)).toBe(5);
    expect(stickyDirectionRow(at(-25), 4)).toBe(4);
    expect(stickyDirectionRow(at(25), -1)).toBe(5);
  });
});

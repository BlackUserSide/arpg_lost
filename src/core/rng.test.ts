import { describe, expect, it } from 'vitest';
import { createRng } from './rng';

describe('rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('resumes from saved state', () => {
    const a = createRng(7);
    a.next();
    a.next();
    const resumed = createRng(a.getState());
    expect(resumed.next()).toBe(a.next());
  });

  it('keeps values in range', () => {
    const rng = createRng(123);
    for (let i = 0; i < 10_000; i++) {
      const f = rng.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = rng.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
      const r = rng.range(-2, 2);
      expect(r).toBeGreaterThanOrEqual(-2);
      expect(r).toBeLessThan(2);
    }
  });

  it('int covers the whole inclusive range roughly uniformly', () => {
    const rng = createRng(99);
    const counts = [0, 0, 0];
    const n = 30_000;
    for (let i = 0; i < n; i++) counts[rng.int(0, 2)]!++;
    for (const c of counts) expect(Math.abs(c / n - 1 / 3)).toBeLessThan(0.02);
  });

  it('chance respects edge probabilities', () => {
    const rng = createRng(5);
    for (let i = 0; i < 1000; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });
});

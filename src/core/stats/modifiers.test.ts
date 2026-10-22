import { describe, expect, it } from 'vitest';
import { computeStat } from './modifiers';
import type { Modifier } from './types';

describe('computeStat', () => {
  it('applies (base + flat) * (1 + Σincreased) * Π(1 + more)', () => {
    const mods: Modifier[] = [
      { stat: 'damage', kind: 'flat', value: 5 },
      { stat: 'damage', kind: 'increased', value: 0.2 },
      { stat: 'damage', kind: 'increased', value: 0.3 },
      { stat: 'damage', kind: 'more', value: 0.1 },
      { stat: 'damage', kind: 'more', value: 0.2 },
    ];
    // (10 + 5) * 1.5 * 1.1 * 1.2 = 29.7
    expect(computeStat(10, mods, 'damage')).toBeCloseTo(29.7, 10);
  });

  it('returns base when there are no modifiers', () => {
    expect(computeStat(42, [], 'life')).toBe(42);
  });

  it('ignores modifiers of other stats', () => {
    const mods: Modifier[] = [{ stat: 'life', kind: 'flat', value: 100 }];
    expect(computeStat(10, mods, 'resource')).toBe(10);
  });

  it('applies tagged modifiers only when context has all their tags', () => {
    const mods: Modifier[] = [
      { stat: 'damage', kind: 'increased', value: 0.15, tags: ['projectile'] },
      { stat: 'damage', kind: 'increased', value: 0.5, tags: ['projectile', 'fire'] },
    ];
    expect(computeStat(100, mods, 'damage', ['spell'])).toBe(100);
    expect(computeStat(100, mods, 'damage', ['spell', 'projectile'])).toBeCloseTo(115, 10);
    expect(computeStat(100, mods, 'damage', ['spell', 'projectile', 'fire'])).toBeCloseTo(165, 10);
  });

  it('clamps multipliers at zero', () => {
    const reduced: Modifier[] = [{ stat: 'damage', kind: 'increased', value: -1.5 }];
    expect(computeStat(100, reduced, 'damage')).toBe(0);
    const lessMore: Modifier[] = [{ stat: 'damage', kind: 'more', value: -2 }];
    expect(computeStat(100, lessMore, 'damage')).toBe(0);
  });

  it('allows flat modifiers to make the value negative (e.g. resistances)', () => {
    const mods: Modifier[] = [{ stat: 'fireResistance', kind: 'flat', value: -0.3 }];
    expect(computeStat(0, mods, 'fireResistance')).toBeCloseTo(-0.3, 10);
  });
});

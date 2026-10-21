import { describe, expect, it } from 'vitest';
import { progression } from '../../data/progression';
import { areaXpMultiplier, grantXp, levelModifiers, mapClearBonusXp, mobXp, xpToNextLevel, type ProgressionRules } from './levels';

const rules: ProgressionRules = {
  maxLevel: 4,
  xpCurve: { base: 100, exponent: 1 },
  mobXpGrowth: 0.5,
  lowAreaPenalty: { startDiff: 2, multipliers: [0.8, 0.6], floor: 0.1 },
  mapClearBonus: 0.07,
  perLevel: { life: 4, mana: 1 },
};

describe('levels', () => {
  it('xp curve grows with level and stops at max level', () => {
    expect(xpToNextLevel(1, rules)).toBe(100);
    expect(xpToNextLevel(2, rules)).toBe(300); // 100 × 2 × 1.5
    expect(xpToNextLevel(4, rules)).toBe(Infinity);
  });

  it('grants xp across several level-ups at once', () => {
    const hero = { level: 1, xp: 50 };
    expect(grantXp(hero, 360, rules)).toBe(2);
    expect(hero).toEqual({ level: 3, xp: 10 });
  });

  it('does not keep xp at max level', () => {
    const hero = { level: 3, xp: 0 };
    expect(grantXp(hero, 10_000, rules)).toBe(1);
    expect(hero).toEqual({ level: 4, xp: 0 });
    expect(grantXp(hero, 50, rules)).toBe(0);
    expect(hero.xp).toBe(0);
  });

  it('mob xp scales with area level', () => {
    expect(mobXp(4, 1, rules)).toBe(4);
    expect(mobXp(4, 3, rules)).toBe(8);
  });

  it('low-area penalty starts at the configured gap and bottoms out at the floor', () => {
    expect(areaXpMultiplier(5, 5, rules)).toBe(1);
    expect(areaXpMultiplier(5, 4, rules)).toBe(1);
    expect(areaXpMultiplier(5, 3, rules)).toBe(0.8);
    expect(areaXpMultiplier(5, 2, rules)).toBe(0.6);
    expect(areaXpMultiplier(9, 1, rules)).toBe(0.1);
    expect(areaXpMultiplier(1, 9, rules)).toBe(1);
  });

  it('level stats and map clear bonus', () => {
    expect(levelModifiers(1, rules)).toEqual([]);
    expect(levelModifiers(3, rules)).toEqual([
      { stat: 'life', kind: 'flat', value: 8 },
      { stat: 'mana', kind: 'flat', value: 2 },
    ]);
    expect(mapClearBonusXp(1000, rules)).toBeCloseTo(70);
  });
});

describe('progression data', () => {
  it('curve is increasing and reaches max level', () => {
    for (let level = 2; level < progression.maxLevel; level++) {
      expect(xpToNextLevel(level, progression)).toBeGreaterThan(xpToNextLevel(level - 1, progression));
    }
    expect(xpToNextLevel(progression.maxLevel, progression)).toBe(Infinity);
  });

  it('penalty multipliers decrease and stay above the floor', () => {
    const { multipliers, floor } = progression.lowAreaPenalty;
    multipliers.forEach((m, i) => {
      expect(m).toBeLessThan(i === 0 ? 1 : multipliers[i - 1]!);
      expect(m).toBeGreaterThan(floor);
    });
  });
});

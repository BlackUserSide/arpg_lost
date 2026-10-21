import { describe, expect, it } from 'vitest';
import { createRng } from '../rng';
import type { Modifier } from '../stats/types';
import type { CombatConfig } from './config';
import { computeDamage, rollBaseDamage, totalDamage } from './damage';
import { applyDamage, resolveHit } from './hit';
import { armourReduction, mitigate, resistanceMultiplier, type Defences } from './mitigation';

const config: CombatConfig = { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9 };
const noDefences: Defences = { armour: 0, resistances: { fire: 0, cold: 0, lightning: 0 } };

describe('rollBaseDamage', () => {
  it('is deterministic for a seed and stays in range', () => {
    const base = { physical: { min: 5, max: 10 }, fire: { min: 1, max: 2 } };
    const a = rollBaseDamage(createRng(1), base);
    const b = rollBaseDamage(createRng(1), base);
    expect(a).toEqual(b);
    expect(a.physical).toBeGreaterThanOrEqual(5);
    expect(a.physical).toBeLessThan(10);
    expect(a.fire).toBeGreaterThanOrEqual(1);
    expect(a.fire).toBeLessThan(2);
    expect(a.cold).toBeUndefined();
  });
});

describe('computeDamage', () => {
  it('adds flat damage of its type and scales each portion by matching tags', () => {
    const mods: Modifier[] = [
      { stat: 'damage', kind: 'flat', value: 10, damageType: 'fire' },
      { stat: 'damage', kind: 'increased', value: 0.5, tags: ['fire'] },
      { stat: 'damage', kind: 'increased', value: 0.2, tags: ['melee'] },
    ];
    const result = computeDamage({ physical: 100 }, mods, ['attack', 'melee']);
    expect(result.physical).toBeCloseTo(120, 10); // 100 * (1 + 0.2)
    expect(result.fire).toBeCloseTo(17, 10); // 10 * (1 + 0.5 + 0.2)
  });

  it('skips flat damage whose tag conditions the skill lacks', () => {
    const mods: Modifier[] = [{ stat: 'damage', kind: 'flat', value: 10, damageType: 'cold', tags: ['spell'] }];
    expect(computeDamage({ physical: 50 }, mods, ['attack', 'melee'])).toEqual({ physical: 50 });
  });

  it('applies more multipliers per portion', () => {
    const mods: Modifier[] = [{ stat: 'damage', kind: 'more', value: 0.5, tags: ['area'] }];
    expect(totalDamage(computeDamage({ fire: 40 }, mods, ['spell', 'area']))).toBeCloseTo(60, 10);
  });
});

describe('mitigation', () => {
  it('armour reduces small hits more than big hits', () => {
    const small = armourReduction(1000, 10, config); // 1000 / (1000 + 50)
    const big = armourReduction(1000, 1000, config); // 1000 / (1000 + 5000)
    expect(small).toBeCloseTo(0.9, 10); // 0.952 capped at 0.9
    expect(big).toBeCloseTo(1 / 6, 10);
  });

  it('armour does nothing at zero armour', () => {
    expect(armourReduction(0, 100, config)).toBe(0);
  });

  it('resistance is capped and may be negative', () => {
    expect(resistanceMultiplier(0.9, config)).toBeCloseTo(0.25, 10);
    expect(resistanceMultiplier(0.4, config)).toBeCloseTo(0.6, 10);
    expect(resistanceMultiplier(-0.5, config)).toBeCloseTo(1.5, 10);
  });

  it('mitigates each damage type separately', () => {
    const defences: Defences = { armour: 100, resistances: { fire: 0.5, cold: -0.2, lightning: 0.75 } };
    const result = mitigate({ physical: 100, fire: 100, cold: 100 }, defences, config);
    expect(result.physical).toBeCloseTo(100 * (1 - 100 / 600), 10);
    expect(result.fire).toBeCloseTo(50, 10);
    expect(result.cold).toBeCloseTo(120, 10);
    expect(result.lightning).toBeUndefined();
  });
});

describe('resolveHit', () => {
  it('never crits at 0% and always crits at 100%', () => {
    const rng = createRng(3);
    for (let i = 0; i < 100; i++) {
      expect(resolveHit(rng, { damage: { fire: 10 }, critChance: 0, critMultiplier: 1.5 }, noDefences, config).isCrit).toBe(false);
      const crit = resolveHit(rng, { damage: { fire: 10 }, critChance: 1, critMultiplier: 1.5 }, noDefences, config);
      expect(crit.isCrit).toBe(true);
      expect(crit.total).toBeCloseTo(15, 10);
    }
  });

  it('applies crit before armour, so armour reduces crits less', () => {
    const defences: Defences = { armour: 500, resistances: { fire: 0, cold: 0, lightning: 0 } };
    const normal = resolveHit(createRng(1), { damage: { physical: 100 }, critChance: 0, critMultiplier: 2 }, defences, config);
    const crit = resolveHit(createRng(1), { damage: { physical: 100 }, critChance: 1, critMultiplier: 2 }, defences, config);
    expect(normal.total).toBeCloseTo(100 * (1 - 500 / 1000), 10); // 50
    expect(crit.total).toBeCloseTo(200 * (1 - 500 / 1500), 10); // ~133.3
  });

  it('crit rate matches chance over many hits', () => {
    const rng = createRng(2024);
    let crits = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      if (resolveHit(rng, { damage: { physical: 1 }, critChance: 0.25, critMultiplier: 1.5 }, noDefences, config).isCrit) crits++;
    }
    expect(Math.abs(crits / n - 0.25)).toBeLessThan(0.01);
  });
});

describe('applyDamage', () => {
  it('energy shield absorbs before life', () => {
    const r = applyDamage({ life: 100, energyShield: 30 }, 50);
    expect(r.pools).toEqual({ life: 80, energyShield: 0 });
    expect(r.shieldLost).toBe(30);
    expect(r.lifeLost).toBe(20);
    expect(r.isDead).toBe(false);
  });

  it('kills when life reaches zero and does not overflow', () => {
    const r = applyDamage({ life: 10, energyShield: 0 }, 999);
    expect(r.pools.life).toBe(0);
    expect(r.lifeLost).toBe(10);
    expect(r.isDead).toBe(true);
  });

  it('ignores negative damage', () => {
    expect(applyDamage({ life: 10, energyShield: 5 }, -3).pools).toEqual({ life: 10, energyShield: 5 });
  });
});

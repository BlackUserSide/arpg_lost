import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classes } from '../data/classes';
import { supportsData } from '../data/supports';
import { setLocale } from '../i18n';
import { compatibleSkillNames, costMultiplierText, describeSupportBonus, describeSupportTier, supportTitle, tierLabel } from './supportText';
import { formatCost } from './resourceText';

describe('support text (uk)', () => {
  beforeEach(() => setLocale('uk'));
  afterEach(() => setLocale('en'));

  it('labels tiers and titles', () => {
    expect(tierLabel(1)).toBe('I');
    expect(tierLabel(3)).toBe('III');
    expect(tierLabel(9)).toBe('9');
    expect(supportTitle({ id: 'echo' }, 2)).toBe('Луна II');
  });

  it('rounds fractional costs for display', () => {
    expect(formatCost(18.2)).toBe('18');
    expect(formatCost(18.5)).toBe('19');
    expect(formatCost(0.3)).toBe('1');
    expect(formatCost(0)).toBe('0');
    expect(costMultiplierText(1.3)).toBe('Вартість скіла ×1,3');
  });

  it('describes param changes, statuses and grants', () => {
    expect(describeSupportBonus({ changes: [{ param: 'projectileCount', add: 2 }, { param: 'spread', add: 20 }] })).toEqual(['+2 снаряди', 'Розкид +20°']);
    expect(describeSupportBonus({ changes: [{ param: 'projectileCount', add: 1 }] })).toEqual(['+1 снаряд']);
    expect(describeSupportBonus({ changes: [{ param: 'pierce', add: 2 }] })).toEqual(['Пробиває ще 2 ворогів']);
    expect(describeSupportBonus({ changes: [{ param: 'radius', increased: 0.25 }] })).toEqual(['Радіус +25%']);
    expect(describeSupportBonus({ addOnHit: [{ status: 'stun', duration: 0.8, chance: 0.2 }] })).toEqual(['20% шанс оглушити на 0,8 с']);
    expect(describeSupportBonus({ addOnHit: [{ status: 'bleed', duration: 4, magnitude: 0.3, maxStacks: 3 }] })[0]).toMatch(/^Кровотеча: 30% урону удару за 4 с на стак, до 3 стаків/);
    expect(describeSupportBonus({ addOnHit: [{ status: 'ignite', duration: 3, magnitude: 0.5, chance: 0.3 }] })).toEqual(['30% шанс підпалити: 50% урону за 3 с']);
    expect(describeSupportBonus({ damageConversion: { to: 'fire', fraction: 0.25 } })).toEqual(['25% урону перетворюється на вогонь']);
    expect(describeSupportBonus({ grants: { echo: { chance: 0.25, delay: 0.25 } } })).toEqual(['25% шанс повторити скіл безкоштовно через 0,25 с']);
    expect(describeSupportBonus({ grants: { chainHit: { hops: 2, range: 160, effectiveness: 0.35, damageType: 'lightning' } } })).toEqual([
      'Кожне влучання: блискавка стрибає по 2 ворогах (до 160 од.)',
      'Удар блискавки: 35% урону скіла блискавкою',
    ]);
    expect(describeSupportBonus({ leech: 0.03 })).toEqual(['3% завданого урону лікує']);
    expect(describeSupportBonus({ modifiers: [{ stat: 'damage', kind: 'more', value: -0.1 }] })).toEqual(['10% менше урону (more)']);
  });

  it('lists the class skills a support fits by their names', () => {
    const pierce = supportsData.supports['pierce'];
    const echo = supportsData.supports['echo'];
    expect(pierce && compatibleSkillNames(pierce, classes['warrior']!)).toEqual([]);
    expect(echo && compatibleSkillNames(echo, classes['warrior']!)).toContain('Рублячий удар');
  });
});

describe('support text (en)', () => {
  it('describes bonuses in English', () => {
    expect(supportTitle({ id: 'echo' }, 2)).toBe('Echo II');
    expect(costMultiplierText(1.3)).toBe('Skill cost ×1.3');
    expect(describeSupportBonus({ changes: [{ param: 'projectileCount', add: 1 }, { param: 'spread', add: 10 }] })).toEqual(['+1 projectile', 'Spread +10°']);
    expect(describeSupportBonus({ addOnHit: [{ status: 'stun', duration: 1, chance: 0.25 }] })).toEqual(['25% chance to Stun for 1 s']);
    expect(describeSupportBonus({ changes: [{ param: 'pierce', add: 1 }] })).toEqual(['Pierces 1 more enemy']);
  });

  it('describes every tier of every support in every finished locale', () => {
    for (const locale of ['en', 'uk'] as const) {
      setLocale(locale);
      for (const def of Object.values(supportsData.supports)) {
        for (const tier of def.tiers) {
          const { lines, variants } = describeSupportTier(tier, 'mana');
          expect(lines.length + variants.length, def.id).toBeGreaterThan(0);
          for (const line of [...lines, ...variants]) expect(line, `${locale} ${def.id}`).not.toMatch(/undefined|NaN|\{\w+\}/);
        }
      }
    }
    setLocale('en');
  });
});

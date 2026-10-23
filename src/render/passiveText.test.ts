import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { passiveTree } from '../data/passives';
import { setLocale } from '../i18n';
import { describeNode, formatMechanic, formatModifier, formatModifiers, unspentBanner } from './passiveText';

describe('passive text (uk)', () => {
  beforeEach(() => setLocale('uk'));
  afterEach(() => setLocale('en'));

  it('formats tagged damage, flat and more modifiers', () => {
    expect(formatModifier({ stat: 'damage', kind: 'increased', value: 0.08, tags: ['projectile'] })).toBe('+8% урону снарядами');
    expect(formatModifier({ stat: 'critMultiplier', kind: 'flat', value: 0.25, tags: ['melee'] })).toBe('+25% множника криту для ближнього бою');
    expect(formatModifier({ stat: 'damage', kind: 'more', value: -0.3 })).toBe('30% менше урону (more)');
    expect(formatModifier({ stat: 'resource', kind: 'flat', value: 10 })).toBe('+10 ресурсу');
    expect(formatModifier({ stat: 'resource', kind: 'flat', value: 10 }, 'mana')).toBe('+10 мани');
    expect(formatModifier({ stat: 'resource', kind: 'increased', value: 0.1 }, 'rage')).toBe('+10% люті');
    expect(formatModifier({ stat: 'resourceRegen', kind: 'flat', value: 2 }, 'energy')).toBe('+2 регенерації енергії/с');
    expect(formatModifier({ stat: 'resourceRegen', kind: 'flat', value: 2 }, 'unknown')).toBe('+2 регенерації ресурсу/с');
    expect(formatModifier({ stat: 'lifeRegen', kind: 'more', value: -1 })).toMatch(/^Немає регенерації життя/);
    expect(formatModifier({ stat: 'armour', kind: 'increased', value: -0.1 })).toBe('−10% броні');
  });

  it('names the hero resource in Blood Magic, with a decimal comma', () => {
    const blood = { kind: 'bloodMagic', lifePerResource: 1.5 } as const;
    expect(formatMechanic(blood, 'rage')).toEqual(['Скіли коштують життя замість люті (1,5 життя за 1 лють)', 'Максимум люті = 0']);
    expect(formatMechanic(blood, 'mana')[0]).toBe('Скіли коштують життя замість мани (1,5 життя за 1 ману)');
    expect(formatMechanic(blood)[1]).toBe('Максимум ресурсу = 0');
  });

  it('collapses equal resistances into one line', () => {
    const res = (stat: 'fireResistance' | 'coldResistance' | 'lightningResistance') => ({ stat, kind: 'flat' as const, value: 0.05 });
    expect(formatModifiers([res('fireResistance'), res('coldResistance'), res('lightningResistance')])).toEqual(['+5% опору всім стихіям']);
  });

  it('uses Ukrainian plurals in the banner and the trap charges', () => {
    expect(unspentBanner(1, 0)).toBe('Маєте 1 очко талантів');
    expect(unspentBanner(5, 0)).toBe('Маєте 5 очок талантів');
    expect(unspentBanner(12, 0)).toBe('Маєте 12 очок талантів');
    expect(unspentBanner(21, 0)).toBe('Маєте 21 очко талантів');
    expect(unspentBanner(2, 1)).toBe('Маєте 2 очки талантів і 1 очко спеціалізації');
    const traps = formatMechanic({ kind: 'trapCharges', charges: 3, maxActive: 3, chainDelay: 0.15, chainRadius: 250 });
    expect(traps[0]).toBe('Пастка має 3 заряди, до 3 пасток одночасно');
  });

  it('describes skill param changes and statuses', () => {
    const lines = formatMechanic({ kind: 'skillParams', skillIds: ['frost_nova'], changes: [{ param: 'cooldown', add: -0.5 }, { param: 'radius', increased: 0.2 }] });
    expect(lines).toEqual(['Крижана нова: кулдаун −0,5 с, радіус +20%']);
    expect(formatMechanic({ kind: 'skillParams', tags: ['projectile'], changes: [{ param: 'pierce', add: 1 }] })).toEqual(['Скіли (снарядів): пробиття +1 ціль']);
    const death = formatMechanic({ kind: 'deathExplosion', status: 'ignite', radius: 100, lifeFraction: 0.3, damageType: 'fire', applyStatus: 'ignite' });
    expect(death).toEqual(['Ворог, що помер під дією «підпал», вибухає: 30% його макс. життя як вогняний урон, радіус 100, накладає підпал']);
  });
});

describe('passive text (en)', () => {
  it('reads like an ARPG tooltip', () => {
    expect(formatModifier({ stat: 'damage', kind: 'increased', value: 0.08, tags: ['projectile'] })).toBe('8% increased Projectile Damage');
    expect(formatModifier({ stat: 'armour', kind: 'increased', value: -0.1 })).toBe('10% reduced Armour');
    expect(formatModifier({ stat: 'critMultiplier', kind: 'flat', value: 0.25, tags: ['melee'] })).toBe('+25% to Melee Critical Strike Multiplier');
    expect(formatModifier({ stat: 'resource', kind: 'flat', value: 10 }, 'mana')).toBe('+10 to maximum Mana');
    expect(formatMechanic({ kind: 'bloodMagic', lifePerResource: 1.5 }, 'rage')).toEqual(['Skills cost Life instead of Rage (1.5 Life per 1 Rage)', 'Maximum Rage is 0']);
    expect(unspentBanner(1, 0)).toBe('You have 1 talent point');
    expect(unspentBanner(2, 1)).toBe('You have 2 talent points and 1 specialization point');
  });

  it('describes every node of the tree except starts, in every finished locale', () => {
    for (const locale of ['en', 'uk'] as const) {
      setLocale(locale);
      for (const node of Object.values(passiveTree.nodes)) {
        if (node.type === 'start') continue;
        const lines = describeNode(node);
        expect(lines.length, node.id).toBeGreaterThan(0);
        for (const line of lines) expect(line, `${locale} ${node.id}`).not.toMatch(/undefined|NaN|\{\w+\}/);
      }
    }
    setLocale('en');
  });
});

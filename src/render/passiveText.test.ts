import { describe, expect, it } from 'vitest';
import { passiveTree } from '../data/passives';
import { describeNode, formatMechanic, formatModifier, formatModifiers, plural, unspentBanner } from './passiveText';

describe('passive text', () => {
  it('formats tagged damage, flat and more modifiers', () => {
    expect(formatModifier({ stat: 'damage', kind: 'increased', value: 0.08, tags: ['projectile'] })).toBe('+8% урону снарядами');
    expect(formatModifier({ stat: 'critMultiplier', kind: 'flat', value: 0.25, tags: ['melee'] })).toBe('+0.25 множника криту для ближнього бою');
    expect(formatModifier({ stat: 'damage', kind: 'more', value: -0.3 })).toBe('30% менше урону (more)');
    expect(formatModifier({ stat: 'resource', kind: 'flat', value: 10 })).toBe('+10 ресурсу');
    expect(formatModifier({ stat: 'resource', kind: 'flat', value: 10 }, 'mana')).toBe('+10 мани');
    expect(formatModifier({ stat: 'resource', kind: 'increased', value: 0.1 }, 'rage')).toBe('+10% люті');
    expect(formatModifier({ stat: 'resourceRegen', kind: 'flat', value: 2 }, 'energy')).toBe('+2 регенерації енергії/с');
    expect(formatModifier({ stat: 'resourceRegen', kind: 'flat', value: 2 }, 'unknown')).toBe('+2 регенерації ресурсу/с');
    expect(formatModifier({ stat: 'lifeRegen', kind: 'more', value: -1 })).toMatch(/^Немає регенерації життя/);
  });

  it('names the hero resource in Blood Magic', () => {
    const blood = { kind: 'bloodMagic', lifePerResource: 1.5 } as const;
    expect(formatMechanic(blood, 'rage')).toEqual(['Скіли коштують життя замість люті (1.5 життя за 1 лють)', 'Максимум люті = 0']);
    expect(formatMechanic(blood, 'mana')[0]).toBe('Скіли коштують життя замість мани (1.5 життя за 1 ману)');
    expect(formatMechanic(blood)[1]).toBe('Максимум ресурсу = 0');
  });

  it('collapses equal resistances into one line', () => {
    const res = (stat: 'fireResistance' | 'coldResistance' | 'lightningResistance') => ({ stat, kind: 'flat' as const, value: 0.05 });
    expect(formatModifiers([res('fireResistance'), res('coldResistance'), res('lightningResistance')])).toEqual(['+5% опору всім стихіям']);
  });

  it('describes every node of the tree except starts', () => {
    for (const node of Object.values(passiveTree.nodes)) {
      if (node.type === 'start') continue;
      const lines = describeNode(node);
      expect(lines.length, node.id).toBeGreaterThan(0);
      for (const line of lines) expect(line, node.id).not.toMatch(/undefined|NaN/);
    }
  });

  it('uses Ukrainian plurals in the banner', () => {
    expect(plural(1, 'a', 'b', 'c')).toBe('a');
    expect(plural(3, 'a', 'b', 'c')).toBe('b');
    expect(plural(12, 'a', 'b', 'c')).toBe('c');
    expect(plural(21, 'a', 'b', 'c')).toBe('a');
    expect(unspentBanner(5, 0)).toBe('Маєте 5 очок талантів');
    expect(unspentBanner(2, 1)).toBe('Маєте 2 очки талантів і 1 очко спеціалізації');
  });
});

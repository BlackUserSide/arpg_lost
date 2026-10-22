import { describe, expect, it } from 'vitest';
import { passiveTree } from '../data/passives';
import { describeNode, formatModifier, formatModifiers, plural, unspentBanner } from './passiveText';

describe('passive text', () => {
  it('formats tagged damage, flat and more modifiers', () => {
    expect(formatModifier({ stat: 'damage', kind: 'increased', value: 0.08, tags: ['projectile'] })).toBe('+8% урону снарядами');
    expect(formatModifier({ stat: 'critMultiplier', kind: 'flat', value: 0.25, tags: ['melee'] })).toBe('+0.25 множника криту для ближнього бою');
    expect(formatModifier({ stat: 'damage', kind: 'more', value: -0.3 })).toBe('30% менше урону (more)');
    expect(formatModifier({ stat: 'mana', kind: 'flat', value: 10 })).toBe('+10 мани');
    expect(formatModifier({ stat: 'lifeRegen', kind: 'more', value: -1 })).toMatch(/^Немає регенерації життя/);
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

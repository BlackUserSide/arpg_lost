import { afterEach, describe, expect, it } from 'vitest';
import type { Item } from '../core/items/types';
import { itemsData } from '../data/items';
import { setLocale } from '../i18n';
import { describeItem, formatLine, formatRange } from './itemText';

describe('item text', () => {
  afterEach(() => setLocale('en'));

  it('formats stat lines like an ARPG tooltip', () => {
    expect(formatLine({ stat: 'life', kind: 'flat' }, 23)).toBe('+23 to maximum Life');
    expect(formatLine({ stat: 'armour', kind: 'increased' }, 0.18)).toBe('18% increased Armour');
    expect(formatLine({ stat: 'fireResistance', kind: 'flat' }, 0.12)).toBe('+12% to Fire Resistance');
    expect(formatLine({ stat: 'damage', kind: 'flat', damageType: 'cold' }, 7)).toBe('Adds 7 Cold Damage');
    expect(formatLine({ stat: 'damage', kind: 'increased', tags: ['spell'] }, 0.25)).toBe('25% increased Spell Damage');
    expect(formatLine({ stat: 'damage', kind: 'more' }, -0.25)).toBe('25% less Damage');
    expect(formatLine({ stat: 'lifeRegen', kind: 'flat' }, 1.5)).toBe('+1.5 to Life Regeneration per second');
    expect(formatLine({ stat: 'critMultiplier', kind: 'flat' }, 0.2)).toBe('+20% to Critical Strike Multiplier');
  });

  it('names the resource stats after the hero class, neutral without one', () => {
    expect(formatLine({ stat: 'resource', kind: 'flat' }, 12)).toBe('+12 to maximum Resource');
    expect(formatLine({ stat: 'resource', kind: 'flat' }, 12, 'rage')).toBe('+12 to maximum Rage');
    expect(formatLine({ stat: 'resource', kind: 'increased' }, 0.1, 'mana')).toBe('10% increased maximum Mana');
    expect(formatLine({ stat: 'resourceRegen', kind: 'flat' }, 2, 'energy')).toBe('+2 to Energy Regeneration per second');
    expect(formatLine({ stat: 'resourceRegen', kind: 'flat' }, 2)).toBe('+2 to Resource Regeneration per second');
  });

  it('formats tier ranges in the same units as the value', () => {
    expect(formatRange({ stat: 'life', kind: 'flat' }, { min: 10, max: 15, step: 1 })).toBe('10–15');
    expect(formatRange({ stat: 'armour', kind: 'increased' }, { min: 0.1, max: 0.15, step: 0.01 })).toBe('10%–15%');
  });

  const rare: Item = {
    id: 'i1',
    baseId: 'chainmail',
    level: 12,
    rarity: 'rare',
    name: 'Grim Ward',
    implicit: 12,
    armour: 25,
    affixes: [
      { affixId: 'life_flat', tier: 4, value: 20 },
      { affixId: 'fire_res', tier: 5, value: 0.1 },
    ],
  };

  it('describes an item with base stats, implicit, affixes with tiers and requirement', () => {
    const t = describeItem(rare, itemsData);
    expect(t.title).toBe('Grim Ward');
    expect(t.subtitle).toBe('Chainmail');
    expect(t.lines.map((l) => l.text)).toEqual([
      'Armour: 25',
      '+12 to maximum Life',
      '+20 to maximum Life',
      '+10% to Fire Resistance',
      'Item level 12 · Requires level 12',
    ]);
    expect(t.lines[2]!.detail).toBe('P · T4 · 15–24');
    expect(t.lines[3]!.detail).toBe('S · T5 · 6%–11%');
  });

  const crown: Item = {
    id: 'u1',
    baseId: 'leather_helm',
    level: 16,
    rarity: 'unique',
    name: '',
    affixes: [],
    unique: {
      id: 'glass_cannon_crown',
      rolls: [
        { tier: 3, value: 0.2 },
        { tier: 3, value: 0.31 },
        { tier: 3, value: 18 },
      ],
    },
  };

  it('describes a unique: own name over its base, rolled lines with tier and range, effect, cost', () => {
    const t = describeItem(crown, itemsData, 'mana');
    expect(t.title).toBe('Glass Cannon Crown');
    expect(t.subtitle).toBe('Leather Helm');
    const of = (kind: string): string[] => t.lines.filter((l) => l.kind === kind).map((l) => l.text);
    expect(of('unique')).toEqual(['20% increased Damage', '31% increased Critical Strike Chance', '+18 to maximum Mana']);
    expect(t.lines.find((l) => l.kind === 'unique')!.detail).toBe('T3 · 19%–24%');
    expect(of('effect')).toEqual(['50% more Damage']);
    expect(of('cost')).toEqual(['Cost: 40% more Damage Taken']);
    expect(t.lines[t.lines.length - 1]!.kind).toBe('meta');
    setLocale('uk');
    const uk = describeItem(crown, itemsData);
    expect(uk.title).toBe('Вінець Скляної Гармати');
    expect(uk.lines.find((l) => l.kind === 'cost')!.text).toMatch(/^Ціна: /);
  });

  it('shows a unique whose id left the data as its base only', () => {
    const t = describeItem({ ...crown, unique: { id: 'gone', rolls: [{ tier: 1, value: 5 }] } }, itemsData);
    expect(t.title).toBe('Leather Helm');
    expect(t.subtitle).toBeUndefined();
    expect(t.lines.filter((l) => l.kind === 'unique' || l.kind === 'effect' || l.kind === 'cost')).toEqual([]);
  });

  it('names normal and magic items by their base in the current language, whatever name the save holds', () => {
    const magic: Item = { id: 'i2', baseId: 'rusty_sword', level: 1, rarity: 'magic', name: 'Rusty Sword', affixes: [] };
    expect(describeItem({ ...magic, name: '' }, itemsData).title).toBe('Rusty Sword');
    setLocale('uk');
    const t = describeItem(magic, itemsData);
    expect(t.title).toBe('Іржавий меч');
    expect(t.lines.map((l) => l.text)).toEqual(['Фізичний урон: 6–11', 'Атак за секунду: 1,6', 'Шанс критичного удару: 5%', 'Рівень предмета 1 · Потрібен рівень 1']);
    expect(describeItem(rare, itemsData).subtitle).toBe('Кольчуга');
    expect(describeItem(rare, itemsData).lines[1]!.text).toBe('+12 життя');
  });
});

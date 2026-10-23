import { afterEach, describe, expect, it } from 'vitest';
import { ESSENCE_CURRENCY } from '../core/items/craft';
import { SALVAGE_CURRENCY } from '../core/items/inventory';
import type { Item } from '../core/items/types';
import { setLocale } from '../i18n';
import { changedAffixes, costParts, craftEffect, craftReason, currencyAmount, currencyWord, essenceShown } from './craftText';

describe('craft text', () => {
  afterEach(() => setLocale('en'));

  const magic: Item = { id: 'i1', baseId: 'rusty_sword', level: 5, rarity: 'magic', name: '', affixes: [] };

  it('lists costs shards first and skips zero amounts', () => {
    const cost = { [ESSENCE_CURRENCY]: 1, [SALVAGE_CURRENCY]: 10, other: 0 };
    expect(costParts(cost)).toEqual([
      { currency: SALVAGE_CURRENCY, amount: 10 },
      { currency: ESSENCE_CURRENCY, amount: 1 },
    ]);
    setLocale('uk');
    expect(currencyWord(SALVAGE_CURRENCY, 5)).toBe('5 осколків');
    expect(currencyWord(ESSENCE_CURRENCY, 2)).toBe('2 есенції');
  });

  it('shows essence with one decimal at most, never rounding up', () => {
    expect(essenceShown(0.7)).toBe(0.7);
    expect(essenceShown(0.3 + 0.4)).toBe(0.7);
    expect(essenceShown(1.99)).toBe(1.9);
    expect(currencyAmount(ESSENCE_CURRENCY, 2)).toBe('2');
    expect(currencyAmount(ESSENCE_CURRENCY, 0.7)).toBe('0.7');
    expect(currencyAmount(SALVAGE_CURRENCY, 12)).toBe('12');
    expect(currencyWord(ESSENCE_CURRENCY, 0.75)).toBe('0.7 essence');
    setLocale('uk');
    expect(currencyAmount(ESSENCE_CURRENCY, 1.3)).toBe('1,3');
    expect(currencyWord(ESSENCE_CURRENCY, 0.7)).toBe('0,7 есенції');
  });

  it('names the rarity an upgrade leads to', () => {
    expect(craftEffect('upgradeRarity', magic)).toBe('Rarity → Rare, new affixes');
    expect(craftEffect('upgradeRarity', { ...magic, rarity: 'normal' })).toBe('Rarity → Magic, new affixes');
  });

  it('explains which currency is short, with the essence source when there is none', () => {
    const cost = { [SALVAGE_CURRENCY]: 10, [ESSENCE_CURRENCY]: 1 };
    expect(craftReason('currency', 'rerollAffix', cost, { [SALVAGE_CURRENCY]: 50 })).toBe('Essence drops from elites and bosses');
    expect(craftReason('currency', 'rerollAffix', cost, { [SALVAGE_CURRENCY]: 50, [ESSENCE_CURRENCY]: 0.5 })).toBe('Not enough essence');
    expect(craftReason('currency', 'rerollAffix', cost, { [SALVAGE_CURRENCY]: 3, [ESSENCE_CURRENCY]: 4 })).toBe('Not enough shards');
    expect(craftReason('rarity', 'upgradeRarity', {}, {})).toBe('Already the highest rarity');
    expect(craftReason('rarity', 'addAffix', {}, {})).toBe('Normal items have no affix slots');
    expect(craftReason('badIndex', 'removeAffix', {}, {})).toBe('Pick an affix on the item');
  });

  it('finds the new and rerolled affixes after a craft', () => {
    const a = { affixId: 'a', tier: 1, value: 5 };
    const b = { affixId: 'b', tier: 2, value: 3 };
    const c = { affixId: 'c', tier: 1, value: 9 };
    expect(changedAffixes([a, b], [a, c, b])).toEqual([1]);
    expect(changedAffixes([a, b], [a, { ...b, value: 4 }])).toEqual([1]);
    expect(changedAffixes([a, a], [a, a, a])).toEqual([2]);
    expect(changedAffixes([a, b], [b])).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { detectLocale, formatNumber, getLocale, hasMessage, listAnd, onLocaleChange, resolveLocale, setLocale, t, tx } from './index';
import { uk } from './locales/uk';

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it('fills template params and formats numbers per locale', () => {
    expect(t('common.level', { level: 7 })).toBe('Level 7');
    expect(t('unit.seconds', { value: 0.5 })).toBe('0.5 s');
    setLocale('uk');
    expect(t('common.level', { level: 7 })).toBe('Рівень 7');
    expect(t('unit.seconds', { value: 0.5 })).toBe('0,5 с');
    expect(formatNumber(1234.5678)).toBe('1234,57');
    expect(formatNumber(-0)).toBe('0');
  });

  it('picks plural forms: en one / other, uk one / few / many / other', () => {
    expect([1, 2, 5, 21].map((count) => t('unit.shards', { count }))).toEqual(['1 shard', '2 shards', '5 shards', '21 shards']);
    setLocale('uk');
    expect([1, 2, 5, 11, 21, 22, 25, 1.5].map((count) => t('unit.shards', { count }))).toEqual([
      '1 осколок',
      '2 осколки',
      '5 осколків',
      '11 осколків',
      '21 осколок',
      '22 осколки',
      '25 осколків',
      '1,5 осколка',
    ]);
  });

  it('falls back to English per key, and to the key (or a given fallback) when nothing has it', () => {
    // Every locale is complete, so drop one Ukrainian key for the duration of the check.
    const table = uk as Record<string, unknown>;
    const saved = table['item.rare.first.Grim'];
    delete table['item.rare.first.Grim'];
    try {
      setLocale('uk');
      expect(hasMessage('item.rare.first.Grim', 'uk')).toBe(false);
      expect(tx('item.rare.first.Grim')).toBe('Grim');
    } finally {
      table['item.rare.first.Grim'] = saved;
    }
    expect(tx('skill.nope.name')).toBe('skill.nope.name');
    expect(tx('skill.nope.name', undefined, 'nope')).toBe('nope');
  });

  it('joins lists in the current language', () => {
    expect(listAnd(['a'])).toBe('a');
    expect(listAnd(['a', 'b', 'c'])).toBe('a, b and c');
    setLocale('uk');
    expect(listAnd(['a', 'b'])).toBe('a і b');
  });

  it('detects the browser language by its primary subtag, English otherwise', () => {
    expect(detectLocale(['uk-UA', 'en-US'])).toBe('uk');
    expect(detectLocale(['ru-RU', 'de-AT'])).toBe('de');
    expect(detectLocale(['pl'])).toBe('pl');
    expect(detectLocale(['en-GB', 'uk'])).toBe('en');
    expect(detectLocale(['fr-FR', 'es'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('lets a saved manual choice win over the browser language', () => {
    expect(resolveLocale('pl', ['uk-UA'])).toBe('pl');
    expect(resolveLocale(undefined, ['uk-UA'])).toBe('uk');
    expect(resolveLocale('xx', ['de-DE'])).toBe('de');
  });

  it('notifies listeners on a change only', () => {
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    setLocale('uk');
    setLocale('uk');
    setLocale('pl');
    off();
    setLocale('en');
    expect(seen).toEqual(['uk', 'pl']);
    expect(getLocale()).toBe('en');
  });
});

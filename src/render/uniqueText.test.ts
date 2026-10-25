import { afterEach, describe, expect, it } from 'vitest';
import type { UniqueDef } from '../core/items/types';
import { content } from '../data';
import { itemsData } from '../data/items';
import { LOCALES, localeTable, setLocale, type Message } from '../i18n';
import { contentKey } from './contentText';
import { uniqueEffectFill, uniqueEffectLines } from './uniqueText';

const placeholders = (message: Message | undefined): string[] => {
  if (message === undefined) return [];
  const texts = typeof message === 'string' ? [message] : Object.values(message).filter((v): v is string => typeof v === 'string');
  return [...new Set(texts.flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))];
};

describe('unique effect text', () => {
  afterEach(() => setLocale('en'));
  const uniques = Object.values(itemsData.uniques);

  it('fills every placeholder of every unique effect text, in every locale, from data', () => {
    expect(uniques.length).toBeGreaterThan(0);
    for (const def of uniques) {
      const fill = uniqueEffectFill(def, content);
      expect(fill, def.id).toBeDefined();
      for (const locale of LOCALES) {
        const message = (localeTable(locale) as Readonly<Record<string, Message | undefined>>)[contentKey.uniqueEffect(def.id)];
        for (const name of placeholders(message)) expect(fill!.params[name], `${def.id} ${locale} {${name}}`).toBeDefined();
      }
      for (const locale of LOCALES) {
        setLocale(locale);
        for (const line of uniqueEffectLines(def, content)) expect(line, `${def.id} ${locale}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('states the numbers of the data', () => {
    const lines = (id: string, resourceId?: string): string[] => uniqueEffectLines(itemsData.uniques[id]!, content, resourceId);
    expect(lines('glass_cannon_crown')).toEqual(['50% more Damage']);
    expect(lines('splitter')).toEqual(['Bolts pierce 2 more enemies']);
    expect(lines('heart_of_winter')[0]).toContain('by 30% for 2 s');
    // Cleave belongs to the warrior: Rage whoever looks at the sword.
    expect(lines('barrow_reaper', 'mana')).toEqual(['Cleave grants 2 Rage for every enemy it hits']);
    setLocale('uk');
    expect(lines('splitter')).toEqual(['Болти пробивають ще 2 цілі']);
    expect(lines('barrow_reaper')).toEqual(['Рублячий удар дає 2 люті за кожного враженого ворога']);
  });

  it('adds effect modifiers the text does not state as modifier lines', () => {
    const def: UniqueDef = { ...itemsData.uniques['splitter']!, effectModifiers: [{ stat: 'life', kind: 'flat', value: 10 }] };
    expect(uniqueEffectLines(def, content)).toEqual(['Bolts pierce 2 more enemies', '+10 to maximum Life']);
    const crown = itemsData.uniques['glass_cannon_crown']!;
    expect(uniqueEffectLines({ ...crown, effectModifiers: [...(crown.effectModifiers ?? []), { stat: 'life', kind: 'flat', value: 5 }] }, content)).toEqual([
      '50% more Damage',
      '+5 to maximum Life',
    ]);
  });
});

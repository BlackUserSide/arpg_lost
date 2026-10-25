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
    expect(lines('iron_heart_oath')).toEqual(['Armour also reduces Elemental damage, at 50% effectiveness']);
    expect(lines('bloody_pupil')).toEqual(['Critical strikes restore 2% of maximum Life, at most once every 0.2 s']);
    expect(lines('ancestral_horn')).toEqual(['Battle Cry Stuns nearby enemies for 1 s and its cooldown is 50% shorter']);
    expect(lines('madman_gloves')).toEqual(['Explosive Trap throws 3 traps in a fan, but its cooldown is 100% longer']);
    expect(lines('shadow_boots')).toEqual(['After a Roll, your next attack is a guaranteed critical strike']);
    expect(lines('rift_ring')).toEqual(['Teleport has no cooldown and leaves a blast where it started (10–18 Lightning damage); every Teleport costs 15% of your current Life']);
    setLocale('uk');
    expect(lines('splitter')).toEqual(['Болти пробивають ще 2 цілі']);
    expect(lines('madman_gloves')).toEqual(['Вибухова пастка ставить 3 пастки віялом, але її кулдаун довший на 100%']);
    expect(lines('ancestral_horn')).toEqual(['Бойовий клич оглушає ворогів довкола на 1 с, кулдаун клича коротший на 50%']);
    expect(lines('barrow_reaper')).toEqual(['Рублячий удар дає 2 люті за кожного враженого ворога']);
  });

  it('a placeholder the data cannot fill drops the text line (never a raw {name}); stated modifiers then get their own line', () => {
    const splitter = itemsData.uniques['splitter']!;
    const broken: UniqueDef = { ...splitter, effectParams: { count: { path: 'mechanics.0.changes.9.add' } } };
    expect(uniqueEffectFill(broken, content).params).toEqual({});
    expect(uniqueEffectLines(broken, content)).toEqual([]);
    const crown = itemsData.uniques['glass_cannon_crown']!;
    expect(uniqueEffectLines({ ...crown, effectParams: {} }, content)).toEqual(['50% more Damage']);
    expect(uniqueEffectFill(crown, content).stated).toEqual([0]);
    // A resource placeholder needs a skill id at its path.
    const reaper = itemsData.uniques['barrow_reaper']!;
    expect(uniqueEffectLines({ ...reaper, effectParams: { ...reaper.effectParams, resGen: { resourceOf: 'mechanics.0.resourcePerHit' } } }, content)).toEqual([]);
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

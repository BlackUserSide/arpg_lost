import { describe, expect, it } from 'vitest';
import { content } from '../data';
import { itemsData } from '../data/items';
import { passiveTree } from '../data/passives';
import { supportsData } from '../data/supports';
import { contentKey, requiredContentKeys } from '../render/contentText';
import { hasMessage, LOCALES, localeTable, type Message } from './index';
import { en } from './locales/en';

// Every content id in data needs its English text (adding content without text fails here), and Ukrainian, German and
// Polish cover every English key.

const enTable = en as Readonly<Record<string, Message>>;

/**
 * Params the code always passes although English does not use them: other languages need another word form or a
 * sign. Keep in sync with the t() calls (and mention new ones in docs/i18n-glossary.md for translators).
 */
const EXTRA_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'mod.addedDamage': ['sign'],
  'mech.deathExplosion': ['statusAcc'],
  'arena.restoredBoth': ['resAcc'],
  'unit.targets': ['count'],
  'supportLine.projectiles': ['count'],
};

const placeholders = (message: Message): string[] => {
  const texts = typeof message === 'string' ? [message] : Object.values(message).filter((v): v is string => typeof v === 'string');
  return [...new Set(texts.flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();
};

describe('locale coverage', () => {
  const required = requiredContentKeys(content, passiveTree, itemsData, supportsData);

  it('has English text for every content id in data', () => {
    expect(required.length).toBeGreaterThan(200);
    const missing = required.filter((key) => !hasMessage(key, 'en'));
    expect(missing).toEqual([]);
  });

  it('names every resource form of every class resource and the generic fallback', () => {
    for (const id of ['generic', ...Object.values(content.classes).map((c) => c.resource.id)]) {
      for (const form of ['name', 'gen', 'acc'] as const) expect(hasMessage(contentKey.resource(id, form), 'en'), `${id}.${form}`).toBe(true);
    }
  });

  it('has Ukrainian text for every English key', () => {
    const missing = Object.keys(enTable).filter((key) => !hasMessage(key, 'uk'));
    expect(missing).toEqual([]);
  });

  it('has German and Polish text for every English key', () => {
    for (const locale of ['de', 'pl'] as const) {
      const missing = Object.keys(enTable).filter((key) => !hasMessage(key, locale));
      expect(missing, locale).toEqual([]);
    }
  });

  it('keeps the placeholders of every translation in line with English', () => {
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      for (const [key, message] of Object.entries(localeTable(locale) as Readonly<Record<string, Message>>)) {
        const source = enTable[key];
        expect(source, `${locale}: unknown key ${key}`).toBeDefined();
        // A translation may drop the count (e.g. a plural form spelled out), never invent a parameter.
        const allowed = [...placeholders(source!), ...(EXTRA_PARAMS[key] ?? [])];
        const extra = placeholders(message).filter((p) => !allowed.includes(p));
        expect(extra, `${locale} ${key}`).toEqual([]);
      }
    }
  });

  it('gives Ukrainian plurals all their forms', () => {
    for (const [key, message] of Object.entries(localeTable('uk') as Readonly<Record<string, Message>>)) {
      if (typeof message === 'string') continue;
      for (const form of ['one', 'few', 'many', 'other'] as const) expect(message[form], `uk ${key}.${form}`).toBeDefined();
    }
    // English plurals translated as plain strings would lose their count forms.
    for (const [key, message] of Object.entries(enTable)) {
      const uk = (localeTable('uk') as Readonly<Record<string, Message>>)[key];
      if (typeof message !== 'string' && uk !== undefined) expect(typeof uk, `uk ${key}`).toBe('object');
    }
  });

  it('gives German and Polish plurals all their forms', () => {
    const forms = { de: ['one', 'other'], pl: ['one', 'few', 'many', 'other'] } as const;
    for (const locale of ['de', 'pl'] as const) {
      const table = localeTable(locale) as Readonly<Record<string, Message>>;
      for (const [key, message] of Object.entries(table)) {
        if (typeof message === 'string') continue;
        for (const form of forms[locale]) expect(message[form], `${locale} ${key}.${form}`).toBeDefined();
      }
      // English plurals translated as plain strings would lose their count forms.
      for (const [key, message] of Object.entries(enTable)) {
        if (typeof message !== 'string' && table[key] !== undefined) expect(typeof table[key], `${locale} ${key}`).toBe('object');
      }
    }
  });
});

import type { en } from './locales/en';

/**
 * Plural forms (CLDR categories, Intl.PluralRules). English and German use one / other; Ukrainian and Polish one /
 * few / many (+ other for fractions). `other` is required: it is the fallback for any missing form.
 */
export interface PluralForms {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

/** A template ("{count} shards") or plural forms selected by the `count` parameter. */
export type Message = string | PluralForms;

/** Every key the game uses: English is the source of truth. */
export type MessageKey = keyof typeof en;

/** A translation: any subset of the English keys; missing keys fall back to English one by one. */
export type LocaleTable = Readonly<Partial<Record<MessageKey, Message>>>;

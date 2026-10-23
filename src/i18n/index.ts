// Tiny localization layer: flat message tables per locale, `{param}` templates, plurals via Intl.PluralRules,
// locale-aware numbers. English (locales/en.ts) is the typed source of truth and the per-key fallback.
// No Phaser, DOM or storage here: render reads t(), the save adapter stores the manual choice, and whoever boots the
// game (render/app.ts today, the CrazyGames SDK language later) feeds resolveLocale().

import { de } from './locales/de';
import { en } from './locales/en';
import { pl } from './locales/pl';
import { uk } from './locales/uk';
import type { LocaleTable, Message, MessageKey, PluralForms } from './types';

export type { LocaleTable, Message, MessageKey, PluralForms } from './types';

export const LOCALES = ['en', 'uk', 'de', 'pl'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Language names for the switcher, each in its own language (never translated). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: 'English', uk: 'Українська', de: 'Deutsch', pl: 'Polski' };

/** Template parameters; numbers are formatted for the current locale (decimal comma in uk / de / pl). */
export type Params = Readonly<Record<string, string | number>>;

const TABLES: Readonly<Record<Locale, LocaleTable>> = { en, uk, de, pl };

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<(locale: Locale) => void>();

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of [...listeners]) listener(locale);
}

/** Subscribes to locale changes; returns the unsubscribe function. */
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The first supported language in the user's preference list (BCP 47 tags such as navigator.languages, or the
 * portal's language later); English when none matches. Only the primary subtag counts: "uk-UA" → uk, "de-AT" → de.
 */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/** A saved manual choice wins over the detected language; an unknown saved value is ignored. */
export function resolveLocale(saved: unknown, languages: readonly string[]): Locale {
  return isLocale(saved) ? saved : detectLocale(languages);
}

// ---- Formatting -------------------------------------------------------------------------------------

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function rulesFor(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

/** Up to `maxDecimals` decimals, no trailing zeros, no digit grouping ("1234", "0.5" / "0,5"). */
export function formatNumber(value: number, maxDecimals = 2, locale: Locale = current): string {
  const key = `${locale}:${maxDecimals}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: maxDecimals, useGrouping: false });
    numberFormats.set(key, format);
  }
  // Intl keeps the sign of -0 ("-0"); callers never want that.
  return format.format(value === 0 ? 0 : value);
}

function pickPlural(forms: PluralForms, count: number, locale: Locale): string {
  const form = rulesFor(locale).select(count);
  return forms[form] ?? forms.other;
}

function render(message: Message, params: Params | undefined, locale: Locale): string {
  let text: string;
  if (typeof message === 'string') text = message;
  else {
    const count = Number(params?.['count'] ?? 0);
    text = pickPlural(message, Math.abs(count), locale);
  }
  if (!params || text.indexOf('{') < 0) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return typeof value === 'number' ? formatNumber(value, 2, locale) : value;
  });
}

function lookup(key: string): { message: Message; locale: Locale } | undefined {
  const own = (TABLES[current] as Readonly<Record<string, Message | undefined>>)[key];
  if (own !== undefined) return { message: own, locale: current };
  const fallback = (en as Readonly<Record<string, Message | undefined>>)[key];
  return fallback !== undefined ? { message: fallback, locale: DEFAULT_LOCALE } : undefined;
}

/** Translated text for a static key, with the English text as the per-key fallback. */
export function t(key: MessageKey, params?: Params): string {
  return tx(key, params);
}

/**
 * Translated text for a key built at runtime (content ids: `skill.${id}.name`). A key missing everywhere returns
 * `fallback` (default: the key itself), so new content without text stays visible instead of blank.
 */
export function tx(key: string, params?: Params, fallback: string = key): string {
  const found = lookup(key);
  return found ? render(found.message, params, found.locale) : fallback;
}

/** Whether a key has text of its own in `locale` (no English fallback). For coverage tests and optional text. */
export function hasMessage(key: string, locale: Locale = current): boolean {
  return (TABLES[locale] as Readonly<Record<string, Message | undefined>>)[key] !== undefined;
}

/** "a, b and c" in the current locale ("a, b і c"). */
export function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(t('list.separator'))}${t('list.and')}${items[items.length - 1]}`;
}

/** First letter upper-cased with the current locale's rules. */
export function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase(current) + text.slice(1);
}

/** Upper-cases with the current locale's rules (captions, rarity labels). */
export function upper(text: string): string {
  return text.toLocaleUpperCase(current);
}

/** Every table, for coverage tests. */
export function localeTable(locale: Locale): LocaleTable {
  return TABLES[locale];
}

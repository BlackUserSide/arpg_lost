// Bundled fonts: @font-face rules with unicode ranges in fonts.css (Latin incl. German, Latin Extended for Polish,
// Cyrillic). A subset file downloads only when text needs its glyphs.
import './fonts.css';
import type { Locale } from '../i18n';

export const HEADING_FONT = '"Cormorant SC", Georgia, serif';
export const BODY_FONT = '"PT Sans", "Trebuchet MS", sans-serif';

/**
 * Sample glyphs per locale: loading a face for them pulls in the matching subsets. Cyrillic only for Ukrainian, Latin
 * Extended only for Polish (German letters are in Latin). Text in another script outside its locale (a Cyrillic or
 * Polish player name) may briefly use a fallback font.
 */
const SAMPLES: Readonly<Record<Locale, string>> = { en: 'A', uk: 'AЯ', de: 'Aß', pl: 'Aąłż' };

/** Loads the faces (heading, body, bold body) needed to draw `sample`; never throws, never blocks on failure. */
export async function loadGlyphs(sample: string): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`700 32px ${HEADING_FONT}`, sample),
      document.fonts.load(`400 16px ${BODY_FONT}`, sample),
      document.fonts.load(`700 16px ${BODY_FONT}`, sample),
    ]);
  } catch {
    // Fallback fonts are fine; never block the game on fonts.
  }
}

/** Canvas text needs fonts loaded before first draw, otherwise Phaser bakes fallback glyphs. */
export function loadFonts(locale: Locale): Promise<void> {
  return loadGlyphs(SAMPLES[locale]);
}

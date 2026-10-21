// Bundled fonts (OFL, see assets/LICENSES.md). Only the subsets we render: Latin + Cyrillic.
import '@fontsource/cormorant-sc/latin-700.css';
import '@fontsource/cormorant-sc/cyrillic-700.css';
import '@fontsource/pt-sans/latin-400.css';
import '@fontsource/pt-sans/cyrillic-400.css';
import '@fontsource/pt-sans/latin-700.css';
import '@fontsource/pt-sans/cyrillic-700.css';

export const HEADING_FONT = '"Cormorant SC", Georgia, serif';
export const BODY_FONT = '"PT Sans", "Trebuchet MS", sans-serif';

/** Canvas text needs fonts loaded before first draw, otherwise Phaser bakes fallback glyphs. */
export async function loadFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`700 32px ${HEADING_FONT}`, 'AЯ'),
      document.fonts.load(`400 16px ${BODY_FONT}`, 'AЯ'),
      document.fonts.load(`700 16px ${BODY_FONT}`, 'AЯ'),
    ]);
  } catch {
    // Fallback fonts are fine; never block the game on fonts.
  }
}

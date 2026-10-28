// The closed-beta code hash recipe, shared by the build (vite.config.ts, Node) and the browser (betaAccess.ts).
// No imports on purpose: vite.config.ts loads this file directly.

/** Public salt: makes the baked hash useless for lookup tables of common words. Changing it invalidates saved access. */
export const BETA_SALT = 'arpg-lost/closed-beta/v1:';

/** Case and spacing do not matter: "  Ember Gate " and "embergate" are the same code. */
export function normalizeBetaCode(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** The exact string that is hashed with SHA-256 (build time in Node, run time in the browser). */
export function betaHashInput(code: string): string {
  return BETA_SALT + normalizeBetaCode(code);
}

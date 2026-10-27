/** Game version from package.json (vite define). */
declare const __APP_VERSION__: string;

/**
 * Closed-beta access gate: salted SHA-256 (hex) of the access code, baked in by vite.config.ts from the BETA_CODE env
 * var; empty when the build has no gate (dev, CrazyGames release). See platform/betaAccess.ts.
 */
declare const __BETA_CODE_HASH__: string;

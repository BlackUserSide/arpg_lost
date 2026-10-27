/** Game version from package.json (vite define). */
declare const __APP_VERSION__: string;

/**
 * Closed-beta access gate: salted SHA-256 (hex) of the access code, baked in by vite.config.ts from the BETA_CODE env
 * var; empty when the build has no gate (dev, CrazyGames release). See platform/betaAccess.ts.
 */
declare const __BETA_CODE_HASH__: string;

/**
 * QA panel available (render/qaPanel.ts, 7 taps on the menu's version label): true in dev and the gated closed-beta
 * build, false in the CrazyGames release build (the panel is not bundled there). Set by vite.config.ts.
 */
declare const __QA_MODE__: boolean;

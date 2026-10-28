import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { betaHashInput, normalizeBetaCode } from './src/platform/betaHash.ts';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Closed-beta gate (src/platform/betaAccess.ts): only the test build on GitHub Pages sets BETA_CODE (a GitHub Actions
// secret). Only its salted SHA-256 goes into the bundle; without BETA_CODE (dev, CrazyGames release) there is no gate.
// No VITE_ prefix on purpose: Vite never exposes the plain code to client code.
const rawBetaCode = process.env.BETA_CODE ?? '';
const betaCode = rawBetaCode.trim();
// A set but blank code (only spaces) would build ungated while CI's "secret is set" check passes: refuse it.
if (rawBetaCode !== '' && normalizeBetaCode(rawBetaCode) === '') {
  throw new Error('BETA_CODE is set but blank after normalization (only whitespace): set a real access code, or unset BETA_CODE for an ungated build.');
}
const betaCodeHash = betaCode === '' ? '' : createHash('sha256').update(betaHashInput(betaCode), 'utf8').digest('hex');
if (betaCodeHash !== '') console.log('[beta] closed-beta access gate is ON in this build');

// QA panel (render/qaPanel.ts, unlocked by 7 taps on the version label; designer decision: in every closed-beta build).
// On in dev and in the gated test build (GitHub Pages), off in an ungated build (the CrazyGames release ZIP), where the
// panel code is not even bundled. QA_MODE=1 / QA_MODE=0 overrides either way (CI's release job sets 0 explicitly).
const qaMode = (command: 'build' | 'serve'): boolean => {
  const forced = process.env.QA_MODE?.trim();
  if (forced === '1') return true;
  if (forced === '0') return false;
  if (forced !== undefined && forced !== '') throw new Error(`QA_MODE must be 1 or 0, got "${forced}".`);
  return command === 'serve' || betaCodeHash !== '';
};

export default defineConfig(({ command }) => {
  const qa = qaMode(command);
  if (command === 'build') console.log(`[qa] QA panel is ${qa ? 'ON' : 'OFF'} in this build`);
  return {
    // Relative paths: the game runs inside the CrazyGames iframe and from GitHub Pages subfolder.
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __BETA_CODE_HASH__: JSON.stringify(betaCodeHash),
      __QA_MODE__: JSON.stringify(qa),
    },
    build: {
      target: 'es2022',
      assetsInlineLimit: 0,
    },
    test: {
      include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
      environment: 'node',
    },
  };
});

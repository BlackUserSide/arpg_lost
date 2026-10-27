import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { betaHashInput } from './src/platform/betaHash.ts';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Closed-beta gate (src/platform/betaAccess.ts): only the test build on GitHub Pages sets BETA_CODE (a GitHub Actions
// secret). Only its salted SHA-256 goes into the bundle; without BETA_CODE (dev, CrazyGames release) there is no gate.
// No VITE_ prefix on purpose: Vite never exposes the plain code to client code.
const betaCode = process.env.BETA_CODE?.trim() ?? '';
const betaCodeHash = betaCode === '' ? '' : createHash('sha256').update(betaHashInput(betaCode), 'utf8').digest('hex');
if (betaCodeHash !== '') console.log('[beta] closed-beta access gate is ON in this build');

export default defineConfig({
  // Relative paths: the game runs inside the CrazyGames iframe and from GitHub Pages subfolder.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BETA_CODE_HASH__: JSON.stringify(betaCodeHash),
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths: the game runs inside the CrazyGames iframe and from GitHub Pages subfolder.
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});

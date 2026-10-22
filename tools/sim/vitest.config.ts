import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Balance simulations (not part of `npm test`): npx vitest run --config tools/sim/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tools/sim/**/*.sim.ts'],
    environment: 'node',
    testTimeout: 600_000,
  },
});

// Sanity of the map environment looks (src/data/environments.ts).
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT, environments } from './environments';

describe('environments', () => {
  it('ids match keys; the default exists', () => {
    for (const [id, env] of Object.entries(environments)) expect(env.id).toBe(id);
    expect(environments[DEFAULT_ENVIRONMENT]).toBeDefined();
  });

  it('every floor has plain tiles, detail tiles come with a period, slabs with stone and grass colours', () => {
    for (const env of Object.values(environments)) {
      const f = env.floor;
      expect(f.plain.length, env.id).toBeGreaterThan(0);
      if (f.detail.length > 0) expect(f.detailEvery, env.id).toBeGreaterThan(0);
      if (f.slabs) {
        expect(f.slabs.stones.length, env.id).toBeGreaterThan(0);
        expect(f.slabs.grass.length, env.id).toBeGreaterThan(0);
        expect(f.slabs.goldEvery, env.id).toBeGreaterThan(0);
      }
    }
  });

  it('light: darkness is an alpha in [0, 1]', () => {
    for (const env of Object.values(environments)) {
      expect(env.light.darkness, env.id).toBeGreaterThanOrEqual(0);
      expect(env.light.darkness, env.id).toBeLessThanOrEqual(1);
    }
  });
});

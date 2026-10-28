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

  it('glows and fog are alphas in [0, 1]; counts are whole and not negative', () => {
    const alpha = (v: number, label: string): void => {
      expect(v, label).toBeGreaterThanOrEqual(0);
      expect(v, label).toBeLessThanOrEqual(1);
    };
    const count = (v: number, label: string): void => {
      expect(Number.isInteger(v) && v >= 0, label).toBe(true);
    };
    for (const env of Object.values(environments)) {
      if (env.bedrock) {
        alpha(env.bedrock.chasmGlowAlpha, env.id);
        for (const n of [env.bedrock.boulders, env.bedrock.stalagmites, env.bedrock.chasms]) count(n, env.id);
      }
      const c = env.crypt;
      if (c) {
        for (const a of [c.candles.alpha, c.braziers.alpha, c.fog.alpha, c.wisps.alpha]) alpha(a, env.id);
        for (const n of [c.candles.count, c.braziers.count, c.fog.count, c.wisps.count]) count(n, env.id);
      }
      if (env.decor) alpha(env.decor.rays.alpha, env.id);
    }
  });

  it('light: darkness is an alpha in [0, 1]', () => {
    for (const env of Object.values(environments)) {
      expect(env.light.darkness, env.id).toBeGreaterThanOrEqual(0);
      expect(env.light.darkness, env.id).toBeLessThanOrEqual(1);
    }
  });
});

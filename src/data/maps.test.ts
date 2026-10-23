// Sanity of the map run data (src/data/maps.ts): every reference resolves and every point is reachable.
import { describe, expect, it } from 'vitest';
import { distance, type Vec2 } from '../core/math';
import { content } from './index';
import { mapsData } from './maps';

const inside = (p: Vec2, w: number, h: number): boolean => p.x > 0 && p.y > 0 && p.x < w && p.y < h;

describe('map data', () => {
  const templates = Object.values(mapsData.templates);

  it('has enough combat templates for a run without repeats, and a boss room', () => {
    expect(templates.filter((t) => t.kind === 'combat').length).toBeGreaterThanOrEqual(mapsData.rules.combatRooms);
    expect(templates.some((t) => t.kind === 'boss')).toBe(true);
  });

  it('templates: ids match keys; entry, exit, altar, boss and spawn points inside the room and outside obstacles', () => {
    for (const [id, t] of Object.entries(mapsData.templates)) {
      expect(t.id).toBe(id);
      const points = [t.entry, ...t.spawnPoints, ...(t.kind === 'combat' ? [t.exit] : [t.altar, t.bossSpawn])];
      expect(t.spawnPoints.length).toBeGreaterThan(0);
      for (const p of points) {
        expect(inside(p, t.width, t.height), `${id} ${JSON.stringify(p)}`).toBe(true);
        for (const o of t.obstacles ?? []) expect(distance(p, o.pos), `${id} ${JSON.stringify(p)}`).toBeGreaterThan(o.radius);
      }
      // Waves never spawn on top of the hero entering the room.
      for (const s of t.spawnPoints) expect(distance(s, t.entry), id).toBeGreaterThanOrEqual(400);
    }
  });

  it('mobs of waves and the boss exist; ranges are ordered', () => {
    const { waves, elites, boss } = mapsData.rules;
    for (const e of waves.mobPool) expect(content.mobs[e.mobId], e.mobId).toBeDefined();
    expect(content.mobs[boss.mobId]).toBeDefined();
    for (const r of [waves.count, waves.mobs, elites.count]) expect(r.min).toBeLessThanOrEqual(r.max);
    expect(waves.mobPool.some((e) => (e.minMapLevel ?? 1) <= 1 && e.weight > 0)).toBe(true);
  });

  it('designer rules: 5:00 limit, linear maps to 40, item level at most map + 3, essence 0.1 / 0.5', () => {
    expect(mapsData.rules.timeLimit).toBe(300);
    expect(mapsData.rules.maxLinearMap).toBe(40);
    expect(mapsData.rewards.chest.maxItemLevelBonus).toBe(3);
    expect(mapsData.rewards.chest.bossItemLevelBonus).toBe(1);
    expect(mapsData.rewards.essence).toEqual({ perElite: 0.1, perBoss: 0.5 });
    expect(mapsData.rewards.bossRoomConsolationItems).toBe(1);
  });
});

describe('map data invariants', () => {
  it('time warnings are in descending order of seconds (fireTimeWarnings walks them in order without sorting)', () => {
    const w = mapsData.rules.timeWarnings;
    for (let i = 1; i < w.length; i++) expect(w[i]!, `timeWarnings[${i}]`).toBeLessThan(w[i - 1]!);
    for (const s of w) expect(s).toBeLessThan(mapsData.rules.timeLimit);
  });

  it('obstacles leave room for the largest body (ranked radius scaling included) to pass walls and each other', () => {
    const { elites, boss } = mapsData.rules;
    const maxScale = Math.max(1, elites.scaling.radius, boss.scaling.radius);
    const bodies = [...Object.values(content.mobs).map((m) => m.radius * maxScale), ...Object.values(content.classes).map((c) => c.radius)];
    const body = Math.max(...bodies);
    // A body passes a gap when the gap is at least its diameter.
    const passage = 2 * body;
    for (const t of Object.values(mapsData.templates)) {
      const obstacles = t.obstacles ?? [];
      obstacles.forEach((o, i) => {
        const label = `${t.id} obstacle ${i}`;
        for (const wall of [o.pos.x, o.pos.y, t.width - o.pos.x, t.height - o.pos.y]) expect(wall - o.radius, label).toBeGreaterThanOrEqual(passage);
        for (const other of obstacles.slice(i + 1)) expect(distance(o.pos, other.pos) - o.radius - other.radius, label).toBeGreaterThanOrEqual(passage);
      });
    }
  });
});

// Sanity of the map run data (src/data/maps.ts): every reference resolves and every point is reachable.
import { describe, expect, it } from 'vitest';
import { distance, type Vec2 } from '../core/math';
import { eliteModifierPoolAt, mobLevelScaling, mobPoolAt } from '../core/run/run';
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

  it('elite modifiers (mobs.md «Еліти»): fast / fat / fiery / explosive, all defined, available from map 1', () => {
    const pool = mapsData.rules.elites.modifiers ?? [];
    expect(pool.map((e) => e.id)).toEqual(['fast', 'fat', 'fiery', 'explosive']);
    for (const e of pool) {
      expect(content.eliteModifiers?.[e.id]?.id, e.id).toBe(e.id);
      expect(e.weight, e.id).toBeGreaterThan(0);
    }
    expect(eliteModifierPoolAt(mapsData.rules, 1).map((e) => e.id)).toEqual(['fast', 'fat', 'fiery', 'explosive']);
    for (const [id, def] of Object.entries(content.eliteModifiers ?? {})) expect(def.id).toBe(id);
    // The explosion must be escapable: the slowest hero leaves the circle well within its delay.
    const zone = content.eliteModifiers?.explosive?.deathZone;
    if (!zone) throw new Error('explosive has no death zone');
    const slowest = Math.min(...Object.values(content.classes).map((c) => c.baseStats.movementSpeed ?? 0));
    const maxHeroRadius = Math.max(...Object.values(content.classes).map((c) => c.radius));
    expect((zone.radius + maxHeroRadius) / slowest).toBeLessThan(zone.delay * 0.75);
    // A fast elite never outruns the heroes (fastest mob × moveSpeed below the slowest hero).
    const fastest = Math.max(...Object.values(content.mobs).filter((m) => !m.boss).map((m) => m.moveSpeed));
    expect(fastest * (content.eliteModifiers?.fast?.moveSpeed ?? 1)).toBeLessThan(slowest);
  });

  it('a new mob type every 5 map levels (mobs.md 2026-10-25): ordinary mobs, unlocked at 5 / 10 / 15 / 20', () => {
    const at = (level: number): string[] => mobPoolAt(mapsData.rules, level).map((e) => e.mobId);
    expect(at(1)).toEqual(['zombie', 'runner', 'archer']);
    expect(at(4)).toEqual(at(1));
    expect(at(5)).toEqual([...at(1), 'shieldbearer']);
    expect(at(10)).toEqual([...at(5), 'boneThrower']);
    expect(at(15)).toEqual([...at(10), 'gravedigger']);
    expect(at(20)).toEqual([...at(15), 'cultist']);
    expect(at(mapsData.rules.maxLinearMap)).toEqual(at(20));
    for (const e of mapsData.rules.waves.mobPool) {
      const def = content.mobs[e.mobId]!;
      expect(def.boss, e.mobId).toBeFalsy();
      expect(def.abilities?.phases ?? [], e.mobId).toEqual([]);
    }
  });

  it('mob growth: × 1 on map 1, then life, damage and armour grow with every map level', () => {
    expect(mobLevelScaling(mapsData.rules, 1)).toEqual({ life: 1, damage: 1, armour: 1 });
    for (let level = 2; level <= mapsData.rules.maxLinearMap; level++) {
      const prev = mobLevelScaling(mapsData.rules, level - 1);
      const now = mobLevelScaling(mapsData.rules, level);
      expect(now.life, `life ${level}`).toBeGreaterThan(prev.life);
      expect(now.damage, `damage ${level}`).toBeGreaterThan(prev.damage);
      expect(now.armour, `armour ${level}`).toBeGreaterThan(prev.armour);
    }
  });

  it('mob growth stays in the band checked by tools/sim/mobScaling.sim.ts (re-run the sim when this fails)', () => {
    // Hero power grows ×5–8 by map 10 and ×15–20 by 40 (average gear), ×10 more with crafted gear; outside these
    // bands average heroes one-shot everything or geared heroes leave the 1–2 hit / 5:00 targets.
    const at = (level: number) => mobLevelScaling(mapsData.rules, level);
    expect(at(10).life).toBeGreaterThan(4);
    expect(at(10).life).toBeLessThan(9);
    expect(at(40).life).toBeGreaterThan(35);
    expect(at(40).life).toBeLessThan(70);
    // Damage grows slower than life (hero life + ES only ×3–4 by map 40), armour no faster than life (no armour wall).
    for (let level = 2; level <= mapsData.rules.maxLinearMap; level++) {
      expect(at(level).damage, `damage ${level}`).toBeLessThan(at(level).life);
      expect(at(level).armour, `armour ${level}`).toBeLessThanOrEqual(at(level).life);
    }
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

// The 0.4 map mob types (docs/design/mobs.md, decision 2026-10-25) from game data: ordinary (non-boss) mobs that use
// the generic mob ability AI (abilities.ts), the shieldbearer's armour, the cultist's rewardless minions.
import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import { content as gameContent } from '../../data';
import { mitigate } from '../combat/mitigation';
import type { Content } from './content';
import { createWorld, spawnMob, step, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;
const idle: PlayerInput = { move: vec(0, 0), aim: vec(0, 0), basicAttack: false, skills: [] };

/** An idle mage at (700, 800) who cannot die (the tests watch the mobs, not the hero). */
function place(content: Content = gameContent): WorldState {
  return createWorld(content, 'mage', 3, { modifiers: [{ stat: 'life', kind: 'flat', value: 1e6 }] }, 1, {
    bounds: { width: 1400, height: 1000 },
    start: vec(700, 800),
    endless: false,
  });
}

/** Runs `steps` steps; every event of `type` with its 1-based step number. */
function timeline<T extends WorldEvent['type']>(world: WorldState, content: Content, steps: number, type: T): { step: number; event: Extract<WorldEvent, { type: T }> }[] {
  const out: { step: number; event: Extract<WorldEvent, { type: T }> }[] = [];
  for (let i = 1; i <= steps; i++) {
    for (const e of step(world, idle, content, DT)) if (e.type === type) out.push({ step: i, event: e as Extract<WorldEvent, { type: T }> });
  }
  return out;
}

describe('map mobs (game data)', () => {
  it('the shieldbearer: armour halves a 9-damage physical hit (map 1 armour 45), elements pass in full', () => {
    const def = gameContent.mobs.shieldbearer!;
    const defences = { armour: def.armour, resistances: def.resistances };
    expect(mitigate({ physical: 9 }, defences, gameContent.combat)).toEqual({ physical: 4.5 });
    expect(mitigate({ fire: 16, cold: 16, lightning: 16 }, defences, gameContent.combat)).toEqual({ fire: 16, cold: 16, lightning: 16 });
    expect(def.abilities).toBeUndefined();
  });

  it('the bone thrower (not a boss) winds up a fan of 3 bones at 1.5 s; it resolves 0.6 s later', () => {
    const world = place();
    const mob = spawnMob(world, gameContent, { defId: 'boneThrower' }, vec(700, 300), []);
    expect(mob.rank).toBeUndefined();
    const casts = timeline(world, gameContent, 130, 'mobCast');
    expect(casts.map((c) => [c.step, c.event.abilityId])).toEqual([[90, 'boneFan']]);
    const fan = world.projectiles.filter((p) => p.abilityId === 'boneFan');
    expect(fan).toHaveLength(3);
    expect(fan.every((p) => p.owner === 'mob' && p.sourceId === 'boneThrower' && p.speed === 220)).toBe(true);
  });

  it('the gravedigger marks the ground under the hero (cast at 2 s, zone 0.4 s later) and it erupts 1 s after that', () => {
    const world = place();
    spawnMob(world, gameContent, { defId: 'gravedigger' }, vec(700, 300), []);
    const spawned: number[] = [];
    const erupted: { step: number; hit: boolean }[] = [];
    let castStep = 0;
    for (let i = 1; i <= 210; i++) {
      for (const e of step(world, idle, gameContent, DT)) {
        if (e.type === 'mobCast' && castStep === 0) castStep = i;
        if (e.type === 'hostileZoneSpawn') {
          spawned.push(i);
          expect(e.pos).toEqual(vec(700, 800));
          expect(e.radius).toBe(55);
        }
        if (e.type === 'hostileZoneErupt') erupted.push({ step: i, hit: e.hit });
      }
    }
    expect(castStep).toBe(120);
    expect(spawned).toEqual([144]);
    // The placement step already counts (updateHostileZones): 60 steps including step 144.
    expect(erupted).toEqual([{ step: 203, hit: true }]);
  });

  it('the cultist raises 2 zombies every 6 s, at most 4 of its own alive', () => {
    const world = place();
    const cultist = spawnMob(world, gameContent, { defId: 'cultist' }, vec(700, 300), []);
    const raised = timeline(world, gameContent, 15 * 60, 'mobAbility');
    // Casts at 2 s and 8 s (cooldown from the cast start), each resolving after the 1 s wind-up; at 14 s 4 are alive.
    expect(raised.map((r) => r.step)).toEqual([180, 540]);
    const minions = world.mobs.filter((m) => m.summonerId === cultist.id);
    expect(minions.map((m) => m.defId)).toEqual(['zombie', 'zombie', 'zombie', 'zombie']);
  });

  it("the cultist's zombies give nothing (kills, XP, supports) and crumble when it dies", () => {
    const supports = gameContent.supports!;
    // Every ordinary kill drops a support: a drop beyond the cultist's would come from a zombie.
    const content: Content = { ...gameContent, supports: { ...supports, rules: { ...supports.rules, dropChance: { normal: 1, elite: 1, boss: 1 } } } };
    const world = place(content);
    const cultist = spawnMob(world, content, { defId: 'cultist' }, vec(700, 300), []);
    timeline(world, content, 180, 'mobAbility');
    const minionIds = world.mobs.filter((m) => m.summonerId === cultist.id).map((m) => m.id);
    expect(minionIds).toHaveLength(2);
    expect(world.kills).toBe(0);
    cultist.life = 0;
    const events = step(world, idle, content, DT);
    expect(events.flatMap((e) => (e.type === 'death' ? [e.id] : []))).toEqual([cultist.id, ...minionIds]);
    expect(world.mobs).toEqual([]);
    expect(world.kills).toBe(1);
    expect(world.xpGained).toBe(content.mobs.cultist!.xp);
    expect(world.supportDrops).toHaveLength(1);
  });
});

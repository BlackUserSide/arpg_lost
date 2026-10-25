// Skill level-3 effect mechanics (docs/design/classes.md «Ефекти 3-го рівня»): arc every-N-th swing, dash landing,
// ground zones (fire puddle, ice field), decoy, projectile split. Mechanics are tested on small data; the last
// block checks the real level-3 data end to end.
import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data/index';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { createWorld, step, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 1000,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};
const boss: MobDef = { ...dummy, id: 'boss', boss: true };
const walker: MobDef = { ...dummy, id: 'walker', moveSpeed: 60, attack: { ...dummy.attack, interval: 0.5 } };
const bossWalker: MobDef = { ...walker, id: 'bossWalker', boss: true };
const shooter: MobDef = {
  ...dummy,
  id: 'shooter',
  moveSpeed: 60,
  preferredRange: 150,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 300, interval: 0.5, critChance: 0, projectile: { speed: 300, radius: 4 } },
};

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};

function hero(skills: ActionDef[]): ClassDef {
  return {
    id: 'hero',
    radius: 10,
    weaponType: 'sword',
    baseStats: { life: 100, resource: 100, resourceRegen: 0, movementSpeed: 100 },
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack: strike,
    skills,
  };
}

function makeContent(skills: ActionDef[]): Content {
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.6, maxLifeCostFraction: 0.9 },
    classes: { hero: hero(skills) },
    mobs: { dummy, boss, walker, bossWalker, shooter },
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
    progression: {
      maxLevel: 5,
      xpCurve: { base: 1000, exponent: 1 },
      mobXpGrowth: 0,
      lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
      mapClearBonus: 0.1,
      perLevel: {},
    },
  };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const useSkill = (slot: number, aim = idle.aim): PlayerInput => ({ ...idle, aim, skills: Array.from({ length: slot + 1 }, (_, i) => i === slot) });

function addMob(world: WorldState, x: number, y: number, defId = 'dummy', life = 1000): MobState {
  const mob: MobState = { id: world.nextId++, defId, pos: vec(x, y), facing: vec(0, 1), life, maxLife: life, attackTimer: 10, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: 10 };
  world.mobs.push(mob);
  return mob;
}

function run(world: WorldState, content: Content, input: PlayerInput, steps: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, content, DT));
  return events;
}

const areas = (events: readonly WorldEvent[]): Extract<WorldEvent, { type: 'area' }>[] => events.filter((e): e is Extract<WorldEvent, { type: 'area' }> => e.type === 'area');

describe('level effect: arc every N-th use', () => {
  const swing: ActionDef = { ...strike, id: 'swing', delivery: { kind: 'arc', radius: 50, angleDeg: 90, everyNth: { every: 3, angleDeg: 360 } } };

  it('every 3rd swing is a full circle, counted over the run', () => {
    const content = makeContent([swing]);
    const world = createWorld(content, 'hero', 1);
    const behind = addMob(world, 460, 500);
    const lives: number[] = [];
    const events: WorldEvent[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(...run(world, content, useSkill(0), 30));
      lives.push(behind.life);
    }
    expect(areas(events).map((a) => [a.angleDeg, a.trigger])).toEqual([
      [90, undefined],
      [90, undefined],
      [360, 'everyNth'],
      [90, undefined],
      [90, undefined],
      [360, 'everyNth'],
    ]);
    expect(lives).toEqual([1000, 1000, 990, 990, 990, 980]);
    expect(world.player.useCounts).toEqual({ swing: 6 });
  });

  it('only actions with a rhythm are counted', () => {
    const content = makeContent([{ ...swing, delivery: { kind: 'arc', radius: 50, angleDeg: 90 } }]);
    const world = createWorld(content, 'hero', 1);
    run(world, content, useSkill(0), 30);
    expect(world.player.useCounts).toEqual({});
  });
});

describe('level effect: dash landing', () => {
  const charge: ActionDef = {
    id: 'charge',
    tags: ['attack', 'melee'],
    resourceCost: 0,
    cooldown: 4,
    damage: { source: 'weapon', effectiveness: 1 },
    delivery: { kind: 'dash', distance: 100, speed: 1000, hitRadius: 10, landing: { radius: 60, effectiveness: 0.5 } },
    onHit: [{ status: 'stun', duration: 1 }],
  };

  it('the landing hits everyone around the end point (path targets again) and stuns; bosses get the stun-slow', () => {
    const content = makeContent([charge]);
    const world = createWorld(content, 'hero', 1);
    const onPath = addMob(world, 550, 500);
    const beside = addMob(world, 600, 560);
    const big = addMob(world, 640, 500, 'boss');
    const far = addMob(world, 700, 500);
    const events: WorldEvent[] = [];
    // Step until the landing (the step's mob update then runs 1 dt of the new stun).
    for (let i = 0; i < 20 && !areas(events).some((a) => a.trigger === 'dashLanding'); i++) events.push(...step(world, useSkill(0), content, DT));
    expect(world.player.pos.x).toBeCloseTo(600, 6);
    const landing = areas(events).filter((a) => a.trigger === 'dashLanding');
    expect(landing).toHaveLength(1);
    expect(landing[0]).toMatchObject({ actionId: 'charge', radius: 60, angleDeg: 360 });
    expect(landing[0]!.origin.x).toBeCloseTo(600, 6);
    expect(onPath.life).toBe(985);
    expect(beside.life).toBe(995);
    expect(big.life).toBe(995);
    expect(far.life).toBe(1000);
    expect(beside.stun).toBeCloseTo(1 - DT, 10);
    expect(onPath.stun).toBeCloseTo(1 - DT, 10);
    expect(big.stun).toBe(0);
    expect(big.stunSlow).toBeCloseTo(1 - DT, 10);
  });

  it('a dash stopped by the arena edge lands there; a dash without landing has none', () => {
    const content = makeContent([charge]);
    const world = createWorld(content, 'hero', 1);
    world.player.pos = vec(950, 500);
    const mob = addMob(world, 960, 540);
    const events = run(world, content, useSkill(0), 10);
    expect(world.player.pos.x).toBe(990);
    expect(areas(events).filter((a) => a.trigger === 'dashLanding')).toHaveLength(1);
    expect(mob.life).toBe(995);

    const plain = makeContent([{ ...charge, delivery: { kind: 'dash', distance: 100, speed: 1000, hitRadius: 10 } }]);
    const w2 = createWorld(plain, 'hero', 1);
    expect(areas(run(w2, plain, useSkill(0), 10))).toEqual([]);
  });
});

describe('level effect: ground zones', () => {
  const trap = (zoneDamage = true): ActionDef => ({
    id: 'trap',
    tags: ['area'],
    resourceCost: 0,
    cooldown: 5,
    castTime: 0,
    damage: { source: 'skill', base: { fire: { min: 10, max: 10 } }, critChance: 0 },
    delivery: { kind: 'trap', throwRange: 100, armTime: 0, triggerRadius: 30, explodeRadius: 50, lifetime: 10 },
    zone: { id: 'fire_puddle', duration: 3, radius: 40, ...(zoneDamage ? { tick: { interval: 0.5, damage: { fire: { min: 4, max: 4 } } } } : {}) },
  });

  it('a fire puddle ticks every 0.5 s for 3 s (6 ticks), then expires', () => {
    const content = makeContent([trap()]);
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 600, 500);
    const outside = addMob(world, 600, 560);
    const first = step(world, useSkill(0, vec(600, 500)), content, DT);
    expect(mob.life).toBe(990);
    const spawn = first.find((e) => e.type === 'zoneSpawn');
    expect(spawn).toMatchObject({ kind: 'fire_puddle', actionId: 'trap', radius: 40, duration: 3 });
    expect(spawn && 'pos' in spawn ? spawn.pos : null).toEqual(vec(600, 500));
    expect(world.zones).toHaveLength(1);

    let events = run(world, content, idle, 28);
    expect(mob.life).toBe(990);
    events = run(world, content, idle, 1);
    expect(mob.life).toBe(986);
    expect(events).toContainEqual({ type: 'hit', targetId: mob.id, pos: mob.pos, amount: 4, isCrit: false, source: 'zone', zoneId: world.zones[0]!.id });

    const zoneId = world.zones[0]!.id;
    events = run(world, content, idle, 149);
    expect(mob.life).toBe(970);
    expect(events).not.toContainEqual({ type: 'zoneExpire', zoneId });
    events = run(world, content, idle, 1);
    expect(mob.life).toBe(966);
    expect(events).toContainEqual({ type: 'zoneExpire', zoneId });
    expect(world.zones).toEqual([]);
    expect(outside.life).toBe(990);
    run(world, content, idle, 60);
    expect(mob.life).toBe(966);
  });

  it('zone ticks scale with increased / more damage but not flat added damage; they never crit, leech or fill resource', () => {
    const content = makeContent([trap()]);
    const world = createWorld(content, 'hero', 1, {
      modifiers: [
        { stat: 'damage', kind: 'increased', value: 0.5 },
        { stat: 'damage', kind: 'flat', value: 100, damageType: 'fire' },
      ],
    });
    const mob = addMob(world, 600, 500);
    step(world, useSkill(0, vec(600, 500)), content, DT);
    const afterExplosion = mob.life;
    expect(afterExplosion).toBe(1000 - (10 + 100) * 1.5);
    run(world, content, idle, 29);
    expect(mob.life).toBe(afterExplosion - 6);
  });

  it('a hero ignite source can ignite from the puddle; without one it never ignites', () => {
    // A trap without explosion damage, so the only fire hits are the puddle's ticks.
    const { damage, ...dry } = trap();
    void damage;
    const content = makeContent([dry]);
    const ignite: PassiveMechanic = { kind: 'ignite', damageType: 'fire', chance: 1, damageFraction: 0.5, duration: 2 };
    const withIgnite = createWorld(content, 'hero', 1, { mechanics: [ignite] });
    const a = addMob(withIgnite, 600, 500);
    run(withIgnite, content, useSkill(0, vec(600, 500)), 1);
    expect(a.ignite).toBe(0);
    run(withIgnite, content, idle, 29);
    expect(a.life).toBe(996);
    expect(a.ignite).toBe(2);
    expect(a.igniteDps).toBe(1);

    const plain = createWorld(content, 'hero', 1);
    const b = addMob(plain, 600, 500);
    run(plain, content, useSkill(0, vec(600, 500)), 30);
    expect(b.life).toBe(996);
    expect(b.ignite).toBe(0);
  });

  it('a projectile explosion zone keeps the cast snapshot, without the hit-only distanceDamage bonus', () => {
    const shot: ActionDef = {
      id: 'shot',
      tags: ['attack', 'projectile'],
      resourceCost: 0,
      cooldown: 5,
      damage: { source: 'skill', base: { fire: { min: 10, max: 10 } }, critChance: 0 },
      delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 400, radius: 5, pierce: 0, explodeRadius: 30 },
      zone: { id: 'fire_puddle', duration: 3, radius: 40, tick: { interval: 0.5, damage: { fire: { min: 4, max: 4 } } } },
    };
    const content = makeContent([shot]);
    const farShot: PassiveMechanic = { kind: 'distanceDamage', tags: ['attack', 'projectile'], minDistance: 0, maxDistance: 100, maxMore: 1 };
    const world = createWorld(content, 'hero', 1, { mechanics: [farShot] });
    const mob = addMob(world, 800, 500);
    const events = run(world, content, useSkill(0), 1);
    for (let i = 0; i < 60 && world.zones.length === 0; i++) events.push(...run(world, content, idle, 1));
    // The explosion hit flew ≥ 100: +100% more damage.
    expect(mob.life).toBe(980);
    expect(world.zones).toHaveLength(1);
    expect(world.zones[0]!.castModifiers).toEqual([]);
    run(world, content, idle, 30);
    // The puddle tick is not doubled.
    expect(mob.life).toBe(976);
  });

  it('an ice field left by a nova slows mobs inside while it lasts; it never damages or freezes', () => {
    const nova: ActionDef = {
      id: 'nova',
      tags: ['spell', 'area'],
      resourceCost: 0,
      cooldown: 3,
      castTime: 0.4,
      delivery: { kind: 'arc', radius: 100, angleDeg: 360 },
      onHit: [{ status: 'slow', duration: 0.5, magnitude: 0.4 }],
      zone: { id: 'ice_field', duration: 3, slow: 0.3 },
    };
    const content = makeContent([nova]);
    const world = createWorld(content, 'hero', 1);
    const inside = addMob(world, 600, 500, 'walker');
    const outside = addMob(world, 800, 500, 'walker');
    const events = step(world, useSkill(0), content, DT);
    expect(events.find((e) => e.type === 'zoneSpawn')).toMatchObject({ kind: 'ice_field', radius: 100, duration: 3 });
    expect(inside.auraSlow).toBe(0.3);
    expect(outside.auraSlow).toBe(0);
    run(world, content, idle, 120);
    expect(inside.auraSlow).toBe(0.3);
    expect(inside.freeze).toBe(0);
    expect(inside.life).toBe(1000);
    run(world, content, idle, 59);
    expect(world.zones).toEqual([]);
    expect(inside.auraSlow).toBe(0);
  });
});

describe('level effect: decoy', () => {
  const roll: ActionDef = {
    id: 'roll',
    tags: [],
    resourceCost: 0,
    cooldown: 3,
    castTime: 0,
    delivery: { kind: 'dash', distance: 200, speed: 1000, hitRadius: 0 },
    selfEffects: [{ kind: 'decoy', id: 'roll_decoy', duration: 2, tauntRadius: 300 }],
  };

  it('a decoy at the roll start draws nearby mobs for 2 s: their swings do nothing; then they return to the hero', () => {
    const content = makeContent([roll]);
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 400, 500, 'walker');
    mob.attackTimer = 0;
    const events = run(world, content, useSkill(0), 1);
    const spawn = events.find((e) => e.type === 'decoySpawn');
    expect(spawn).toEqual({ type: 'decoySpawn', decoyId: world.decoys[0]!.id, kind: 'roll_decoy', pos: vec(500, 500), radius: 10, duration: 2 });
    const later = run(world, content, idle, 118);
    expect(world.player.pos.x).toBeCloseTo(700, 6);
    // The walker reached the decoy (gap ≤ 0.8 × its 5 reach) and attacks it, not the hero.
    // 1 px per step from 400 until the gap to the decoy (centre 500, radii 10 + 10) is 4.
    expect(mob.pos.x).toBeCloseTo(476, 6);
    const decoyId = world.decoys[0]!.id;
    const attacks = later.filter((e) => e.type === 'mobAttack');
    expect(attacks.length).toBeGreaterThan(0);
    // Every swing names the decoy it targets, so render does not have to guess.
    for (const attack of attacks) expect(attack).toEqual({ type: 'mobAttack', id: mob.id, decoyId });
    expect(later.filter((e) => e.type === 'hit')).toEqual([]);
    expect(world.player.life).toBe(100);
    const end = run(world, content, idle, 1);
    expect(end).toContainEqual({ type: 'decoyExpire', decoyId });
    expect(world.decoys).toEqual([]);
    const x = mob.pos.x;
    run(world, content, idle, 10);
    expect(mob.pos.x).toBeGreaterThan(x);
    expect(mob.facing).toEqual(vec(1, 0));
  });

  it('a swing at the hero carries no decoyId', () => {
    const content = makeContent([roll]);
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 522, 500, 'walker');
    mob.attackTimer = 0;
    const events = run(world, content, idle, 1);
    expect(events.filter((e) => e.type === 'mobAttack')).toEqual([{ type: 'mobAttack', id: mob.id }]);
  });

  it('bosses follow the decoy only for its first bossTauntDuration seconds; other mobs for its whole life', () => {
    const content = makeContent([{ ...roll, selfEffects: [{ kind: 'decoy', id: 'roll_decoy', duration: 2, tauntRadius: 300, bossTauntDuration: 1 }] }]);
    const world = createWorld(content, 'hero', 1);
    const big = addMob(world, 500, 700, 'bossWalker');
    const small = addMob(world, 500, 300, 'walker');
    run(world, content, useSkill(0), 1);
    expect(world.decoys[0]!.bossTauntRemaining).toBeCloseTo(1 - DT, 10);
    run(world, content, idle, 59);
    // Steps 1..60: both head for the decoy at (500, 500).
    expect(big.facing).toEqual(vec(0, -1));
    expect(small.facing).toEqual(vec(0, 1));
    expect(world.decoys[0]!.bossTauntRemaining).toBe(0);
    run(world, content, idle, 1);
    // Step 61: the boss turns to the hero at (700, 500); the walker stays on the decoy.
    expect(big.facing.x).toBeGreaterThan(0);
    expect(big.facing.y).toBeLessThan(0);
    expect(small.facing).toEqual(vec(0, 1));
  });

  it('mobs beyond the taunt radius keep chasing the hero; mob shots that touch the decoy are absorbed', () => {
    const content = makeContent([roll]);
    const world = createWorld(content, 'hero', 1);
    const far = addMob(world, 900, 900, 'walker');
    const gunner = addMob(world, 500, 300, 'shooter');
    gunner.attackTimer = 0;
    const events = run(world, content, useSkill(0), 119);
    expect(far.facing.x).toBeLessThan(0);
    expect(far.facing.y).toBeLessThan(0);
    expect(events.filter((e) => e.type === 'mobAttack' && e.id === gunner.id).length).toBeGreaterThan(1);
    expect(world.player.life).toBe(100);
  });
});

describe('level effect: projectile split', () => {
  const ball: ActionDef = {
    id: 'ball',
    tags: ['spell', 'projectile', 'area'],
    resourceCost: 0,
    cooldown: 0,
    castTime: 0.6,
    damage: { source: 'skill', base: { fire: { min: 20, max: 20 } }, critChance: 0 },
    delivery: {
      kind: 'projectile',
      count: 1,
      spreadDeg: 0,
      speed: 600,
      range: 400,
      radius: 5,
      pierce: 0,
      explodeRadius: 30,
      split: { count: 3, spreadDeg: 90, speed: 300, range: 100, radius: 4, explodeRadius: 20, damageMultiplier: 0.5 },
    },
  };

  it('the explosion scatters 3 children at half damage that skip the targets already hit and never split again', () => {
    const content = makeContent([ball]);
    const world = createWorld(content, 'hero', 1);
    const a = addMob(world, 700, 500);
    const b = addMob(world, 760, 500);
    const events = run(world, content, useSkill(0), 19);
    expect(a.life).toBe(980);
    const split = events.filter((e) => e.type === 'projectileSplit');
    expect(split).toHaveLength(1);
    const childIds = split[0]!.type === 'projectileSplit' ? split[0]!.childIds : [];
    expect(childIds).toHaveLength(3);
    expect(world.projectiles.map((p) => p.id)).toEqual(childIds);
    const dirs = world.projectiles.map((p) => [p.dir.x, p.dir.y]);
    expect(dirs[0]![0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(dirs[0]![1]).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(dirs[1]).toEqual([1, 0]);
    expect(dirs[2]![1]).toBeCloseTo(Math.SQRT1_2, 10);
    for (const p of world.projectiles) {
      expect(p.hitIds).toEqual([a.id]);
      expect(p.action?.damage).toEqual({ source: 'skill', base: { fire: { min: 10, max: 10 } }, critChance: 0 });
      expect(p.action?.delivery).toEqual({ kind: 'projectile', count: 1, spreadDeg: 0, speed: 300, range: 100, radius: 4, pierce: 0, explodeRadius: 20 });
    }
    const after = run(world, content, idle, 30);
    expect(b.life).toBe(990);
    expect(a.life).toBe(980);
    expect(after.filter((e) => e.type === 'projectileSplit')).toEqual([]);
    expect(world.projectiles).toEqual([]);
  });

  it('a ball that reaches the end of its range explodes and splits there', () => {
    const content = makeContent([ball]);
    const world = createWorld(content, 'hero', 1);
    // No targets: it flies its full 400 from x = 510 (hero edge) and explodes at x = 910, inside the arena.
    const events = run(world, content, useSkill(0), 60);
    const split = events.filter((e): e is Extract<WorldEvent, { type: 'projectileSplit' }> => e.type === 'projectileSplit');
    expect(split).toHaveLength(1);
    expect(split[0]!.pos.x).toBeCloseTo(910, 6);
    expect(split[0]!.childIds).toHaveLength(3);
    expect(areas(events).filter((a) => a.actionId === 'ball').map((a) => a.radius)).toEqual([30, 20, 20, 20]);
  });

  it('a non-exploding projectile splits when its pierce runs out, skipping contact with the targets it hit', () => {
    const bolt: ActionDef = {
      ...ball,
      delivery: {
        kind: 'projectile',
        count: 1,
        spreadDeg: 0,
        speed: 600,
        range: 400,
        radius: 5,
        pierce: 1,
        split: { count: 3, spreadDeg: 90, speed: 300, range: 100, radius: 4, damageMultiplier: 0.5 },
      },
    };
    const content = makeContent([bolt]);
    const world = createWorld(content, 'hero', 1);
    const a = addMob(world, 600, 500);
    const b = addMob(world, 700, 500);
    const events = run(world, content, useSkill(0), 30);
    expect(a.life).toBe(980);
    expect(b.life).toBe(980);
    const split = events.filter((e): e is Extract<WorldEvent, { type: 'projectileSplit' }> => e.type === 'projectileSplit');
    expect(split).toHaveLength(1);
    expect(split[0]!.pos.x).toBeGreaterThan(680);
    expect(areas(events)).toEqual([]);
    // The middle child flies on through b without touching it again; nothing else is in reach.
    run(world, content, idle, 30);
    expect(a.life).toBe(980);
    expect(b.life).toBe(980);
    expect(world.projectiles).toEqual([]);
  });

  it('no split outside the arena', () => {
    const content = makeContent([ball]);
    const world = createWorld(content, 'hero', 1);
    world.player.pos = vec(800, 500);
    // One cast (0.6 s cast time); it leaves the arena at x > 1000 on step 20 and explodes there.
    const events = run(world, content, useSkill(0), 30);
    expect(events.filter((e) => e.type === 'area')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'projectileSplit')).toEqual([]);
  });
});

describe('level effects with game data', () => {
  const allLevel3 = (classId: string): Record<string, { level: number; xp: number }> =>
    Object.fromEntries(gameContent.classes[classId]!.skills.map((s) => [s.id, { level: 3, xp: 0 }]));

  it('Cleave at level 3: the 3rd swing is a circle', () => {
    const world = createWorld(gameContent, 'warrior', 1, { skills: allLevel3('warrior') });
    world.player.resource = 100;
    const events: WorldEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(...step(world, { ...idle, skills: [true] }, gameContent, DT));
      world.player.actionTimer = 0;
    }
    expect(areas(events).map((a) => a.angleDeg)).toEqual([150, 150, 360]);
  });

  it('Frost Nova at level 3: the ice field keeps its own radius 150 when the nova radius grows', () => {
    const bigger: PassiveMechanic = { kind: 'skillParams', skillIds: ['frost_nova'], changes: [{ param: 'radius', increased: 0.2 }] };
    const world = createWorld(gameContent, 'mage', 1, { skills: allLevel3('mage'), mechanics: [bigger] });
    world.player.resource = 100;
    const events = step(world, { ...idle, skills: [false, true] }, gameContent, DT);
    expect(areas(events).map((a) => [a.actionId, a.radius])).toEqual([['frost_nova', 180]]);
    expect(events.find((e) => e.type === 'zoneSpawn')).toMatchObject({ kind: 'ice_field', actionId: 'frost_nova', radius: 150 });
  });

  it('is deterministic with every level-3 effect in play, and the world stays plain JSON', () => {
    const play = (classId: string): { log: string; world: WorldState } => {
      const world = createWorld(gameContent, classId, 42, { skills: allLevel3(classId) });
      const events: WorldEvent[] = [];
      for (let i = 0; i < 1200; i++) {
        const t = i % 120;
        const input: PlayerInput = { move: vec(Math.cos(i / 50), Math.sin(i / 70)), aim: vec(800 + 200 * Math.cos(i / 30), 550), basicAttack: true, skills: [t < 40, t >= 40 && t < 80, t >= 80] };
        events.push(...step(world, input, gameContent, DT));
      }
      return { log: JSON.stringify(events), world };
    };
    for (const classId of ['warrior', 'ranger', 'mage']) {
      const a = play(classId);
      const b = play(classId);
      expect(a.log).toBe(b.log);
      expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
      expect(JSON.parse(JSON.stringify(a.world))).toEqual(a.world);
    }
  });
});

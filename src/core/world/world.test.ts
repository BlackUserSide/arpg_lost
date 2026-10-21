import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import type { ClassDef, Content, MobDef } from './content';
import { createWorld, step, type MobState, type PlayerInput, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 100,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};

const hero: ClassDef = {
  id: 'hero',
  radius: 10,
  baseStats: { life: 50, mana: 20, manaRegen: 0, movementSpeed: 100 },
  weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
  basicAttack: { id: 'strike', tags: ['attack', 'melee'], damageEffectiveness: 1, shape: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 }, manaCost: 0, cooldown: 0 },
  skills: [
    { id: 'sweep', tags: ['attack', 'melee', 'area'], damageEffectiveness: 1, shape: { kind: 'arc', radius: 50, angleDeg: 180 }, manaCost: 8, cooldown: 0 },
    { id: 'slam', tags: ['attack', 'area'], damageEffectiveness: 2, shape: { kind: 'arc', radius: 50, angleDeg: 360 }, manaCost: 0, cooldown: 5 },
  ],
};

function makeContent(overrides: Partial<Content['arena']['spawn']> = {}): Content {
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9 },
    classes: { hero },
    mobs: { dummy },
    arena: {
      width: 1000,
      height: 1000,
      spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'], ...overrides },
    },
  };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };

function addMob(world: WorldState, x: number, y: number, life = 100): MobState {
  const mob: MobState = { id: world.nextId++, defId: 'dummy', pos: vec(x, y), life, attackTimer: 10 };
  world.mobs.push(mob);
  return mob;
}

describe('world: player', () => {
  it('moves at movement speed and stays inside the arena', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    for (let i = 0; i < 60; i++) step(world, { ...idle, move: vec(1, 0) }, content, DT);
    expect(world.player.pos.x).toBeCloseTo(600, 6);
    for (let i = 0; i < 600; i++) step(world, { ...idle, move: vec(1, 0) }, content, DT);
    expect(world.player.pos.x).toBe(990);
  });

  it('basic attack hits only the closest mob in front', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const near = addMob(world, 530, 500);
    const far = addMob(world, 545, 500);
    const behind = addMob(world, 470, 500);
    step(world, { ...idle, basicAttack: true }, content, DT);
    expect(near.life).toBe(90);
    expect(far.life).toBe(100);
    expect(behind.life).toBe(100);
  });

  it('area skill hits everything in the arc and spends mana', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const a = addMob(world, 530, 500);
    const b = addMob(world, 510, 530);
    const behind = addMob(world, 460, 500);
    step(world, { ...idle, skills: [true] }, content, DT);
    expect(a.life).toBe(90);
    expect(b.life).toBe(90);
    expect(behind.life).toBe(100);
    expect(world.player.mana).toBe(12);
  });

  it('falls back to basic attack when the skill is unaffordable', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    world.player.mana = 0;
    const mob = addMob(world, 530, 500);
    const events = step(world, { ...idle, basicAttack: true, skills: [true] }, content, DT);
    expect(events.find((e) => e.type === 'action')).toMatchObject({ actionId: 'strike' });
    expect(mob.life).toBe(90);
  });

  it('attack rate follows attacks per second', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    addMob(world, 530, 500, 1e9);
    let attacks = 0;
    for (let i = 0; i < 120; i++) {
      attacks += step(world, { ...idle, basicAttack: true }, content, DT).filter((e) => e.type === 'action').length;
    }
    expect(attacks).toBe(4); // 2 seconds * 2 attacks/s
  });

  it('skill cooldown blocks reuse until it expires', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    let uses = 0;
    for (let i = 0; i < 60 * 6; i++) {
      uses += step(world, { ...idle, skills: [false, true] }, content, DT).filter((e) => e.type === 'action').length;
    }
    expect(uses).toBe(2); // t=0 and t=5
  });
});

describe('world: mobs', () => {
  it('kills mobs at zero life and counts kills', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    addMob(world, 530, 500, 5);
    const events = step(world, { ...idle, basicAttack: true }, content, DT);
    expect(events.some((e) => e.type === 'death')).toBe(true);
    expect(world.mobs).toHaveLength(0);
    expect(world.kills).toBe(1);
  });

  it('mobs chase and hit the player until death', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 600, 500);
    mob.attackTimer = 0;
    // dummy has 0 move speed: place it in reach.
    mob.pos = vec(521, 500);
    let died = false;
    for (let i = 0; i < 60 * 10 && !died; i++) died = step(world, idle, content, DT).some((e) => e.type === 'playerDeath');
    expect(died).toBe(true);
    expect(world.player.life).toBe(0);
    expect(world.player.dead).toBe(true);
  });

  it('mobs do not overlap each other', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const a = addMob(world, 200, 200);
    const b = addMob(world, 205, 200);
    step(world, idle, content, DT);
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeGreaterThanOrEqual(20 - 1e-9);
  });

  it('spawner spawns growing batches and respects maxAlive', () => {
    const content = makeContent({ firstDelay: 1, interval: 1, batchStart: 2, batchGrowth: 1, maxAlive: 6 });
    const world = createWorld(content, 'hero', 1);
    step(world, idle, content, 0.99);
    expect(world.mobs).toHaveLength(0);
    step(world, idle, content, 0.02); // wave 1: 2
    expect(world.mobs).toHaveLength(2);
    step(world, idle, content, 1); // wave 2: 3
    expect(world.mobs).toHaveLength(5);
    step(world, idle, content, 1); // wave 3: 4, capped
    expect(world.mobs).toHaveLength(6);
  });
});

describe('world: determinism', () => {
  it('same seed and inputs produce identical state', () => {
    const content = makeContent({ firstDelay: 0.5, interval: 0.5, batchStart: 3, batchGrowth: 1, maxAlive: 30 });
    const run = (): WorldState => {
      const world = createWorld(content, 'hero', 777);
      for (let i = 0; i < 600; i++) {
        const t = i * DT;
        step(world, { move: vec(Math.cos(t), Math.sin(t)), aim: vec(500, 0), basicAttack: i % 2 === 0, skills: [i % 3 === 0, true] }, content, DT);
      }
      return world;
    };
    expect(run()).toEqual(run());
  });
});

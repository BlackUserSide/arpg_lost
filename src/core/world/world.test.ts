import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { createWorld, setLoadoutModifiers, step, type MobState, type PlayerInput, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 100,
  xp: 10,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};

const walker: MobDef = { ...dummy, id: 'walker', moveSpeed: 100 };

const shooter: MobDef = {
  ...dummy,
  id: 'shooter',
  moveSpeed: 100,
  preferredRange: 200,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 300, interval: 1, critChance: 0, projectile: { speed: 300, radius: 5 } },
};

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};

const skill = (def: Omit<ActionDef, 'resourceCost' | 'cooldown' | 'tags'> & Partial<ActionDef>): ActionDef => ({
  resourceCost: 0,
  cooldown: 0,
  tags: [],
  ...def,
});

const sweep = skill({ id: 'sweep', tags: ['attack', 'melee', 'area'], resourceCost: 8, damage: { source: 'weapon', effectiveness: 1 }, delivery: { kind: 'arc', radius: 50, angleDeg: 180 } });
const slam = skill({ id: 'slam', tags: ['attack', 'area'], cooldown: 5, damage: { source: 'weapon', effectiveness: 2 }, delivery: { kind: 'arc', radius: 50, angleDeg: 360 } });

function hero(skills: ActionDef[], baseStats: ClassDef['baseStats'] = {}): ClassDef {
  return {
    id: 'hero',
    radius: 10,
    weaponType: 'sword',
    baseStats: { life: 50, resource: 20, resourceRegen: 0, movementSpeed: 100, ...baseStats },
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack: strike,
    skills,
  };
}

function makeContent(skills: ActionDef[] = [sweep, slam], spawn: Partial<Content['arena']['spawn']> = {}, baseStats: ClassDef['baseStats'] = {}): Content {
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5 },
    classes: { hero: hero(skills, baseStats) },
    mobs: { dummy, walker, shooter },
    arena: {
      width: 1000,
      height: 1000,
      spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'], ...spawn },
    },
    progression: {
      maxLevel: 5,
      xpCurve: { base: 15, exponent: 1 },
      mobXpGrowth: 0,
      lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
      mapClearBonus: 0.1,
      perLevel: { life: 10 },
    },
  };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };

function addMob(world: WorldState, x: number, y: number, life = 100, defId = 'dummy'): MobState {
  const mob: MobState = { id: world.nextId++, defId, pos: vec(x, y), facing: vec(0, 1), life, maxLife: life, attackTimer: 10, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0 };
  world.mobs.push(mob);
  return mob;
}

function run(world: WorldState, content: Content, input: PlayerInput, seconds: number): ReturnType<typeof step> {
  const events = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) events.push(...step(world, input, content, DT));
  return events;
}

describe('world: player basics', () => {
  it('moves at movement speed and stays inside the arena', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    run(world, content, { ...idle, move: vec(1, 0) }, 1);
    expect(world.player.pos.x).toBeCloseTo(600, 6);
    run(world, content, { ...idle, move: vec(1, 0) }, 10);
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

  it('area skill hits everything in the arc and spends resource', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const a = addMob(world, 530, 500);
    const b = addMob(world, 510, 530);
    const behind = addMob(world, 460, 500);
    step(world, { ...idle, skills: [true] }, content, DT);
    expect(a.life).toBe(90);
    expect(b.life).toBe(90);
    expect(behind.life).toBe(100);
    expect(world.player.resource).toBe(12);
  });

  it('falls back to basic attack when the skill is unaffordable', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    world.player.resource = 0;
    const mob = addMob(world, 530, 500);
    const events = step(world, { ...idle, basicAttack: true, skills: [true] }, content, DT);
    expect(events.find((e) => e.type === 'action')).toMatchObject({ actionId: 'strike' });
    expect(mob.life).toBe(90);
  });

  it('attack rate follows attacks per second', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    addMob(world, 530, 500, 1e9);
    const attacks = run(world, content, { ...idle, basicAttack: true }, 2).filter((e) => e.type === 'action').length;
    expect(attacks).toBe(4);
  });

  it('skill cooldown blocks reuse until it expires', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const uses = run(world, content, { ...idle, skills: [false, true] }, 6).filter((e) => e.type === 'action').length;
    expect(uses).toBe(2);
  });

  it('spells use cast time scaled by cast speed', () => {
    const bolt = skill({ id: 'bolt', tags: ['spell'], castTime: 0.5, damage: { source: 'skill', base: { fire: { min: 1, max: 1 } }, critChance: 0 }, delivery: { kind: 'self' } });
    const content = makeContent([bolt]);
    const world = createWorld(content, 'hero', 1);
    expect(run(world, content, { ...idle, skills: [true] }, 1).filter((e) => e.type === 'action')).toHaveLength(2);
    world.player.modifiers.push({ stat: 'castSpeed', kind: 'increased', value: 1 });
    world.player.actionTimer = 0;
    expect(run(world, content, { ...idle, skills: [true] }, 1).filter((e) => e.type === 'action')).toHaveLength(4);
  });
});

describe('world: skill deliveries', () => {
  it('projectiles fly, hit the first mob and stop without pierce', () => {
    const shot = skill({ id: 'shot', tags: ['attack', 'projectile'], damage: { source: 'weapon', effectiveness: 1 }, delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 500, radius: 5, pierce: 0 } });
    const content = makeContent([shot]);
    const world = createWorld(content, 'hero', 1);
    const first = addMob(world, 700, 500);
    const second = addMob(world, 760, 500);
    step(world, { ...idle, skills: [true] }, content, DT);
    expect(world.projectiles).toHaveLength(1);
    run(world, content, idle, 1);
    expect(first.life).toBe(90);
    expect(second.life).toBe(100);
    expect(world.projectiles).toHaveLength(0);
  });

  it('fanned projectiles spread and pierce passes through', () => {
    const fan = skill({ id: 'fan', tags: ['attack', 'projectile'], damage: { source: 'weapon', effectiveness: 1 }, delivery: { kind: 'projectile', count: 3, spreadDeg: 40, speed: 600, range: 500, radius: 5, pierce: 1 } });
    const content = makeContent([fan]);
    const world = createWorld(content, 'hero', 1);
    const a = addMob(world, 650, 500);
    const b = addMob(world, 720, 500);
    step(world, { ...idle, skills: [true] }, content, DT);
    expect(world.projectiles).toHaveLength(3);
    expect(world.projectiles[0]!.dir.y).toBeLessThan(0);
    expect(world.projectiles[2]!.dir.y).toBeGreaterThan(0);
    run(world, content, idle, 1);
    expect(a.life).toBe(90);
    expect(b.life).toBe(90);
  });

  it('exploding projectile damages everything in the blast', () => {
    const fireball = skill({
      id: 'fireball',
      tags: ['spell', 'projectile', 'area'],
      castTime: 0.5,
      damage: { source: 'skill', base: { fire: { min: 20, max: 20 } }, critChance: 0 },
      delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 500, radius: 5, pierce: 0, explodeRadius: 60 },
    });
    const content = makeContent([fireball]);
    const world = createWorld(content, 'hero', 1);
    const target = addMob(world, 700, 500);
    const nearby = addMob(world, 700, 540);
    const far = addMob(world, 700, 650);
    step(world, { ...idle, skills: [true] }, content, DT);
    run(world, content, idle, 1);
    expect(target.life).toBe(80);
    expect(nearby.life).toBe(80);
    expect(far.life).toBe(100);
  });

  it('dash moves the player, hits mobs on the path once and stuns them', () => {
    const charge = skill({ id: 'charge', tags: ['attack', 'melee'], damage: { source: 'weapon', effectiveness: 1 }, delivery: { kind: 'dash', distance: 200, speed: 1000, hitRadius: 20 }, onHit: [{ status: 'stun', duration: 1 }] });
    const content = makeContent([charge]);
    const world = createWorld(content, 'hero', 1);
    const onPath = addMob(world, 600, 500);
    const offPath = addMob(world, 600, 600);
    step(world, { ...idle, skills: [true] }, content, DT);
    run(world, content, idle, 0.5);
    expect(world.player.pos.x).toBeCloseTo(700, 0);
    expect(onPath.life).toBe(90);
    expect(onPath.stun).toBeGreaterThan(0);
    expect(offPath.life).toBe(100);
  });

  it('stunned mobs neither move nor attack', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 600, 500, 100, 'walker');
    mob.stun = 1;
    run(world, content, idle, 0.9);
    expect(mob.pos.x).toBe(600);
  });

  it('slow reduces mob movement', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const slowed = addMob(world, 800, 300, 100, 'walker');
    const normal = addMob(world, 800, 700, 100, 'walker');
    slowed.slow = 5;
    slowed.slowMagnitude = 0.5;
    run(world, content, idle, 1);
    const moved = (m: MobState): number => Math.hypot(m.pos.x - 800, m.pos.y - (m === slowed ? 300 : 700));
    expect(moved(slowed)).toBeCloseTo(moved(normal) / 2, 0);
  });

  it('teleport moves to the aim point, capped by range', () => {
    const blink = skill({ id: 'blink', tags: ['spell'], castTime: 0.1, delivery: { kind: 'teleport', range: 300 } });
    const content = makeContent([blink]);
    const world = createWorld(content, 'hero', 1);
    step(world, { ...idle, aim: vec(600, 500), skills: [true] }, content, DT);
    expect(world.player.pos.x).toBeCloseTo(600, 6);
    world.player.cooldowns = {};
    world.player.actionTimer = 0;
    step(world, { ...idle, aim: vec(1000, 500), skills: [true] }, content, DT);
    expect(world.player.pos.x).toBeCloseTo(900, 6);
  });

  it('trap arms, then explodes when a mob comes close', () => {
    const trap = skill({
      id: 'trap',
      tags: ['area'],
      castTime: 0.2,
      damage: { source: 'skill', base: { fire: { min: 30, max: 30 } }, critChance: 0 },
      delivery: { kind: 'trap', throwRange: 200, armTime: 0.5, triggerRadius: 30, explodeRadius: 80, lifetime: 10 },
    });
    const content = makeContent([trap]);
    const world = createWorld(content, 'hero', 1);
    step(world, { ...idle, aim: vec(650, 500), skills: [true] }, content, DT);
    expect(world.traps).toHaveLength(1);
    expect(world.traps[0]!.pos.x).toBeCloseTo(650, 6);
    const mob = addMob(world, 660, 500);
    run(world, content, idle, 0.3);
    expect(mob.life).toBe(100); // not armed yet
    run(world, content, idle, 0.4);
    expect(mob.life).toBe(70);
    expect(world.traps).toHaveLength(0);
  });

  it('buffs add modifiers for their duration', () => {
    const cry = skill({ id: 'cry', castTime: 0.1, delivery: { kind: 'self' }, selfEffects: [{ kind: 'buff', id: 'cry', duration: 1, modifiers: [{ stat: 'damage', kind: 'increased', value: 1 }] }] });
    const content = makeContent([cry]);
    const world = createWorld(content, 'hero', 1);
    step(world, { ...idle, skills: [true] }, content, DT);
    const mob = addMob(world, 530, 500, 1000);
    run(world, content, idle, 0.6);
    step(world, { ...idle, basicAttack: true }, content, DT);
    expect(mob.life).toBe(980);
    run(world, content, idle, 1);
    expect(world.player.buffs).toHaveLength(0);
    step(world, { ...idle, basicAttack: true }, content, DT);
    expect(mob.life).toBe(970);
  });

  it('invulnerability blocks incoming damage', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 521, 500);
    mob.attackTimer = 0;
    world.player.invulnerable = 0.5;
    run(world, content, idle, 0.4);
    expect(world.player.life).toBe(50);
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

  it('melee mobs hit the player until death', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 521, 500);
    mob.attackTimer = 0;
    const died = run(world, content, idle, 10).some((e) => e.type === 'playerDeath');
    expect(died).toBe(true);
    expect(world.player.life).toBe(0);
  });

  it('ranged mobs keep their distance and shoot projectiles', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const mob = addMob(world, 900, 500, 100, 'shooter');
    mob.attackTimer = 0;
    const events = run(world, content, idle, 3);
    const gap = Math.hypot(mob.pos.x - 500, mob.pos.y - 500) - 20;
    expect(gap).toBeGreaterThan(115);
    expect(gap).toBeLessThanOrEqual(201);
    expect(events.some((e) => e.type === 'mobAttack')).toBe(true);
    expect(world.player.life).toBeLessThan(50);
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
    const content = makeContent(undefined, { firstDelay: 1, interval: 1, batchStart: 2, batchGrowth: 1, maxAlive: 6 });
    const world = createWorld(content, 'hero', 1);
    step(world, idle, content, 0.99);
    expect(world.mobs).toHaveLength(0);
    step(world, idle, content, 0.02);
    expect(world.mobs).toHaveLength(2);
    step(world, idle, content, 1);
    expect(world.mobs).toHaveLength(5);
    step(world, idle, content, 1);
    expect(world.mobs).toHaveLength(6);
  });
});

describe('world: experience', () => {
  it('kills grant XP; a level-up adds level stats and restores life', () => {
    const content = makeContent(undefined, {}, { life: 100 });
    const world = createWorld(content, 'hero', 1, { level: 1, xp: 0 });
    world.player.life = 20;
    addMob(world, 520, 500, 0);
    let events = step(world, idle, content, DT);
    expect(world.player.xp).toBe(10);
    expect(world.player.life).toBeLessThan(100);
    expect(events.some((e) => e.type === 'levelUp')).toBe(false);

    addMob(world, 520, 500, 0);
    events = step(world, idle, content, DT);
    expect(events).toContainEqual({ type: 'levelUp', level: 2 });
    expect(world.player.level).toBe(2);
    expect(world.player.xp).toBe(5);
    expect(world.player.life).toBe(110);
    expect(world.xpGained).toBe(20);
  });

  it('starts with level stats and reduces XP in a low-level area', () => {
    const content = makeContent(undefined, {}, { life: 100 });
    const world = createWorld(content, 'hero', 1, { level: 3, xp: 0 }, 1);
    expect(world.player.life).toBe(120);
    addMob(world, 520, 500, 0);
    step(world, idle, content, DT);
    expect(world.player.xp).toBe(5);
  });

  it('setLoadoutModifiers swaps loadout modifiers mid-run, keeping pool fill fractions', () => {
    const content = makeContent(undefined, {}, { life: 100 });
    const world = createWorld(content, 'hero', 1, { level: 3, modifiers: [{ stat: 'life', kind: 'increased', value: 0.5 }] });
    expect(world.player.life).toBe(180);
    setLoadoutModifiers(world, content, [{ stat: 'life', kind: 'flat', value: 30 }]);
    expect(world.player.gearModifiers).toEqual([{ stat: 'life', kind: 'flat', value: 30 }]);
    expect(world.player.modifiers).toEqual([
      { stat: 'life', kind: 'flat', value: 30 },
      { stat: 'life', kind: 'flat', value: 20 },
    ]);
    expect(world.player.life).toBe(150);
    // Full life stays full when max life grows: (100 + 20) * 2.
    setLoadoutModifiers(world, content, [{ stat: 'life', kind: 'increased', value: 1 }]);
    expect(world.player.life).toBe(240);
    world.player.life = 60;
    setLoadoutModifiers(world, content, []);
    expect(world.player.life).toBe(30);
  });
});

describe('world: determinism', () => {
  it('same seed and inputs produce identical state', () => {
    const content = makeContent(undefined, { firstDelay: 0.5, interval: 0.5, batchStart: 3, batchGrowth: 1, maxAlive: 30, mobIds: ['walker', 'shooter'] });
    const play = (): WorldState => {
      const world = createWorld(content, 'hero', 777);
      for (let i = 0; i < 600; i++) {
        const t = i * DT;
        step(world, { move: vec(Math.cos(t), Math.sin(t)), aim: vec(500, 0), basicAttack: i % 2 === 0, skills: [i % 3 === 0, true] }, content, DT);
      }
      return world;
    };
    expect(play()).toEqual(play());
  });
});

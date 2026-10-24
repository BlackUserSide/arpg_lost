// Mob abilities (abilities.ts): telegraphed boss attacks, summons, hostile ground zones, phases, interrupts.
import { describe, expect, it } from 'vitest';
import { distance, vec, type Vec2 } from '../math';
import { content as gameContent } from '../../data';
import type { PassiveMechanic } from '../passives/types';
import { createRng } from '../rng';
import { skillKillXp } from '../skills/levels';
import type { ActionDef, ClassDef, Content, MobAbilityDef, MobDef } from './content';
import { explodeOnDeath } from './deathExplosions';
import { applyStatus, conditionTarget, fillStunBar } from './statuses';
import { stunBarStats } from './passiveEffects';
import { createWorld, spawnMob, step, type Ctx, type Decoy, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const baseMob = (id: string, extra: Partial<MobDef> = {}): MobDef => ({
  id,
  radius: 20,
  life: 1000,
  xp: 10,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  // Never in reach: the tests see only the abilities.
  attack: { damage: { physical: { min: 50, max: 50 } }, range: 0, interval: 1000, critChance: 0 },
  ...extra,
});

const NOVA: MobAbilityDef = { id: 'nova', kind: 'nova', windUp: 1, cooldown: 4, range: 100, radius: 120, damage: { physical: { min: 10, max: 10 } } };
const FAN: MobAbilityDef = {
  id: 'spears',
  kind: 'projectileFan',
  windUp: 0.5,
  cooldown: 3,
  count: 5,
  spreadDeg: 60,
  speed: 300,
  radius: 5,
  flightRange: 600,
  damage: { physical: { min: 7, max: 7 } },
};
const SUMMON: MobAbilityDef = { id: 'raise', kind: 'summon', windUp: 1, cooldown: 2, count: 4, maxAlive: 6, ringRadius: 50, pool: [{ mobId: 'minion', weight: 1 }] };
const ZONES: MobAbilityDef = {
  id: 'graves',
  kind: 'groundZones',
  minPhase: 2,
  windUp: 0.5,
  cooldown: 3,
  count: 3,
  radius: 40,
  delay: 1,
  scatter: 100,
  damage: { physical: { min: 9, max: 9 } },
};

const PHASES = [{ lifeBelow: 0.5, cooldownMultiplier: 0.5 }];
const caster = (id: string, list: MobAbilityDef[]): MobDef => baseMob(id, { boss: true, abilities: { recovery: 0.5, phases: PHASES, list } });
/** A 0.5 s (30 steps) immune roar at 50% life. */
const ROAR = [{ lifeBelow: 0.5, cooldownMultiplier: 1, transition: { duration: 0.5 } }];
/** Walks (100) towards the hero and shoots (range 400, every 1 s) when no ability keeps it busy. */
const walkerAttack: Partial<MobDef> = {
  moveSpeed: 100,
  attack: { damage: { physical: { min: 50, max: 50 } }, range: 400, interval: 1, critChance: 0, projectile: { speed: 100, radius: 2 } },
};

const MOBS: Record<string, MobDef> = {
  novaBoss: caster('novaBoss', [NOVA]),
  fanBoss: caster('fanBoss', [FAN]),
  summonBoss: caster('summonBoss', [SUMMON]),
  zoneBoss: caster('zoneBoss', [ZONES]),
  minion: baseMob('minion', { radius: 10, life: 5, xp: 5 }),
  // Priority: both ready at spawn, list order decides.
  novaFirst: caster('novaFirst', [NOVA, FAN]),
  fanFirst: caster('fanFirst', [FAN, NOVA]),
  // Phase transitions.
  roarWalker: baseMob('roarWalker', { ...walkerAttack, boss: true, abilities: { recovery: 0, phases: ROAR, list: [{ ...NOVA, range: 1000 }] } }),
  roarMob: baseMob('roarMob', { abilities: { recovery: 0, phases: ROAR, list: [NOVA] } }),
  twoRoars: baseMob('twoRoars', {
    abilities: {
      recovery: 0,
      phases: [
        { lifeBelow: 0.6, cooldownMultiplier: 1, transition: { duration: 0.5 } },
        { lifeBelow: 0.3, cooldownMultiplier: 1, transition: { duration: 0.5 } },
      ],
      list: [NOVA],
    },
  }),
  // A non-boss caster (any stun / freeze / push interrupts it).
  grunt: baseMob('grunt', { abilities: { recovery: 0.5, phases: [], list: [NOVA] } }),
  // Resolve step: the nova (2 s wind-up, 100 s cooldown) once, then the walker's basic behaviour.
  busyWalker: baseMob('busyWalker', { ...walkerAttack, abilities: { recovery: 0, phases: [], list: [{ ...NOVA, range: 1000, windUp: 2, cooldown: 100 }] } }),
};

/** Stun bar mechanic: one hit fills a full bar (baseFill 1); bosses are stunned for 0.4 s. */
const FULL_BAR: PassiveMechanic = { kind: 'stunBar', baseFill: 1, damageFill: 0, stunDuration: 1, bossFillFactor: 1, bossStunDuration: 0.4, decayDelay: 5, decayPerSecond: 0.5 };

function makeContent(): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'wand',
    baseStats: { life: 100, resource: 0, resourceRegen: 0, movementSpeed: 100 },
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: { damage: { physical: { min: 1, max: 1 } }, attacksPerSecond: 1, critChance: 0 },
    basicAttack: {
      id: 'poke',
      tags: ['attack', 'melee'],
      resourceCost: 0,
      cooldown: 0,
      damage: { source: 'weapon', effectiveness: 1 },
      delivery: { kind: 'arc', radius: 10, angleDeg: 10 },
    },
    skills: [],
  };
  // Swings all round (300) with a stun, a freeze and a push on every hit.
  const brute: ClassDef = {
    ...hero,
    id: 'brute',
    basicAttack: {
      ...hero.basicAttack,
      delivery: { kind: 'arc', radius: 300, angleDeg: 360 },
      onHit: [
        { status: 'stun', duration: 1 },
        { status: 'freeze', duration: 1 },
      ],
      knockback: { distance: 50, speed: 500, eliteMultiplier: 1 },
    },
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5 },
    classes: { hero, brute },
    mobs: MOBS,
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['minion'] } },
    progression: {
      maxLevel: 5,
      xpCurve: { base: 1000, exponent: 1 },
      mobXpGrowth: 0,
      lowAreaPenalty: { startDiff: 2, multipliers: [1], floor: 1 },
      mapClearBonus: 0,
      perLevel: {},
    },
  };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(0, 0), basicAttack: false, skills: [] };

/** Hero at (500, 500), boss of `defId` at `bossPos`. */
function setup(defId: string, bossPos = vec(580, 500), seed = 7): { content: Content; world: WorldState; boss: MobState } {
  const content = makeContent();
  const world = createWorld(content, 'hero', seed, {}, 1, { bounds: { width: 1000, height: 1000 }, start: vec(500, 500), endless: false });
  const boss = spawnMob(world, content, { defId }, bossPos, []);
  return { content, world, boss };
}

function run(world: WorldState, content: Content, steps: number): WorldEvent[] {
  const all: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) all.push(...step(world, idle, content, DT));
  return all;
}

const ofType = <T extends WorldEvent['type']>(events: WorldEvent[], type: T): Extract<WorldEvent, { type: T }>[] =>
  events.filter((e): e is Extract<WorldEvent, { type: T }> => e.type === type);

/** Runs `steps` steps; returns the 1-based step number of every event of `type` (with the event). */
function timeline<T extends WorldEvent['type']>(world: WorldState, content: Content, steps: number, type: T): { step: number; event: Extract<WorldEvent, { type: T }> }[] {
  const out: { step: number; event: Extract<WorldEvent, { type: T }> }[] = [];
  for (let i = 1; i <= steps; i++) for (const event of ofType(step(world, idle, content, DT), type)) out.push({ step: i, event });
  return out;
}

/** A step context outside step() (status / explosion helpers called directly). */
function ctxOf(world: WorldState, content: Content, events: WorldEvent[] = []): Ctx {
  return { world, content, classDef: content.classes[world.player.classId]!, rng: createRng(world.rngState), events, input: idle };
}

/** A decoy taunting everything within 2000 (bosses for `bossTaunt` seconds). */
function addDecoy(world: WorldState, pos: Vec2, bossTaunt: number): Decoy {
  const decoy: Decoy = { id: world.nextId++, kind: 'decoy', pos, radius: 10, tauntRadius: 2000, remaining: 10, bossTauntRemaining: bossTaunt };
  world.decoys.push(decoy);
  return decoy;
}

function place(content: Content, start: Vec2, seed = 7, classId = 'hero', mechanics: readonly PassiveMechanic[] = []): WorldState {
  return createWorld(content, classId, seed, { mechanics }, 1, { bounds: { width: 1000, height: 1000 }, start, endless: false });
}

describe('mob abilities: spawn state', () => {
  it('a mob with abilities spawns in phase 1 with its phase-1 timers; others get no ability state', () => {
    const { content, world, boss } = setup('zoneBoss');
    expect(boss).toMatchObject({ phase: 1, abilityTimers: {}, castRecovery: 0 });
    expect(boss.casting).toBeUndefined();
    const minion = spawnMob(world, content, { defId: 'minion' }, vec(100, 100), []);
    expect(minion.phase).toBeUndefined();
    expect(minion.abilityTimers).toBeUndefined();
    const nova = setup('novaBoss').boss;
    expect(nova.abilityTimers).toEqual({ nova: 0 });
  });
});

describe('nova', () => {
  it('telegraphs for its wind-up, then hits the hero in range; the cooldown starts with the cast', () => {
    const { content, world, boss } = setup('novaBoss');
    const first = step(world, idle, content, DT);
    expect(ofType(first, 'mobCast')).toEqual([{ type: 'mobCast', id: boss.id, abilityId: 'nova', kind: 'nova', pos: vec(580, 500), dir: vec(-1, 0), duration: 1, radius: 120 }]);
    expect(boss.casting).toEqual({ abilityId: 'nova', kind: 'nova', remaining: 1, total: 1, dir: vec(-1, 0), radius: 120 });
    expect(boss.abilityTimers!.nova).toBe(4);
    // 59 more steps: still winding up, no damage.
    const waiting = run(world, content, 59);
    expect(ofType(waiting, 'mobAbility')).toEqual([]);
    expect(world.player.life).toBe(100);
    expect(boss.casting!.remaining).toBeCloseTo(1 / 60, 9);
    // The 60th step after the start resolves it.
    const resolved = step(world, idle, content, DT);
    expect(ofType(resolved, 'mobAbility')).toEqual([{ type: 'mobAbility', id: boss.id, abilityId: 'nova', kind: 'nova', pos: vec(580, 500), radius: 120, hit: true }]);
    expect(world.player.life).toBe(90);
    expect(boss.casting).toBeUndefined();
    expect(boss.castRecovery).toBe(0.5);
  });

  it('a hero who leaves the circle during the wind-up takes nothing', () => {
    const { content, world, boss } = setup('novaBoss');
    step(world, idle, content, DT);
    expect(boss.casting).toBeDefined();
    world.player.pos = vec(300, 500); // 280 from the boss: outside 120 + 10
    const events = run(world, content, 60);
    expect(ofType(events, 'mobAbility')[0]).toMatchObject({ abilityId: 'nova', hit: false });
    expect(world.player.life).toBe(100);
  });

  it('does not start while the target is out of its range', () => {
    const { content, world, boss } = setup('novaBoss', vec(700, 500)); // gap 200 − 30 = 170 > 100
    const events = run(world, content, 120);
    expect(ofType(events, 'mobCast')).toEqual([]);
    expect(boss.casting).toBeUndefined();
  });

  it('casts again only after its cooldown', () => {
    const { content, world } = setup('novaBoss');
    const events = run(world, content, 241);
    // Starts at step 1 and step 241 (cooldown 4 s = 240 steps after the first start).
    expect(ofType(events, 'mobCast')).toHaveLength(2);
  });
});

describe('projectile fan', () => {
  it('fires `count` projectiles evenly over the spread, with gaps, using the ability damage', () => {
    const { content, world, boss } = setup('fanBoss', vec(700, 500));
    run(world, content, 30);
    const fired = step(world, idle, content, DT);
    const ability = ofType(fired, 'mobAbility')[0]!;
    expect(ability).toMatchObject({ abilityId: 'spears', kind: 'projectileFan' });
    expect(ability.projectileIds).toHaveLength(5);
    const spears = world.projectiles.filter((p) => p.abilityId === 'spears');
    expect(spears.map((p) => p.id)).toEqual(ability.projectileIds);
    // 15° between neighbours, the middle one straight at the hero.
    const angles = spears.map((p) => Math.round((Math.atan2(p.dir.y, p.dir.x) * 180) / Math.PI));
    expect(angles).toEqual([150, 165, 180, -165, -150]);
    for (const p of spears) expect(p).toMatchObject({ owner: 'mob', sourceId: 'fanBoss', speed: 300, radius: 5, remaining: 595 });
    // Fired from the body's edge; like every projectile it already flew this step (300 × 1/60).
    expect(distance(spears[2]!.pos, boss.pos)).toBeCloseTo(25, 9);
    // The middle spear hits for the ability's 7 (not the basic attack's 50); the neighbours pass beside the hero.
    run(world, content, 40);
    expect(world.player.life).toBe(93);
  });

  it('aims where the target was when the wind-up started', () => {
    const { content, world } = setup('fanBoss', vec(700, 500));
    step(world, idle, content, DT);
    world.player.pos = vec(500, 300);
    const events = run(world, content, 30);
    expect(ofType(events, 'mobAbility')).toHaveLength(1);
    const middle = world.projectiles.find((p) => p.abilityId === 'spears' && Math.abs(p.dir.y) < 1e-9);
    expect(middle?.dir.x).toBeCloseTo(-1, 9);
  });
});

describe('summon', () => {
  it('raises minions in a ring, at most maxAlive alive; then waits until some die', () => {
    const { content, world, boss } = setup('summonBoss', vec(500, 300));
    const events = run(world, content, 61);
    const first = ofType(events, 'mobAbility')[0]!;
    expect(first.spawnedIds).toHaveLength(4);
    const minions = world.mobs.filter((m) => m.summonerId === boss.id);
    expect(minions.map((m) => m.id)).toEqual(first.spawnedIds);
    for (const m of minions) expect(distance(m.pos, boss.pos)).toBeCloseTo(50, 6);
    expect(ofType(events, 'spawn').map((e) => e.id)).toEqual(first.spawnedIds);
    // Next cast (cooldown 2 s from the first start): only 2 more fit under the cap of 6.
    const more = run(world, content, 120);
    expect(ofType(more, 'mobAbility')[0]!.spawnedIds).toHaveLength(2);
    expect(world.mobs.filter((m) => m.summonerId === boss.id)).toHaveLength(6);
    // At the cap the summon does not even start.
    const capped = run(world, content, 300);
    expect(ofType(capped, 'mobCast')).toEqual([]);
    // One dies: the next cast raises one.
    world.mobs.find((m) => m.summonerId === boss.id)!.life = 0;
    const after = run(world, content, 62);
    expect(ofType(after, 'mobAbility')[0]!.spawnedIds).toHaveLength(1);
  });

  it('minions give nothing on death: no kill count, no XP', () => {
    const { content, world, boss } = setup('summonBoss', vec(500, 300));
    run(world, content, 61);
    for (const m of world.mobs) if (m.summonerId === boss.id) m.life = 0;
    const events = run(world, content, 1);
    expect(ofType(events, 'death')).toHaveLength(4);
    expect(world.kills).toBe(0);
    expect(world.xpGained).toBe(0);
    expect(world.player.xp).toBe(0);
    // An ordinary mob of the same def still counts.
    spawnMob(world, content, { defId: 'minion' }, vec(900, 900), []).life = 0;
    run(world, content, 1);
    expect(world.kills).toBe(1);
    expect(world.xpGained).toBe(5);
  });
});

describe('phases and ground zones', () => {
  it('phase-2 abilities are locked until life falls to the threshold', () => {
    const { content, world, boss } = setup('zoneBoss');
    expect(ofType(run(world, content, 120), 'mobCast')).toEqual([]);
    boss.life = 500;
    const events = step(world, idle, content, DT);
    expect(ofType(events, 'mobPhase')).toEqual([{ type: 'mobPhase', id: boss.id, phase: 2, pos: boss.pos }]);
    expect(boss.phase).toBe(2);
    expect(ofType(events, 'mobCast')[0]).toMatchObject({ abilityId: 'graves', kind: 'groundZones' });
    // Phase 2 halves the cooldown (cooldownMultiplier 0.5).
    expect(boss.abilityTimers!.graves).toBe(1.5);
    // The phase changes once.
    expect(ofType(run(world, content, 10), 'mobPhase')).toEqual([]);
  });

  it('zones appear under the hero after the wind-up and erupt `delay` later, hitting the hero inside', () => {
    const { content, world, boss } = setup('zoneBoss');
    boss.life = 500;
    run(world, content, 30);
    const placed = step(world, idle, content, DT);
    const spawns = ofType(placed, 'hostileZoneSpawn');
    expect(spawns).toHaveLength(3);
    expect(spawns[0]).toMatchObject({ sourceId: boss.id, abilityId: 'graves', pos: vec(500, 500), radius: 40, delay: 1 });
    for (const s of spawns) expect(distance(s.pos, vec(500, 500))).toBeLessThanOrEqual(100);
    expect(world.hostileZones.map((z) => z.id)).toEqual(spawns.map((s) => s.zoneId));
    expect(world.hostileZones[0]).toMatchObject({ remaining: 1 - DT, total: 1, sourceDefId: 'zoneBoss' });
    expect(ofType(placed, 'mobAbility')[0]!.zoneIds).toEqual(spawns.map((s) => s.zoneId));
    // Nothing until the delay has passed (the placing step counted).
    expect(ofType(run(world, content, 58), 'hostileZoneErupt')).toEqual([]);
    expect(world.player.life).toBe(100);
    const erupt = ofType(step(world, idle, content, DT), 'hostileZoneErupt');
    expect(erupt).toHaveLength(3);
    expect(erupt[0]).toMatchObject({ zoneId: spawns[0]!.zoneId, hit: true });
    const hits = erupt.filter((e) => e.hit).length;
    expect(world.player.life).toBe(100 - 9 * hits);
    expect(world.hostileZones).toEqual([]);
  });

  it('a hero who steps out of the circles takes nothing; the zones outlive a stun of their caster', () => {
    const { content, world, boss } = setup('zoneBoss');
    boss.life = 500;
    run(world, content, 31);
    expect(world.hostileZones).toHaveLength(3);
    world.player.pos = vec(900, 900);
    boss.stun = 2;
    const events = run(world, content, 60);
    expect(ofType(events, 'hostileZoneErupt').map((e) => e.hit)).toEqual([false, false, false]);
    expect(world.player.life).toBe(100);
  });

  it('phase 2 shortens every cooldown and the recovery', () => {
    const def: MobDef = caster('fan2', [FAN]);
    const content = { ...makeContent(), mobs: { ...MOBS, fan2: def } };
    const world = createWorld(content, 'hero', 1, {}, 1, { bounds: { width: 1000, height: 1000 }, start: vec(500, 500), endless: false });
    const boss = spawnMob(world, content, { defId: 'fan2' }, vec(800, 500), []);
    step(world, idle, content, DT);
    expect(boss.abilityTimers!.spears).toBe(3);
    run(world, content, 30);
    expect(boss.castRecovery).toBe(0.5);
    boss.life = 400;
    const casts = ofType(run(world, content, 600), 'mobCast');
    // Phase 2 from step 32: next start when the 3 s cooldown runs out (step 181), then every 1.5 s (90 steps):
    // steps 181, 271, 361, 451, 541 and 631 (the last step of the run).
    expect(casts.length).toBe(6);
    expect(boss.abilityTimers!.spears).toBe(1.5);
    // The last cast resolves 30 steps later; the recovery is 0.5 × 0.5.
    run(world, content, 30);
    expect(boss.casting).toBeUndefined();
    expect(boss.castRecovery).toBe(0.25);
  });
});

describe('interrupts and slows', () => {
  it('a stun during the wind-up cancels the ability; its cooldown stays spent', () => {
    const { content, world, boss } = setup('novaBoss');
    step(world, idle, content, DT);
    run(world, content, 30);
    boss.stun = 0.4; // what a full stun bar does to a boss
    const events = step(world, idle, content, DT);
    expect(ofType(events, 'mobCastInterrupted')).toEqual([{ type: 'mobCastInterrupted', id: boss.id, abilityId: 'nova' }]);
    expect(boss.casting).toBeUndefined();
    const later = run(world, content, 120);
    expect(ofType(later, 'mobAbility')).toEqual([]);
    expect(world.player.life).toBe(100);
    // Timers stopped during the stun, then ran: still on cooldown, so no new cast yet. 4 s from step 1, minus the
    // 30 acting steps before the stun and the 120 − 24 after it (the 0.4 s stun disables 24 steps).
    expect(ofType(later, 'mobCast')).toEqual([]);
    expect(boss.abilityTimers!.nova).toBeCloseTo(4 - (30 + 96) * DT, 9);
  });

  it('a slowed caster winds up slower (the boss stun-slow halves its speed)', () => {
    const { content, world, boss } = setup('novaBoss');
    boss.stunSlow = 10;
    step(world, idle, content, DT);
    expect(boss.casting).toBeDefined();
    expect(ofType(run(world, content, 119), 'mobAbility')).toEqual([]);
    expect(ofType(step(world, idle, content, DT), 'mobAbility')).toHaveLength(1);
  });

  it('a casting mob neither moves nor uses its basic attack', () => {
    const walker = baseMob('walker', {
      moveSpeed: 100,
      attack: { damage: { physical: { min: 50, max: 50 } }, range: 400, interval: 1, critChance: 0, projectile: { speed: 100, radius: 2 } },
      abilities: { recovery: 0, phases: [], list: [{ ...NOVA, range: 1000, windUp: 2 }] },
    });
    const content = { ...makeContent(), mobs: { ...MOBS, walker } };
    const world = createWorld(content, 'hero', 1, {}, 1, { bounds: { width: 1000, height: 1000 }, start: vec(500, 500), endless: false });
    const mob = spawnMob(world, content, { defId: 'walker' }, vec(800, 500), []);
    const events = run(world, content, 60);
    expect(mob.pos).toEqual(vec(800, 500));
    expect(ofType(events, 'mobAttack')).toEqual([]);
    expect(world.projectiles).toEqual([]);
  });
});

describe('the necromancer (game data)', () => {
  it('casts bone spears and raises the dead in a fixed-seed fight, all from data', () => {
    const world = createWorld(gameContent, 'mage', 3, {}, 1, { bounds: { width: 1300, height: 1000 }, start: vec(650, 800), endless: false });
    const boss = spawnMob(world, gameContent, { defId: 'necromancer', rank: 'boss' }, vec(650, 200), []);
    expect(boss).toMatchObject({ phase: 1, abilityTimers: { darkNova: 3, raiseDead: 4, boneSpears: 1.5 } });
    const events: WorldEvent[] = [];
    for (let i = 0; i < 6 * 60; i++) events.push(...step(world, idle, gameContent, DT));
    // Bone spears when their 1.5 s initial cooldown runs out (step 90), raise dead at 4 s (step 240); no nova (the
    // hero stays out of its 90 range), no grave circles (phase 1).
    const casts = ofType(events, 'mobCast').map((e) => e.abilityId);
    expect(casts).toEqual(['boneSpears', 'raiseDead']);
    const raised = ofType(events, 'mobAbility').find((e) => e.abilityId === 'raiseDead')!;
    expect(raised.spawnedIds).toHaveLength(4);
    expect(world.mobs.filter((m) => m.summonerId === boss.id).map((m) => m.id)).toEqual(raised.spawnedIds);
  });
});

describe('ability priority', () => {
  it('two abilities ready at once: the first in the list starts, the second waits for the recovery', () => {
    const { content, world, boss } = setup('novaFirst');
    // Nova starts at step 1, resolves at step 61 (1 s wind-up); recovery 0.5 s → the fan starts at step 91.
    const casts = timeline(world, content, 91, 'mobCast').map((c) => [c.step, c.event.abilityId]);
    expect(casts).toEqual([
      [1, 'nova'],
      [91, 'spears'],
    ]);
    expect(boss.abilityTimers!.spears).toBe(3);
    expect(boss.abilityTimers!.nova).toBeCloseTo(4 - 90 * DT, 9);
  });

  it('the same two abilities in the other order: the fan goes first', () => {
    const { content, world } = setup('fanFirst');
    // Fan: 0.5 s wind-up (resolves at step 31) + 0.5 s recovery → the nova starts at step 61.
    const casts = timeline(world, content, 61, 'mobCast').map((c) => [c.step, c.event.abilityId]);
    expect(casts).toEqual([
      [1, 'spears'],
      [61, 'nova'],
    ]);
  });
});

describe('resolve step and the basic attack', () => {
  it('the mob neither moves nor attacks on the resolve step; its attack timer waits through the whole cast', () => {
    const content = makeContent();
    const world = place(content, vec(500, 500));
    // Gap 370: beyond 0.8 × attack range (walks), within the range (shoots).
    const mob = spawnMob(world, content, { defId: 'busyWalker' }, vec(900, 500), []);
    mob.attackTimer = 0.5;
    const cast = timeline(world, content, 121, 'mobAbility');
    // Started at step 1, resolved at step 121 (2 s = 120 steps later).
    expect(cast.map((c) => c.step)).toEqual([121]);
    expect(mob.pos).toEqual(vec(900, 500));
    expect(mob.attackTimer).toBe(0.5);
    expect(world.projectiles).toEqual([]);
    // The step after the resolve it walks and its attack timer runs again.
    const after = step(world, idle, content, DT);
    expect(mob.pos).toEqual(vec(900 - 100 * DT, 500));
    expect(mob.attackTimer).toBe(0.5 - DT);
    expect(ofType(after, 'mobAttack')).toEqual([]);
  });
});

describe('phase transition (immune roar)', () => {
  it('cancels the wind-up (cooldown spent), pauses the mob for exactly 30 steps: no moving, attacking or casting', () => {
    const content = makeContent();
    const world = place(content, vec(500, 500));
    const boss = spawnMob(world, content, { defId: 'roarWalker' }, vec(900, 500), []);
    run(world, content, 11);
    expect(boss.casting?.abilityId).toBe('nova');
    const novaTimer = boss.abilityTimers!.nova!;
    expect(novaTimer).toBeCloseTo(4 - 10 * DT, 9);
    boss.life = 500;
    const start = step(world, idle, content, DT);
    expect(ofType(start, 'mobPhase')).toEqual([{ type: 'mobPhase', id: boss.id, phase: 2, pos: vec(900, 500), transition: 0.5 }]);
    expect(ofType(start, 'mobCastInterrupted')).toEqual([{ type: 'mobCastInterrupted', id: boss.id, abilityId: 'nova' }]);
    expect(boss.casting).toBeUndefined();
    expect(boss.phaseTransition).toEqual({ remaining: 0.5, total: 0.5 });
    // 29 more pause steps (30 with the start step).
    const pause = run(world, content, 29);
    expect(boss.phaseTransition?.remaining).toBeCloseTo(DT, 9);
    for (const type of ['mobCast', 'mobAttack', 'mobAbility'] as const) expect(ofType(pause, type)).toEqual([]);
    expect(boss.pos).toEqual(vec(900, 500));
    expect(world.projectiles).toEqual([]);
    expect(boss.abilityTimers!.nova).toBe(novaTimer);
    expect(boss.attackTimer).toBe(0);
    // Step 31: the pause is over, the mob acts: walks and shoots; the nova is still on cooldown.
    const free = step(world, idle, content, DT);
    expect(boss.phaseTransition).toBeUndefined();
    expect(ofType(free, 'mobCast')).toEqual([]);
    expect(ofType(free, 'mobAttack')).toEqual([{ type: 'mobAttack', id: boss.id }]);
    expect(boss.pos).toEqual(vec(900 - 100 * DT, 500));
    expect(boss.abilityTimers!.nova).toBe(novaTimer - DT);
  });

  it('hero hits on the immune mob emit "immune" and change nothing: life, stun bar, statuses, knockback', () => {
    const content = makeContent();
    const world = place(content, vec(500, 500), 7, 'brute', [FULL_BAR]);
    const mob = spawnMob(world, content, { defId: 'roarMob' }, vec(700, 500), []);
    const control = spawnMob(world, content, { defId: 'minion' }, vec(500, 700), []);
    mob.life = 500;
    expect(ofType(step(world, idle, content, DT), 'mobPhase')).toHaveLength(1);
    const swing = step(world, { ...idle, aim: vec(700, 500), basicAttack: true }, content, DT);
    expect(ofType(swing, 'immune')).toEqual([{ type: 'immune', targetId: mob.id, pos: vec(700, 500) }]);
    // The same swing works on the ordinary mob next to it.
    expect(ofType(swing, 'hit').map((e) => e.targetId)).toEqual([control.id]);
    expect(ofType(swing, 'knockback').map((e) => e.targetId)).toEqual([control.id]);
    expect(ofType(swing, 'status').map((e) => [e.targetId, e.status])).toEqual([
      [control.id, 'stun'],
      [control.id, 'freeze'],
      [control.id, 'stun'],
    ]);
    expect(ofType(swing, 'stunBar').map((e) => e.targetId)).toEqual([control.id]);
    expect(mob).toMatchObject({ life: 500, stunBar: 0, stun: 0, freeze: 0, stunSlow: 0, freezeSlow: 0, slow: 0, ignite: 0 });
    expect(mob.knockback).toBeUndefined();
    expect(mob.pos).toEqual(vec(700, 500));
  });

  it('ignite and bleed run out during the pause without damage', () => {
    const content = makeContent();
    const world = place(content, vec(500, 500));
    const mob = spawnMob(world, content, { defId: 'roarMob' }, vec(700, 500), []);
    mob.life = 500;
    step(world, idle, content, DT);
    mob.ignite = 10 * DT;
    mob.igniteDps = 60;
    mob.bleed = 10 * DT;
    mob.bleedStacks = [30];
    const events = run(world, content, 10);
    expect(ofType(events, 'dot')).toEqual([]);
    expect(mob.life).toBe(500);
    expect(mob.ignite).toBe(0);
    expect(mob.bleed).toBe(0);
    expect(mob.bleedStacks).toEqual([]);
  });

  it('hero ground zone ticks, zone / trap aura slows and death explosions skip the immune mob', () => {
    const content = makeContent();
    const world = place(content, vec(100, 100));
    const mob = spawnMob(world, content, { defId: 'roarMob' }, vec(600, 600), []);
    const other = spawnMob(world, content, { defId: 'minion' }, vec(660, 600), []);
    mob.life = 500;
    step(world, idle, content, DT);
    expect(mob.phaseTransition).toBeDefined();
    const action: ActionDef = {
      ...content.classes.hero!.basicAttack,
      zone: { id: 'fire_puddle', duration: 5, tick: { interval: 1, damage: { fire: { min: 2, max: 2 } } }, slow: 0.5 },
    };
    world.zones.push({ id: world.nextId++, actionId: 'poke', kind: 'fire_puddle', pos: vec(630, 600), radius: 100, remaining: 5, tickTimer: 0, action, castModifiers: [] });
    world.traps.push({
      id: world.nextId++,
      actionId: 'poke',
      action,
      pos: vec(630, 700),
      armTimer: 0,
      lifetime: 10,
      triggerRadius: 1,
      explodeRadius: 1,
      chain: null,
      aura: { radius: 200, slow: 0.3 },
      chainTimer: null,
      castModifiers: [],
    });
    const tick = step(world, idle, content, DT);
    expect(ofType(tick, 'hit').map((e) => [e.targetId, e.amount])).toEqual([[other.id, 2]]);
    expect(mob.life).toBe(500);
    expect(other.auraSlow).toBe(0.5);
    expect(mob.auraSlow).toBe(0);
    // Without the zone only the trap aura is left: still nothing on the immune mob.
    world.zones = [];
    step(world, idle, content, DT);
    expect(other.auraSlow).toBe(0.3);
    expect(mob.auraSlow).toBe(0);
    // A death explosion next to both hits only the ordinary mob (0.2 × the dead minion's 5 life).
    const dead = spawnMob(world, content, { defId: 'minion' }, vec(630, 640), []);
    const events: WorldEvent[] = [];
    explodeOnDeath(ctxOf(world, content, events), dead, { radius: 200, lifeFraction: 0.2, damageType: 'fire' }, 200);
    expect(ofType(events, 'hit').map((e) => [e.targetId, e.amount])).toEqual([[other.id, 1]]);
    expect(mob.life).toBe(500);
  });

  it('a second phase starting during a running pause gets its full pause', () => {
    const content = makeContent();
    const world = place(content, vec(500, 500));
    const mob = spawnMob(world, content, { defId: 'twoRoars' }, vec(800, 500), []);
    mob.life = 500;
    step(world, idle, content, DT);
    run(world, content, 10);
    expect(mob.phaseTransition?.remaining).toBeCloseTo(0.5 - 10 * DT, 9);
    mob.life = 250;
    const second = step(world, idle, content, DT);
    expect(ofType(second, 'mobPhase')).toEqual([{ type: 'mobPhase', id: mob.id, phase: 3, pos: vec(800, 500), transition: 0.5 }]);
    // Its start step is its first step: nothing counted down yet.
    expect(mob.phaseTransition).toEqual({ remaining: 0.5, total: 0.5 });
    run(world, content, 29);
    expect(mob.phaseTransition).toBeDefined();
    step(world, idle, content, DT);
    expect(mob.phaseTransition).toBeUndefined();
  });
});

describe('minions die with their summoner', () => {
  it('killing only the boss kills its living minions the same step; they add no kills, XP, skill XP or drops', () => {
    const base = makeContent();
    const supports = gameContent.supports!;
    // Every ordinary kill drops a support, the boss none: any further drop would come from the minions.
    const content: Content = {
      ...base,
      supports: { ...supports, rules: { ...supports.rules, dropChance: { normal: 1, elite: 1, boss: 0 } } },
      skillLevels: gameContent.skillLevels!,
    };
    const world = place(content, vec(500, 500));
    const boss = spawnMob(world, content, { defId: 'summonBoss' }, vec(500, 300), []);
    run(world, content, 61);
    const minions = world.mobs.filter((m) => m.summonerId === boss.id);
    expect(minions.map((m) => m.life)).toEqual([5, 5, 5, 5]);
    // An ordinary mob of the minions' def counts and drops (control).
    spawnMob(world, content, { defId: 'minion' }, vec(900, 900), []).life = 0;
    run(world, content, 1);
    expect(world.kills).toBe(1);
    expect(world.supportDrops).toHaveLength(1);
    boss.life = 0;
    const events = step(world, idle, content, DT);
    expect(ofType(events, 'death').map((e) => e.id)).toEqual([boss.id, ...minions.map((m) => m.id)]);
    expect(world.mobs).toEqual([]);
    expect(world.kills).toBe(2);
    // 5 (control) + 10 (boss).
    expect(world.xpGained).toBe(15);
    const rules = content.skillLevels!.rules;
    expect(world.skillXpGained).toBe(skillKillXp(5, rules) + skillKillXp(10, rules));
    expect(world.supportDrops).toHaveLength(1);
    expect(ofType(events, 'supportDrop')).toEqual([]);
  });
});

describe('decoy targeting', () => {
  it('a taunted boss aims its fan at the decoy, then (taunt over) at the hero', () => {
    const { content, world } = setup('fanBoss', vec(700, 500));
    addDecoy(world, vec(700, 800), 1);
    const casts = timeline(world, content, 181, 'mobCast').map((c) => [c.step, c.event.dir]);
    // Second cast at step 181 (3 s cooldown), after the 1 s boss taunt.
    expect(casts).toEqual([
      [1, vec(0, 1)],
      [181, vec(-1, 0)],
    ]);
  });

  it('the range check uses the decoy while taunted: the nova waits until the taunt is over', () => {
    const { content, world } = setup('novaBoss');
    // Decoy gap 400 − 20 − 10 = 370 > range 100; the hero (gap 50) is ignored while the boss is taunted.
    addDecoy(world, vec(580, 900), 1);
    const casts = timeline(world, content, 61, 'mobCast');
    expect(casts.map((c) => [c.step, c.event.dir])).toEqual([[61, vec(-1, 0)]]);
  });

  it('a taunted boss places grave circles on the decoy; after the taunt, on the hero', () => {
    const { content, world, boss } = setup('zoneBoss');
    boss.life = 500;
    addDecoy(world, vec(300, 300), 2);
    // Casts at steps 1 and 91 (1.5 s cooldown in phase 2), resolving at 31 and 121; the taunt ends after step 120.
    const spawns = timeline(world, content, 121, 'hostileZoneSpawn');
    expect(spawns.map((s) => s.step)).toEqual([31, 31, 31, 121, 121, 121]);
    expect(spawns[0]!.event.pos).toEqual(vec(300, 300));
    expect(spawns[3]!.event.pos).toEqual(vec(500, 500));
  });
});

describe('grave circles: where the hero is at the end of the wind-up (designer decision 2026-10-24)', () => {
  it('a hero who moves during the wind-up gets the first circle at the new position', () => {
    const { content, world, boss } = setup('zoneBoss');
    boss.life = 500;
    step(world, idle, content, DT);
    expect(boss.casting?.abilityId).toBe('graves');
    world.player.pos = vec(300, 700);
    const placed = timeline(world, content, 30, 'hostileZoneSpawn');
    expect(placed.map((p) => p.step)).toEqual([30, 30, 30]);
    expect(placed[0]!.event.pos).toEqual(vec(300, 700));
  });

  it('circles are kept their radius inside the room (a hero in the corner is still hit)', () => {
    const content = makeContent();
    const world = place(content, vec(10, 10));
    spawnMob(world, content, { defId: 'zoneBoss' }, vec(580, 500), []).life = 500;
    const events = run(world, content, 31);
    const spawns = ofType(events, 'hostileZoneSpawn');
    expect(spawns).toHaveLength(3);
    expect(spawns[0]!.pos).toEqual(vec(40, 40));
    for (const s of spawns) {
      expect(Math.min(s.pos.x, s.pos.y)).toBeGreaterThanOrEqual(40);
      expect(Math.max(s.pos.x, s.pos.y)).toBeLessThanOrEqual(960);
    }
    const erupt = ofType(run(world, content, 60), 'hostileZoneErupt');
    expect(erupt[0]).toMatchObject({ zoneId: spawns[0]!.zoneId, pos: vec(40, 40), hit: true });
  });
});

describe('interrupts by rank', () => {
  function casting(defId: string): { content: Content; world: WorldState; mob: MobState } {
    const r = setup(defId);
    step(r.world, idle, r.content, DT);
    expect(r.boss.casting?.abilityId).toBe('nova');
    return { content: r.content, world: r.world, mob: r.boss };
  }
  const hitOf = (mob: MobState) => ({ mods: [], tags: [], raw: undefined, before: conditionTarget(mob) });

  it('a freeze interrupts a non-boss caster', () => {
    const { content, world, mob } = casting('grunt');
    applyStatus(ctxOf(world, content), mob, { status: 'freeze', duration: 0.5 }, hitOf(mob));
    expect(mob.freeze).toBe(0.5);
    expect(ofType(step(world, idle, content, DT), 'mobCastInterrupted')).toEqual([{ type: 'mobCastInterrupted', id: mob.id, abilityId: 'nova' }]);
    expect(mob.casting).toBeUndefined();
  });

  it('a push interrupts a non-boss caster', () => {
    const { content, world, mob } = casting('grunt');
    mob.knockback = { dir: vec(1, 0), speed: 600, remaining: 30 };
    expect(ofType(step(world, idle, content, DT), 'mobCastInterrupted')).toEqual([{ type: 'mobCastInterrupted', id: mob.id, abilityId: 'nova' }]);
    expect(mob.pos).toEqual(vec(590, 500));
  });

  it('an ordinary stun or freeze on a boss (stun-slow / freeze-slow) does not interrupt; a full stun bar does', () => {
    const { content, world, mob } = casting('novaBoss');
    const ctx = ctxOf(world, content);
    applyStatus(ctx, mob, { status: 'stun', duration: 1 }, hitOf(mob));
    applyStatus(ctx, mob, { status: 'freeze', duration: 1 }, hitOf(mob));
    expect(mob).toMatchObject({ stun: 0, freeze: 0, stunSlow: 1, freezeSlow: 1 });
    const slowed = run(world, content, 10);
    expect(ofType(slowed, 'mobCastInterrupted')).toEqual([]);
    // The wind-up still runs, at half speed: 1 − 10 × 0.5 / 60 left.
    expect(mob.casting?.remaining).toBeCloseTo(1 - 5 * DT, 9);
    fillStunBar(ctx, mob, stunBarStats([FULL_BAR])!, 0);
    expect(mob.stun).toBe(0.4);
    expect(ofType(step(world, idle, content, DT), 'mobCastInterrupted')).toEqual([{ type: 'mobCastInterrupted', id: mob.id, abilityId: 'nova' }]);
    expect(mob.casting).toBeUndefined();
  });
});

// Life potion (docs/design/combat.md, decision 2026-10-26): 40% of the max life recovery pool over 1 s, 3 charges,
// a charge per 15 kill points (normal 1, elite 5, boss 15, minions 0). Bloodsucker ×0.5, Crystal Shell heals ES.
import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data/index';
import { mapsData } from '../../data/maps';
import { passiveTree } from '../../data/passives';
import { lifePotion } from '../../data/potion';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import { createRun, openDoor, stepRun } from '../run/run';
import type { RunInput, RunState } from '../run/types';
import type { ClassDef, Content, LifePotionDef, MobDef, MobRank } from './content';
import { createWorld, potionHealAmount, spawnMob, step, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 5,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 1, max: 1 } }, range: 5, interval: 1, critChance: 0 },
};

const heroClass: ClassDef = {
  id: 'hero',
  radius: 10,
  weaponType: 'sword',
  baseStats: { life: 100, resource: 20, resourceRegen: 0, movementSpeed: 120 },
  resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
  weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
  basicAttack: {
    id: 'strike',
    tags: ['attack', 'melee'],
    resourceCost: 0,
    cooldown: 0,
    damage: { source: 'weapon', effectiveness: 1 },
    delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
  },
  skills: [],
};

/** Fixture potion with the PROPOSAL numbers, so the mechanic tests do not move with rebalancing. */
const potionDef: LifePotionDef = { healFraction: 0.4, duration: 1, maxCharges: 3, pointsPerCharge: 15, killPoints: { normal: 1, elite: 5, boss: 15 } };

const content: Content = {
  combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5, maxLifeCostFraction: 0.9 },
  classes: { hero: heroClass },
  mobs: { dummy },
  arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
  progression: {
    maxLevel: 5,
    xpCurve: { base: 100000, exponent: 1 },
    mobXpGrowth: 0,
    lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
    mapClearBonus: 0.07,
    perLevel: {},
  },
  lifePotion: potionDef,
};

const BLOODSUCKER: readonly PassiveMechanic[] = passiveTree.nodes.k_leech!.mechanics!;
const CRYSTAL: readonly PassiveMechanic[] = passiveTree.nodes.k_crystal!.mechanics!;

const idle: PlayerInput = { move: vec(0, 0), aim: vec(600, 500), basicAttack: false, skills: [] };
const drink: PlayerInput = { ...idle, potion: true };

function hero(mechanics: readonly PassiveMechanic[] = [], data: Content = content): WorldState {
  return createWorld(data, 'hero', 1, { mechanics });
}

function run(world: WorldState, steps: number, input: PlayerInput = idle): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, content, DT));
  return events;
}

const ofType = <T extends WorldEvent['type']>(events: readonly WorldEvent[], type: T): Extract<WorldEvent, { type: T }>[] =>
  events.filter((e): e is Extract<WorldEvent, { type: T }> => e.type === type);

/** Kills one mob of `rank` (optionally a minion) far from the hero; returns the step's events. */
function kill(world: WorldState, rank: MobRank, minion = false): WorldEvent[] {
  const mob = spawnMob(world, content, { defId: 'dummy', rank, ...(minion ? { summonerId: 999 } : {}) }, vec(900, 900), []);
  mob.life = 0;
  return run(world, 1);
}

describe('life potion: data', () => {
  it('PROPOSAL numbers: 40% over 1 s, 3 charges, a charge per 15 points; normal 1, elite 5, boss 15', () => {
    expect(lifePotion).toEqual(potionDef);
    expect(gameContent.lifePotion).toBe(lifePotion);
  });
});

describe('life potion: drinking', () => {
  it('a run starts with full charges and nothing running', () => {
    expect(hero().player.potion).toEqual({ charges: 3, points: 0, heals: [], held: false });
    const noPotion: Content = { ...content };
    delete (noPotion as { lifePotion?: LifePotionDef }).lifePotion;
    expect(hero([], noPotion).player.potion.charges).toBe(0);
  });

  it('heals 40% of max life evenly over 1 s (60 steps), from the step of the drink', () => {
    const world = hero();
    world.player.life = 40;
    const events = run(world, 1, drink);
    expect(ofType(events, 'potionDrink')).toEqual([{ type: 'potionDrink', amount: 40, duration: 1, charges: 2, pos: world.player.pos }]);
    expect(world.player.potion.charges).toBe(2);
    expect(world.player.life).toBeCloseTo(40 + 40 / 60, 10);
    run(world, 29, drink);
    expect(world.player.life).toBeCloseTo(60, 10);
    run(world, 29);
    expect(world.player.potion.heals).toHaveLength(1);
    run(world, 1);
    expect(world.player.potion.heals).toEqual([]);
    expect(world.player.life).toBeCloseTo(80, 10);
    run(world, 30);
    expect(world.player.life).toBeCloseTo(80, 10);
  });

  it('one drink per press: holding the input does not drink again; a new press while healing adds a second heal', () => {
    const world = hero();
    world.player.life = 10;
    expect(ofType(run(world, 10, drink), 'potionDrink')).toHaveLength(1);
    run(world, 1);
    const events = run(world, 1, drink);
    expect(ofType(events, 'potionDrink')).toEqual([expect.objectContaining({ amount: 40, charges: 1 })]);
    expect(world.player.potion.heals).toHaveLength(2);
    // First heal: 12 of its 60 steps done; second heal: 1 of 60.
    expect(world.player.life).toBeCloseTo(10 + (40 * 12) / 60 + 40 / 60, 10);
    run(world, 60);
    expect(world.player.potion.heals).toEqual([]);
    expect(world.player.life).toBeCloseTo(90, 10);
  });

  it('no drink at 0 charges or at full life; the charge is kept at full life', () => {
    const world = hero();
    expect(ofType(run(world, 1, drink), 'potionDenied')).toEqual([{ type: 'potionDenied', reason: 'full' }]);
    expect(world.player.potion.charges).toBe(3);
    world.player.life = 50;
    world.player.potion.charges = 0;
    run(world, 1);
    expect(ofType(run(world, 1, drink), 'potionDenied')).toEqual([{ type: 'potionDenied', reason: 'empty' }]);
    expect(world.player.potion.heals).toEqual([]);
    expect(world.player.life).toBe(50);
  });

  it('heal over max life is lost; a dead hero cannot drink', () => {
    const world = hero();
    world.player.life = 90;
    run(world, 60, drink);
    expect(world.player.life).toBe(100);
    world.player.life = 0;
    world.player.dead = true;
    run(world, 1);
    expect(run(world, 1, drink)).toEqual([]);
    expect(world.player.potion.charges).toBe(2);
  });

  it('Bloodsucker: the heal is halved (20 of 100)', () => {
    const world = hero(BLOODSUCKER);
    world.player.life = 40;
    expect(potionHealAmount(content, heroClass, world.player)).toBe(20);
    expect(ofType(run(world, 1, drink), 'potionDrink')[0]!.amount).toBe(20);
    run(world, 59);
    expect(world.player.life).toBeCloseTo(60, 10);
  });

  it('Crystal Shell: the potion heals 40% of max ES into ES; life stays 1; full ES refuses the drink', () => {
    const world = hero(CRYSTAL);
    expect(world.player.energyShield).toBe(100);
    expect(ofType(run(world, 1, drink), 'potionDenied')).toEqual([{ type: 'potionDenied', reason: 'full' }]);
    world.player.energyShield = 30;
    run(world, 1);
    expect(ofType(run(world, 1, drink), 'potionDrink')[0]!.amount).toBe(40);
    run(world, 59);
    expect(world.player.energyShield).toBeCloseTo(70, 10);
    expect(world.player.life).toBe(1);
  });

  it('Crystal Shell + Bloodsucker: 20% of max ES', () => {
    const world = hero([...CRYSTAL, ...BLOODSUCKER]);
    world.player.energyShield = 30;
    expect(ofType(run(world, 1, drink), 'potionDrink')[0]!.amount).toBe(20);
  });

  it('the heal keeps ticking during a time stop (the hero acts)', () => {
    const world = hero();
    world.timeStop = 3;
    world.player.life = 40;
    run(world, 60, drink);
    expect(world.timeStop).toBeGreaterThan(0);
    expect(world.player.life).toBeCloseTo(80, 10);
  });
});

describe('life potion: charges from kills', () => {
  it('15 ordinary kills make a charge', () => {
    const world = hero();
    world.player.potion.charges = 0;
    for (let i = 0; i < 14; i++) expect(ofType(kill(world, 'normal'), 'potionCharge')).toEqual([]);
    expect(world.player.potion.points).toBe(14);
    expect(ofType(kill(world, 'normal'), 'potionCharge')).toEqual([{ type: 'potionCharge', charges: 1 }]);
    expect(world.player.potion).toMatchObject({ charges: 1, points: 0 });
  });

  it('an elite gives 5 points, a boss 15 (a full charge); leftover points carry over', () => {
    const world = hero();
    world.player.potion.charges = 0;
    kill(world, 'elite');
    kill(world, 'elite');
    expect(world.player.potion.points).toBe(10);
    kill(world, 'boss');
    expect(world.player.potion).toMatchObject({ charges: 1, points: 10 });
    kill(world, 'elite');
    expect(world.player.potion).toMatchObject({ charges: 2, points: 0 });
  });

  it('minions give nothing', () => {
    const world = hero();
    world.player.potion.charges = 0;
    kill(world, 'normal', true);
    kill(world, 'boss', true);
    expect(world.player.potion).toMatchObject({ charges: 0, points: 0 });
  });

  it('cap 3: reaching the cap drops the leftover points; kills at the cap give nothing', () => {
    const world = hero();
    world.player.potion.charges = 2;
    world.player.potion.points = 14;
    expect(ofType(kill(world, 'boss'), 'potionCharge')).toEqual([{ type: 'potionCharge', charges: 3 }]);
    expect(world.player.potion).toMatchObject({ charges: 3, points: 0 });
    expect(ofType(kill(world, 'boss'), 'potionCharge')).toEqual([]);
    expect(world.player.potion).toMatchObject({ charges: 3, points: 0 });
  });
});

describe('life potion: map run', () => {
  const idleRun: RunInput = { move: vec(0, 0), aim: vec(0, 0), basicAttack: false, skills: [] };
  const newRun = (seed: number): RunState => createRun(gameContent, mapsData, 'warrior', seed, {}, 1);

  it('charges, points and a running heal carry into the next room; a new run starts full', () => {
    const r = newRun(11);
    for (let i = 0; i < 100000 && r.phase === 'waves'; i++) {
      for (const mob of r.world.mobs) mob.life = 0;
      stepRun(r, idleRun, gameContent, mapsData, DT);
    }
    expect(r.phase).toBe('cleared');
    const player = r.world.player;
    player.potion = { charges: 1, points: 7, heals: [], held: false };
    player.life = 1;
    stepRun(r, { ...idleRun, potion: true }, gameContent, mapsData, DT);
    expect(player.potion.charges).toBe(0);
    const door = openDoor(r, mapsData)!;
    player.pos = vec(door.x, door.y);
    const events = stepRun(r, idleRun, gameContent, mapsData, DT);
    expect(events.some((e) => e.type === 'roomEnter')).toBe(true);
    expect(player.potion).toMatchObject({ charges: 0, points: 7 });
    expect(player.potion.heals).toHaveLength(1);
    expect(newRun(12).world.player.potion).toEqual({ charges: 3, points: 0, heals: [], held: false });
  });
});

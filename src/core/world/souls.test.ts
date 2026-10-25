// Souls (legendary Devourer's Crown, 0.4 pkg 6c; docs/design/items.md, defaults in overnight-questions.md «Пакет 6»):
// counting kills, the guaranteed echo at the cap, the "no souls" damage cost, and the real data on the warrior.
import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data/index';
import { itemsData } from '../../data/items';
import { passiveTree } from '../../data/passives';
import { supportsData } from '../../data/supports';
import type { Equipment } from '../items/equipment';
import type { Item } from '../items/types';
import { vec } from '../math';
import { createAllocation } from '../passives/allocation';
import { heroMechanics, heroModifiers } from '../progression/hero';
import { computeStat } from '../stats/modifiers';
import type { Content, MobDef } from './content';
import { soulEchoDelay, soulsMax } from './souls';
import { allModifiers, createWorld, step, type Loadout, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 1000,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 1, max: 1 } }, range: 5, interval: 100, critChance: 0 },
};

const content: Content = {
  ...gameContent,
  mobs: { ...gameContent.mobs, dummy },
  arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
};

/** The crown with its stat lines rolled to 0, so only its mechanics count. */
function crown(): Item {
  const def = itemsData.uniques.devourer_crown!;
  return { id: 'crown', baseId: def.baseId, level: 31, rarity: def.rarity, name: '', affixes: [], unique: { id: def.id, rolls: def.stats.map(() => ({ tier: 1, value: 0 })) } };
}

function loadout(item: Item | undefined): Pick<Loadout, 'modifiers' | 'mechanics'> {
  const equipment: Equipment = item ? { helmet: item } : {};
  const hero = { equipment, passives: createAllocation() };
  return { modifiers: heroModifiers(hero, itemsData, passiveTree), mechanics: heroMechanics(hero, passiveTree, itemsData) };
}

function warrior(withCrown = true): WorldState {
  const world = createWorld(content, 'warrior', 1, loadout(withCrown ? crown() : undefined));
  world.player.resource = 100;
  return world;
}

function addMob(world: WorldState, x: number, y: number, extra: Partial<MobState> = {}): MobState {
  const mob: MobState = { id: world.nextId++, defId: 'dummy', pos: vec(x, y), facing: vec(0, 1), life: 1000, maxLife: 1000, attackTimer: 100, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: 10, ...extra };
  world.mobs.push(mob);
  return mob;
}

/** Puts `count` dead mobs into the world (far from the hero) and steps once: removeDeadMobs takes them. */
function killMobs(world: WorldState, count: number, extra: Partial<MobState> = {}): WorldEvent[] {
  for (let i = 0; i < count; i++) addMob(world, 50 + i, 50, { life: 0, ...extra });
  return step(world, idle, content, DT);
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const cleave: PlayerInput = { ...idle, skills: [true] };
const charge: PlayerInput = { ...idle, skills: [false, true] };
const battleCry: PlayerInput = { ...idle, skills: [false, false, true] };
const strike: PlayerInput = { ...idle, basicAttack: true };

function run(world: WorldState, input: PlayerInput, steps: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, content, DT));
  return events;
}

const ofType = <T extends WorldEvent['type']>(events: readonly WorldEvent[], type: T): Extract<WorldEvent, { type: T }>[] =>
  events.filter((e): e is Extract<WorldEvent, { type: T }> => e.type === type);

describe("Devourer's Crown: souls", () => {
  it('data: a legendary helmet; souls max 30, echo after the Echo support delay, 30% less damage at 0 souls', () => {
    const def = itemsData.uniques.devourer_crown!;
    expect(def.rarity).toBe('legendary');
    expect(itemsData.bases[def.baseId]!.slot).toBe('helmet');
    expect(def.mechanics!.find((m) => m.kind === 'souls')).toMatchObject({ max: 30, echoDelay: 0.25 });
    // The same pause as the Echo support's repeat.
    expect(supportsData.supports.echo!.tiers.map((t) => t.bonus.grants?.echo?.delay)).toEqual([0.25, 0.25, 0.25]);
  });

  it('souls start at 0; every non-minion death gives one (soulGain), up to 30, then nothing', () => {
    const world = warrior();
    expect(world.player.souls).toBe(0);
    const first = killMobs(world, 3);
    expect(world.player.souls).toBe(3);
    expect(ofType(first, 'soulGain').map((e) => e.souls)).toEqual([1, 2, 3]);
    expect(world.kills).toBe(3);
    killMobs(world, 26);
    expect(world.player.souls).toBe(29);
    const capped = killMobs(world, 3);
    expect(world.player.souls).toBe(30);
    expect(ofType(capped, 'soulGain').map((e) => e.souls)).toEqual([30]);
    expect(world.kills).toBe(32);
  });

  it('minions give no soul, also when they die with their summoner', () => {
    const world = warrior();
    const summoner = addMob(world, 50, 900);
    killMobs(world, 2, { summonerId: summoner.id });
    expect(world.player.souls).toBe(0);
    addMob(world, 60, 900, { summonerId: summoner.id });
    summoner.life = 0;
    const events = step(world, idle, content, DT);
    expect(ofType(events, 'death')).toHaveLength(2);
    expect(world.player.souls).toBe(1);
  });

  it('without the crown no souls are counted', () => {
    const world = warrior(false);
    expect(soulsMax(world.player)).toBeUndefined();
    expect(soulsMax(warrior().player)).toBe(30);
    const events = killMobs(world, 5);
    expect(world.player.souls).toBe(0);
    expect(ofType(events, 'soulGain')).toEqual([]);
  });

  it('at 30 the next Cleave fires twice: the echo 0.25 s later still hits with the souls, then they are spent', () => {
    const world = warrior();
    world.player.souls = 30;
    const mob = addMob(world, 560, 500);
    const use = run(world, cleave, 1);
    expect(ofType(use, 'soulEcho')).toEqual([{ type: 'soulEcho', actionId: 'cleave', pos: world.player.pos, delay: 0.25 }]);
    expect(ofType(use, 'hit').filter((h) => h.targetId === mob.id)).toHaveLength(1);
    expect(world.player.echoes).toHaveLength(1);
    expect(world.player.souls).toBe(30);
    // 14 more steps: not yet.
    const waiting = run(world, idle, 14);
    expect(ofType(waiting, 'echo')).toEqual([]);
    expect(world.player.souls).toBe(30);
    const fired = run(world, idle, 1);
    expect(ofType(fired, 'echo')).toEqual([{ type: 'echo', actionId: 'cleave', pos: world.player.pos, facing: vec(1, 0), souls: true }]);
    expect(ofType(fired, 'hit').filter((h) => h.targetId === mob.id)).toHaveLength(1);
    expect(world.player.souls).toBe(0);
    expect(world.player.echoes).toEqual([]);
  });

  it('a kill by the souls echo already counts towards the next 30', () => {
    const world = warrior();
    world.player.souls = 30;
    run(world, cleave, 1);
    const mob = addMob(world, 560, 500, { life: 1 });
    const events = run(world, idle, 15);
    expect(ofType(events, 'death').map((e) => e.id)).toEqual([mob.id]);
    expect(world.player.souls).toBe(1);
  });

  it('movement (Shield Charge) and buff (Battle Cry) uses keep the souls; the basic attack takes them', () => {
    const world = warrior();
    world.player.souls = 30;
    const dash = run(world, charge, 1);
    expect(ofType(dash, 'action').map((e) => e.actionId)).toEqual(['shield_charge']);
    expect(ofType(dash, 'soulEcho')).toEqual([]);
    run(world, idle, 60);
    const cry = run(world, battleCry, 1);
    expect(ofType(cry, 'action').map((e) => e.actionId)).toEqual(['battle_cry']);
    run(world, idle, 60);
    expect(world.player.echoes).toEqual([]);
    expect(world.player.souls).toBe(30);
    const attack = run(world, strike, 1);
    expect(ofType(attack, 'soulEcho').map((e) => e.actionId)).toEqual(['warrior_strike']);
    run(world, idle, 15);
    expect(world.player.souls).toBe(0);
  });

  it('one souls echo at a time: while it waits, no other use takes the souls', () => {
    const world = warrior();
    world.player.souls = 30;
    const cleaveAction = world.player.actions.skills[0]!;
    expect(soulEchoDelay(world.player, cleaveAction)).toBe(0.25);
    run(world, cleave, 1);
    expect(soulEchoDelay(world.player, cleaveAction)).toBeUndefined();
    world.player.souls = 29;
    world.player.echoes = [];
    expect(soulEchoDelay(world.player, cleaveAction)).toBeUndefined();
  });

  it('with the Echo support socketed the souls echo replaces its roll: one echo, not two; later uses roll again', () => {
    // A forced Echo support (chance 1) shows the roll is skipped, not lost.
    const forced: Content = {
      ...content,
      supports: {
        ...supportsData,
        supports: { ...supportsData.supports, echo: { ...supportsData.supports.echo!, tiers: [{ bonus: { grants: { echo: { chance: 1, delay: 0.25 } } } }] } },
      },
    };
    const world = createWorld(forced, 'warrior', 1, { ...loadout(crown()), supports: { cleave: [{ defId: 'echo', tier: 1 }] } });
    world.player.resource = 100;
    world.player.souls = 30;
    const events: WorldEvent[] = [];
    for (let i = 0; i < 16; i++) events.push(...step(world, i === 0 ? cleave : idle, forced, DT));
    expect(ofType(events, 'echo').map((e) => e.souls === true)).toEqual([true]);
    expect(world.player.souls).toBe(0);
    for (let i = 0; i < 60; i++) step(world, idle, forced, DT);
    for (let i = 0; i < 16; i++) events.push(...step(world, i === 0 ? cleave : idle, forced, DT));
    expect(ofType(events, 'action').map((e) => e.actionId)).toEqual(['cleave', 'cleave']);
    expect(ofType(events, 'echo').map((e) => e.souls === true)).toEqual([true, false]);
  });

  it('cost: 30% less damage while holding no souls, none from the first soul on', () => {
    const world = warrior();
    const classDef = content.classes.warrior!;
    const damage = (): number => computeStat(100, allModifiers(classDef, world.player), 'damage');
    expect(damage()).toBeCloseTo(70, 10);
    world.player.souls = 1;
    expect(damage()).toBe(100);
    world.player.souls = 30;
    expect(damage()).toBe(100);
    // Without the crown there is no cost.
    expect(computeStat(100, allModifiers(classDef, warrior(false).player), 'damage')).toBe(100);
  });
});

// Map run state machine (docs/design/maps.md): rooms and waves, door gating, altar and boss, timer, fails, ranks.
import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import type { SupportData } from '../supports/types';
import type { ActionDef, ClassDef, Content, MobDef } from '../world/content';
import { clampToArena, isBoss, mobRank, spawnMob, step, type PlayerInput } from '../world/world';
import { abandonRun, canActivateAltar, createRun, currentTemplate, eliteModifierPoolAt, levelCurveMultiplier, mobLevelScaling, mobPoolAt, openDoor, rollEliteModifier, stepRun, timeLeft } from './run';
import { createRng } from '../rng';
import { planRunRewards, runOutcome } from './rewards';
import type { MapsData, RunInput, RunState, RunStepEvent } from './types';

const DT = 1 / 60;

// Exact elite modifier rolls of the fixtures in the «elite modifiers» block (fixed seeds).
const ROLLS_MAP1 = ['quick', 'tough', 'quick', 'quick', 'tough', 'quick', 'tough', 'quick'];
const ROLLS_MAP3 = ['deep', 'deep', 'deep', 'deep', 'quick', 'deep', 'quick', 'deep'];
const ELITES_SEED7 = ['quick', 'quick', 'quick', 'quick'];

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 10,
  xp: 10,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 1, max: 1 } }, range: 5, interval: 1, critChance: 0 },
};
const late: MobDef = { ...dummy, id: 'late' };
const plated: MobDef = { ...dummy, id: 'plated', armour: 10 };
const biter: MobDef = { ...dummy, id: 'biter', attack: { ...dummy.attack, damage: { physical: { min: 1000, max: 1000 } } } };
/** Raises 2 dummies 0.5 s after it spawns (once: cooldown 100). */
const caller: MobDef = {
  ...dummy,
  id: 'caller',
  abilities: {
    recovery: 0,
    phases: [],
    list: [{ id: 'call', kind: 'summon', windUp: 0.5, cooldown: 100, count: 2, maxAlive: 2, ringRadius: 30, pool: [{ mobId: 'dummy', weight: 1 }] }],
  },
};

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};

const heroClass: ClassDef = {
  id: 'hero',
  radius: 10,
  weaponType: 'sword',
  baseStats: { life: 100, resource: 20, resourceRegen: 0, movementSpeed: 120 },
  resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
  weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
  basicAttack: strike,
  skills: [],
};

const content: Content = {
  combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5, maxLifeCostFraction: 0.9 },
  classes: { hero: heroClass },
  mobs: { dummy, late, biter, caller, plated },
  arena: { width: 1000, height: 1000, spawn: { firstDelay: 1, interval: 1, batchStart: 5, batchGrowth: 0, maxAlive: 50, mobIds: ['dummy'] } },
  progression: {
    maxLevel: 5,
    xpCurve: { base: 100000, exponent: 1 },
    mobXpGrowth: 0,
    lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
    mapClearBonus: 0.07,
    perLevel: {},
  },
};

const maps: MapsData = {
  rules: {
    combatRooms: 2,
    timeLimit: 60,
    timeWarnings: [30, 10],
    maxLinearMap: 5,
    doorRadius: 20,
    altarRadius: 30,
    waves: {
      count: { min: 2, max: 2 },
      mobs: { min: 2, max: 2 },
      firstDelay: 0.5,
      nextDelay: 1,
      spawnJitter: 0,
      mobPool: [
        { mobId: 'dummy', weight: 1 },
        { mobId: 'late', weight: 1, minMapLevel: 3 },
      ],
    },
    elites: { count: { min: 1, max: 1 }, scaling: { life: 3, damage: 2, xp: 5, radius: 1.5 } },
    boss: { mobId: 'dummy', scaling: { life: 10, damage: 4, xp: 20, radius: 2 }, spawnDelay: 0.5 },
    // No growth: the other tests see the defs' numbers on every map (scaledMaps below has growth).
    mobScaling: { life: { linear: 0, compound: 0 }, damage: { linear: 0, compound: 0 }, armour: { linear: 0, compound: 0 } },
  },
  rewards: {
    chest: { items: 2, bossItemLevelBonus: 1, maxItemLevelBonus: 3, speedTiers: [], bossUniqueWeightMultiplier: 3, legendary: { minMapLevel: 30, chance: 0.002 } },
    shardsPerRoom: 2,
    bossRoomConsolationItems: 1,
    essence: { perElite: 0.1, perBoss: 0.5 },
  },
  templates: {
    roomA: { id: 'roomA', kind: 'combat', width: 400, height: 300, entry: vec(20, 150), exit: vec(380, 150), spawnPoints: [vec(300, 50)] },
    roomB: {
      id: 'roomB',
      kind: 'combat',
      width: 300,
      height: 300,
      entry: vec(150, 280),
      exit: vec(150, 20),
      spawnPoints: [vec(150, 100)],
      obstacles: [{ pos: vec(150, 200), radius: 20 }],
    },
    lair: { id: 'lair', kind: 'boss', width: 400, height: 400, entry: vec(200, 380), altar: vec(200, 100), bossSpawn: vec(200, 50), spawnPoints: [vec(100, 100)] },
  },
};

/** Same rules with growth: map 3 = life × 4 (compound 1: 2²), damage × 2 (linear 0.5: 1 + 0.5 × 2), armour × 3 (linear 1). */
const scaledMaps: MapsData = {
  ...maps,
  rules: { ...maps.rules, mobScaling: { life: { linear: 0, compound: 1 }, damage: { linear: 0.5, compound: 0 }, armour: { linear: 1, compound: 0 } } },
};

const idle: RunInput = { move: vec(0, 0), aim: vec(0, 0), basicAttack: false, skills: [] };
const interact: RunInput = { ...idle, interact: true };

function newRun(seed = 7, mapLevel = 1, data: MapsData = maps): RunState {
  return createRun(content, data, 'hero', seed, {}, mapLevel);
}

function steps(run: RunState, n: number, input: RunInput = idle): RunStepEvent[] {
  const out: RunStepEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...stepRun(run, input, content, maps, DT));
  return out;
}

/** Steps until an event of `type` appears (at most `max` steps); returns the events of that last step. */
function stepUntil(run: RunState, type: RunStepEvent['type'], input: RunInput = idle, max = 10000): RunStepEvent[] {
  for (let i = 0; i < max; i++) {
    const events = stepRun(run, input, content, maps, DT);
    if (events.some((e) => e.type === type)) return events;
  }
  throw new Error(`No ${type} within ${max} steps`);
}

function killAll(run: RunState): void {
  for (const mob of run.world.mobs) mob.life = 0;
}

/** Clears the current combat room: kills each wave as it comes until the door opens. */
function clearRoom(run: RunState): void {
  for (let i = 0; i < 10000 && run.phase === 'waves'; i++) {
    killAll(run);
    stepRun(run, idle, content, maps, DT);
  }
  expect(run.phase).toBe('cleared');
}

function walkThroughDoor(run: RunState): RunStepEvent[] {
  const door = openDoor(run, maps);
  if (!door) throw new Error('door closed');
  run.world.player.pos = vec(door.x, door.y);
  return stepRun(run, idle, content, maps, DT);
}

function toBossRoom(run: RunState): void {
  for (let room = 0; room < maps.rules.combatRooms; room++) {
    clearRoom(run);
    walkThroughDoor(run);
  }
  expect(run.rooms[run.room]!.kind).toBe('boss');
}

function summonBoss(run: RunState): number {
  const t = currentTemplate(run, maps);
  if (t.kind !== 'boss') throw new Error('not in the boss room');
  run.world.player.pos = vec(t.altar.x, t.altar.y + 20);
  stepUntil(run, 'bossSpawned', interact);
  return run.bossId!;
}

describe('createRun', () => {
  it('plans K combat rooms + the boss room from the seed; the hero starts at the first entry at map level', () => {
    const run = newRun(7, 3);
    expect(run.rooms.map((r) => r.kind)).toEqual(['combat', 'combat', 'boss']);
    expect(new Set(run.rooms.slice(0, 2).map((r) => r.templateId))).toEqual(new Set(['roomA', 'roomB']));
    expect(run.rooms[2]!.templateId).toBe('lair');
    for (const room of run.rooms.slice(0, 2)) {
      expect(room.waves).toHaveLength(2);
      // 2 mobs per wave + 1 elite in one of them.
      expect(room.waves.flat()).toHaveLength(5);
      expect(room.waves.flat().filter((s) => s.rank === 'elite')).toEqual([expect.objectContaining({ rank: 'elite', lifeScale: 3, damageScale: 2, xpScale: 5, radiusScale: 1.5 })]);
    }
    const first = currentTemplate(run, maps);
    expect(run.world.areaLevel).toBe(3);
    expect(run.world.endless).toBe(false);
    expect(run.world.bounds).toEqual({ width: first.width, height: first.height });
    expect(run.world.player.pos).toEqual(first.entry);
    expect(run).toMatchObject({ mapLevel: 3, room: 0, phase: 'waves', wavesSpawned: 0, status: 'active', elapsed: 0, roomsCleared: 0 });
    expect(timeLeft(run, maps)).toBe(60);
  });

  it('only mob types unlocked at the map level enter the waves', () => {
    expect(mobPoolAt(maps.rules, 1).map((e) => e.mobId)).toEqual(['dummy']);
    expect(mobPoolAt(maps.rules, 3).map((e) => e.mobId)).toEqual(['dummy', 'late']);
    expect(newRun(7, 1).rooms.flatMap((r) => r.waves.flat()).every((s) => s.defId === 'dummy')).toBe(true);
    expect(newRun(7, 3).rooms.flatMap((r) => r.waves.flat()).some((s) => s.defId === 'late')).toBe(true);
  });

  it('is deterministic: the same seed and inputs give the same run; another seed another plan', () => {
    const play = (seed: number): RunState => {
      const run = newRun(seed);
      steps(run, 40);
      killAll(run);
      steps(run, 70, { ...idle, move: vec(1, 0), basicAttack: true, aim: vec(400, 150) });
      return run;
    };
    expect(JSON.stringify(play(11))).toBe(JSON.stringify(play(11)));
    const plans = new Set([1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(newRun(s).rooms)));
    expect(plans.size).toBeGreaterThan(1);
  });

  it('keeps the plain arena working: the endless spawner runs only there', () => {
    const run = newRun();
    expect(run.world.mobs).toHaveLength(0);
    // A world step alone (no run rules) never spawns arena waves into a run world.
    for (let i = 0; i < 120; i++) step(run.world, idle as PlayerInput, content, DT);
    expect(run.world.mobs).toHaveLength(0);
  });
});

describe('waves and room progression', () => {
  it('the first wave comes after firstDelay, the next one nextDelay after the previous wave is dead', () => {
    const run = newRun();
    expect(steps(run, 29).some((e) => e.type === 'waveStart')).toBe(false);
    const first = steps(run, 1);
    const waveSize = run.rooms[0]!.waves[0]!.length;
    expect(first.filter((e) => e.type === 'waveStart')).toEqual([{ type: 'waveStart', room: 0, wave: 0, count: waveSize }]);
    expect(first.filter((e) => e.type === 'spawn')).toHaveLength(waveSize);
    expect(run.world.mobs).toHaveLength(waveSize);
    // Spawn points (no jitter here) inside the room.
    for (const mob of run.world.mobs) expect(mob.pos).toEqual(vec(300, 50));
    // While mobs live, no next wave however long it takes.
    expect(steps(run, 300).some((e) => e.type === 'waveStart')).toBe(false);
    killAll(run);
    expect(steps(run, 59).some((e) => e.type === 'waveStart')).toBe(false);
    expect(steps(run, 1).filter((e) => e.type === 'waveStart')).toEqual([{ type: 'waveStart', room: 0, wave: 1, count: run.rooms[0]!.waves[1]!.length }]);
  });

  it('the room is cleared when its last wave is dead: the door opens; only then does walking into it change rooms', () => {
    const run = newRun();
    const t = currentTemplate(run, maps);
    if (t.kind !== 'combat') throw new Error('combat room expected');
    stepUntil(run, 'waveStart');
    // Door closed: standing in the doorway does nothing.
    run.world.player.pos = vec(t.exit.x, t.exit.y);
    steps(run, 5);
    expect(run.room).toBe(0);
    expect(openDoor(run, maps)).toBeNull();

    killAll(run);
    stepUntil(run, 'waveStart');
    killAll(run);
    const cleared = steps(run, 1);
    expect(cleared.filter((e) => e.type === 'roomCleared')).toEqual([{ type: 'roomCleared', room: 0, door: t.exit }]);
    expect(run).toMatchObject({ phase: 'cleared', roomsCleared: 1, room: 0 });
    expect(openDoor(run, maps)).toEqual(t.exit);

    // Away from the door: still in room 0.
    run.world.player.pos = vec(t.exit.x - maps.rules.doorRadius - 1, t.exit.y);
    steps(run, 1);
    expect(run.room).toBe(0);
    run.world.projectiles.push({ ...dummyProjectile(), id: 999 });
    const entered = walkThroughDoor(run);
    const next = currentTemplate(run, maps);
    expect(entered.filter((e) => e.type === 'roomEnter')).toEqual([{ type: 'roomEnter', room: 1, templateId: next.id, kind: 'combat' }]);
    expect(run).toMatchObject({ room: 1, phase: 'waves', wavesSpawned: 0, waveTimer: 0.5 });
    expect(run.world.bounds).toEqual({ width: next.width, height: next.height });
    expect(run.world.obstacles).toEqual(next.obstacles ?? []);
    expect(run.world.player.pos).toEqual(next.entry);
    expect(run.world.projectiles).toEqual([]);
  });

  it('elites are counted when they die (rankedKill), with their rank scaling', () => {
    const run = newRun();
    let elite = undefined as ReturnType<typeof run.world.mobs.find>;
    for (let i = 0; i < 1000 && !elite; i++) {
      stepRun(run, idle, content, maps, DT);
      elite = run.world.mobs.find((m) => m.rank === 'elite');
      if (!elite && run.world.mobs.length > 0) killAll(run);
    }
    if (!elite) throw new Error('no elite');
    expect(elite).toMatchObject({ rank: 'elite', life: 30, maxLife: 30, damageScale: 2, xpScale: 5, radius: 15 });
    expect(mobRank(dummy, elite)).toBe('elite');
    expect(run.eliteIds).toContain(elite.id);
    const xpBefore = run.world.xpGained;
    elite.life = 0;
    const events = steps(run, 1);
    expect(events.filter((e) => e.type === 'rankedKill')).toEqual([{ type: 'rankedKill', id: elite.id, rank: 'elite' }]);
    expect(run.elitesKilled).toBe(1);
    // XP 10 × xpScale 5 (no area growth, no penalty at map 1).
    expect(run.world.xpGained - xpBefore).toBe(50);
  });

  it('obstacles keep bodies out', () => {
    const world = { bounds: { width: 300, height: 300 }, obstacles: [{ pos: vec(150, 200), radius: 20 }] };
    expect(clampToArena(vec(150, 195), 10, world)).toEqual(vec(150, 170));
    expect(clampToArena(vec(150, 200), 10, world)).toEqual(vec(180, 200));
    expect(clampToArena(vec(100, 100), 10, world)).toEqual(vec(100, 100));
    expect(clampToArena(vec(-5, 400), 10, world)).toEqual(vec(10, 290));
  });

  it('a hero walking into a pillar stops at its edge', () => {
    const run = newRun();
    run.world.bounds = { width: 300, height: 300 };
    run.world.obstacles = [{ pos: vec(150, 200), radius: 20 }];
    run.world.player.pos = vec(150, 280);
    steps(run, 120, { ...idle, move: vec(0, -1) });
    expect(run.world.player.pos.x).toBe(150);
    expect(run.world.player.pos.y).toBe(230);
  });
});

describe('mob growth with the map level', () => {
  it('a curve is × 1 at level 1 (and below); the linear and compound terms multiply', () => {
    expect(levelCurveMultiplier({ linear: 0.5, compound: 0.3 }, 1)).toBe(1);
    expect(levelCurveMultiplier({ linear: 0.5, compound: 0.3 }, 0)).toBe(1);
    expect(levelCurveMultiplier({ linear: 0.5, compound: 0.3 }, -3)).toBe(1);
    expect(levelCurveMultiplier({ linear: 0, compound: 0 }, 40)).toBe(1);
    expect(levelCurveMultiplier({ linear: 0.5, compound: 0 }, 5)).toBe(3);
    expect(levelCurveMultiplier({ linear: 0, compound: 1 }, 4)).toBe(8);
    expect(levelCurveMultiplier({ linear: 0.5, compound: 1 }, 3)).toBe(8);
  });

  it('mobLevelScaling: life and damage multipliers of a map level', () => {
    expect(mobLevelScaling(scaledMaps.rules, 1)).toEqual({ life: 1, damage: 1, armour: 1 });
    expect(mobLevelScaling(scaledMaps.rules, 3)).toEqual({ life: 4, damage: 2, armour: 3 });
    expect(mobLevelScaling(maps.rules, 3)).toEqual({ life: 1, damage: 1, armour: 1 });
  });

  it("map 1 changes nothing: the defs' numbers, no damage scale on ordinary mobs", () => {
    const run = newRun(7, 1, scaledMaps);
    expect(run.world.mobScale).toEqual({ life: 1, damage: 1, armour: 1 });
    const mob = spawnMob(run.world, content, { defId: 'dummy' }, vec(300, 50), []);
    expect(mob.life).toBe(10);
    expect(mob.maxLife).toBe(10);
    expect(mob.damageScale).toBeUndefined();
  });

  it('waves and elites (on top of their rank scaling) grow; their hits deal the scaled damage', () => {
    const run = newRun(7, 3, scaledMaps);
    expect(run.world.mobScale).toEqual({ life: 4, damage: 2, armour: 3 });
    stepUntil(run, 'waveStart');
    const normal = run.world.mobs.filter((m) => m.rank === undefined);
    expect(normal.length).toBeGreaterThan(0);
    for (const m of normal) expect(m).toMatchObject({ life: 40, maxLife: 40, damageScale: 2 });
    for (const m of run.world.mobs.filter((m) => m.rank === 'elite')) expect(m).toMatchObject({ life: 120, maxLife: 120, damageScale: 4, xpScale: 5 });
    // A dummy next to the hero: its 1-damage swing lands as 2.
    killAll(run);
    stepRun(run, idle, content, scaledMaps, DT);
    const hero = run.world.player;
    expect(hero.life).toBe(100);
    spawnMob(run.world, content, { defId: 'dummy' }, vec(hero.pos.x + 23, hero.pos.y), []);
    const events = stepRun(run, idle, content, scaledMaps, DT);
    expect(events.filter((e) => e.type === 'mobAttack')).toHaveLength(1);
    expect(hero.life).toBe(98);
  });

  it('the boss grows (numbers only)', () => {
    const run = newRun(7, 3, scaledMaps);
    toBossRoom(run);
    const bossId = summonBoss(run);
    const boss = run.world.mobs.find((m) => m.id === bossId)!;
    expect(boss).toMatchObject({ rank: 'boss', life: 400, maxLife: 400, damageScale: 8, xpScale: 20, radius: 20 });
  });

  it('armour grows with the map level (not with rank) and cuts the hero hits by the grown amount', () => {
    // Map 1: the def's armour, no armour key; a 10 physical hit vs 10 armour: 10 / (10 + 5 × 10) = 1/6 off.
    const low = newRun(7, 1, scaledMaps);
    expect(spawnMob(low.world, content, { defId: 'plated' }, vec(300, 50), []).armour).toBeUndefined();
    const run = newRun(7, 3, scaledMaps);
    const elite = spawnMob(run.world, content, { defId: 'plated', rank: 'elite', lifeScale: 3 }, vec(300, 50), []);
    expect(elite.armour).toBe(30);
    expect(spawnMob(run.world, content, { defId: 'dummy' }, vec(300, 100), []).armour).toBe(0);
    run.world.mobs = [];
    // Map 3: armour 30 vs the hero's 10 physical swing: 30 / (30 + 50) = 0.375 off → 6.25 of 40 life.
    const hero = run.world.player;
    const mob = spawnMob(run.world, content, { defId: 'plated' }, vec(hero.pos.x + 30, hero.pos.y), []);
    expect(mob).toMatchObject({ life: 40, armour: 30 });
    stepRun(run, { ...idle, basicAttack: true, aim: vec(hero.pos.x + 30, hero.pos.y) }, content, scaledMaps, DT);
    expect(mob.life).toBe(33.75);
  });

  it("minions raised by any mob grow too, without their summoner's rank scaling", () => {
    const run = newRun(7, 3, scaledMaps);
    const elite = spawnMob(run.world, content, { defId: 'caller', rank: 'elite', lifeScale: 3, damageScale: 2, xpScale: 5 }, vec(300, 50), []);
    expect(elite).toMatchObject({ life: 120, damageScale: 4 });
    stepUntil(run, 'mobAbility');
    const minions = run.world.mobs.filter((m) => m.summonerId === elite.id);
    expect(minions).toHaveLength(2);
    for (const m of minions) expect(m).toMatchObject({ defId: 'dummy', life: 40, maxLife: 40, damageScale: 2 });
    expect(minions.every((m) => m.rank === undefined && m.xpScale === undefined)).toBe(true);
  });

  it("an elite summoner's minions give nothing and crumble with it: one elite kill (essence), its XP only", () => {
    const run = newRun(7, 3, scaledMaps);
    const elite = spawnMob(run.world, content, { defId: 'caller', rank: 'elite', lifeScale: 3, damageScale: 2, xpScale: 5 }, vec(300, 50), []);
    run.eliteIds.push(elite.id);
    stepUntil(run, 'mobAbility');
    const minionIds = run.world.mobs.filter((m) => m.summonerId === elite.id).map((m) => m.id);
    expect(minionIds).toHaveLength(2);
    elite.life = 0;
    const events = stepRun(run, idle, content, scaledMaps, DT);
    expect(events.flatMap((e) => (e.type === 'death' ? [e.id] : []))).toEqual([elite.id, ...minionIds]);
    expect(events.filter((e) => e.type === 'rankedKill')).toEqual([{ type: 'rankedKill', id: elite.id, rank: 'elite' }]);
    expect(run.world.mobs).toEqual([]);
    expect(run.elitesKilled).toBe(1);
    expect(run.world.kills).toBe(1);
    // 10 × xpScale 5 (no area growth in this fixture); the minions add nothing.
    expect(run.world.xpGained).toBe(50);
  });
});

function dummyProjectile(): RunState['world']['projectiles'][number] {
  return {
    id: 0,
    owner: 'mob',
    sourceId: 'dummy',
    pos: vec(5, 5),
    dir: vec(1, 0),
    speed: 0,
    radius: 1,
    remaining: 100,
    travelled: 0,
    pierceLeft: 0,
    explodeRadius: 0,
    hitIds: [],
    castModifiers: [],
  };
}

describe('boss room', () => {
  it('is calm until the hero activates the altar up close', () => {
    const run = newRun();
    toBossRoom(run);
    const t = currentTemplate(run, maps);
    if (t.kind !== 'boss') throw new Error('boss room expected');
    expect(run.phase).toBe('altar');
    expect(run.world.bounds).toEqual({ width: 400, height: 400 });
    // Calm: no spawns.
    expect(steps(run, 600).some((e) => e.type === 'spawn')).toBe(false);
    // Interact far from the altar: nothing.
    expect(canActivateAltar(run, maps)).toBe(false);
    expect(steps(run, 1, interact).some((e) => e.type === 'altarActivated')).toBe(false);
    // Near the altar without interacting: nothing.
    run.world.player.pos = vec(t.altar.x, t.altar.y + maps.rules.altarRadius);
    expect(canActivateAltar(run, maps)).toBe(true);
    expect(steps(run, 5).some((e) => e.type === 'altarActivated')).toBe(false);
    const activated = steps(run, 1, interact);
    expect(activated.filter((e) => e.type === 'altarActivated')).toEqual([{ type: 'altarActivated', pos: t.altar, delay: 0.5 }]);
    expect(run.phase).toBe('summoning');
    expect(canActivateAltar(run, maps)).toBe(false);
    // The boss appears spawnDelay later (30 steps), once.
    expect(steps(run, 29, interact).some((e) => e.type === 'bossSpawned')).toBe(false);
    const spawned = steps(run, 1, interact);
    const boss = run.world.mobs.find((m) => m.id === run.bossId)!;
    expect(spawned.filter((e) => e.type === 'bossSpawned')).toEqual([{ type: 'bossSpawned', id: boss.id, pos: t.bossSpawn }]);
    expect(boss).toMatchObject({ defId: 'dummy', rank: 'boss', life: 100, maxLife: 100, damageScale: 4, xpScale: 20, radius: 20 });
    expect(isBoss(content, boss)).toBe(true);
    expect(run.phase).toBe('boss');
    expect(steps(run, 60, interact).some((e) => e.type === 'bossSpawned')).toBe(false);
  });

  it('killing the boss wins the run with the map completion XP bonus; the run then stops', () => {
    const run = newRun();
    toBossRoom(run);
    const bossId = summonBoss(run);
    run.world.mobs.find((m) => m.id === bossId)!.life = 0;
    const events = steps(run, 1);
    const xp = run.world.xpGained;
    // 4 waves × 2 dummies (10 XP) + 2 elites (50) + the boss (10 × 20) = 80 + 100 + 200.
    expect(xp).toBe(380);
    expect(run.bonusXp).toBeCloseTo(380 * 0.07, 10);
    expect(run.world.player.xp).toBeCloseTo(380 + 380 * 0.07, 10);
    expect(events.filter((e) => e.type === 'rankedKill')).toEqual([{ type: 'rankedKill', id: bossId, rank: 'boss' }]);
    expect(events.filter((e) => e.type === 'runWon')).toEqual([{ type: 'runWon', elapsed: run.elapsed, timeLeft: 60 - run.elapsed, bonusXp: run.bonusXp }]);
    expect(run).toMatchObject({ status: 'won', bossKilled: true, failReason: null, roomsCleared: 2, elitesKilled: 2 });
    const frozen = JSON.stringify(run);
    expect(steps(run, 10)).toEqual([]);
    expect(JSON.stringify(run)).toBe(frozen);
  });

  it("the boss's minions give no XP, kills, ranked kills or essence (designer decision 2026-10-24)", () => {
    const run = newRun();
    toBossRoom(run);
    const bossId = summonBoss(run);
    const kills = run.world.kills;
    for (let i = 0; i < 3; i++) spawnMob(run.world, content, { defId: 'dummy', summonerId: bossId }, vec(100 + i * 40, 200), []).life = 0;
    const events = steps(run, 1);
    expect(events.filter((e) => e.type === 'death')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'rankedKill')).toEqual([]);
    expect(run.world.kills).toBe(kills);
    run.world.mobs.find((m) => m.id === bossId)!.life = 0;
    steps(run, 1);
    // Same XP as the run without minions (see above) and essence for the 2 elites + the boss only.
    expect(run.world.xpGained).toBe(380);
    expect(run.elitesKilled).toBe(2);
    expect(planRunRewards(runOutcome(run, maps), maps.rewards).essence).toBe(0.7);
  });
});

describe('fails', () => {
  it('the timer fires its warnings once and fails the run at the limit', () => {
    const run = newRun();
    const events = steps(run, 60 * 50 - 1);
    expect(events.filter((e) => e.type === 'timeWarning')).toEqual([{ type: 'timeWarning', secondsLeft: 30 }]);
    expect(steps(run, 1).filter((e) => e.type === 'timeWarning')).toEqual([{ type: 'timeWarning', secondsLeft: 10 }]);
    expect(steps(run, 60 * 10 - 1).some((e) => e.type === 'runFailed')).toBe(false);
    expect(run.status).toBe('active');
    expect(steps(run, 1)).toContainEqual({ type: 'runFailed', reason: 'timeout' });
    expect(run).toMatchObject({ status: 'failed', failReason: 'timeout' });
    expect(timeLeft(run, maps)).toBeLessThan(1e-9);
    expect(steps(run, 5)).toEqual([]);
  });

  it('hero death fails the run (XP so far is kept in the world)', () => {
    const run = newRun();
    spawnMob(run.world, content, { defId: 'biter' }, vec(run.world.player.pos.x + 25, run.world.player.pos.y), []);
    const events = steps(run, 1);
    expect(events).toContainEqual({ type: 'playerDeath' });
    expect(events).toContainEqual({ type: 'runFailed', reason: 'death' });
    expect(run).toMatchObject({ status: 'failed', failReason: 'death' });
    expect(steps(run, 5)).toEqual([]);
  });

  it('hero and boss dying in the same step: the run is lost (death), not won (designer decision 2026-10-23)', () => {
    const run = newRun();
    toBossRoom(run);
    const bossId = summonBoss(run);
    const hero = run.world.player;
    run.world.mobs.find((m) => m.id === bossId)!.life = 0;
    spawnMob(run.world, content, { defId: 'biter' }, vec(hero.pos.x + 25, hero.pos.y), []);
    const events = steps(run, 1);
    expect(events).toContainEqual({ type: 'playerDeath' });
    expect(events).toContainEqual({ type: 'death', id: bossId, pos: expect.anything() });
    expect(events.filter((e) => e.type === 'runFailed' || e.type === 'runWon')).toEqual([{ type: 'runFailed', reason: 'death' }]);
    expect(run).toMatchObject({ status: 'failed', failReason: 'death', bossKilled: false, bonusXp: 0 });
    expect(steps(run, 5)).toEqual([]);
  });

  it('a boss killed in the step the timer runs out wins the run (no timeout)', () => {
    const run = newRun();
    toBossRoom(run);
    const bossId = summonBoss(run);
    run.elapsed = maps.rules.timeLimit - DT;
    run.world.mobs.find((m) => m.id === bossId)!.life = 0;
    const events = steps(run, 1);
    expect(timeLeft(run, maps)).toBe(0);
    expect(events.some((e) => e.type === 'runFailed')).toBe(false);
    expect(events.filter((e) => e.type === 'runWon')).toEqual([{ type: 'runWon', elapsed: run.elapsed, timeLeft: 0, bonusXp: run.bonusXp }]);
    expect(run).toMatchObject({ status: 'won', failReason: null, bossKilled: true });
  });

  it('abandoning an active run fails it once', () => {
    const run = newRun();
    expect(abandonRun(run)).toEqual([{ type: 'runFailed', reason: 'abandoned' }]);
    expect(run).toMatchObject({ status: 'failed', failReason: 'abandoned' });
    expect(abandonRun(run)).toEqual([]);
  });
});

describe('rank scaling in combat', () => {
  it('a ranked mob hits with its damage scale (melee and projectiles)', () => {
    const run = newRun();
    const hero = run.world.player;
    const before = hero.life;
    spawnMob(run.world, content, { defId: 'dummy', rank: 'elite', damageScale: 2 }, vec(hero.pos.x + 25, hero.pos.y), []);
    steps(run, 1);
    expect(before - hero.life).toBe(2);
  });

  it('a ranked body is bigger: hero hits reach it, its melee reaches further, walls keep it at its own radius', () => {
    const run = newRun();
    const hero = run.world.player;
    const ahead = vec(hero.pos.x + 65, hero.pos.y);
    const aim: RunInput = { ...idle, basicAttack: true, aim: vec(hero.pos.x + 200, hero.pos.y) };
    // Strike arc 50: a normal dummy (radius 10) at 65 is out of reach, one with radius scale 2 (20) is in it.
    const small = spawnMob(run.world, content, { defId: 'dummy' }, ahead, []);
    expect(small.radius).toBe(10);
    expect(steps(run, 1, aim).some((e) => e.type === 'hit' && e.targetId === small.id)).toBe(false);
    run.world.mobs = [];
    hero.actionTimer = 0;
    const big = spawnMob(run.world, content, { defId: 'dummy', rank: 'boss', radiusScale: 2 }, ahead, []);
    expect(big.radius).toBe(20);
    expect(steps(run, 1, aim).some((e) => e.type === 'hit' && e.targetId === big.id)).toBe(true);
  });

  it('mob melee reach and wall clamping use the per-mob radius', () => {
    const run = newRun();
    const hero = run.world.player;
    hero.pos = vec(100, 100);
    // Gap = 35 - hero 10 - mob radius; the dummy's reach is 5.
    spawnMob(run.world, content, { defId: 'dummy' }, vec(135, 100), []);
    const before = hero.life;
    steps(run, 1);
    expect(hero.life).toBe(before);
    run.world.mobs = [];
    spawnMob(run.world, content, { defId: 'dummy', radiusScale: 2 }, vec(135, 100), []);
    steps(run, 1);
    expect(hero.life).toBe(before - 1);
    run.world.mobs = [];
    const walled = spawnMob(run.world, content, { defId: 'dummy', radiusScale: 2 }, vec(5, 250), []);
    steps(run, 1);
    expect(walled.pos).toEqual(vec(20, 250));
  });

  it('supports drop by the spawn rank (elite / boss chances), not only by the def', () => {
    const supports: SupportData = {
      rules: { slotsPerSkill: 2, tabSize: 3, tierMinLevel: [1], tierWeights: [100], dropChance: { normal: 0, elite: 1, boss: 1 }, salvage: [2] },
      supports: { s: { id: 's', group: 'general', compatibility: {}, resourceCostMultiplier: 1, weight: 1, tiers: [{ bonus: {} }] } },
    };
    const withSupports: Content = { ...content, supports };
    const run = createRun(withSupports, maps, 'hero', 3, {}, 1);
    const normal = spawnMob(run.world, withSupports, { defId: 'dummy' }, vec(300, 250), []);
    const elite = spawnMob(run.world, withSupports, { defId: 'dummy', rank: 'elite' }, vec(350, 250), []);
    normal.life = 0;
    elite.life = 0;
    const events = step(run.world, idle, withSupports, DT);
    expect(events.filter((e) => e.type === 'supportDrop')).toEqual([{ type: 'supportDrop', mobId: elite.id, pos: elite.pos, defId: 's', tier: 1 }]);
  });
});

describe('elite modifiers (mobs.md «Еліти»)', () => {
  const modContent: Content = {
    ...content,
    eliteModifiers: { tough: { id: 'tough', life: 3 }, quick: { id: 'quick', moveSpeed: 2 }, deep: { id: 'deep', life: 2 } },
  };
  const modMaps: MapsData = {
    ...maps,
    rules: {
      ...maps.rules,
      elites: {
        ...maps.rules.elites,
        count: { min: 2, max: 2 },
        modifiers: [
          { id: 'tough', weight: 1 },
          { id: 'quick', weight: 1 },
          { id: 'deep', weight: 5, minMapLevel: 3 },
        ],
      },
    },
  };

  it('the pool on a map level: weight > 0 and minMapLevel reached, in data order', () => {
    expect(eliteModifierPoolAt(modMaps.rules, 1).map((e) => e.id)).toEqual(['tough', 'quick']);
    expect(eliteModifierPoolAt(modMaps.rules, 3).map((e) => e.id)).toEqual(['tough', 'quick', 'deep']);
    expect(eliteModifierPoolAt(maps.rules, 1)).toEqual([]);
    expect(rollEliteModifier(createRng(1), maps.rules, 1)).toBeUndefined();
  });

  it('rolls by weight with one draw (exact values for fixed seeds)', () => {
    const rolls = (level: number): (string | undefined)[] => {
      const rng = createRng(42);
      return Array.from({ length: 8 }, () => rollEliteModifier(rng, modMaps.rules, level));
    };
    expect(rolls(1)).toEqual(ROLLS_MAP1);
    expect(rolls(3)).toEqual(ROLLS_MAP3);
  });

  it('every elite gets exactly one modifier from the pool; ordinary mobs and the boss none; deterministic', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const run = createRun(modContent, modMaps, 'hero', seed, {}, 1);
      for (const room of run.rooms) {
        for (const spawn of room.waves.flat()) {
          if (spawn.rank === 'elite') expect(['tough', 'quick']).toContain(spawn.eliteModifier);
          else expect(spawn.eliteModifier).toBeUndefined();
        }
      }
      expect(createRun(modContent, modMaps, 'hero', seed, {}, 1).rooms).toEqual(run.rooms);
    }
    const run = createRun(modContent, modMaps, 'hero', 7, {}, 1);
    expect(run.rooms.flatMap((r) => r.waves.flat().filter((s) => s.rank === 'elite').map((s) => s.eliteModifier))).toEqual(ELITES_SEED7);
  });

  it('modifiers come from their own stream: the room plan of a seed is otherwise unchanged', () => {
    const plain = createRun(content, { ...modMaps, rules: { ...modMaps.rules, elites: { ...modMaps.rules.elites, modifiers: [] } } }, 'hero', 7, {}, 1);
    const withMods = createRun(modContent, modMaps, 'hero', 7, {}, 1);
    const strip = (r: RunState): unknown =>
      r.rooms.map((room) => ({ ...room, waves: room.waves.map((w) => w.map(({ eliteModifier, ...rest }) => (void eliteModifier, rest))) }));
    expect(strip(withMods)).toEqual(strip(plain));
    expect(withMods.rngState).toBe(plain.rngState);
  });

  it('a spawned elite carries its modifier (fat life on top of the rank); the boss never does', () => {
    const run = createRun(modContent, modMaps, 'hero', 7, {}, 1);
    let elites: ReturnType<typeof run.world.mobs.filter> = [];
    for (let i = 0; i < 1000 && elites.length === 0; i++) {
      stepRun(run, idle, modContent, modMaps, DT);
      elites = run.world.mobs.filter((m) => m.rank === 'elite');
    }
    expect(elites.length).toBeGreaterThan(0);
    for (const e of elites) {
      expect(['tough', 'quick']).toContain(e.eliteModifier);
      // dummy life 10 × rank 3 (× 3 for tough).
      expect(e.maxLife).toBe(e.eliteModifier === 'tough' ? 90 : 30);
    }
    const boss = spawnMob(run.world, modContent, { defId: 'dummy', rank: 'boss' }, vec(200, 200), []);
    expect(boss.eliteModifier).toBeUndefined();
  });
});

describe('souls (Devourer\'s Crown) across rooms', () => {
  it('a souls echo still waiting at a room change is dropped, the souls stay full and the next use queues it again', () => {
    const souls: PassiveMechanic = { kind: 'souls', max: 30, echoDelay: 0.25, echoFor: { damaging: true, excludeDeliveries: ['dash', 'teleport', 'self'] } };
    const run = createRun(content, maps, 'hero', 7, { mechanics: [souls] }, 1);
    clearRoom(run);
    run.world.player.souls = 30;
    const attack: RunInput = { ...idle, basicAttack: true, aim: vec(run.world.player.pos.x + 30, run.world.player.pos.y) };
    const used = steps(run, 1, attack);
    expect(used.filter((e) => e.type === 'soulEcho').map((e) => (e.type === 'soulEcho' ? e.actionId : ''))).toEqual(['strike']);
    expect(run.world.player.echoes.map((e) => e.souls)).toEqual([true]);
    // Through the door before the 0.25 s are up.
    walkThroughDoor(run);
    expect(run.room).toBe(1);
    expect(run.world.player.echoes).toEqual([]);
    expect(run.world.player.souls).toBe(30);
    // After the attack time the next use takes the souls again.
    steps(run, 40);
    const again = steps(run, 1, { ...attack, aim: vec(run.world.player.pos.x + 30, run.world.player.pos.y) });
    expect(again.some((e) => e.type === 'soulEcho')).toBe(true);
    expect(run.world.player.echoes.map((e) => e.souls)).toEqual([true]);
    expect(run.world.player.souls).toBe(30);
  });
});

// The map run state machine (docs/design/maps.md): K combat rooms with waves, then a boss room with an altar.
// Fixed timestep, seeded: the same seed, data and inputs give the same run. Wraps one WorldState; each room is its
// own space (the world's bounds / obstacles are swapped when the hero walks through an open door).

import { distance, vec, type Vec2 } from '../math';
import { mapClearBonusXp } from '../progression/levels';
import { createRng, type Rng } from '../rng';
import { weightedPick } from '../items/generate';
import type { Content } from '../world/content';
import { clampToArena, createWorld, grantBonusXp, spawnMob, spawnRadius, step, type Loadout, type MobSpawn } from '../world/world';
import type {
  BossRoomTemplate,
  MapsData,
  MobPoolEntry,
  RankScaling,
  RoomPlan,
  RoomTemplate,
  RunEvent,
  RunFailReason,
  RunInput,
  RunRules,
  RunState,
  RunStepEvent,
} from './types';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** Mixed into the run seed for the run stream (RunState.rngState); structural, not balance. */
const RUN_STREAM = 0x85ebca6b;

export function getTemplate(maps: MapsData, id: string): RoomTemplate {
  const t = maps.templates[id];
  if (!t) throw new Error(`Unknown room template: ${id}`);
  return t;
}

/** Template of the room the hero is in. */
export function currentTemplate(run: RunState, maps: MapsData): RoomTemplate {
  const plan = run.rooms[run.room];
  if (!plan) throw new Error(`Run has no room ${run.room}`);
  return getTemplate(maps, plan.templateId);
}

/** Seconds left on the run timer (never below 0). */
export function timeLeft(run: RunState, maps: MapsData): number {
  return Math.max(0, maps.rules.timeLimit - run.elapsed);
}

/** The open door of the current room (render: draw it open, walk-in target), or null while it is closed / absent. */
export function openDoor(run: RunState, maps: MapsData): Vec2 | null {
  const t = currentTemplate(run, maps);
  return run.status === 'active' && run.phase === 'cleared' && t.kind === 'combat' ? t.exit : null;
}

/** True when the interact input would activate the altar now (render: show the prompt). */
export function canActivateAltar(run: RunState, maps: MapsData): boolean {
  const t = currentTemplate(run, maps);
  if (run.status !== 'active' || run.phase !== 'altar' || t.kind !== 'boss' || run.world.player.dead) return false;
  return distance(run.world.player.pos, t.altar) <= maps.rules.altarRadius;
}

/** Shuffled copy (Fisher–Yates, one draw per element after the first). */
function shuffled<T>(rng: Rng, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * `count` templates of `kind` in random order, without repeats while there are enough (then the pool is reshuffled).
 * Templates are taken in data order before shuffling.
 */
function pickTemplates(rng: Rng, maps: MapsData, kind: RoomTemplate['kind'], count: number): RoomTemplate[] {
  const pool = Object.values(maps.templates).filter((t) => t.kind === kind);
  if (pool.length === 0 && count > 0) throw new Error(`No ${kind} room templates`);
  const out: RoomTemplate[] = [];
  let bag: RoomTemplate[] = [];
  while (out.length < count) {
    if (bag.length === 0) bag = shuffled(rng, pool);
    out.push(bag.shift()!);
  }
  return out;
}

/** Mob types that can appear on this map level. */
export function mobPoolAt(rules: RunRules, mapLevel: number): MobPoolEntry[] {
  return rules.waves.mobPool.filter((e) => e.weight > 0 && (e.minMapLevel ?? 1) <= mapLevel);
}

function ranked(defId: string, rank: 'elite' | 'boss', scaling: RankScaling): MobSpawn {
  return { defId, rank, lifeScale: scaling.life, damageScale: scaling.damage, xpScale: scaling.xp, radiusScale: scaling.radius };
}

/**
 * Waves of one combat room: wave count, then per wave its size and mob types (pool by weight), then the elites
 * (count, then per elite its type and the wave it joins, appended at the end of that wave). Draw order as listed.
 */
function planWaves(rng: Rng, rules: RunRules, mapLevel: number): MobSpawn[][] {
  const pool = mobPoolAt(rules, mapLevel);
  if (pool.length === 0) throw new Error(`No mobs for map level ${mapLevel}`);
  const pick = (): string => weightedPick(rng, pool, (e) => e.weight)!.mobId;
  const waveCount = Math.max(1, rng.int(rules.waves.count.min, rules.waves.count.max));
  const waves: MobSpawn[][] = [];
  for (let w = 0; w < waveCount; w++) {
    const size = rng.int(rules.waves.mobs.min, rules.waves.mobs.max);
    const wave: MobSpawn[] = [];
    for (let i = 0; i < size; i++) wave.push({ defId: pick() });
    waves.push(wave);
  }
  const elites = rng.int(rules.elites.count.min, rules.elites.count.max);
  for (let i = 0; i < elites; i++) {
    const defId = pick();
    waves[rng.int(0, waveCount - 1)]!.push(ranked(defId, 'elite', rules.elites.scaling));
  }
  return waves;
}

/**
 * Plans the run's rooms: combat templates (pickTemplates), the boss template, then each combat room's waves in room
 * order (planWaves). Everything comes from the run stream, so a seed always gives the same map.
 */
function planRooms(rng: Rng, maps: MapsData, mapLevel: number): RoomPlan[] {
  const combat = pickTemplates(rng, maps, 'combat', maps.rules.combatRooms);
  const boss = pickTemplates(rng, maps, 'boss', 1)[0]!;
  const rooms: RoomPlan[] = combat.map((t) => ({ templateId: t.id, kind: 'combat', waves: planWaves(rng, maps.rules, mapLevel) }));
  rooms.push({ templateId: boss.id, kind: 'boss', waves: [] });
  return rooms;
}

/**
 * A new run on map `mapLevel`: rooms planned from the seed, the hero in the first room's entry, mob level (world
 * areaLevel) = map level. The first wave comes after RunRules.waves.firstDelay.
 */
export function createRun(content: Content, maps: MapsData, classId: string, seed: number, loadout: Loadout, mapLevel: number): RunState {
  const level = Math.max(1, Math.floor(mapLevel));
  const rng = createRng((seed ^ RUN_STREAM) >>> 0);
  const rooms = planRooms(rng, maps, level);
  const first = getTemplate(maps, rooms[0]!.templateId);
  const world = createWorld(content, classId, seed, loadout, level, {
    bounds: { width: first.width, height: first.height },
    obstacles: first.obstacles ?? [],
    start: first.entry,
    endless: false,
  });
  return {
    mapLevel: level,
    seed: seed >>> 0,
    rngState: rng.getState(),
    rooms,
    room: 0,
    phase: first.kind === 'boss' ? 'altar' : 'waves',
    wavesSpawned: 0,
    waveTimer: maps.rules.waves.firstDelay,
    eliteIds: [],
    bossId: null,
    elapsed: 0,
    warningsFired: 0,
    status: 'active',
    failReason: null,
    roomsCleared: 0,
    elitesKilled: 0,
    bossKilled: false,
    bonusXp: 0,
    recorded: false,
    world,
  };
}

/** Moves the hero into room `index`: new bounds and obstacles, everything of the old room is gone. */
function enterRoom(run: RunState, maps: MapsData, index: number, events: RunStepEvent[]): void {
  const plan = run.rooms[index]!;
  const t = getTemplate(maps, plan.templateId);
  const world = run.world;
  world.bounds = { width: t.width, height: t.height };
  world.obstacles = (t.obstacles ?? []).map((o) => ({ pos: vec(o.pos.x, o.pos.y), radius: o.radius }));
  world.mobs = [];
  world.projectiles = [];
  world.traps = [];
  world.zones = [];
  world.decoys = [];
  world.hostileZones = [];
  world.player.echoes = [];
  world.player.motion = undefined;
  world.player.pos = vec(t.entry.x, t.entry.y);
  run.room = index;
  run.wavesSpawned = 0;
  run.eliteIds = [];
  run.phase = t.kind === 'boss' ? 'altar' : 'waves';
  run.waveTimer = maps.rules.waves.firstDelay;
  events.push({ type: 'roomEnter', room: index, templateId: t.id, kind: t.kind });
}

/** A point within spawnJitter of a random spawn point (angle, then distance), kept out of walls and obstacles. */
function spawnPosition(rng: Rng, run: RunState, t: RoomTemplate, radius: number, jitter: number): Vec2 {
  const points = t.spawnPoints.length > 0 ? t.spawnPoints : [vec(t.width / 2, t.height / 2)];
  const base = points[rng.int(0, points.length - 1)]!;
  const angle = rng.next() * Math.PI * 2;
  const dist = rng.next() * jitter;
  return clampToArena(vec(base.x + Math.cos(angle) * dist, base.y + Math.sin(angle) * dist), radius, run.world);
}

function spawnWave(run: RunState, content: Content, maps: MapsData, rng: Rng, events: RunStepEvent[]): void {
  const plan = run.rooms[run.room]!;
  const wave = plan.waves[run.wavesSpawned] ?? [];
  const t = getTemplate(maps, plan.templateId);
  events.push({ type: 'waveStart', room: run.room, wave: run.wavesSpawned, count: wave.length });
  for (const spawn of wave) {
    const pos = spawnPosition(rng, run, t, spawnRadius(content, spawn), maps.rules.waves.spawnJitter);
    const mob = spawnMob(run.world, content, spawn, pos, events);
    if (spawn.rank === 'elite') run.eliteIds.push(mob.id);
  }
  run.wavesSpawned++;
}

function fail(run: RunState, reason: RunFailReason): RunEvent {
  run.status = 'failed';
  run.failReason = reason;
  return { type: 'runFailed', reason };
}

/** The player leaves an active run (pause menu, closing the screen): it fails with reason 'abandoned'. */
export function abandonRun(run: RunState): RunEvent[] {
  if (run.status !== 'active') return [];
  return [fail(run, 'abandoned')];
}

/** Counts elite / boss deaths among this step's world events. Returns true when the boss died. */
function countRankedKills(run: RunState, events: RunStepEvent[]): boolean {
  let bossDied = false;
  const out: RunEvent[] = [];
  for (const e of events) {
    if (e.type !== 'death') continue;
    const elite = run.eliteIds.indexOf(e.id);
    if (elite >= 0) {
      run.eliteIds.splice(elite, 1);
      run.elitesKilled++;
      out.push({ type: 'rankedKill', id: e.id, rank: 'elite' });
    } else if (e.id === run.bossId) {
      bossDied = true;
      out.push({ type: 'rankedKill', id: e.id, rank: 'boss' });
    }
  }
  events.push(...out);
  return bossDied;
}

/** Fires the warnings the timer just passed; RunRules.timeWarnings is in descending order (checked by maps.test.ts). */
function fireTimeWarnings(run: RunState, maps: MapsData, events: RunStepEvent[]): void {
  const warnings = maps.rules.timeWarnings;
  const left = timeLeft(run, maps);
  while (run.warningsFired < warnings.length && left <= warnings[run.warningsFired]! + TIME_EPSILON) {
    events.push({ type: 'timeWarning', secondsLeft: warnings[run.warningsFired]! });
    run.warningsFired++;
  }
}

function win(run: RunState, content: Content, maps: MapsData, events: RunStepEvent[]): void {
  run.bossKilled = true;
  run.status = 'won';
  run.bonusXp = mapClearBonusXp(run.world.xpGained, content.progression);
  grantBonusXp(run.world, content, run.bonusXp, events);
  events.push({ type: 'runWon', elapsed: run.elapsed, timeLeft: timeLeft(run, maps), bonusXp: run.bonusXp });
}

/**
 * Advances the run by a fixed dt: the world step first (hero, mobs, combat), then the run rules on the result.
 * Order within a step: ranked kills; hero death → fail 'death' (even if the boss died in the same step); the timer
 * (warnings); boss death → won (a boss killed in the step the timer runs out still counts); timer at the limit →
 * fail 'timeout'; then the room: next wave / room cleared / door / altar / boss spawn.
 * Returns world and run events in order. After the run ends nothing advances and [] is returned.
 */
export function stepRun(run: RunState, input: RunInput, content: Content, maps: MapsData, dt: number): RunStepEvent[] {
  if (run.status !== 'active') return [];
  const events: RunStepEvent[] = step(run.world, input, content, dt);
  const bossDied = countRankedKills(run, events);
  if (run.world.player.dead) {
    events.push(fail(run, 'death'));
    return events;
  }
  run.elapsed += dt;
  fireTimeWarnings(run, maps, events);
  if (bossDied) {
    win(run, content, maps, events);
    return events;
  }
  if (timeLeft(run, maps) <= TIME_EPSILON) {
    events.push(fail(run, 'timeout'));
    return events;
  }

  const rng = createRng(run.rngState);
  updateRoom(run, input, content, maps, rng, dt, events);
  run.rngState = rng.getState();
  return events;
}

function updateRoom(run: RunState, input: RunInput, content: Content, maps: MapsData, rng: Rng, dt: number, events: RunStepEvent[]): void {
  const t = currentTemplate(run, maps);
  const plan = run.rooms[run.room]!;
  const hero = run.world.player;
  switch (run.phase) {
    case 'waves': {
      if (run.world.mobs.length > 0) return;
      if (run.wavesSpawned < plan.waves.length) {
        run.waveTimer -= dt;
        if (run.waveTimer > TIME_EPSILON) return;
        spawnWave(run, content, maps, rng, events);
        run.waveTimer = maps.rules.waves.nextDelay;
        return;
      }
      run.phase = 'cleared';
      run.roomsCleared++;
      if (t.kind === 'combat') events.push({ type: 'roomCleared', room: run.room, door: t.exit });
      return;
    }
    case 'cleared': {
      if (t.kind !== 'combat' || run.room + 1 >= run.rooms.length) return;
      if (distance(hero.pos, t.exit) <= maps.rules.doorRadius) enterRoom(run, maps, run.room + 1, events);
      return;
    }
    case 'altar': {
      if (!input.interact || !canActivateAltar(run, maps)) return;
      run.phase = 'summoning';
      run.waveTimer = maps.rules.boss.spawnDelay;
      events.push({ type: 'altarActivated', pos: (t as BossRoomTemplate).altar, delay: run.waveTimer });
      return;
    }
    case 'summoning': {
      run.waveTimer -= dt;
      if (run.waveTimer > TIME_EPSILON) return;
      const boss = maps.rules.boss;
      const spawnAt = (t as BossRoomTemplate).bossSpawn;
      const spawn = ranked(boss.mobId, 'boss', boss.scaling);
      const pos = clampToArena(vec(spawnAt.x, spawnAt.y), spawnRadius(content, spawn), run.world);
      const mob = spawnMob(run.world, content, spawn, pos, events);
      run.bossId = mob.id;
      run.phase = 'boss';
      events.push({ type: 'bossSpawned', id: mob.id, pos: mob.pos });
      return;
    }
    case 'boss':
      return;
  }
}

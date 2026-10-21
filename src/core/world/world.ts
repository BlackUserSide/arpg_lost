import { computeDamage, rollBaseDamage, scaleDamage } from '../combat/damage';
import { applyDamage, resolveHit } from '../combat/hit';
import type { Defences } from '../combat/mitigation';
import { add, clamp, distance, dot, normalize, scale, sub, vec, type Vec2 } from '../math';
import { createRng, type Rng } from '../rng';
import { computeStat } from '../stats/modifiers';
import type { Modifier, StatId, Tag } from '../stats/types';
import type { ActionDef, ClassDef, Content, MobDef } from './content';

export interface PlayerState {
  readonly id: 0;
  readonly classId: string;
  pos: Vec2;
  facing: Vec2;
  radius: number;
  life: number;
  energyShield: number;
  mana: number;
  /** Time until the next basic attack or skill can start. */
  actionTimer: number;
  cooldowns: Record<string, number>;
  modifiers: Modifier[];
  dead: boolean;
}

export interface MobState {
  readonly id: number;
  readonly defId: string;
  pos: Vec2;
  life: number;
  attackTimer: number;
}

export interface WorldState {
  time: number;
  rngState: number;
  nextId: number;
  player: PlayerState;
  mobs: MobState[];
  spawn: { timer: number; wave: number };
  kills: number;
}

export interface PlayerInput {
  /** Desired move direction; normalized internally. */
  readonly move: Vec2;
  /** World point to aim at. */
  readonly aim: Vec2;
  readonly basicAttack: boolean;
  /** Skill slots 1..3. */
  readonly skills: readonly boolean[];
}

export type WorldEvent =
  | { type: 'action'; actorId: number; actionId: string; origin: Vec2; facing: Vec2; radius: number; angleDeg: number }
  | { type: 'mobAttack'; id: number }
  | { type: 'hit'; targetId: number; pos: Vec2; amount: number; isCrit: boolean }
  | { type: 'spawn'; id: number }
  | { type: 'death'; id: number; pos: Vec2 }
  | { type: 'playerDeath' };

export const PLAYER_ID = 0;

export function createWorld(content: Content, classId: string, seed: number): WorldState {
  const classDef = getClass(content, classId);
  const player: PlayerState = {
    id: PLAYER_ID,
    classId,
    pos: vec(content.arena.width / 2, content.arena.height / 2),
    facing: vec(1, 0),
    radius: classDef.radius,
    life: 0,
    energyShield: 0,
    mana: 0,
    actionTimer: 0,
    cooldowns: {},
    modifiers: [],
    dead: false,
  };
  player.life = playerStat(classDef, player, 'life');
  player.energyShield = playerStat(classDef, player, 'energyShield');
  player.mana = playerStat(classDef, player, 'mana');
  return {
    time: 0,
    rngState: seed >>> 0,
    nextId: 1,
    player,
    mobs: [],
    spawn: { timer: content.arena.spawn.firstDelay, wave: 0 },
    kills: 0,
  };
}

/** Advances the simulation by a fixed dt. Mutates `world`, returns what happened for the view. */
export function step(world: WorldState, input: PlayerInput, content: Content, dt: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  world.time += dt;
  if (world.player.dead) return events;

  const rng = createRng(world.rngState);
  const classDef = getClass(content, world.player.classId);

  updatePlayer(world, input, content, classDef, rng, dt, events);
  updateMobs(world, content, classDef, rng, dt, events);
  removeDeadMobs(world, events);
  updateSpawner(world, content, rng, dt, events);

  world.rngState = rng.getState();
  return events;
}

export function playerStat(classDef: ClassDef, player: PlayerState, stat: StatId, tags: readonly Tag[] = []): number {
  return computeStat(classDef.baseStats[stat] ?? 0, player.modifiers, stat, tags);
}

export function getClass(content: Content, id: string): ClassDef {
  const def = content.classes[id];
  if (!def) throw new Error(`Unknown class: ${id}`);
  return def;
}

export function getMob(content: Content, id: string): MobDef {
  const def = content.mobs[id];
  if (!def) throw new Error(`Unknown mob: ${id}`);
  return def;
}

function updatePlayer(
  world: WorldState,
  input: PlayerInput,
  content: Content,
  classDef: ClassDef,
  rng: Rng,
  dt: number,
  events: WorldEvent[],
): void {
  const player = world.player;

  player.life = Math.min(playerStat(classDef, player, 'life'), player.life + playerStat(classDef, player, 'lifeRegen') * dt);
  player.energyShield = Math.min(
    playerStat(classDef, player, 'energyShield'),
    player.energyShield + playerStat(classDef, player, 'energyShieldRegen') * dt,
  );
  player.mana = Math.min(playerStat(classDef, player, 'mana'), player.mana + playerStat(classDef, player, 'manaRegen') * dt);

  player.actionTimer = Math.max(0, player.actionTimer - dt);
  const recovery = computeStat(1, player.modifiers, 'cooldownRecovery');
  for (const id of Object.keys(player.cooldowns)) {
    player.cooldowns[id] = Math.max(0, (player.cooldowns[id] ?? 0) - dt * recovery);
  }

  const move = normalize(input.move);
  const speed = playerStat(classDef, player, 'movementSpeed');
  const next = add(player.pos, scale(move, speed * dt));
  player.pos = clampToArena(next, player.radius, content);

  const aimDir = normalize(sub(input.aim, player.pos));
  if (aimDir.x !== 0 || aimDir.y !== 0) player.facing = aimDir;

  if (player.actionTimer > 0) return;
  const action = pickAction(input, classDef, player);
  if (action) performAction(world, content, classDef, action, rng, events);
}

function pickAction(input: PlayerInput, classDef: ClassDef, player: PlayerState): ActionDef | undefined {
  for (let i = 0; i < classDef.skills.length; i++) {
    const skill = classDef.skills[i];
    if (!skill || !input.skills[i]) continue;
    if ((player.cooldowns[skill.id] ?? 0) > 0 || player.mana < skill.manaCost) continue;
    return skill;
  }
  return input.basicAttack ? classDef.basicAttack : undefined;
}

function performAction(
  world: WorldState,
  content: Content,
  classDef: ClassDef,
  action: ActionDef,
  rng: Rng,
  events: WorldEvent[],
): void {
  const player = world.player;
  const mods = player.modifiers;
  player.mana -= action.manaCost;
  if (action.cooldown > 0) player.cooldowns[action.id] = action.cooldown;
  // M1: only attacks; spells will use castSpeed in M2.
  const rate = computeStat(classDef.weapon.attacksPerSecond, mods, 'attackSpeed', action.tags);
  player.actionTimer = rate > 0 ? 1 / rate : Infinity;

  const { shape } = action;
  events.push({
    type: 'action',
    actorId: player.id,
    actionId: action.id,
    origin: player.pos,
    facing: player.facing,
    radius: shape.radius,
    angleDeg: shape.angleDeg,
  });

  const halfAngleCos = Math.cos(((shape.angleDeg / 2) * Math.PI) / 180);
  const targets = world.mobs
    .filter((mob) => mob.life > 0)
    .map((mob) => ({ mob, def: getMob(content, mob.defId), dist: distance(player.pos, mob.pos) }))
    .filter(({ mob, def, dist }) => {
      if (dist > shape.radius + def.radius) return false;
      if (dist <= def.radius) return true;
      return dot(normalize(sub(mob.pos, player.pos)), player.facing) >= halfAngleCos;
    })
    .sort((a, b) => a.dist - b.dist || a.mob.id - b.mob.id)
    .slice(0, shape.maxTargets ?? Infinity);

  const critChance = computeStat(classDef.weapon.critChance, mods, 'critChance', action.tags);
  const critMultiplier = computeStat(content.combat.critMultiplierBase, mods, 'critMultiplier', action.tags);
  for (const { mob, def } of targets) {
    const rolled = scaleDamage(rollBaseDamage(rng, classDef.weapon.damage), action.damageEffectiveness);
    const damage = computeDamage(rolled, mods, action.tags);
    const defences: Defences = { armour: def.armour, resistances: def.resistances };
    const hit = resolveHit(rng, { damage, critChance, critMultiplier }, defences, content.combat);
    mob.life -= hit.total;
    events.push({ type: 'hit', targetId: mob.id, pos: mob.pos, amount: hit.total, isCrit: hit.isCrit });
  }
}

function updateMobs(
  world: WorldState,
  content: Content,
  classDef: ClassDef,
  rng: Rng,
  dt: number,
  events: WorldEvent[],
): void {
  const player = world.player;
  for (const mob of world.mobs) {
    const def = getMob(content, mob.defId);
    mob.attackTimer = Math.max(0, mob.attackTimer - dt);
    const toPlayer = sub(player.pos, mob.pos);
    const gap = distance(player.pos, mob.pos) - player.radius - def.radius;
    if (gap > def.attack.range * 0.8) {
      const stepLen = Math.min(def.moveSpeed * dt, gap);
      mob.pos = add(mob.pos, scale(normalize(toPlayer), stepLen));
    }
    if (gap <= def.attack.range && mob.attackTimer <= 0 && !player.dead) {
      mob.attackTimer = def.attack.interval;
      events.push({ type: 'mobAttack', id: mob.id });
      hitPlayer(world, content, classDef, def, rng, events);
    }
  }
  separateMobs(world, content);
}

function hitPlayer(world: WorldState, content: Content, classDef: ClassDef, mobDef: MobDef, rng: Rng, events: WorldEvent[]): void {
  const player = world.player;
  const defences: Defences = {
    armour: playerStat(classDef, player, 'armour'),
    resistances: {
      fire: playerStat(classDef, player, 'fireResistance'),
      cold: playerStat(classDef, player, 'coldResistance'),
      lightning: playerStat(classDef, player, 'lightningResistance'),
    },
  };
  const damage = rollBaseDamage(rng, mobDef.attack.damage);
  const hit = resolveHit(
    rng,
    { damage, critChance: mobDef.attack.critChance, critMultiplier: content.combat.critMultiplierBase },
    defences,
    content.combat,
  );
  const result = applyDamage({ life: player.life, energyShield: player.energyShield }, hit.total);
  player.life = result.pools.life;
  player.energyShield = result.pools.energyShield;
  events.push({ type: 'hit', targetId: player.id, pos: player.pos, amount: hit.total, isCrit: hit.isCrit });
  if (result.isDead) {
    player.dead = true;
    events.push({ type: 'playerDeath' });
  }
}

/** Pushes overlapping mobs apart and out of the player, so crowds surround instead of stacking. */
function separateMobs(world: WorldState, content: Content): void {
  const { mobs, player } = world;
  for (let i = 0; i < mobs.length; i++) {
    const a = mobs[i]!;
    const ra = getMob(content, a.defId).radius;
    for (let j = i + 1; j < mobs.length; j++) {
      const b = mobs[j]!;
      const rb = getMob(content, b.defId).radius;
      const d = distance(a.pos, b.pos);
      const overlap = ra + rb - d;
      if (overlap <= 0) continue;
      const dir = d > 0 ? scale(sub(b.pos, a.pos), 1 / d) : vec(1, 0);
      a.pos = sub(a.pos, scale(dir, overlap / 2));
      b.pos = add(b.pos, scale(dir, overlap / 2));
    }
    const d = distance(a.pos, player.pos);
    const overlap = ra + player.radius - d;
    if (overlap > 0) {
      const dir = d > 0 ? scale(sub(a.pos, player.pos), 1 / d) : vec(1, 0);
      a.pos = add(a.pos, scale(dir, overlap));
    }
    a.pos = clampToArena(a.pos, ra, content);
  }
}

function removeDeadMobs(world: WorldState, events: WorldEvent[]): void {
  const alive: MobState[] = [];
  for (const mob of world.mobs) {
    if (mob.life > 0) {
      alive.push(mob);
      continue;
    }
    world.kills++;
    events.push({ type: 'death', id: mob.id, pos: mob.pos });
  }
  world.mobs = alive;
}

function updateSpawner(world: WorldState, content: Content, rng: Rng, dt: number, events: WorldEvent[]): void {
  const spawn = content.arena.spawn;
  world.spawn.timer -= dt;
  if (world.spawn.timer > 0) return;
  world.spawn.timer += spawn.interval;
  world.spawn.wave++;
  const count = spawn.batchStart + Math.floor((world.spawn.wave - 1) * spawn.batchGrowth);
  for (let i = 0; i < count && world.mobs.length < spawn.maxAlive; i++) {
    const defId = spawn.mobIds[rng.int(0, spawn.mobIds.length - 1)];
    if (defId === undefined) return;
    const def = getMob(content, defId);
    const mob: MobState = { id: world.nextId++, defId, pos: randomEdgePoint(rng, def.radius, content), life: def.life, attackTimer: 0 };
    world.mobs.push(mob);
    events.push({ type: 'spawn', id: mob.id });
  }
}

function randomEdgePoint(rng: Rng, radius: number, content: Content): Vec2 {
  const { width, height } = content.arena;
  const side = rng.int(0, 3);
  const t = rng.next();
  switch (side) {
    case 0:
      return vec(radius + t * (width - 2 * radius), radius);
    case 1:
      return vec(width - radius, radius + t * (height - 2 * radius));
    case 2:
      return vec(radius + t * (width - 2 * radius), height - radius);
    default:
      return vec(radius, radius + t * (height - 2 * radius));
  }
}

function clampToArena(pos: Vec2, radius: number, content: Content): Vec2 {
  return vec(clamp(pos.x, radius, content.arena.width - radius), clamp(pos.y, radius, content.arena.height - radius));
}

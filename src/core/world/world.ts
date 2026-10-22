import { add, clamp, normalize, scale, sub, vec } from '../math';
import { createRng } from '../rng';
import { computeStat } from '../stats/modifiers';
import { performAction, pickAction, updateMotion } from './actions';
import type { PassiveMechanic } from '../passives/types';
import type { Modifier } from '../stats/types';
import { levelModifiers } from '../progression/levels';
import type { Content, WeaponDef } from './content';
import { refillPools } from './experience';
import { removeDeadMobs, updateMobs, updateSpawner } from './mobs';
import { updateProjectiles, updateTraps } from './projectiles';
import { allModifiers, clampToArena, getClass, movePlayer, playerStat, PLAYER_ID, type Ctx, type PlayerInput, type PlayerState, type WorldEvent, type WorldState } from './state';

export * from './state';
export { recoverLife, recoverMana, setLoadoutModifiers } from './experience';
export { canAfford } from './actions';
export { actionCost, deriveStat, lifeRecoveryPool, type ActionCost, type StatSource } from './passiveEffects';

/** What the hero brings into the run: level, equipment and passives as modifiers (see heroModifiers), plus the weapon. */
export interface Loadout {
  readonly level?: number;
  readonly xp?: number;
  readonly modifiers?: readonly Modifier[];
  readonly weapon?: WeaponDef;
  /** Passive tree mechanics (keystones, spec effects); see heroMechanics. */
  readonly mechanics?: readonly PassiveMechanic[];
}

/** `areaLevel` defaults to the hero's level. */
export function createWorld(content: Content, classId: string, seed: number, loadout: Loadout = {}, areaLevel = loadout.level ?? 1): WorldState {
  const classDef = getClass(content, classId);
  const level = loadout.level ?? 1;
  const gearModifiers = [...(loadout.modifiers ?? [])];
  const levelMods = levelModifiers(level, content.progression);
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
    level,
    xp: loadout.xp ?? 0,
    gearModifiers,
    modifiers: [...gearModifiers, ...levelMods],
    levelModifiers: levelMods,
    mechanics: [...(loadout.mechanics ?? [])],
    stillTime: 0,
    weapon: loadout.weapon ?? classDef.weapon,
    buffs: [],
    invulnerable: 0,
    motion: undefined,
    dead: false,
  };
  refillPools(classDef, player);
  return {
    time: 0,
    rngState: seed >>> 0,
    nextId: 1,
    player,
    mobs: [],
    projectiles: [],
    traps: [],
    spawn: { timer: content.arena.spawn.firstDelay, wave: 0 },
    kills: 0,
    areaLevel,
    xpGained: 0,
  };
}

/** Advances the simulation by a fixed dt. Mutates `world`, returns what happened for the view. */
export function step(world: WorldState, input: PlayerInput, content: Content, dt: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  world.time += dt;
  if (world.player.dead) return events;

  const rng = createRng(world.rngState);
  const ctx: Ctx = { world, content, classDef: getClass(content, world.player.classId), rng, events, input };

  updatePlayer(ctx, dt);
  updateMobs(ctx, dt);
  updateProjectiles(ctx, dt);
  updateTraps(ctx, dt);
  removeDeadMobs(ctx);
  updateSpawner(ctx, dt);

  world.rngState = rng.getState();
  return events;
}

function updatePlayer(ctx: Ctx, dt: number): void {
  const { world, content, classDef, input } = ctx;
  const player = world.player;

  player.buffs = player.buffs.filter((b) => (b.remaining -= dt) > 0);
  player.invulnerable = Math.max(0, player.invulnerable - dt);
  player.stillTime += dt;

  const maxLife = playerStat(classDef, player, 'life');
  const maxShield = playerStat(classDef, player, 'energyShield');
  const maxMana = playerStat(classDef, player, 'mana');
  player.life = clamp(player.life + playerStat(classDef, player, 'lifeRegen') * dt, 0, maxLife);
  player.energyShield = clamp(player.energyShield + playerStat(classDef, player, 'energyShieldRegen') * dt, 0, maxShield);
  player.mana = clamp(player.mana + playerStat(classDef, player, 'manaRegen') * dt, 0, maxMana);

  player.actionTimer = Math.max(0, player.actionTimer - dt);
  const recovery = computeStat(1, allModifiers(classDef, player), 'cooldownRecovery');
  for (const id of Object.keys(player.cooldowns)) {
    player.cooldowns[id] = Math.max(0, (player.cooldowns[id] ?? 0) - dt * recovery);
  }

  if (updateMotion(ctx, dt)) return;

  const move = normalize(input.move);
  const speed = playerStat(classDef, player, 'movementSpeed');
  movePlayer(player, clampToArena(add(player.pos, scale(move, speed * dt)), player.radius, content));

  const aimDir = normalize(sub(input.aim, player.pos));
  if (aimDir.x !== 0 || aimDir.y !== 0) player.facing = aimDir;

  if (player.actionTimer > 0) return;
  const action = pickAction(ctx);
  if (action) performAction(ctx, action);
}

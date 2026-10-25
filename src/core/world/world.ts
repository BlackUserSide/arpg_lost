import { add, clamp, normalize, scale, sub, vec, type Vec2 } from '../math';
import { createRng } from '../rng';
import { computeStat } from '../stats/modifiers';
import { performAction, pickAction, updateEchoes, updateMotion } from './actions';
import type { PassiveMechanic } from '../passives/types';
import type { Modifier } from '../stats/types';
import { levelModifiers } from '../progression/levels';
import { classSkillProgress, type SkillProgress } from '../skills/levels';
import type { SupportRef } from '../supports/types';
import type { Content, WeaponDef } from './content';
import { decayLeech, spawnPools } from './experience';
import { advanceCombatIdle, spawnCombatIdle, tickResource } from './resource';
import { syncCharges, tickCooldowns } from './charges';
import { removeDeadMobs, updateMobs, updateSpawner } from './mobs';
import { updateProjectiles, updateTraps } from './projectiles';
import { updateDecoys, updateZones } from './zones';
import { updateHostileZones } from './abilities';
import { allModifiers, clampToArena, deriveFromMechanics, getClass, movePlayer, playerStat, PLAYER_ID, type Bounds, type Ctx, type MobScale, type Obstacle, type PlayerInput, type PlayerState, type WorldEvent, type WorldState } from './state';

export * from './state';
export { applyLeech, grantBonusXp, recoverLife, setLoadoutModifiers } from './experience';
export { spawnMob, spawnRadius, type MobSpawn } from './mobs';
export { inCombat, maxResource, recoverResource } from './resource';
export { canAfford } from './actions';
export { supportChangeSets, supportFits, supportTier } from '../supports/rules';
export type { SupportRef } from '../supports/types';
export { actionReady, availableCharges, chargeInfo, maxCharges, type ChargeInfo } from './charges';
export {
  actionCost,
  deriveStat,
  distanceDamageMore,
  leechStats,
  lifePotionMultiplier,
  lifeRecoveryPool,
  skillChangeSets,
  stunBarStats,
  stunDurationMultiplier,
  type ActionCost,
  type StatSource,
} from './passiveEffects';
export { resolveAction, resolveActions, skillMatches, type ActionSet } from '../skills/params';
export {
  classSkillProgress,
  isLevelEffectPending,
  skillLevelInfo,
  skillXpToNext,
  type SkillLevelData,
  type SkillLevelInfo,
  type SkillProgress,
} from '../skills/levels';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** What the hero brings into the run: level, equipment and passives as modifiers (see heroModifiers), plus the weapon. */
export interface Loadout {
  readonly level?: number;
  readonly xp?: number;
  readonly modifiers?: readonly Modifier[];
  readonly weapon?: WeaponDef;
  /** Passive tree mechanics (keystones, spec effects); see heroMechanics. */
  readonly mechanics?: readonly PassiveMechanic[];
  /**
   * Stored skill progress per skill id (CharacterRecord.skills); missing skills start at level 1, 0 XP
   * (sanitized by classSkillProgress). Ignored without Content.skillLevels.
   */
  readonly skills?: Readonly<Record<string, Readonly<SkillProgress>>>;
  /**
   * Socketed supports per class skill id, in slot order (socketedSupports(character)). Ignored without
   * Content.supports; invalid entries (unknown, incompatible, duplicates, past the slot count) do nothing.
   */
  readonly supports?: Readonly<Record<string, readonly SupportRef[]>>;
}

/** Mixed into the world seed for the loot stream (WorldState.lootRngState); structural, not balance. */
const LOOT_STREAM = 0x9e3779b9;

/** Where the world takes place: the endless arena (default) or a room of a map run (core/run). */
export interface WorldPlace {
  readonly bounds: Bounds;
  readonly obstacles?: readonly Obstacle[];
  /** Hero spawn point; default: the centre of the bounds. */
  readonly start?: Vec2;
  /** Runs the endless arena spawner (Content.arena.spawn). */
  readonly endless: boolean;
  /** Area level scaling of every mob spawned here (WorldState.mobScale); absent = × 1. */
  readonly mobScale?: MobScale;
}

/**
 * `areaLevel` defaults to the hero's level (the arena); a map run passes the map level. `place` defaults to the
 * endless arena (Content.arena).
 */
export function createWorld(
  content: Content,
  classId: string,
  seed: number,
  loadout: Loadout = {},
  areaLevel = loadout.level ?? 1,
  place: WorldPlace = { bounds: { width: content.arena.width, height: content.arena.height }, endless: true },
): WorldState {
  const classDef = getClass(content, classId);
  const level = loadout.level ?? 1;
  const gearModifiers = [...(loadout.modifiers ?? [])];
  const levelMods = levelModifiers(level, content.progression);
  const mechanics = [...(loadout.mechanics ?? [])];
  const skillProgress = content.skillLevels ? classSkillProgress(classDef, loadout.skills, content.skillLevels.rules) : {};
  const supports: Record<string, SupportRef[]> = {};
  for (const [skillId, refs] of Object.entries(loadout.supports ?? {})) supports[skillId] = refs.map((r) => ({ defId: r.defId, tier: r.tier }));
  const player: PlayerState = {
    id: PLAYER_ID,
    classId,
    pos: place.start ? vec(place.start.x, place.start.y) : vec(place.bounds.width / 2, place.bounds.height / 2),
    facing: vec(1, 0),
    radius: classDef.radius,
    life: 0,
    energyShield: 0,
    resource: 0,
    combatIdle: spawnCombatIdle(classDef),
    resourceHits: 0,
    actionTimer: 0,
    cooldowns: {},
    charges: {},
    useCounts: {},
    level,
    xp: loadout.xp ?? 0,
    gearModifiers,
    modifiers: [...gearModifiers, ...levelMods],
    levelModifiers: levelMods,
    mechanics,
    skillProgress,
    supports,
    echoes: [],
    ...deriveFromMechanics(content, classDef, { mechanics, skillProgress, supports }),
    stillTime: 0,
    leechRecent: 0,
    counterCooldown: 0,
    weapon: loadout.weapon ?? classDef.weapon,
    buffs: [],
    invulnerable: 0,
    motion: undefined,
    dead: false,
  };
  spawnPools(classDef, player);
  syncCharges(player, true);
  return {
    time: 0,
    bounds: { width: place.bounds.width, height: place.bounds.height },
    obstacles: (place.obstacles ?? []).map((o) => ({ pos: vec(o.pos.x, o.pos.y), radius: o.radius })),
    endless: place.endless,
    rngState: seed >>> 0,
    lootRngState: (seed ^ LOOT_STREAM) >>> 0,
    supportDrops: [],
    nextId: 1,
    player,
    mobs: [],
    projectiles: [],
    traps: [],
    zones: [],
    decoys: [],
    hostileZones: [],
    spawn: { timer: content.arena.spawn.firstDelay, wave: 0 },
    kills: 0,
    areaLevel,
    ...(place.mobScale ? { mobScale: { life: place.mobScale.life, damage: place.mobScale.damage, armour: place.mobScale.armour } } : {}),
    xpGained: 0,
    skillXpGained: 0,
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
  // Zones and decoys created this step (by the hero, projectiles or traps) already count this step's dt.
  updateZones(ctx, dt);
  updateDecoys(ctx, dt);
  updateHostileZones(ctx, dt);
  removeDeadMobs(ctx);
  updateSpawner(ctx, dt);

  world.rngState = rng.getState();
  return events;
}

function updatePlayer(ctx: Ctx, dt: number): void {
  const { world, classDef, input } = ctx;
  const player = world.player;

  player.buffs = player.buffs.filter((b) => (b.remaining -= dt) > 0);
  player.invulnerable = Math.max(0, player.invulnerable - dt);
  player.stillTime += dt;
  advanceCombatIdle(classDef, player, dt);
  // Snap float leftovers (1 − 60 × 1/60) so a 1 s internal cooldown ends after exactly 60 steps.
  player.counterCooldown = player.counterCooldown - dt > TIME_EPSILON ? player.counterCooldown - dt : 0;

  const maxLife = playerStat(classDef, player, 'life');
  const maxShield = playerStat(classDef, player, 'energyShield');
  player.life = clamp(player.life + playerStat(classDef, player, 'lifeRegen') * dt, 0, maxLife);
  player.energyShield = clamp(player.energyShield + playerStat(classDef, player, 'energyShieldRegen') * dt, 0, maxShield);
  tickResource(classDef, player, dt);
  decayLeech(classDef, player, dt);

  player.actionTimer = Math.max(0, player.actionTimer - dt);
  const recovery = computeStat(1, allModifiers(classDef, player), 'cooldownRecovery');
  tickCooldowns(player, dt, recovery);

  updateEchoes(ctx, dt);
  if (updateMotion(ctx, dt)) return;

  const move = normalize(input.move);
  const speed = playerStat(classDef, player, 'movementSpeed');
  movePlayer(player, clampToArena(add(player.pos, scale(move, speed * dt)), player.radius, world));

  const aimDir = normalize(sub(input.aim, player.pos));
  if (aimDir.x !== 0 || aimDir.y !== 0) player.facing = aimDir;

  if (player.actionTimer > 0) return;
  const action = pickAction(ctx);
  if (action) performAction(ctx, action);
}

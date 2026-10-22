import { clamp, vec, type Vec2 } from '../math';
import type { Rng } from '../rng';
import type { PassiveMechanic } from '../passives/types';
import type { DamageType, Modifier, StatId, Tag } from '../stats/types';
import type { ActionDef, ClassDef, Content, MobDef, StatusId, WeaponDef } from './content';
import type { ActionSet } from '../skills/params';
import { activeConditionalModifiers, deriveStat, hasStateMechanics, type ConditionState, type ConditionTarget } from './passiveEffects';

export const PLAYER_ID = 0;

export interface Buff {
  readonly id: string;
  readonly modifiers: readonly Modifier[];
  remaining: number;
}

/** Forced movement from a dash-like action. */
export interface Motion {
  readonly actionId: string;
  /** The effective action as it was when the dash started; its hits use this (see Projectile.action). */
  readonly action: ActionDef;
  readonly dir: Vec2;
  readonly speed: number;
  readonly hitRadius: number;
  remaining: number;
  hitIds: number[];
}

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
  level: number;
  /** XP towards the next level. */
  xp: number;
  /** Modifiers brought into the run (items, passives); level stats are added on top. */
  gearModifiers: readonly Modifier[];
  /** Permanent modifiers: gear + level. Rebuilt on level-up. */
  modifiers: Modifier[];
  /** Level stats only (a subset of `modifiers`); "base life" for lifeToEnergyShield. */
  levelModifiers: Modifier[];
  /** Passive tree mechanics brought into the run (keystones, spec effects); see passiveEffects.ts. */
  mechanics: readonly PassiveMechanic[];
  /**
   * Effective basic attack and skills: class data with the skill changes of `mechanics` applied
   * (core/skills/params). Derived plain data, rebuilt whenever the mechanics change (createWorld,
   * setLoadoutModifiers). The simulation reads actions from here, never from the class data.
   */
  actions: ActionSet;
  /** Seconds since the player last changed position (walk, dash, teleport). 0 at spawn. */
  stillTime: number;
  /**
   * Leech restored "recently" for the lifeLeech per-second cap: grows by each leech, drains by the cap per
   * second. Leech is allowed while it is below one second's worth of cap. 0 at spawn.
   */
  leechRecent: number;
  /** Equipped weapon, or the class default. */
  weapon: WeaponDef;
  buffs: Buff[];
  invulnerable: number;
  motion: Motion | undefined;
  dead: boolean;
}

export interface MobState {
  readonly id: number;
  readonly defId: string;
  pos: Vec2;
  facing: Vec2;
  life: number;
  /** Max life, set at spawn (= MobDef.life today; elite / map scaling later). Death explosions use it. */
  readonly maxLife: number;
  attackTimer: number;
  /** Remaining seconds of each status (0 = none); see STATUS_IDS. */
  stun: number;
  slow: number;
  slowMagnitude: number;
  ignite: number;
  /** Fire damage per second of the current ignite, after the mob's fire resistance (0 when not ignited). */
  igniteDps: number;
  freeze: number;
  /**
   * Bosses only: the short strong slow that replaces a freeze (CombatConfig.bossFreezeSlow). A separate slot,
   * so it never overwrites a longer, weaker `slow`; the stronger of the two active slows applies.
   * While it runs the boss counts as frozen (and as slowed).
   */
  freezeSlow: number;
}

export interface Projectile {
  readonly id: number;
  readonly owner: 'player' | 'mob';
  /** Action id (player) or mob def id (mob). */
  readonly sourceId: string;
  /**
   * Player projectiles: the effective action (plain data) as it was when fired. Its hits use this snapshot, so
   * damage, tags, crit and on-hit statuses (incl. durations) come from cast time even if the loadout changes
   * mid-flight. Omitted for mob projectiles.
   */
  readonly action?: ActionDef;
  pos: Vec2;
  readonly dir: Vec2;
  readonly speed: number;
  readonly radius: number;
  remaining: number;
  pierceLeft: number;
  readonly explodeRadius: number;
  hitIds: number[];
  /**
   * Hero-wide conditional modifiers (moving / standing / low life) locked when the action fired; used for
   * its hits instead of re-evaluating at impact. Empty for mob projectiles. See heroConditionalModifiers.
   */
  readonly castModifiers: readonly Modifier[];
}

export interface Trap {
  readonly id: number;
  readonly actionId: string;
  /** The effective action as it was when thrown (see Projectile.action). */
  readonly action: ActionDef;
  readonly pos: Vec2;
  armTimer: number;
  lifetime: number;
  /** Trigger and explosion radii locked when the trap was thrown (effective skill params at that moment). */
  readonly triggerRadius: number;
  readonly explodeRadius: number;
  /** Hero-wide conditional modifiers locked when the trap was thrown (see Projectile.castModifiers). */
  readonly castModifiers: readonly Modifier[];
}

export interface WorldState {
  time: number;
  rngState: number;
  nextId: number;
  player: PlayerState;
  mobs: MobState[];
  projectiles: Projectile[];
  traps: Trap[];
  spawn: { timer: number; wave: number };
  kills: number;
  /** Level of the area (map level); scales mob XP. */
  readonly areaLevel: number;
  /** Total XP earned this run. */
  xpGained: number;
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
  | { type: 'action'; actionId: string; facing: Vec2 }
  /**
   * A damage zone resolved this tick (arc swing, nova, explosion) — for visuals. Death explosions have
   * actionId 'deathExplosion', `source` 'deathExplosion', their damage type and the id of the mob that exploded.
   */
  | {
      type: 'area';
      actionId: string;
      origin: Vec2;
      facing: Vec2;
      radius: number;
      angleDeg: number;
      source?: 'deathExplosion';
      damageType?: DamageType;
      sourceMobId?: number;
    }
  /** A status was applied to (or refreshed on) a living mob; `duration` is its new remaining time. */
  | { type: 'status'; targetId: number; pos: Vec2; status: StatusId; duration: number }
  /** Damage over time dealt this step (one event per mob per step; aggregate for damage numbers). */
  | { type: 'dot'; targetId: number; pos: Vec2; amount: number; status: StatusId }
  | { type: 'teleport'; from: Vec2; to: Vec2 }
  | { type: 'mobAttack'; id: number }
  | { type: 'hit'; targetId: number; pos: Vec2; amount: number; isCrit: boolean }
  | { type: 'spawn'; id: number }
  | { type: 'death'; id: number; pos: Vec2 }
  | { type: 'levelUp'; level: number }
  | { type: 'playerDeath' };

/** Everything a system needs during one step. */
export interface Ctx {
  readonly world: WorldState;
  readonly content: Content;
  readonly classDef: ClassDef;
  readonly rng: Rng;
  readonly events: WorldEvent[];
  readonly input: PlayerInput;
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

/** Permanent modifiers and buffs, without conditional (passive mechanic) modifiers. */
export function baseModifiers(player: PlayerState): readonly Modifier[] {
  if (player.buffs.length === 0) return player.modifiers;
  return [...player.modifiers, ...player.buffs.flatMap((b) => b.modifiers)];
}

function hasConditionalMechanics(player: PlayerState): boolean {
  return hasStateMechanics(player.mechanics);
}

/** Hero state for conditions; pool maximums (full stat derivations) are computed only if a mechanic asks. */
function conditionState(classDef: ClassDef, player: PlayerState, base: readonly Modifier[]): ConditionState {
  const source = { baseStats: classDef.baseStats, modifiers: base, levelModifiers: player.levelModifiers, mechanics: player.mechanics };
  return {
    stillTime: player.stillTime,
    life: player.life,
    energyShield: player.energyShield,
    get maxLife(): number {
      return deriveStat(source, 'life');
    },
    get maxEnergyShield(): number {
      return deriveStat(source, 'energyShield');
    },
  };
}

/**
 * Conditional modifiers whose hero-wide condition (moving, standing, low life) holds right now.
 * Delayed hits (projectiles, traps) snapshot this when the action fires (Projectile.castModifiers).
 */
export function heroConditionalModifiers(classDef: ClassDef, player: PlayerState): Modifier[] {
  if (!hasConditionalMechanics(player)) return [];
  return activeConditionalModifiers(player.mechanics, conditionState(classDef, player, baseModifiers(player)));
}

/**
 * Every modifier that applies to the player right now: permanent, buffs and conditional modifiers whose
 * hero condition holds (moving, standing, low life). With `target`, per-hit target conditions are added too.
 * `castModifiers` replaces the live hero conditions with a snapshot taken at cast time (delayed hits);
 * target conditions are still evaluated now, against the target being hit.
 */
export function allModifiers(
  classDef: ClassDef,
  player: PlayerState,
  target?: ConditionTarget,
  castModifiers?: readonly Modifier[],
): readonly Modifier[] {
  const base = baseModifiers(player);
  if (!hasConditionalMechanics(player)) return castModifiers && castModifiers.length > 0 ? [...base, ...castModifiers] : base;
  const state = conditionState(classDef, player, base);
  const extra = castModifiers ? [...castModifiers] : activeConditionalModifiers(player.mechanics, state);
  if (target) extra.push(...activeConditionalModifiers(player.mechanics, state, target));
  return extra.length === 0 ? base : [...base, ...extra];
}

/** A player stat with all modifiers and pool mechanics (blood magic, crystal shell) applied. */
export function playerStat(classDef: ClassDef, player: PlayerState, stat: StatId, tags: readonly Tag[] = []): number {
  return deriveStat(
    { baseStats: classDef.baseStats, modifiers: allModifiers(classDef, player), levelModifiers: player.levelModifiers, mechanics: player.mechanics },
    stat,
    tags,
  );
}

/** Moves the player; any actual change of position counts as movement for movement conditions. */
export function movePlayer(player: PlayerState, pos: Vec2): void {
  if (pos.x !== player.pos.x || pos.y !== player.pos.y) player.stillTime = 0;
  player.pos = pos;
}

export function clampToArena(pos: Vec2, radius: number, content: Content): Vec2 {
  return vec(clamp(pos.x, radius, content.arena.width - radius), clamp(pos.y, radius, content.arena.height - radius));
}

export function insideArena(pos: Vec2, content: Content): boolean {
  return pos.x >= 0 && pos.y >= 0 && pos.x <= content.arena.width && pos.y <= content.arena.height;
}

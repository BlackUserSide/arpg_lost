import { clamp, vec, type Vec2 } from '../math';
import type { Rng } from '../rng';
import { computeStat } from '../stats/modifiers';
import type { Modifier, StatId, Tag } from '../stats/types';
import type { ClassDef, Content, MobDef, WeaponDef } from './content';

export const PLAYER_ID = 0;

export interface Buff {
  readonly id: string;
  readonly modifiers: readonly Modifier[];
  remaining: number;
}

/** Forced movement from a dash-like action. */
export interface Motion {
  readonly actionId: string;
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
  attackTimer: number;
  stun: number;
  slow: number;
  slowMagnitude: number;
}

export interface Projectile {
  readonly id: number;
  readonly owner: 'player' | 'mob';
  /** Action id (player) or mob def id (mob). */
  readonly sourceId: string;
  pos: Vec2;
  readonly dir: Vec2;
  readonly speed: number;
  readonly radius: number;
  remaining: number;
  pierceLeft: number;
  readonly explodeRadius: number;
  hitIds: number[];
}

export interface Trap {
  readonly id: number;
  readonly actionId: string;
  readonly pos: Vec2;
  armTimer: number;
  lifetime: number;
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
  /** A damage zone resolved this tick (arc swing, nova, explosion) — for visuals. */
  | { type: 'area'; actionId: string; origin: Vec2; facing: Vec2; radius: number; angleDeg: number }
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

export function allModifiers(player: PlayerState): readonly Modifier[] {
  if (player.buffs.length === 0) return player.modifiers;
  return [...player.modifiers, ...player.buffs.flatMap((b) => b.modifiers)];
}

export function playerStat(classDef: ClassDef, player: PlayerState, stat: StatId, tags: readonly Tag[] = []): number {
  return computeStat(classDef.baseStats[stat] ?? 0, allModifiers(player), stat, tags);
}

export function clampToArena(pos: Vec2, radius: number, content: Content): Vec2 {
  return vec(clamp(pos.x, radius, content.arena.width - radius), clamp(pos.y, radius, content.arena.height - radius));
}

export function insideArena(pos: Vec2, content: Content): boolean {
  return pos.x >= 0 && pos.y >= 0 && pos.x <= content.arena.width && pos.y <= content.arena.height;
}

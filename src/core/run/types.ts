// Map run data and state (docs/design/maps.md): K combat rooms + a boss room, a hard time limit, a chest at the end.
// Data shapes live here; numbers live in src/data/maps.ts. State is plain serializable JSON.

import type { Vec2 } from '../math';
import type { MobRank } from '../world/content';
import type { MobSpawn, Obstacle, PlayerInput, WorldEvent, WorldState } from '../world/world';

export interface IntRange {
  readonly min: number;
  readonly max: number;
}

/** Fields every room template has. Coordinates are world units inside (0, 0)–(width, height). */
interface RoomTemplateBase {
  /** Unique id; render keys its look by it. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Where the hero appears when entering the room (render: the door they came through). */
  readonly entry: Vec2;
  /** Where waves (and later boss minions) appear; each mob picks one at random, plus a jitter (RunRules.waves.spawnJitter). */
  readonly spawnPoints: readonly Vec2[];
  readonly obstacles?: readonly Obstacle[];
}

/** A room with waves; its door to the next room is at `exit` and opens when the room is cleared. */
export interface CombatRoomTemplate extends RoomTemplateBase {
  readonly kind: 'combat';
  readonly exit: Vec2;
}

/** The last room: calm until the hero activates the altar, then the boss appears at `bossSpawn`. */
export interface BossRoomTemplate extends RoomTemplateBase {
  readonly kind: 'boss';
  readonly altar: Vec2;
  readonly bossSpawn: Vec2;
}

export type RoomTemplate = CombatRoomTemplate | BossRoomTemplate;
export type RoomKind = RoomTemplate['kind'];

/** A mob type that can appear in waves from `minMapLevel` on (new types every few map levels, docs/design/mobs.md). */
export interface MobPoolEntry {
  readonly mobId: string;
  readonly weight: number;
  /** First map level it appears on; absent = 1. */
  readonly minMapLevel?: number;
}

/** How a rank changes an ordinary mob def (multipliers over MobDef life / attack damage / XP / body radius). */
export interface RankScaling {
  readonly life: number;
  readonly damage: number;
  readonly xp: number;
  /** Multiplier on MobDef.radius: the ranked mob's collision radius (MobState.radius) and drawn size. */
  readonly radius: number;
}

export interface RunRules {
  /** Combat rooms before the boss room (docs/design/maps.md PROPOSAL: 3). */
  readonly combatRooms: number;
  /** Hard time limit, seconds; running out fails the run. */
  readonly timeLimit: number;
  /** Seconds left at which a 'timeWarning' event fires (once each). Must be in descending order (maps.test.ts). */
  readonly timeWarnings: readonly number[];
  /** Highest map of the linear ladder (keys follow later, docs/design/endgame.md). */
  readonly maxLinearMap: number;
  /** The hero passes an open door when within this distance of its centre. */
  readonly doorRadius: number;
  /** The hero can activate the altar within this distance of it. */
  readonly altarRadius: number;
  readonly waves: {
    /** Waves per combat room. */
    readonly count: IntRange;
    /** Ordinary mobs per wave (elites come on top). */
    readonly mobs: IntRange;
    /** Seconds from entering a room to its first wave. */
    readonly firstDelay: number;
    /** Seconds from a wave being wiped out to the next one. */
    readonly nextDelay: number;
    /** Max distance of a spawn from its spawn point. */
    readonly spawnJitter: number;
    readonly mobPool: readonly MobPoolEntry[];
  };
  readonly elites: {
    /** Elites per combat room; each joins a random wave, its mob type from the wave pool. */
    readonly count: IntRange;
    readonly scaling: RankScaling;
  };
  readonly boss: {
    /**
     * Mob def of the boss. Package 1 uses an ordinary mob scaled as a placeholder; the necromancer (package 2) will
     * be its own MobDef with boss: true (and scaling 1).
     */
    readonly mobId: string;
    readonly scaling: RankScaling;
    /** Seconds from the altar's activation to the boss appearing. */
    readonly spawnDelay: number;
  };
}

/** Chest bonus for a fast clear: applies when at least `minTimeLeft` of the time limit (fraction) is left. */
export interface SpeedTier {
  readonly minTimeLeft: number;
  readonly extraItems: number;
  readonly itemLevelBonus: number;
  /** Rarity luck of the chest items (rollRarity). */
  readonly luck: number;
}

export interface RunRewardRules {
  readonly chest: {
    readonly items: number;
    /** Item level bonus of boss loot (docs/design/items.md: +1). */
    readonly bossItemLevelBonus: number;
    /** All item level bonuses together never exceed this (designer decision 2026-10-23: map level + 3). */
    readonly maxItemLevelBonus: number;
    readonly speedTiers: readonly SpeedTier[];
  };
  /** Shards per combat room cleared (a failed run's consolation; a won run gets them too). */
  readonly shardsPerRoom: number;
  /** Items of map level (no bonus) for a failed run that reached the boss room. */
  readonly bossRoomConsolationItems: number;
  readonly essence: { readonly perElite: number; readonly perBoss: number };
}

export interface MapsData {
  readonly rules: RunRules;
  readonly rewards: RunRewardRules;
  readonly templates: Readonly<Record<string, RoomTemplate>>;
}

/** One planned room of a run: its template and its waves (mobs with rank and scaling already applied). */
export interface RoomPlan {
  readonly templateId: string;
  readonly kind: RoomKind;
  /** Combat rooms: the mobs of each wave in spawn order. Empty for the boss room. */
  readonly waves: readonly (readonly MobSpawn[])[];
}

/**
 * Where the current room is:
 * - 'waves': waves are coming (combat room); the next spawns `waveTimer` seconds after the last one is wiped out.
 * - 'cleared': all waves dead, the door is open; walking into it enters the next room.
 * - 'altar': boss room, calm until the hero activates the altar.
 * - 'summoning': the altar is active, the boss appears when `waveTimer` runs out.
 * - 'boss': the boss fight; killing the boss wins the run.
 */
export type RoomPhase = 'waves' | 'cleared' | 'altar' | 'summoning' | 'boss';
export type RunStatus = 'active' | 'won' | 'failed';
/** 'abandoned': the player left the run (abandonRun). */
export type RunFailReason = 'death' | 'timeout' | 'abandoned';

export interface RunState {
  readonly mapLevel: number;
  readonly seed: number;
  /** Run stream (room picks, wave plans, spawn positions); separate from the world's combat and loot streams. */
  rngState: number;
  readonly rooms: readonly RoomPlan[];
  /** Index into `rooms` of the room the hero is in. */
  room: number;
  phase: RoomPhase;
  /** Waves of the current room spawned so far. */
  wavesSpawned: number;
  /** Phase timer: seconds to the next wave ('waves') or to the boss ('summoning'). */
  waveTimer: number;
  /** Elites of the current room still alive (mob ids). */
  eliteIds: number[];
  /** The boss's mob id once it spawned. */
  bossId: number | null;
  /** Seconds since the run started (the timer). */
  elapsed: number;
  /** timeWarnings already fired (count, in descending order of seconds). */
  warningsFired: number;
  status: RunStatus;
  failReason: RunFailReason | null;
  /** Combat rooms cleared. */
  roomsCleared: number;
  elitesKilled: number;
  bossKilled: boolean;
  /** Map completion XP granted on the win (0 otherwise). */
  bonusXp: number;
  /** Set by finishRun: rewards were granted, a second call does nothing. */
  recorded: boolean;
  world: WorldState;
}

export interface RunInput extends PlayerInput {
  /** Interaction key (altar); edge or held both work, the altar reacts once. */
  readonly interact?: boolean;
}

export type RunEvent =
  /** The hero entered room `room` (also the boss room); the world's bounds and obstacles are now the template's. */
  | { type: 'roomEnter'; room: number; templateId: string; kind: RoomKind }
  /** Wave `wave` (0-based) of the current room spawned `count` mobs (their 'spawn' events follow). */
  | { type: 'waveStart'; room: number; wave: number; count: number }
  /** Every wave of combat room `room` is dead; its door at `door` is open. */
  | { type: 'roomCleared'; room: number; door: Vec2 }
  | { type: 'altarActivated'; pos: Vec2; delay: number }
  | { type: 'bossSpawned'; id: number; pos: Vec2 }
  /** A ranked mob of this run died (rank 'elite' or 'boss'). */
  | { type: 'rankedKill'; id: number; rank: Exclude<MobRank, 'normal'> }
  | { type: 'timeWarning'; secondsLeft: number }
  | { type: 'runWon'; elapsed: number; timeLeft: number; bonusXp: number }
  | { type: 'runFailed'; reason: RunFailReason };

export type RunStepEvent = WorldEvent | RunEvent;

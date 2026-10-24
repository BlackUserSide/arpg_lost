import * as Phaser from 'phaser';
import manifest from './sprites.json';

// Baked character sprites (tools/sprite-baker) and how game entities map onto them.

export interface AnimDef {
  file: string;
  frames: number;
  fps: number;
  loop: boolean;
  /** Direction rows present in the sheet when only a subset was baked (sheet row i = rows[i]). */
  rows?: number[];
  /** Trimmed atlas (JSON hash) for big sheets; frame names are the grid frame indices, so use is identical. */
  atlas?: string;
}

type SpriteSet = Partial<Record<string, AnimDef>>;

export const SPRITE_SETS = manifest.characters as Record<string, SpriteSet>;
export const FRAME_SIZE = manifest.frameSize;
export const ORIGIN_Y = manifest.originY / manifest.frameSize;

/** Frame layout of a sprite set: bosses are baked in a bigger frame at their in-game size. */
export interface SpriteLayout {
  frameSize: number;
  /** Feet position as a fraction of the frame height (Phaser origin y). */
  originY: number;
  /**
   * Scale the sheet is already baked at relative to a normal mob: draw with `drawScale / nativeScale`
   * (a boss at rank radius scale 1.75 baked with nativeScale 1.75 is drawn 1:1).
   */
  nativeScale: number;
}

const LAYOUTS = (manifest as { layouts?: Record<string, { frameSize: number; originY: number; nativeScale: number }> }).layouts ?? {};
const DEFAULT_LAYOUT: SpriteLayout = { frameSize: FRAME_SIZE, originY: ORIGIN_Y, nativeScale: 1 };

export function spriteLayout(set: string): SpriteLayout {
  const layout = LAYOUTS[set];
  return layout ? { frameSize: layout.frameSize, originY: layout.originY / layout.frameSize, nativeScale: layout.nativeScale } : DEFAULT_LAYOUT;
}

/** Visual look of a class; its name and description come from the locale files (render/contentText.ts). */
export interface ClassLook {
  classId: string;
  sprite: string;
}

export const CLASS_LOOKS: readonly ClassLook[] = [
  { classId: 'warrior', sprite: 'knight' },
  { classId: 'ranger', sprite: 'ranger' },
  { classId: 'mage', sprite: 'mage' },
];

export const MOB_SPRITES: Readonly<Record<string, string>> = {
  zombie: 'skeleton_warrior',
  runner: 'skeleton_minion',
  archer: 'skeleton_archer',
  necromancer: 'necromancer',
};

/**
 * Sets without an `attack` sheet: the animation their basic attack plays instead (the necromancer's weak dark bolt
 * uses the spear cast's quick staff thrust).
 */
export const ATTACK_ANIMS: Readonly<Record<string, string>> = {
  necromancer: 'cast_spears',
};

/**
 * Wind-up pose per mob ability kind (MobState.casting), played over the wind-up so the release lands when the
 * ability resolves. Sets without the sheet just stand.
 */
export const CAST_ANIMS: Readonly<Record<string, string>> = {
  nova: 'cast_nova',
  summon: 'cast_summon',
  projectileFan: 'cast_spears',
  // Grave circles: arms raised like the summon; the graves open under the target.
  groundZones: 'cast_summon',
};

/** Pose held during a phase change roar (MobState.phaseTransition): arms raised. */
export const ROAR_ANIM = 'cast_summon';

/** Baked animation for each core action id; unknown actions fall back to `attack`. */
export const ACTION_ANIMS: Readonly<Record<string, string>> = {
  warrior_strike: 'attack',
  cleave: 'cleave',
  shield_charge: 'dash',
  battle_cry: 'cry',
  ranger_bolt: 'attack',
  volley: 'volley',
  explosive_trap: 'trap',
  roll: 'roll',
  wand_bolt: 'attack',
  fireball: 'fireball',
  frost_nova: 'nova',
  teleport: 'teleport',
};

export const textureKey = (set: string, anim: string): string => `${set}_${anim}`;

export function loadSprites(scene: Phaser.Scene): void {
  for (const [set, anims] of Object.entries(SPRITE_SETS)) {
    const { frameSize } = spriteLayout(set);
    for (const [anim, def] of Object.entries(anims)) {
      if (!def || scene.textures.exists(textureKey(set, anim))) continue;
      if (def.atlas) scene.load.atlas(textureKey(set, anim), `assets/sprites/${def.file}`, `assets/sprites/${def.atlas}`);
      else scene.load.spritesheet(textureKey(set, anim), `assets/sprites/${def.file}`, { frameWidth: frameSize, frameHeight: frameSize });
    }
  }
}

/** Frame index for a looping animation at `time` seconds, in direction `row`. */
export function spriteFrame(set: string, anim: string, row: number, time: number): number {
  const def = SPRITE_SETS[set]?.[anim];
  if (!def) return 0;
  // Partial sheets hold only some directions; an unbaked direction falls back to the first baked one.
  const sheetRow = def.rows ? Math.max(0, def.rows.indexOf(row)) : row;
  return sheetRow * def.frames + (Math.floor(time * def.fps) % def.frames);
}

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
}

type SpriteSet = Partial<Record<string, AnimDef>>;

export const SPRITE_SETS = manifest.characters as Record<string, SpriteSet>;
export const FRAME_SIZE = manifest.frameSize;
export const ORIGIN_Y = manifest.originY / manifest.frameSize;

export interface ClassLook {
  classId: string;
  sprite: string;
  name: string;
  description: string;
}

export const CLASS_LOOKS: readonly ClassLook[] = [
  { classId: 'warrior', sprite: 'knight', name: 'Warrior', description: 'Melee. Cleave, shield charge, battle cry.' },
  { classId: 'ranger', sprite: 'ranger', name: 'Ranger', description: 'Crossbow. Volley, explosive trap, roll.' },
  { classId: 'mage', sprite: 'mage', name: 'Mage', description: 'Spells. Fireball, frost nova, teleport.' },
];

export const MOB_SPRITES: Readonly<Record<string, string>> = {
  zombie: 'skeleton_warrior',
  runner: 'skeleton_minion',
  archer: 'skeleton_archer',
};

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
    for (const [anim, def] of Object.entries(anims)) {
      if (!def || scene.textures.exists(textureKey(set, anim))) continue;
      scene.load.spritesheet(textureKey(set, anim), `assets/sprites/${def.file}`, { frameWidth: FRAME_SIZE, frameHeight: FRAME_SIZE });
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

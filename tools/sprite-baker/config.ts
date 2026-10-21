// What to bake. Models come from art_src/ (see fetch-models.sh), output goes to public/assets/sprites/.

export interface BakeAnim {
  /** Name used by the game. */
  readonly id: string;
  /** Clip name inside the glTF. */
  readonly clip: string;
  readonly frames: number;
  /** Playback fps. Omit for loops to play at the clip's natural speed (frames / clip duration). */
  readonly fps?: number;
  readonly loop: boolean;
}

export interface BakeAttachment {
  /** Separate glTF model (e.g. a weapon) parented to a bone of the character. */
  readonly model: string;
  readonly bone: string;
  /** Euler rotation in degrees (x, y, z) relative to the bone. */
  readonly rotation?: readonly [number, number, number];
}

export interface BakeCharacter {
  readonly id: string;
  readonly model: string;
  /** Mesh node names to hide (unused weapons / shields). */
  readonly hide: readonly string[];
  readonly attach?: readonly BakeAttachment[];
  /** Height on screen in pixels (world units). */
  readonly height: number;
  readonly anims: readonly BakeAnim[];
}

export const BAKE = {
  frameSize: 128,
  /** Feet position inside a frame, from the top. */
  originY: 104,
  /** Render at frameSize / pixelScale and upscale with nearest filter for a chunkier pixel look. */
  pixelScale: 1,
  outlineColor: [12, 10, 14] as const,
};

export const CHARACTERS: readonly BakeCharacter[] = [
  {
    id: 'knight',
    model: 'Knight.glb',
    hide: ['1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Spike_Shield', '2H_Sword'],
    height: 64,
    anims: [
      { id: 'idle', clip: 'Idle', frames: 10, loop: true },
      { id: 'run', clip: 'Running_A', frames: 14, loop: true },
      { id: 'attack', clip: '1H_Melee_Attack_Chop', frames: 8, fps: 24, loop: false },
      { id: 'cleave', clip: '1H_Melee_Attack_Slice_Horizontal', frames: 8, fps: 24, loop: false },
      { id: 'dash', clip: 'Dodge_Forward', frames: 8, fps: 21, loop: false },
      { id: 'cry', clip: 'Cheer', frames: 8, fps: 16, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_A', frames: 8, fps: 14, loop: false },
    ],
  },
  {
    id: 'ranger',
    model: 'Rogue_Hooded.glb',
    hide: ['Knife_Offhand', '1H_Crossbow', 'Knife', 'Throwable'],
    height: 62,
    anims: [
      { id: 'idle', clip: '2H_Ranged_Aiming', frames: 10, loop: true },
      { id: 'run', clip: 'Running_A', frames: 14, loop: true },
      { id: 'attack', clip: '2H_Ranged_Shoot', frames: 8, fps: 24, loop: false },
      { id: 'volley', clip: '2H_Ranged_Shooting', frames: 8, fps: 24, loop: false },
      { id: 'trap', clip: 'Throw', frames: 8, fps: 21, loop: false },
      { id: 'roll', clip: 'Dodge_Forward', frames: 8, fps: 21, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_A', frames: 8, fps: 14, loop: false },
    ],
  },
  {
    id: 'mage',
    model: 'Mage.glb',
    hide: ['Spellbook', 'Spellbook_open', '2H_Staff'],
    height: 62,
    anims: [
      { id: 'idle', clip: 'Idle', frames: 10, loop: true },
      { id: 'run', clip: 'Running_A', frames: 14, loop: true },
      { id: 'attack', clip: 'Spellcast_Shoot', frames: 8, fps: 24, loop: false },
      { id: 'fireball', clip: 'Spellcast_Long', frames: 8, fps: 19, loop: false },
      { id: 'nova', clip: 'Spellcast_Raise', frames: 8, fps: 19, loop: false },
      { id: 'teleport', clip: 'Spellcasting', frames: 8, fps: 21, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_A', frames: 8, fps: 14, loop: false },
    ],
  },
  {
    id: 'skeleton_warrior',
    model: 'Skeleton_Warrior.glb',
    hide: [],
    height: 62,
    anims: [
      { id: 'idle', clip: 'Idle', frames: 10, loop: true },
      { id: 'run', clip: 'Walking_D_Skeletons', frames: 14, loop: true },
      { id: 'attack', clip: '1H_Melee_Attack_Chop', frames: 8, fps: 19, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_C_Skeletons', frames: 8, fps: 14, loop: false },
      { id: 'spawn', clip: 'Spawn_Ground_Skeletons', frames: 8, fps: 14, loop: false },
    ],
  },
  {
    id: 'skeleton_archer',
    model: 'Skeleton_Rogue.glb',
    hide: [],
    attach: [{ model: 'Skeleton_Crossbow.gltf', bone: 'handslot.r', rotation: [0, 180, 0] }],
    height: 58,
    anims: [
      { id: 'idle', clip: '1H_Ranged_Aiming', frames: 10, loop: true },
      { id: 'run', clip: 'Walking_D_Skeletons', frames: 14, loop: true },
      { id: 'attack', clip: '1H_Ranged_Shoot', frames: 8, fps: 19, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_C_Skeletons', frames: 8, fps: 14, loop: false },
      { id: 'spawn', clip: 'Spawn_Ground_Skeletons', frames: 8, fps: 14, loop: false },
    ],
  },
  {
    id: 'skeleton_minion',
    model: 'Skeleton_Minion.glb',
    hide: [],
    height: 52,
    anims: [
      { id: 'idle', clip: 'Idle', frames: 10, loop: true },
      { id: 'run', clip: 'Running_C', frames: 14, loop: true },
      { id: 'attack', clip: 'Unarmed_Melee_Attack_Punch_A', frames: 8, fps: 21, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_C_Skeletons', frames: 8, fps: 14, loop: false },
      { id: 'spawn', clip: 'Spawn_Ground_Skeletons', frames: 8, fps: 14, loop: false },
    ],
  },
];

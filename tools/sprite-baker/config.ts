// What to bake. Models come from art_src/ (see fetch-models.sh), output goes to public/assets/sprites/.

export interface BakeAnim {
  /** Name used by the game. */
  readonly id: string;
  /** Clip name inside the glTF. */
  readonly clip: string;
  readonly frames: number;
  readonly fps: number;
  readonly loop: boolean;
}

export interface BakeCharacter {
  readonly id: string;
  readonly model: string;
  /** Mesh node names to hide (unused weapons / shields). */
  readonly hide: readonly string[];
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
      { id: 'idle', clip: 'Idle', frames: 4, fps: 4, loop: true },
      { id: 'run', clip: 'Running_A', frames: 8, fps: 12, loop: true },
      { id: 'attack', clip: '1H_Melee_Attack_Chop', frames: 6, fps: 18, loop: false },
      { id: 'skill', clip: '1H_Melee_Attack_Slice_Horizontal', frames: 6, fps: 18, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 3, fps: 16, loop: false },
      { id: 'death', clip: 'Death_A', frames: 6, fps: 10, loop: false },
    ],
  },
  {
    id: 'skeleton_warrior',
    model: 'Skeleton_Warrior.glb',
    hide: [],
    height: 62,
    anims: [
      { id: 'idle', clip: 'Idle_Combat', frames: 4, fps: 4, loop: true },
      { id: 'run', clip: 'Walking_D_Skeletons', frames: 8, fps: 10, loop: true },
      { id: 'attack', clip: '1H_Melee_Attack_Chop', frames: 6, fps: 14, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 3, fps: 16, loop: false },
      { id: 'death', clip: 'Death_C_Skeletons', frames: 6, fps: 10, loop: false },
      { id: 'spawn', clip: 'Spawn_Ground_Skeletons', frames: 6, fps: 10, loop: false },
    ],
  },
  {
    id: 'skeleton_minion',
    model: 'Skeleton_Minion.glb',
    hide: [],
    height: 52,
    anims: [
      { id: 'idle', clip: 'Idle_Combat', frames: 4, fps: 4, loop: true },
      { id: 'run', clip: 'Running_C', frames: 8, fps: 14, loop: true },
      { id: 'attack', clip: 'Unarmed_Melee_Attack_Punch_A', frames: 5, fps: 16, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 3, fps: 16, loop: false },
      { id: 'death', clip: 'Death_C_Skeletons', frames: 6, fps: 10, loop: false },
      { id: 'spawn', clip: 'Spawn_Ground_Skeletons', frames: 6, fps: 10, loop: false },
    ],
  },
];

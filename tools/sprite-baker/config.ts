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
  /**
   * Direction rows to bake (Flare order: 0 W, 1 NW, 2 N, 3 NE, 4 E, 5 SE, 6 S, 7 SW). Omit for all 8.
   * Use for anims shown from one fixed angle (e.g. the menu pose) to keep the build small.
   */
  readonly rows?: readonly number[];
  /** Extra mesh node names hidden for this anim only (e.g. a weapon that clips through a sitting pose). */
  readonly hide?: readonly string[];
  /** Cut everything below the floor (rising-from-the-ground spawns start underground). */
  readonly clipBelowGround?: boolean;
}

export interface BakeAttachment {
  /** Separate glTF model (e.g. a weapon) parented to a bone of the character. */
  readonly model: string;
  readonly bone: string;
  /** Euler rotation in degrees (x, y, z) relative to the bone. */
  readonly rotation?: readonly [number, number, number];
  /** Offset relative to the bone, in the prop's own units (before the character is scaled). */
  readonly position?: readonly [number, number, number];
  /** Uniform scale of the prop relative to the bone. Default 1. */
  readonly scale?: number;
}

export interface BakeTint {
  /** Mesh node names (character parts or attached props) whose material colour is multiplied. */
  readonly meshes: readonly string[];
  /**
   * New hue / saturation (RGB); the texture's per-texel brightness is kept, so shading and painted details stay.
   * The shared KayKit texture itself is left untouched.
   */
  readonly color: number;
  /** Brightness multiplier on top of the texture's own. Default 1. */
  readonly brightness?: number;
}

export interface BakeCharacter {
  readonly id: string;
  readonly model: string;
  /** Mesh node names to hide (unused weapons / shields). */
  readonly hide: readonly string[];
  readonly attach?: readonly BakeAttachment[];
  /** Per-part colour multipliers: variants of a shared model (hood / robe colour) that read apart at a glance. */
  readonly tint?: readonly BakeTint[];
  /** Height on screen in pixels (world units). */
  readonly height: number;
  /**
   * Larger characters (bosses) get their own frame so they are baked at native size instead of being
   * upscaled in game (render uses nearest filtering, so non-integer upscales look uneven). Defaults: BAKE.
   */
  readonly frameSize?: number;
  readonly originY?: number;
  /**
   * Draw scale the sheet is already baked at, relative to a normal-sized mob. Render divides its in-game
   * scale by this (a boss drawn at radius scale 1.75 with nativeScale 1.75 is shown 1:1). Default 1.
   */
  readonly nativeScale?: number;
  /**
   * Write trimmed atlases (PNG + Phaser JSON hash) instead of grid sheets: empty frame margins are cut,
   * which matters for big frames (GPU memory is width x height x 4 regardless of PNG compression).
   */
  readonly trim?: boolean;
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
      // Menu backdrop only: sitting by the campfire, facing it (east row).
      { id: 'sit', clip: 'Sit_Floor_Idle', frames: 12, loop: true, rows: [4] },
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
      // Crossbow is set aside while resting: held in a sitting pose it points straight into the floor.
      { id: 'sit', clip: 'Sit_Floor_Idle', frames: 12, loop: true, rows: [4], hide: ['2H_Crossbow'] },
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
      { id: 'sit', clip: 'Sit_Floor_Idle', frames: 12, loop: true, rows: [4] },
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
  // Map mobs added in 0.4 (docs/design/mobs.md). Not summoned, so no spawn sheet; casters have no `attack` sheet
  // (render ATTACK_ANIMS maps their basic attack onto the cast sheet). Death_A falls flat without the root-motion
  // drift of Death_C_Skeletons but does not fit a 128 px frame, so these get a roomier 192 px frame, trimmed (the
  // margins cost neither file size nor GPU memory). Fewer idle / run frames than the older sets keep the build small.
  {
    // Slow heavy melee: big shield held in front, axe, steel-blue helmet and cloak (the zombie is unarmed, red).
    id: 'shieldbearer',
    model: 'Skeleton_Warrior.glb',
    hide: [],
    attach: [
      { model: 'Skeleton_Shield_Large_A.gltf', bone: 'handslot.l' },
      { model: 'Skeleton_Axe.gltf', bone: 'handslot.r' },
    ],
    tint: [{ meshes: ['Skeleton_Warrior_Helmet', 'Skeleton_Warrior_Cloak'], color: 0x6f9fe0 }],
    height: 66,
    frameSize: 192,
    originY: 136,
    trim: true,
    anims: [
      { id: 'idle', clip: 'Blocking', frames: 8, loop: true },
      { id: 'run', clip: 'Walking_A', frames: 10, loop: true },
      { id: 'attack', clip: '1H_Melee_Attack_Chop', frames: 8, fps: 16, loop: false },
      { id: 'hit', clip: 'Block_Hit', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_A', frames: 8, fps: 12, loop: false },
    ],
  },
  {
    // Ranged: bare skull (hood off, unlike the crossbow archer), green cape, empty-handed overhand throws.
    id: 'bone_thrower',
    model: 'Skeleton_Rogue.glb',
    hide: ['Skeleton_Rogue_Hood'],
    tint: [{ meshes: ['Skeleton_Rogue_Cape'], color: 0x3fa070 }],
    height: 56,
    frameSize: 192,
    originY: 136,
    trim: true,
    anims: [
      { id: 'idle', clip: 'Idle_Combat', frames: 8, loop: true },
      { id: 'run', clip: 'Walking_D_Skeletons', frames: 10, loop: true },
      // Wind-up and release of the bone fan (projectileFan) and the basic throw.
      { id: 'cast_spears', clip: 'Throw', frames: 8, fps: 16, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_A', frames: 8, fps: 12, loop: false },
    ],
  },
  {
    // Ranged caster: earth-brown hood and cape, an axe held two-handed like a digging tool; slams it into the floor
    // to open a grave under the hero.
    id: 'gravedigger',
    model: 'Skeleton_Rogue.glb',
    hide: [],
    attach: [{ model: 'Skeleton_Axe.gltf', bone: 'handslot.r' }],
    tint: [{ meshes: ['Skeleton_Rogue_Hood', 'Skeleton_Rogue_Cape'], color: 0xb08850, brightness: 0.9 }],
    height: 58,
    frameSize: 192,
    originY: 136,
    trim: true,
    anims: [
      { id: 'idle', clip: '2H_Melee_Idle', frames: 8, loop: true },
      { id: 'run', clip: 'Walking_C', frames: 10, loop: true },
      // groundZones wind-up (CAST_ANIMS maps it to cast_summon): the tool comes down on the floor.
      { id: 'cast_summon', clip: '2H_Melee_Attack_Chop', frames: 8, fps: 14, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_A', frames: 8, fps: 12, loop: false },
    ],
  },
  {
    // Summoner: normal-sized Skeleton_Mage, no staff (the boss has a staff and a red hat), violet hat and robe.
    id: 'cultist',
    model: 'Skeleton_Mage.glb',
    hide: [],
    tint: [{ meshes: ['Skeleton_Mage_Hat', 'Skeleton_Mage_Body'], color: 0x9a5cf0 }],
    height: 62,
    frameSize: 192,
    originY: 136,
    trim: true,
    anims: [
      { id: 'idle', clip: 'Idle', frames: 8, loop: true },
      { id: 'run', clip: 'Walking_B', frames: 10, loop: true },
      { id: 'cast_summon', clip: 'Spellcast_Summon', frames: 8, fps: 10, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      { id: 'death', clip: 'Death_A', frames: 8, fps: 12, loop: false },
    ],
  },
  {
    // Boss (docs/design/mobs.md). Baked at its in-game size (normal skeleton 62 px x boss radius scale 1.75)
    // in a bigger, roomy frame (no clipping when it falls or raises the staff), so it is drawn 1:1 instead of
    // being upscaled with nearest filtering. Trimmed atlases keep the large frame cheap in GPU memory.
    id: 'necromancer',
    model: 'Skeleton_Mage.glb',
    hide: [],
    attach: [{ model: 'Skeleton_Staff.gltf', bone: 'handslot.r' }],
    height: 108,
    frameSize: 288,
    originY: 180,
    trim: true,
    nativeScale: 1.75,
    anims: [
      // 2H_Melee_Idle holds the staff across the body; the plain Idle lets it dangle skull-down.
      { id: 'idle', clip: '2H_Melee_Idle', frames: 8, loop: true },
      { id: 'run', clip: 'Walking_A', frames: 10, loop: true },
      // Climbs out of the floor; geometry below the floor is cut so it reads as rising from the ground.
      { id: 'spawn', clip: 'Spawn_Ground_Skeletons', frames: 10, fps: 8, loop: false, clipBelowGround: true },
      { id: 'cast_spears', clip: 'Spellcast_Shoot', frames: 8, fps: 16, loop: false },
      { id: 'cast_summon', clip: 'Spellcast_Summon', frames: 10, fps: 10, loop: false },
      // Staff raised overhead and slammed into the floor.
      { id: 'cast_nova', clip: '2H_Melee_Attack_Chop', frames: 8, fps: 14, loop: false },
      { id: 'hit', clip: 'Hit_A', frames: 4, fps: 20, loop: false },
      // Death_B staggers and collapses forward: slower, reads as a boss death. Death_C_Skeletons has strong
      // root motion (the body slides out of place).
      { id: 'death', clip: 'Death_B', frames: 8, fps: 8, loop: false },
    ],
  },
];

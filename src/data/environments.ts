// Map environments (docs/design/maps.md «Зони»): the look of a zone's rooms. Visual only — render reads these, core
// never does (zones in maps.ts pick an environment id by map level). Colours are 0xRRGGBB.

/** Floor slabs drawn procedurally over a base tile (temple flagstones with grass in the joints). */
export interface SlabLook {
  /** Stone colours a slab picks from (base tint before weathering). */
  readonly stones: readonly number[];
  /** Lit upper edges / shaded lower edges and the slab's visible thickness. */
  readonly highlight: number;
  readonly shade: number;
  /** Cracks and pits. */
  readonly crack: number;
  /** Grass tufts and moss in the joints. */
  readonly grass: readonly number[];
  /** Gold inlay of the rare ornamented slab (one tile in `goldEvery`). */
  readonly gold: number;
  readonly goldEvery: number;
  /** Wash over the ground tiles under the slabs (e.g. sun-dried grass). */
  readonly groundTint?: { readonly color: number; readonly alpha: number };
}

export interface FloorLook {
  /** Texture key and path of the floor tile sheet (192 × 96 frames), loaded with the zone. */
  readonly texture: string;
  readonly path: string;
  /** Frames of plain tiles and of detailed tiles (one tile in `detailEvery` is detailed). */
  readonly plain: readonly number[];
  readonly detail: readonly number[];
  readonly detailEvery: number;
  /** Present: the tiles are only the ground under procedural slabs. */
  readonly slabs?: SlabLook;
}

export interface WallLook {
  readonly top: number;
  readonly bottom: number;
  readonly mortar: number;
  readonly mortarAlpha: number;
  readonly coping: number;
  /** Colour the left (turned away) wall and ledge are shaded towards. */
  readonly shadow: number;
  readonly ledge: number;
  readonly ledgeEdge: number;
  /** Ruins: a broken, uneven top, cracks and ivy. */
  readonly ruined?: { readonly crack: number; readonly ivy: readonly number[] };
}

export interface PillarLook {
  readonly plinth: string;
  /** Shaft gradient, left to right. */
  readonly shaft: readonly [string, string, string, string];
  readonly capital: string;
  readonly capitalInner: string;
  /** Shadow on the ground. */
  readonly shadow: number;
  readonly shadowAlpha: number;
  /** Ruins: some columns are broken off (deterministic per position); a gold band on the whole ones. */
  readonly broken?: { readonly band: string };
}

export interface DoorLook {
  /** Arch stone gradient, left to right. */
  readonly stone: readonly [string, string, string, string];
  readonly passage: string;
  readonly bars: string;
  readonly keystone: string;
  readonly keystoneOpen: string;
  readonly threshold: string;
}

export interface AltarLook {
  /** Top / side of the three steps, bottom to top. */
  readonly steps: readonly (readonly [string, string])[];
  readonly runes: string;
  /** Crystal tint once the altar is spent. */
  readonly spent: number;
}

export interface LightLook {
  /** Camera background and the void beyond the room's edges. */
  readonly background: number;
  /** Alpha and colour of the darkness around the hero's light (0: no overlay at all). */
  readonly darkness: number;
  readonly darknessColor: number;
  /** Glows of doors and altars: additive on dark floors; plain alpha on light ones (additive washes out to white). */
  readonly glowBlend: 'add' | 'normal';
  /** Dark under-stroke of rings on the ground (door zone, altar reach) so they read on a light floor. */
  readonly ringShadow?: { readonly color: number; readonly alpha: number };
  /** Soft shadow on the ground under the hero, mobs and allies (light floors: grounds pale skeletons on pale stone). */
  readonly actorShadow?: { readonly color: number; readonly alpha: number };
  /** CSS colour of a dark halo behind centre-screen announcements (their warm glow washes out on a light floor). */
  readonly textHalo?: string;
}

/**
 * The world beyond the room's edges instead of a flat void: a tileable ground with dunes, half-buried ruin fragments
 * and dry bushes, plus drifts of it creeping over the floor's edges. Counts are per room (around it / along its edges).
 */
export interface OutsideLook {
  readonly sand: number;
  readonly sandLight: number;
  readonly sandShadow: number;
  /** Stone of the fragments: lit, mid, shadow. */
  readonly stone: readonly [number, number, number];
  readonly dryBush: readonly number[];
  readonly dunes: number;
  readonly fragments: number;
  readonly bushes: number;
  /** Sand drifts over the floor per 1000 world units of room edge. */
  readonly drifts: number;
}

/** Small props inside a room with no effect on play (no collision, drawn under every body and ground ring). */
export interface DecorLook {
  /** Props per 1,000,000 square world units of floor. */
  readonly density: number;
  /** World units props keep from the entry, exit, altar, boss spawn and spawn points (and around obstacles). */
  readonly clearance: number;
  readonly bush: readonly number[];
  readonly flowers: readonly number[];
  /** Urns: lit, mid, shadow. */
  readonly terracotta: readonly [number, number, number];
  /** Slanted sun rays over the room, with dust motes drifting in them (no motes with prefers-reduced-motion). */
  readonly rays: { readonly count: number; readonly color: number; readonly alpha: number; readonly motes: number };
}

/**
 * The bedrock a dungeon room is carved into, instead of a flat void: a tileable rock sheet, rough boulders hugging the
 * walls and ledge, stalagmites and a few chasms with a faint glow from the abyss. Counts are per room.
 */
export interface BedrockLook {
  readonly rock: number;
  readonly rockLight: number;
  readonly rockDark: number;
  readonly crack: number;
  readonly boulders: number;
  readonly stalagmites: number;
  readonly chasms: number;
  /** Glow out of the chasms, drawn above the darkness so it is seen from afar (keep it faint). */
  readonly chasmGlow: number;
  readonly chasmGlowAlpha: number;
}

/** A warm light island in the dark (candles, braziers): a soft glow on the floor and a softer one above the darkness. */
export interface FlameLight {
  readonly count: number;
  readonly color: number;
  /** Glow size, multiples of a 64 px dot. */
  readonly scale: number;
  /** Alpha of the glow above the darkness (the floor glow under it is stronger). */
  readonly alpha: number;
}

/** Dungeon props with no effect on play (no collision; under every body, ground ring and floor effect). */
export interface CryptDecorLook {
  /** Small props (bones, skulls, cloth, weapons) per 1,000,000 square world units of floor. */
  readonly density: number;
  /** Flat marks (cracks, puddles) per 1,000,000 square world units. */
  readonly flats: number;
  /** World units props and lights keep from the entry, exit, altar, boss spawn and spawn points. */
  readonly clearance: number;
  readonly bone: number;
  readonly boneShade: number;
  readonly cloth: readonly number[];
  readonly rust: readonly number[];
  readonly web: number;
  readonly puddle: number;
  readonly candles: FlameLight;
  readonly braziers: FlameLight;
  /** Low fog banks along the walls and in corners. */
  readonly fog: { readonly count: number; readonly color: number; readonly alpha: number };
  /** Ghost wisps drifting about (none with prefers-reduced-motion), drawn above the darkness. */
  readonly wisps: { readonly count: number; readonly color: number; readonly alpha: number };
}

export interface EnvironmentLook {
  readonly id: string;
  readonly floor: FloorLook;
  readonly walls: WallLook;
  readonly pillars: PillarLook;
  readonly door: DoorLook;
  readonly altar: AltarLook;
  readonly light: LightLook;
  readonly outside?: OutsideLook;
  readonly decor?: DecorLook;
  readonly bedrock?: BedrockLook;
  readonly crypt?: CryptDecorLook;
}

/** The dark dungeon: the look every map had before zones (Flare dungeon tiles, deep darkness around the hero). */
const crypt: EnvironmentLook = {
  id: 'crypt',
  floor: {
    texture: 'floor',
    path: 'assets/test/floor.png',
    plain: [0, 1, 2, 3, 20, 21, 22, 23],
    detail: [16, 17, 18, 19, 24, 25, 26, 27, 28, 29, 30, 31],
    detailEvery: 5,
  },
  walls: {
    top: 0x3a3340,
    bottom: 0x17141b,
    mortar: 0x0c0a0e,
    mortarAlpha: 0.7,
    coping: 0x6a6070,
    shadow: 0x000000,
    ledge: 0x1d1920,
    ledgeEdge: 0x4a4250,
  },
  pillars: {
    plinth: '#1a171d',
    shaft: ['#2c2732', '#6d6372', '#4b4352', '#1a161e'],
    capital: '#857a8a',
    capitalInner: '#5d5462',
    shadow: 0x000000,
    shadowAlpha: 0.35,
  },
  door: {
    stone: ['#2a252e', '#6a6070', '#4a4250', '#1e1a22'],
    passage: '#0b090d',
    bars: '#6b6470',
    keystone: '#857a8a',
    keystoneOpen: '#f3d58a',
    threshold: '#3a3440',
  },
  altar: {
    steps: [
      ['#4a4250', '#221e27'],
      ['#5a5160', '#2a252e'],
      ['#6d6372', '#332d38'],
    ],
    runes: 'rgba(200,170,255,0.55)',
    spent: 0x4a4450,
  },
  light: { background: 0x07070a, darkness: 0.92, darknessColor: 0x000000, glowBlend: 'add' },
  // Designer decision 2026-10-27 (maps.md «Зони»): the crypt comes alive too — bedrock and chasms outside, bones,
  // candles, braziers, cobwebs, fog and ghost wisps inside. Cold violet abyss glow matches the altar palette.
  bedrock: {
    rock: 0x2b2631,
    rockLight: 0x5a5262,
    rockDark: 0x121016,
    crack: 0x0a080c,
    boulders: 34,
    stalagmites: 12,
    chasms: 3,
    chasmGlow: 0x8a5cff,
    chasmGlowAlpha: 0.15,
  },
  crypt: {
    density: 12,
    flats: 7,
    clearance: 110,
    bone: 0xcfc4ab,
    boneShade: 0x8e8270,
    // Faded, dusty cloth (never red: on the floor it would read as blood, PEGI 12).
    cloth: [0x4f4560, 0x2e2838, 0x6e6280],
    rust: [0x7a4a2a, 0x5e5a58, 0x8c5a32],
    web: 0xd8d4e0,
    puddle: 0x1a2430,
    candles: { count: 3, color: 0xffb050, scale: 2.4, alpha: 0.16 },
    braziers: { count: 2, color: 0xff9a40, scale: 3.6, alpha: 0.22 },
    fog: { count: 7, color: 0x9aa6a8, alpha: 0.12 },
    wisps: { count: 6, color: 0x8affc4, alpha: 0.45 },
  },
};

/**
 * Sunlit temple ruins (designer decision 2026-10-27): light weathered sandstone, grass between the slabs, gold
 * accents, daylight — only a soft warm vignette instead of the darkness, so the game starts in the light.
 * Ground: Flare grassland tiles (assets/LICENSES.md); slabs, walls, columns, door and altar are drawn procedurally.
 */
const temple: EnvironmentLook = {
  id: 'temple',
  floor: {
    texture: 'floor:temple',
    path: 'assets/zones/temple_grass.png',
    plain: [0, 1, 2, 3, 4, 5, 6, 7],
    detail: [],
    detailEvery: 0,
    slabs: {
      stones: [0xdccfb0, 0xd4c5a2, 0xcdbd98, 0xe2d6ba, 0xc8b690],
      highlight: 0xfbf6e8,
      shade: 0x86704c,
      crack: 0x8a7656,
      // Sun-dried tufts: the grass of a place half swallowed by the desert.
      grass: [0x8a9440, 0xa3a452, 0x748236, 0xb3ab60],
      gold: 0xd9a838,
      goldEvery: 67,
      groundTint: { color: 0xc9a865, alpha: 0.28 },
    },
  },
  // Designer decision 2026-10-27 (maps.md «Зони»): sand and dunes beyond the ruins, small props inside the rooms.
  outside: {
    sand: 0xd8b47a,
    sandLight: 0xf0d6a2,
    sandShadow: 0xae8752,
    stone: [0xf1e8d2, 0xd3c4a2, 0x9c8a68],
    dryBush: [0x8a6a3a, 0x9c7c46, 0x6e5530, 0x7d7a3e],
    dunes: 24,
    fragments: 18,
    bushes: 34,
    drifts: 5,
  },
  decor: {
    density: 11,
    clearance: 120,
    bush: [0x5f7f30, 0x76953c, 0x4c6a26],
    flowers: [0xf2d34a, 0xf5f0e0, 0xe0703a, 0xc65a9a],
    terracotta: [0xd9895a, 0xb8683e, 0x7e4326],
    rays: { count: 3, color: 0xfff0c8, alpha: 0.1, motes: 10 },
  },
  walls: {
    top: 0xe6dcc2,
    bottom: 0xb9a888,
    mortar: 0x9a8866,
    mortarAlpha: 0.55,
    coping: 0xf6efdc,
    shadow: 0x5a4630,
    ledge: 0xc9b996,
    ledgeEdge: 0xf3ead2,
    ruined: { crack: 0x7d6a4a, ivy: [0x4f7a2e, 0x6a9638, 0x3f6526] },
  },
  pillars: {
    plinth: '#bfae8c',
    shaft: ['#a8987a', '#f6efdc', '#ddd1b4', '#9c8b6c'],
    capital: '#f8f2e2',
    capitalInner: '#ddd0b2',
    shadow: 0x4a3a20,
    shadowAlpha: 0.3,
    broken: { band: '#d9a838' },
  },
  door: {
    stone: ['#a8987a', '#f3ead4', '#d8cbad', '#9a8a6c'],
    passage: '#2e2416',
    bars: '#b8862e',
    keystone: '#d9a838',
    keystoneOpen: '#ffe08a',
    threshold: '#b3a283',
  },
  altar: {
    // Darker, warmer sandstone than the floor so the altar stands out of it; gold runes.
    steps: [
      ['#b59f76', '#6f5a3c'],
      ['#c7b28a', '#7d6744'],
      ['#d9c7a0', '#8a7350'],
    ],
    runes: 'rgba(240,190,70,1)',
    spent: 0x9a8f80,
  },
  light: {
    background: 0xd8b47a,
    darkness: 0.26,
    darknessColor: 0x2a1a08,
    glowBlend: 'normal',
    ringShadow: { color: 0x2a1c0a, alpha: 0.45 },
    actorShadow: { color: 0x3a2810, alpha: 0.36 },
    textHalo: 'rgba(26,16,6,0.85)',
  },
};

export const environments: Readonly<Record<string, EnvironmentLook>> = { crypt, temple };

/** Used when a map has no zone or names an unknown environment. */
export const DEFAULT_ENVIRONMENT = 'crypt';

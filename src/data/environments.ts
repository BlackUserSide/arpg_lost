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

export interface EnvironmentLook {
  readonly id: string;
  readonly floor: FloorLook;
  readonly walls: WallLook;
  readonly pillars: PillarLook;
  readonly door: DoorLook;
  readonly altar: AltarLook;
  readonly light: LightLook;
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
      grass: [0x6f8f3a, 0x88a646, 0x5c7a30, 0x9cb85a],
      gold: 0xd9a838,
      goldEvery: 67,
    },
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
    background: 0x2a3120,
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

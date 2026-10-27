import * as Phaser from 'phaser';
import { vec, type Vec2 } from '../core/math';
import type { RoomTemplate } from '../core/run/types';
import type { EnvironmentLook, PillarLook, SlabLook } from '../data/environments';
import { softDotTexture } from './fxTextures';
import { css, decorRandom, makeCanvas } from './proceduralArt';
import { CryptDecor } from './cryptDecor';
import { RuinsDecor } from './ruinsDecor';
import { toScreen } from './iso';

// One room of a map run on screen: floor tiles sized to the room, back walls and a front ledge, round pillars (core
// obstacles), the exit door (closed / open) and, in the boss room, the altar with its summoning circle. Everything is
// styled by the zone's environment (src/data/environments.ts): the crypt draws Flare dungeon tiles in darkness, the
// temple ruins draw sunlit flagstones over grass, broken walls with ivy and broken columns.
// Render-only: positions and sizes come from the room template (src/data/maps.ts), states from core run state.

const TILE_WORLD = 68;
const TILE_SCALE = 0.5;
/** Floor tile frame size, texture px. */
const TILE_W = 192;
const TILE_H = 96;

const FLOOR_DEPTH = -100000;
const VOID_DEPTH = -99000;
const WALL_DEPTH = -90000;
/** Above the darkness overlay (depth 5000): glows that must read from across the room. */
const GLOW_DEPTH = 5001;
/** Under actors, above the floor: rings on the ground. */
const GROUND_DEPTH = -1500;

/** Back wall height and front ledge thickness, screen px. */
const WALL_H = 118;
const LEDGE_H = 16;
/** World units of darkness drawn beyond each edge (hides floor tiles that overhang the room). */
const VOID_BAND = 600;
/** Pillar shaft height above its base, screen px. */
const PILLAR_H = 150;

const DOOR_GLOW = 0xffb44a;
const ALTAR_READY = 0xb77bff;
const ALTAR_SUMMON = 0xff4a3a;
/** Glows drawn with plain alpha (light floors) are this much fainter than additive ones. */
const NORMAL_GLOW_ALPHA = 0.6;

/** Slab tile variants generated per environment (two rows of eight); the last one is the gold-inlaid slab. */
const SLAB_VARIANTS = 16;
const GOLD_VARIANT = SLAB_VARIANTS - 1;

export type AltarLook = 'ready' | 'summoning' | 'spent';

export interface RoomFrame {
  /** Hero position on screen (feet). */
  readonly hero: Vec2;
  readonly doorOpen: boolean;
  readonly altar: AltarLook;
  /** The hero stands close enough to wake the altar. */
  readonly altarInRange: boolean;
  /** 0..1 while the boss is being summoned; negative otherwise. */
  readonly summon: number;
}

interface Pillar {
  readonly sprite: Phaser.GameObjects.Image;
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** Graphics point lists want Vector2s (allocated at build time only). */
const pts = (list: readonly Vec2[]): Phaser.Math.Vector2[] => list.map((p) => new Phaser.Math.Vector2(p.x, p.y));

const lerpColor = (a: number, b: number, k: number): number => {
  const c = Phaser.Display.Color.Interpolate.ColorWithColor(Phaser.Display.Color.IntegerToColor(a), Phaser.Display.Color.IntegerToColor(b), 100, Math.round(k * 100));
  return Phaser.Display.Color.GetColor(c.r, c.g, c.b);
};

const tileHash = (i: number, j: number): number => (i * 73856093) ^ (j * 19349663);

/**
 * A stone column of world radius `r` (screen half width r, the base ellipse r × r/2), origin at its base centre.
 * `broken` > 0 (ruins): the shaft ends that fraction lower in a jagged break, without a capital.
 */
function pillarTexture(scene: Phaser.Scene, r: number, envId: string, look: PillarLook, broken: number): { key: string; originY: number } {
  const rx = Math.round(r);
  const ry = Math.round(r / 2);
  const pad = 10;
  const w = rx * 2 + pad * 2;
  const baseY = ry + 6 + PILLAR_H;
  const h = baseY + ry + 8;
  const key = `room:pillar:${envId}:${rx}:${broken}`;
  const originY = baseY / h;
  if (scene.textures.exists(key)) return { key, originY };
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const cx = w / 2;
  const topY = ry + 6 + Math.round(PILLAR_H * broken);
  // Plinth.
  ctx.fillStyle = look.plinth;
  ctx.beginPath();
  ctx.ellipse(cx, baseY, rx + 7, ry + 4, 0, 0, Math.PI * 2);
  ctx.fill();
  const shaft = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  shaft.addColorStop(0, look.shaft[0]);
  shaft.addColorStop(0.3, look.shaft[1]);
  shaft.addColorStop(0.55, look.shaft[2]);
  shaft.addColorStop(1, look.shaft[3]);
  ctx.fillStyle = shaft;
  ctx.fillRect(cx - rx, topY, rx * 2, baseY - topY);
  ctx.beginPath();
  ctx.ellipse(cx, baseY, rx, ry, 0, 0, Math.PI);
  ctx.fill();
  // Flutes.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 2;
  for (const f of [-0.6, -0.2, 0.2, 0.6]) {
    ctx.beginPath();
    ctx.moveTo(cx + f * rx, topY + 10);
    ctx.lineTo(cx + f * rx, baseY - 14);
    ctx.stroke();
  }
  // Bands near the top and the foot.
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 4;
  for (const y of broken > 0 ? [baseY - 18] : [ry + 22, baseY - 18]) {
    ctx.beginPath();
    ctx.ellipse(cx, y, rx, ry, 0, 0, Math.PI);
    ctx.stroke();
  }
  if (broken > 0) {
    // Jagged break: the cut face, its rim chipped unevenly.
    const rand = decorRandom(rx * 31 + Math.round(broken * 1000));
    ctx.fillStyle = look.capitalInner;
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const chip = Math.sin(a) < 0 ? 1 + rand() * 7 : 0;
      const x = cx + Math.cos(a) * rx;
      const y = topY + Math.sin(a) * ry - chip;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // A crack running down from the break.
    ctx.strokeStyle = 'rgba(60,45,25,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let x = cx + (rand() - 0.5) * rx;
    let y = topY + ry;
    ctx.moveTo(x, y);
    for (let i = 0; i < 4; i++) {
      x += (rand() - 0.5) * 10;
      y += 8 + rand() * 10;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else {
    if (look.broken) {
      // Gold band under the capital of a whole column (ruins).
      ctx.strokeStyle = look.broken.band;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(cx, ry + 22, rx, ry, 0, 0, Math.PI);
      ctx.stroke();
    }
    // Capital.
    ctx.fillStyle = look.capital;
    ctx.beginPath();
    ctx.ellipse(cx, ry + 6, rx + 5, ry + 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = look.capitalInner;
    ctx.beginPath();
    ctx.ellipse(cx, ry + 6, rx - 2, ry - 1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  scene.textures.addCanvas(key, canvas);
  return { key, originY };
}

const DOOR_W = 104;
const DOOR_H = 150;
const DOOR_BASE = 140;

/** A stone archway; closed: bars over darkness, open: a glowing passage. Origin at the threshold. */
function doorTexture(scene: Phaser.Scene, env: EnvironmentLook, open: boolean): string {
  const key = `room:door:${env.id}:${open ? 'open' : 'closed'}`;
  if (scene.textures.exists(key)) return key;
  const look = env.door;
  const canvas = document.createElement('canvas');
  canvas.width = DOOR_W;
  canvas.height = DOOR_H;
  const ctx = canvas.getContext('2d')!;
  const cx = DOOR_W / 2;
  const innerL = 26;
  const innerR = DOOR_W - 26;
  const archY = 52;
  // Passage.
  ctx.beginPath();
  ctx.moveTo(innerL, DOOR_BASE);
  ctx.lineTo(innerL, archY);
  ctx.arc(cx, archY, (innerR - innerL) / 2, Math.PI, 0);
  ctx.lineTo(innerR, DOOR_BASE);
  ctx.closePath();
  if (open) {
    const glow = ctx.createRadialGradient(cx, DOOR_BASE - 40, 4, cx, DOOR_BASE - 40, 80);
    glow.addColorStop(0, '#fff3c8');
    glow.addColorStop(0.4, '#ffb04a');
    glow.addColorStop(1, '#6a2a08');
    ctx.fillStyle = glow;
    ctx.fill();
  } else {
    ctx.fillStyle = look.passage;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = look.bars;
    ctx.lineWidth = 4;
    for (let x = innerL + 6; x < innerR; x += 10) {
      ctx.beginPath();
      ctx.moveTo(x, 20);
      ctx.lineTo(x, DOOR_BASE);
      ctx.stroke();
    }
    ctx.lineWidth = 5;
    for (const y of [archY + 10, DOOR_BASE - 30]) {
      ctx.beginPath();
      ctx.moveTo(innerL, y);
      ctx.lineTo(innerR, y);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Posts and arch.
  const stone = ctx.createLinearGradient(0, 0, DOOR_W, 0);
  stone.addColorStop(0, look.stone[0]);
  stone.addColorStop(0.25, look.stone[1]);
  stone.addColorStop(0.75, look.stone[2]);
  stone.addColorStop(1, look.stone[3]);
  ctx.fillStyle = stone;
  ctx.fillRect(6, archY, innerL - 6, DOOR_BASE - archY);
  ctx.fillRect(innerR, archY, DOOR_W - 6 - innerR, DOOR_BASE - archY);
  ctx.beginPath();
  ctx.arc(cx, archY, cx - 6, Math.PI, 0);
  ctx.arc(cx, archY, (innerR - innerL) / 2, 0, Math.PI, true);
  ctx.closePath();
  ctx.fill();
  // Keystone and joints.
  ctx.fillStyle = open ? look.keystoneOpen : look.keystone;
  ctx.fillRect(cx - 7, archY - (cx - 6), 14, 16);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 2;
  for (let y = archY + 18; y < DOOR_BASE; y += 22) {
    ctx.beginPath();
    ctx.moveTo(6, y);
    ctx.lineTo(innerL, y);
    ctx.moveTo(innerR, y);
    ctx.lineTo(DOOR_W - 6, y);
    ctx.stroke();
  }
  // Threshold.
  ctx.fillStyle = look.threshold;
  ctx.fillRect(2, DOOR_BASE - 4, DOOR_W - 4, 10);
  scene.textures.addCanvas(key, canvas);
  return key;
}

const ALTAR_W = 116;
const ALTAR_H = 96;
const ALTAR_BASE = 78;

/** A stepped stone altar with a rune-cut top; the crystal above it is a separate tinted image. */
function altarTexture(scene: Phaser.Scene, env: EnvironmentLook): string {
  const key = `room:altar:${env.id}`;
  if (scene.textures.exists(key)) return key;
  const look = env.altar;
  const canvas = document.createElement('canvas');
  canvas.width = ALTAR_W;
  canvas.height = ALTAR_H;
  const ctx = canvas.getContext('2d')!;
  const cx = ALTAR_W / 2;
  const slab = (y: number, rx: number, ry: number, h: number, top: string, side: string): void => {
    ctx.fillStyle = side;
    ctx.beginPath();
    ctx.moveTo(cx - rx, y - h);
    ctx.lineTo(cx, y - h + ry);
    ctx.lineTo(cx + rx, y - h);
    ctx.lineTo(cx + rx, y);
    ctx.lineTo(cx, y + ry);
    ctx.lineTo(cx - rx, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(cx, y - h - ry);
    ctx.lineTo(cx + rx, y - h);
    ctx.lineTo(cx, y - h + ry);
    ctx.lineTo(cx - rx, y - h);
    ctx.closePath();
    ctx.fill();
  };
  const [s0, s1, s2] = look.steps;
  if (s0) slab(ALTAR_BASE, 56, 22, 12, s0[0], s0[1]);
  if (s1) slab(ALTAR_BASE - 14, 40, 16, 12, s1[0], s1[1]);
  if (s2) slab(ALTAR_BASE - 28, 24, 10, 22, s2[0], s2[1]);
  // Runes on the front faces.
  ctx.strokeStyle = look.runes;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 14, ALTAR_BASE - 40);
  ctx.lineTo(cx - 8, ALTAR_BASE - 30);
  ctx.lineTo(cx - 14, ALTAR_BASE - 22);
  ctx.moveTo(cx + 14, ALTAR_BASE - 40);
  ctx.lineTo(cx + 8, ALTAR_BASE - 30);
  ctx.lineTo(cx + 14, ALTAR_BASE - 22);
  ctx.stroke();
  scene.textures.addCanvas(key, canvas);
  return key;
}

/** White faceted crystal (tinted per altar state). */
function crystalTexture(scene: Phaser.Scene): string {
  const key = 'room:crystal';
  if (scene.textures.exists(key)) return key;
  const canvas = document.createElement('canvas');
  canvas.width = 28;
  canvas.height = 44;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(27, 18);
  ctx.lineTo(14, 44);
  ctx.lineTo(1, 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(27, 18);
  ctx.lineTo(14, 44);
  ctx.closePath();
  ctx.fill();
  scene.textures.addCanvas(key, canvas);
  return key;
}

/** Point of a floor tile frame at tile-local world fractions (u along world x, v along world y), texture px. */
const tilePoint = (ox: number, oy: number, u: number, v: number): Vec2 => vec(ox + TILE_W / 2 + (u - v) * (TILE_W / 2), oy + (u + v) * (TILE_H / 2));

/** A tuft of grass blades rising from (x, y) on a tile canvas. */
function grassTuft(ctx: CanvasRenderingContext2D, rand: () => number, look: SlabLook, x: number, y: number, size: number): void {
  const blades = 4 + Math.floor(rand() * 5);
  ctx.lineCap = 'round';
  for (let b = 0; b < blades; b++) {
    const color = look.grass[Math.floor(rand() * look.grass.length)] ?? 0x6f8f3a;
    const bx = x + (rand() - 0.5) * size * 1.4;
    const len = size * (0.6 + rand() * 0.8);
    const lean = (rand() - 0.5) * size;
    ctx.strokeStyle = css(color, 0.95);
    ctx.lineWidth = 1.6 + rand();
    ctx.beginPath();
    ctx.moveTo(bx, y);
    ctx.quadraticCurveTo(bx + lean * 0.3, y - len * 0.6, bx + lean, y - len);
    ctx.stroke();
  }
}

/**
 * Sunlit flagstones over the zone's ground tiles: SLAB_VARIANTS frames of TILE_W × TILE_H in one canvas texture.
 * Variants: one whole slab, 2 × 2 or 1 × 2 slabs, a missing slab grown over, a cracked slab and a gold-inlaid one.
 */
function slabTileTexture(scene: Phaser.Scene, env: EnvironmentLook, look: SlabLook): string {
  const key = `room:slabs:${env.id}`;
  if (scene.textures.exists(key)) return key;
  const cols = 8;
  const canvas = document.createElement('canvas');
  canvas.width = TILE_W * cols;
  canvas.height = TILE_H * Math.ceil(SLAB_VARIANTS / cols);
  const ctx = canvas.getContext('2d')!;
  const ground = scene.textures.get(env.floor.texture);
  const groundImage = ground.getSourceImage() as CanvasImageSource;
  const groundFrames = env.floor.plain;
  for (let n = 0; n < SLAB_VARIANTS; n++) {
    const ox = (n % cols) * TILE_W;
    const oy = Math.floor(n / cols) * TILE_H;
    const rand = decorRandom(0x9e3779b9 ^ (n * 2654435761));
    // Ground under the slabs.
    const gf = ground.get(groundFrames[n % Math.max(1, groundFrames.length)] ?? 0);
    ctx.drawImage(groundImage, gf.cutX, gf.cutY, gf.cutWidth, gf.cutHeight, ox, oy, TILE_W, TILE_H);
    ctx.save();
    ctx.beginPath();
    const diamond = [tilePoint(ox, oy, 0, 0), tilePoint(ox, oy, 1, 0), tilePoint(ox, oy, 1, 1), tilePoint(ox, oy, 0, 1)];
    diamond.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
    if (look.groundTint) {
      ctx.fillStyle = css(look.groundTint.color, look.groundTint.alpha);
      ctx.fillRect(ox, oy, TILE_W, TILE_H);
    }
    // Layout of slabs in tile fractions [u0, v0, u1, v1].
    // Mostly whole flagstones (they read calmer under a crowd), some halves and quarters, two grown-over gaps.
    const quarters: [number, number, number, number][] = [[0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5], [0, 0.5, 0.5, 1], [0.5, 0.5, 1, 1]];
    const missing = n === 12 || n === 13 ? n - 11 : -1;
    let cells: [number, number, number, number][];
    if (n < 7 || n === 14 || n === GOLD_VARIANT) cells = [[0, 0, 1, 1]];
    else if (n < 9) cells = [[0, 0, 0.5, 1], [0.5, 0, 1, 1]];
    else if (n === 9) cells = [[0, 0, 1, 0.5], [0, 0.5, 1, 1]];
    else if (n < 12) cells = quarters;
    else cells = quarters.filter((_, i) => i !== missing);
    const gap = 0.016;
    const tufts: Vec2[] = [];
    for (const [u0, v0, u1, v1] of cells) {
      const j = (): number => (rand() - 0.5) * 0.02;
      const corners = [
        tilePoint(ox, oy, u0 + gap + j(), v0 + gap + j()),
        tilePoint(ox, oy, u1 - gap + j(), v0 + gap + j()),
        tilePoint(ox, oy, u1 - gap + j(), v1 - gap + j()),
        tilePoint(ox, oy, u0 + gap + j(), v1 - gap + j()),
      ];
      const path = (dy: number): void => {
        ctx.beginPath();
        corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y + dy) : ctx.lineTo(p.x, p.y + dy)));
        ctx.closePath();
      };
      // Thickness: the slab's lower faces show under its top.
      ctx.fillStyle = css(look.shade);
      path(3);
      ctx.fill();
      const stone = look.stones[Math.floor(rand() * look.stones.length)] ?? 0xe2d5b6;
      ctx.fillStyle = css(stone);
      path(0);
      ctx.fill();
      // Weathering inside the slab: soft blotches and speckle.
      ctx.save();
      path(0);
      ctx.clip();
      const c = tilePoint(ox, oy, (u0 + u1) / 2, (v0 + v1) / 2);
      const span = (u1 - u0 + v1 - v0) * TILE_W * 0.25;
      for (let b = 0; b < 4; b++) {
        const bx = c.x + (rand() - 0.5) * span * 1.4;
        const by = c.y + (rand() - 0.5) * span * 0.7;
        const br = span * (0.25 + rand() * 0.4);
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        const dark = rand() < 0.6;
        g.addColorStop(0, dark ? css(look.crack, 0.16) : css(look.highlight, 0.3));
        g.addColorStop(1, dark ? css(look.crack, 0) : css(look.highlight, 0));
        ctx.fillStyle = g;
        ctx.fillRect(bx - br, by - br, br * 2, br * 2);
      }
      for (let s = 0; s < 70; s++) {
        ctx.fillStyle = rand() < 0.5 ? css(look.crack, 0.18) : css(look.highlight, 0.35);
        ctx.fillRect(c.x + (rand() - 0.5) * span * 2, c.y + (rand() - 0.5) * span, 1 + rand() * 2, 1 + rand());
      }
      // Moss creeping in from an edge, now and then.
      if (rand() < 0.3) {
        const e = corners[Math.floor(rand() * 4)]!;
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, span * 0.6);
        g.addColorStop(0, css(look.grass[0] ?? 0x6f8f3a, 0.45));
        g.addColorStop(1, css(look.grass[0] ?? 0x6f8f3a, 0));
        ctx.fillStyle = g;
        ctx.fillRect(e.x - span, e.y - span, span * 2, span * 2);
      }
      // Cracks.
      if (n === 14 || rand() < 0.12) {
        const lines = n === 14 ? 2 : 1;
        for (let k = 0; k < lines; k++) {
          // From an edge towards the far side, wandering a little.
          const from = corners[Math.floor(rand() * 4)]!;
          let x = from.x + (c.x - from.x) * 0.15;
          let y = from.y + (c.y - from.y) * 0.15;
          const dx = (c.x - from.x) / 3;
          const dy = (c.y - from.y) / 3;
          ctx.strokeStyle = css(look.crack, 0.5);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, y);
          for (let s = 0; s < 4; s++) {
            x += dx + (rand() - 0.5) * span * 0.15;
            y += dy + (rand() - 0.5) * span * 0.08;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
      // Lit upper edges, shaded lower edges.
      const [a, b, d, e] = corners as [Vec2, Vec2, Vec2, Vec2];
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = css(look.highlight, 0.6);
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = css(look.shade, 0.45);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(d.x, d.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      if (rand() < 0.45) tufts.push(corners[Math.floor(rand() * 4)]!);
    }
    if (n === GOLD_VARIANT) {
      // Gold sun inlay in the middle of the slab (the temple's accent).
      const c = tilePoint(ox, oy, 0.5, 0.5);
      ctx.strokeStyle = css(look.shade, 0.6);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + 1, 34, 17, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = css(look.gold, 0.85);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 34, 17, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = css(look.gold, 0.9);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 10, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      for (let r = 0; r < 8; r++) {
        const ang = (r * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(c.x + Math.cos(ang) * 15, c.y + Math.sin(ang) * 7.5);
        ctx.lineTo(c.x + Math.cos(ang) * 27, c.y + Math.sin(ang) * 13.5);
        ctx.stroke();
      }
    }
    // Grass in the joints, and over a missing slab.
    if (missing >= 0) tufts.push(tilePoint(ox, oy, 0.25 + 0.5 * (missing % 2), 0.25 + 0.5 * Math.floor(missing / 2)));
    if (rand() < 0.6) tufts.push(tilePoint(ox, oy, rand() < 0.5 ? 0 : 1, rand()));
    for (const t of tufts) grassTuft(ctx, rand, look, t.x, t.y, 9);
    ctx.restore();
  }
  const texture = scene.textures.addCanvas(key, canvas)!;
  for (let n = 0; n < SLAB_VARIANTS; n++) texture.add(n, 0, (n % cols) * TILE_W, Math.floor(n / cols) * TILE_H, TILE_W, TILE_H);
  return key;
}

/** Whole-slab frames a cut edge tile is made from. */
const PARTIAL_VARIANTS = 4;

/**
 * Frame `frame` of floor texture `texture` cut to the part of its cell inside the room (tile-local world fractions
 * `fu` along x, `fv` along y): the room's last row / column when its size is not a whole number of tiles.
 */
function partialTileTexture(scene: Phaser.Scene, texture: string, frame: number, fu: number, fv: number): string {
  const ku = Math.round(fu * 100);
  const kv = Math.round(fv * 100);
  const key = `room:part:${texture}:${frame}:${ku}:${kv}`;
  if (scene.textures.exists(key)) return key;
  const { canvas, ctx } = makeCanvas(TILE_W, TILE_H);
  const corners = [tilePoint(0, 0, 0, 0), tilePoint(0, 0, ku / 100, 0), tilePoint(0, 0, ku / 100, kv / 100), tilePoint(0, 0, 0, kv / 100)];
  ctx.beginPath();
  corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.clip();
  const source = scene.textures.get(texture);
  const f = source.get(frame);
  ctx.drawImage(source.getSourceImage() as CanvasImageSource, f.cutX, f.cutY, f.cutWidth, f.cutHeight, 0, 0, TILE_W, TILE_H);
  scene.textures.addCanvas(key, canvas);
  return key;
}

export class RoomView {
  private objects: Phaser.GameObjects.GameObject[] = [];
  private pillars: Pillar[] = [];
  private door: { sprite: Phaser.GameObjects.Image; glow: Phaser.GameObjects.Image; x: number; y: number; open: boolean } | undefined;
  private altar: { crystal: Phaser.GameObjects.Image; glow: Phaser.GameObjects.Image; x: number; y: number } | undefined;
  private bossSpawn: Vec2 | undefined;
  /** Rings on the floor (door pass zone, altar reach); drawn above the darkness so they read from afar. */
  private readonly rings: Phaser.GameObjects.Graphics;
  /** Summoning circle on the floor. */
  private readonly circle: Phaser.GameObjects.Graphics;
  private doorRadius = 0;
  private altarRadius = 0;
  private time = 0;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private env!: EnvironmentLook;
  /** Alpha factor of door / altar glows (plain-alpha glows on light floors are fainter). */
  private glowAlpha = 1;

  /** Open-air environments: the land beyond the room, floor props and sun rays. */
  private readonly decor: RuinsDecor;
  /** Dungeon environments: the bedrock beyond the room, props, lights, fog and wisps. */
  private readonly cryptDecor: CryptDecor;

  constructor(private readonly scene: Phaser.Scene) {
    this.rings = scene.add.graphics().setDepth(GLOW_DEPTH);
    this.circle = scene.add.graphics().setDepth(GROUND_DEPTH);
    this.decor = new RuinsDecor(scene);
    this.cryptDecor = new CryptDecor(scene);
  }

  /** Replaces whatever room was shown with template `t`, in the look of environment `env`. */
  build(t: RoomTemplate, doorRadius: number, altarRadius: number, env: EnvironmentLook): void {
    this.clear();
    this.env = env;
    this.doorRadius = doorRadius;
    this.altarRadius = altarRadius;
    const blend = env.light.glowBlend === 'add' ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL;
    this.glowAlpha = env.light.glowBlend === 'add' ? 1 : NORMAL_GLOW_ALPHA;
    this.buildFloor(t.width, t.height);
    this.buildWalls(t.width, t.height);
    this.decor.build(t, env);
    this.cryptDecor.build(t, env);
    for (const o of t.obstacles ?? []) {
      // Ruins: about half the columns are broken off at a height picked by their position.
      const h = Math.abs(tileHash(Math.round(o.pos.x), Math.round(o.pos.y)));
      const broken = env.pillars.broken && h % 2 === 0 ? [0.35, 0.5, 0.62][(h >> 2) % 3]! : 0;
      const tex = pillarTexture(this.scene, o.radius, env.id, env.pillars, broken);
      const s = toScreen(o.pos);
      const shadow = this.scene.add.ellipse(s.x + 8, s.y + 4, o.radius * 2.4, o.radius * 1.2, env.pillars.shadow, env.pillars.shadowAlpha).setDepth(GROUND_DEPTH);
      const sprite = this.scene.add.image(s.x, s.y, tex.key).setOrigin(0.5, tex.originY).setDepth(s.y);
      this.objects.push(shadow, sprite);
      this.pillars.push({ sprite, x: s.x, y: s.y, r: o.radius });
    }
    if (t.kind === 'combat') {
      const s = toScreen(t.exit);
      const sprite = this.scene.add.image(s.x, s.y, doorTexture(this.scene, env, false)).setOrigin(0.5, DOOR_BASE / DOOR_H).setDepth(s.y);
      const glow = this.scene.add.image(s.x, s.y - 50, softDotTexture(this.scene)).setTint(DOOR_GLOW).setBlendMode(blend).setScale(3.4, 4).setDepth(GLOW_DEPTH).setAlpha(0);
      this.objects.push(sprite, glow);
      this.door = { sprite, glow, x: s.x, y: s.y, open: false };
    } else {
      const s = toScreen(t.altar);
      const stone = this.scene.add.image(s.x, s.y, altarTexture(this.scene, env)).setOrigin(0.5, ALTAR_BASE / ALTAR_H).setDepth(s.y);
      const crystal = this.scene.add.image(s.x, s.y - 70, crystalTexture(this.scene)).setDepth(s.y + 1);
      const glow = this.scene.add.image(s.x, s.y - 66, softDotTexture(this.scene)).setTint(ALTAR_READY).setBlendMode(blend).setScale(2.4).setDepth(GLOW_DEPTH);
      this.objects.push(stone, crystal, glow);
      this.altar = { crystal, glow, x: s.x, y: s.y };
      this.bossSpawn = toScreen(t.bossSpawn);
    }
    const left = toScreen(vec(0, t.height)).x;
    const right = toScreen(vec(t.width, 0)).x;
    const bottom = toScreen(vec(t.width, t.height)).y;
    this.bounds = { x: left - 200, y: -WALL_H - 160, width: right - left + 400, height: bottom + WALL_H + 360 };
  }

  /** Camera bounds of the room, screen px. */
  cameraBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds;
  }

  /** Screen position of the door (its threshold), if the room has one. */
  doorScreen(): Vec2 | undefined {
    return this.door ? vec(this.door.x, this.door.y) : undefined;
  }

  /** The door swings open: a flash and the glowing passage. */
  openDoor(): void {
    const door = this.door;
    if (!door || door.open) return;
    door.open = true;
    door.sprite.setTexture(doorTexture(this.scene, this.env, true));
    const flash = this.scene.add.image(door.x, door.y - 50, softDotTexture(this.scene)).setTint(0xfff0c0).setBlendMode(Phaser.BlendModes.ADD).setScale(2).setDepth(GLOW_DEPTH);
    this.scene.tweens.add({ targets: flash, scale: 9, alpha: 0, duration: 650, ease: 'Cubic.easeOut', onComplete: () => flash.destroy() });
  }

  /** The boss rises: a burst over the summoning circle. */
  bossRises(): void {
    const at = this.bossSpawn;
    if (!at) return;
    const burst = this.scene.add.image(at.x, at.y - 30, softDotTexture(this.scene)).setTint(ALTAR_SUMMON).setBlendMode(Phaser.BlendModes.ADD).setScale(2).setDepth(GLOW_DEPTH);
    this.scene.tweens.add({ targets: burst, scale: 14, alpha: 0, duration: 800, ease: 'Cubic.easeOut', onComplete: () => burst.destroy() });
    const ring = this.scene.add.ellipse(at.x, at.y, 60, 30).setStrokeStyle(5, ALTAR_SUMMON, 1).setDepth(GLOW_DEPTH);
    this.scene.tweens.add({ targets: ring, scaleX: 8, scaleY: 8, alpha: 0, duration: 700, ease: 'Cubic.easeOut', onComplete: () => ring.destroy() });
  }

  update(dt: number, f: RoomFrame): void {
    this.time += dt;
    this.decor.update(dt);
    this.cryptDecor.update(dt);
    const rings = this.rings.clear();
    const door = this.door;
    if (door) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
      door.glow.setAlpha(door.open ? (0.35 + 0.25 * pulse) * this.glowAlpha : 0);
      if (door.open) {
        this.ringShadow(door.x, door.y, this.doorRadius, 3);
        rings.lineStyle(3, DOOR_GLOW, 0.45 + 0.4 * pulse).strokeEllipse(door.x, door.y, this.doorRadius * 2, this.doorRadius);
        rings.lineStyle(1, 0xfff0c0, 0.3 * pulse).strokeEllipse(door.x, door.y, this.doorRadius * 2.6, this.doorRadius * 1.3);
      }
    }
    const altar = this.altar;
    if (altar) {
      const ready = f.altar === 'ready';
      const color = f.altar === 'summoning' ? ALTAR_SUMMON : ALTAR_READY;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * (f.altar === 'summoning' ? 12 : 3));
      altar.crystal.setTint(f.altar === 'spent' ? this.env.altar.spent : color).setY(altar.y - 72 - (f.altar === 'spent' ? 0 : 4 * Math.sin(this.time * 2)));
      altar.glow.setTint(color).setAlpha(f.altar === 'spent' ? 0 : ((f.altarInRange ? 0.7 : 0.4) + 0.3 * pulse) * this.glowAlpha);
      if (ready) {
        // Reach of the altar: the prompt appears inside this ring.
        const width = f.altarInRange ? 3 : 2;
        this.ringShadow(altar.x, altar.y, this.altarRadius, width);
        rings.lineStyle(width, ALTAR_READY, (f.altarInRange ? 0.75 : 0.35) + 0.2 * pulse).strokeEllipse(altar.x, altar.y, this.altarRadius * 2, this.altarRadius);
      }
    }
    this.drawSummoning(f.summon);
    // A pillar between the camera and the hero turns see-through.
    for (const p of this.pillars) {
      const behind = f.hero.y < p.y && f.hero.y > p.y - PILLAR_H - 20 && Math.abs(f.hero.x - p.x) < p.r + 24;
      p.sprite.setAlpha(behind ? 0.45 : 1);
    }
  }

  /** Light floors: a dark band under a ground ring of world radius `r` so its colour reads on pale stone. */
  private ringShadow(x: number, y: number, r: number, width: number): void {
    const shadow = this.env.light.ringShadow;
    if (!shadow) return;
    this.rings.lineStyle(width + 4, shadow.color, shadow.alpha).strokeEllipse(x, y, r * 2, r);
  }

  /** Rune circle growing at the boss spawn while the altar summons (progress 0..1). */
  private drawSummoning(progress: number): void {
    const g = this.circle.clear();
    const at = this.bossSpawn;
    if (!at || progress < 0) return;
    const r = 40 + 90 * Math.min(1, progress * 1.4);
    const spin = this.time * 2.2;
    g.fillStyle(ALTAR_SUMMON, 0.12 + 0.2 * progress).fillEllipse(at.x, at.y, r * 2, r);
    g.lineStyle(3, ALTAR_SUMMON, 0.5 + 0.5 * progress).strokeEllipse(at.x, at.y, r * 2, r);
    g.lineStyle(2, 0xffb0a0, 0.6).strokeEllipse(at.x, at.y, r * 1.4, r * 0.7);
    // Rune spokes.
    for (let i = 0; i < 6; i++) {
      const a = spin + (i * Math.PI) / 3;
      g.lineBetween(at.x + Math.cos(a) * r * 0.7, at.y + Math.sin(a) * r * 0.35, at.x + Math.cos(a) * r, at.y + Math.sin(a) * r * 0.5);
    }
  }

  private buildFloor(width: number, height: number): void {
    const floor = this.env.floor;
    const slabs = floor.slabs;
    const texture = slabs ? slabTileTexture(this.scene, this.env, slabs) : floor.texture;
    const cols = Math.ceil(width / TILE_WORLD);
    const rows = Math.ceil(height / TILE_WORLD);
    const landOutside = this.env.outside !== undefined || this.env.bedrock !== undefined;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const hash = tileHash(i, j);
        let frame: number;
        if (slabs) {
          frame = Math.abs(hash) % slabs.goldEvery === 0 ? GOLD_VARIANT : Math.abs(hash >> 3) % GOLD_VARIANT;
        } else {
          const pool = floor.detail.length > 0 && Math.abs(hash) % floor.detailEvery === 0 ? floor.detail : floor.plain;
          frame = pool[Math.abs(hash >> 3) % pool.length] ?? 0;
        }
        const p = toScreen(vec((i + 0.5) * TILE_WORLD, (j + 0.5) * TILE_WORLD));
        // Land beyond the room (sand, bedrock): nothing covers it, so the last row / column of tiles is cut at the edge.
        const fu = Math.min(1, width / TILE_WORLD - i);
        const fv = Math.min(1, height / TILE_WORLD - j);
        if (landOutside && (fu < 1 || fv < 1)) {
          const part = partialTileTexture(this.scene, texture, Math.abs(hash >> 3) % PARTIAL_VARIANTS, fu, fv);
          this.objects.push(this.scene.add.image(p.x, p.y, part).setScale(TILE_SCALE).setDepth(FLOOR_DEPTH));
          continue;
        }
        this.objects.push(this.scene.add.image(p.x, p.y, texture, frame).setScale(TILE_SCALE).setDepth(FLOOR_DEPTH));
      }
    }
    if (landOutside) return;
    // Tiles overhang the room edges by up to a tile: darkness over everything outside.
    const v = VOID_BAND;
    const g = this.scene.add.graphics().setDepth(VOID_DEPTH).fillStyle(this.env.light.background, 1);
    const quad = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): void => {
      g.fillPoints(pts([a, b, c, d].map((p) => toScreen(p))), true);
    };
    quad(vec(-v, -v), vec(width + v, -v), vec(width + v, 0), vec(-v, 0));
    quad(vec(-v, -v), vec(0, -v), vec(0, height + v), vec(-v, height + v));
    quad(vec(width, -v), vec(width + v, -v), vec(width + v, height + v), vec(width, height + v));
    quad(vec(-v, height), vec(width + v, height), vec(width + v, height + v), vec(-v, height + v));
    this.objects.push(g);
  }

  /** Brick walls on the two back edges, a stone ledge on the two front edges. */
  private buildWalls(width: number, height: number): void {
    const look = this.env.walls;
    const g = this.scene.add.graphics().setDepth(WALL_DEPTH);
    const top = toScreen(vec(0, 0));
    const right = toScreen(vec(width, 0));
    const left = toScreen(vec(0, height));
    const bottom = toScreen(vec(width, height));
    const wall = (a: Vec2, b: Vec2, shade: number, along: number): void => {
      if (look.ruined) {
        this.ruinedWall(g, a, b, shade, along);
        return;
      }
      const bands = 8;
      for (let i = 0; i < bands; i++) {
        const y0 = (WALL_H * i) / bands;
        const y1 = (WALL_H * (i + 1)) / bands;
        g.fillStyle(lerpColor(lerpColor(look.top, look.bottom, i / (bands - 1)), look.shadow, shade), 1);
        g.fillPoints(pts([vec(a.x, a.y - y1), vec(b.x, b.y - y1), vec(b.x, b.y - y0), vec(a.x, a.y - y0)]), true);
      }
      // Mortar: courses parallel to the floor edge, staggered joints.
      g.lineStyle(1, look.mortar, look.mortarAlpha);
      const course = 18;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      for (let row = 0, y = course; y < WALL_H; y += course, row++) {
        g.lineBetween(a.x, a.y - y, b.x, b.y - y);
        for (let d = (row % 2) * (along / 2); d < len; d += along) {
          g.lineBetween(a.x + ux * d, a.y + uy * d - y, a.x + ux * d, a.y + uy * d - y + course);
        }
      }
      // Lighter coping on top, dark skirting at the foot.
      g.fillStyle(look.coping, 1 - shade).fillPoints(pts([vec(a.x, a.y - WALL_H - 6), vec(b.x, b.y - WALL_H - 6), vec(b.x, b.y - WALL_H), vec(a.x, a.y - WALL_H)]), true);
      g.fillStyle(look.shadow, 0.45).fillPoints(pts([vec(a.x, a.y - 8), vec(b.x, b.y - 8), vec(b.x, b.y), vec(a.x, a.y)]), true);
    };
    wall(top, right, 0, 46);
    wall(top, left, 0.3, 46);
    const ledge = (a: Vec2, b: Vec2, shade: number): void => {
      g.fillStyle(lerpColor(look.ledge, look.shadow, shade), 1).fillPoints(pts([a, b, vec(b.x, b.y + LEDGE_H), vec(a.x, a.y + LEDGE_H)]), true);
      g.lineStyle(2, look.ledgeEdge, 0.8).lineBetween(a.x, a.y, b.x, b.y);
    };
    ledge(right, bottom, 0);
    ledge(left, bottom, 0.3);
    this.objects.push(g);
  }

  /**
   * A ruined wall from `a` to `b`: a brick wall whose top line is broken down in places (bands and mortar end at the
   * broken profile, so the land behind shows through the breaks), a pale coping along the profile, rubble under the
   * breaks, cracks and ivy hanging from the top.
   */
  private ruinedWall(g: Phaser.GameObjects.Graphics, a: Vec2, b: Vec2, shade: number, along: number): void {
    const look = this.env.walls;
    const ruin = look.ruined!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const rand = decorRandom(Math.round(len * 7 + shade * 1000));
    const at = (d: number, h: number): Vec2 => vec(a.x + ux * d, a.y + uy * d - h);
    // Broken top profile: wall height at every half block; breaks are dips of a few points, ragged inside.
    const step = along / 2;
    const count = Math.ceil(len / step);
    const dist: number[] = [];
    const profile: number[] = [];
    for (let k = 0; k <= count; k++) {
      dist.push(Math.min(len, k * step));
      profile.push(WALL_H);
    }
    for (let k = 1; k < count - 1; k++) {
      if (rand() > 0.16) continue;
      const width = 2 + Math.floor(rand() * 5);
      const depth = 22 + rand() * 58;
      for (let i = 0; i <= width && k + i < count; i++) {
        const dip = Math.sin((Math.PI * i) / width) * depth + (i > 0 && i < width ? (rand() - 0.5) * 14 : 0);
        profile[k + i] = Math.min(profile[k + i]!, WALL_H - Math.max(0, dip));
      }
      k += width + 1;
    }
    const heightAt = (d: number): number => {
      const k = Math.min(count - 1, Math.floor(d / step));
      const t = Math.min(1, Math.max(0, (d - dist[k]!) / Math.max(1e-6, dist[k + 1]! - dist[k]!)));
      return profile[k]! + (profile[k + 1]! - profile[k]!) * t;
    };
    // Bands (the crypt's gradient) per profile segment, each band cut by the sloped top of its segment.
    const bands = 8;
    const course = 18;
    for (let k = 0; k < count; k++) {
      const d0 = dist[k]!;
      const d1 = dist[k + 1]!;
      const h0 = profile[k]!;
      const h1 = profile[k + 1]!;
      for (let i = 0; i < bands; i++) {
        const y0 = (WALL_H * i) / bands;
        if (y0 >= Math.max(h0, h1)) break;
        const y1 = (WALL_H * (i + 1)) / bands;
        const t0 = Math.max(y0, Math.min(y1, h0));
        const t1 = Math.max(y0, Math.min(y1, h1));
        g.fillStyle(lerpColor(lerpColor(look.top, look.bottom, i / (bands - 1)), look.shadow, shade), 1);
        g.fillPoints(pts([at(d0, t0), at(d1, t1), at(d1, y0), at(d0, y0)]), true);
      }
    }
    // Mortar: courses up to the profile, staggered joints where the course above still stands.
    g.lineStyle(1, look.mortar, look.mortarAlpha);
    for (let row = 0, y = course; y < WALL_H; y += course, row++) {
      for (let k = 0; k < count; k++) {
        const d0 = dist[k]!;
        const d1 = dist[k + 1]!;
        const h0 = profile[k]!;
        const h1 = profile[k + 1]!;
        if (h0 <= y && h1 <= y) continue;
        // The part of the segment where the wall still reaches this course.
        const cut = h0 === h1 ? 0 : (y - h0) / (h1 - h0);
        const from = h0 > y ? d0 : d0 + (d1 - d0) * cut;
        const to = h1 > y ? d1 : d0 + (d1 - d0) * cut;
        const p0 = at(from, y);
        const p1 = at(to, y);
        g.lineBetween(p0.x, p0.y, p1.x, p1.y);
      }
      for (let d = (row % 2) * (along / 2); d < len; d += along) {
        if (heightAt(d) < y) continue;
        const q = at(d, y);
        g.lineBetween(q.x, q.y, q.x, q.y + course);
      }
    }
    // Coping along the profile; rubble under deep breaks.
    for (let k = 0; k < count; k++) {
      const d0 = dist[k]!;
      const d1 = dist[k + 1]!;
      const h0 = profile[k]!;
      const h1 = profile[k + 1]!;
      g.fillStyle(look.coping, 1 - shade * 0.6).fillPoints(pts([at(d0, h0 + 5), at(d1, h1 + 5), at(d1, h1), at(d0, h0)]), true);
      if (Math.min(h0, h1) < WALL_H - 30 && rand() < 0.7) {
        // Rubble at the foot of a deep break.
        const foot = at(d0 + rand() * (d1 - d0), 0);
        g.fillStyle(lerpColor(look.top, look.shadow, 0.15 + shade), 1).fillEllipse(foot.x, foot.y + 4, 12 + rand() * 10, 5 + rand() * 3);
      }
    }
    // Cracks running down from the top.
    for (let d = rand() * along * 2; d < len; d += along * (1.5 + rand() * 2.5)) {
      g.lineStyle(1.5, ruin.crack, 0.6);
      let x = d;
      let y = heightAt(d) - 3;
      for (let s = 0; s < 4 && y > 12; s++) {
        const nx = x + (rand() - 0.5) * 14;
        const ny = y - 10 - rand() * 14;
        const p0 = at(x, y);
        const p1 = at(nx, ny);
        g.lineBetween(p0.x, p0.y, p1.x, p1.y);
        x = nx;
        y = ny;
      }
    }
    // Ivy: leafy clumps on the top with strands hanging from them.
    for (let d = rand() * along * 2; d < len - 10; d += along * (1.2 + rand() * 2.8)) {
      const top = heightAt(d);
      const leaf = (x: number, h: number, r: number): void => {
        const color = ruin.ivy[Math.floor(rand() * ruin.ivy.length)] ?? 0x4f7a2e;
        const p = at(x, h);
        g.fillStyle(lerpColor(color, look.shadow, shade * 0.5), 1).fillCircle(p.x + (rand() - 0.5) * 5, p.y, r);
      };
      for (let i = 0; i < 7; i++) leaf(d + (rand() - 0.5) * 22, top + 1 - rand() * 8, 2.5 + rand() * 2);
      const strands = 1 + Math.floor(rand() * 3);
      for (let s = 0; s < strands; s++) {
        let x = d + (rand() - 0.5) * 18;
        const drop = 16 + rand() * Math.min(64, top - 12);
        for (let y = 0; y < drop; y += 4) {
          x += (rand() - 0.5) * 3;
          leaf(x, top - y, 1.8 + rand() * 1.6);
        }
      }
    }
    // Soft shade at the foot.
    g.fillStyle(look.shadow, 0.3).fillPoints(pts([vec(a.x, a.y - 8), vec(b.x, b.y - 8), vec(b.x, b.y), vec(a.x, a.y)]), true);
  }

  clear(): void {
    for (const o of this.objects) o.destroy();
    this.objects = [];
    this.pillars = [];
    this.door = undefined;
    this.altar = undefined;
    this.bossSpawn = undefined;
    this.rings.clear();
    this.circle.clear();
    this.decor.clear();
    this.cryptDecor.clear();
  }
}

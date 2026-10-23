import * as Phaser from 'phaser';
import { vec, type Vec2 } from '../core/math';
import type { RoomTemplate } from '../core/run/types';
import { softDotTexture } from './fxTextures';
import { toScreen } from './iso';

// One room of a map run on screen: Flare floor tiles sized to the room, back walls and a front ledge, round pillars
// (core obstacles), the exit door (closed / open) and, in the boss room, the altar with its summoning circle.
// Render-only: positions and sizes come from the room template (src/data/maps.ts), states from core run state.

const TILE_WORLD = 68;
const TILE_SCALE = 0.5;
const PLAIN_FLOORS = [0, 1, 2, 3, 20, 21, 22, 23];
const DETAIL_FLOORS = [16, 17, 18, 19, 24, 25, 26, 27, 28, 29, 30, 31];

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

const BG = 0x07070a;
const WALL_TOP = 0x3a3340;
const WALL_BOTTOM = 0x17141b;
const MORTAR = 0x0c0a0e;
const LEDGE = 0x1d1920;
const DOOR_GLOW = 0xffb44a;
const ALTAR_READY = 0xb77bff;
const ALTAR_SUMMON = 0xff4a3a;

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

/** A stone column of world radius `r` (screen half width r, the base ellipse r × r/2), origin at its base centre. */
function pillarTexture(scene: Phaser.Scene, r: number): { key: string; originY: number } {
  const rx = Math.round(r);
  const ry = Math.round(r / 2);
  const pad = 10;
  const w = rx * 2 + pad * 2;
  const baseY = ry + 6 + PILLAR_H;
  const h = baseY + ry + 8;
  const key = `room:pillar:${rx}`;
  const originY = baseY / h;
  if (scene.textures.exists(key)) return { key, originY };
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const cx = w / 2;
  // Plinth.
  ctx.fillStyle = '#1a171d';
  ctx.beginPath();
  ctx.ellipse(cx, baseY, rx + 7, ry + 4, 0, 0, Math.PI * 2);
  ctx.fill();
  const shaft = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  shaft.addColorStop(0, '#2c2732');
  shaft.addColorStop(0.3, '#6d6372');
  shaft.addColorStop(0.55, '#4b4352');
  shaft.addColorStop(1, '#1a161e');
  ctx.fillStyle = shaft;
  ctx.fillRect(cx - rx, ry + 6, rx * 2, PILLAR_H);
  ctx.beginPath();
  ctx.ellipse(cx, baseY, rx, ry, 0, 0, Math.PI);
  ctx.fill();
  // Flutes.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 2;
  for (const f of [-0.6, -0.2, 0.2, 0.6]) {
    ctx.beginPath();
    ctx.moveTo(cx + f * rx, ry + 16);
    ctx.lineTo(cx + f * rx, baseY - 14);
    ctx.stroke();
  }
  // Bands near the top and the foot.
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 4;
  for (const y of [ry + 22, baseY - 18]) {
    ctx.beginPath();
    ctx.ellipse(cx, y, rx, ry, 0, 0, Math.PI);
    ctx.stroke();
  }
  // Capital.
  ctx.fillStyle = '#857a8a';
  ctx.beginPath();
  ctx.ellipse(cx, ry + 6, rx + 5, ry + 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5d5462';
  ctx.beginPath();
  ctx.ellipse(cx, ry + 6, rx - 2, ry - 1, 0, 0, Math.PI * 2);
  ctx.fill();
  scene.textures.addCanvas(key, canvas);
  return { key, originY };
}

const DOOR_W = 104;
const DOOR_H = 150;
const DOOR_BASE = 140;

/** A stone archway; closed: iron bars over darkness, open: a glowing passage. Origin at the threshold. */
function doorTexture(scene: Phaser.Scene, open: boolean): string {
  const key = `room:door:${open ? 'open' : 'closed'}`;
  if (scene.textures.exists(key)) return key;
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
    ctx.fillStyle = '#0b090d';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = '#6b6470';
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
  stone.addColorStop(0, '#2a252e');
  stone.addColorStop(0.25, '#6a6070');
  stone.addColorStop(0.75, '#4a4250');
  stone.addColorStop(1, '#1e1a22');
  ctx.fillStyle = stone;
  ctx.fillRect(6, archY, innerL - 6, DOOR_BASE - archY);
  ctx.fillRect(innerR, archY, DOOR_W - 6 - innerR, DOOR_BASE - archY);
  ctx.beginPath();
  ctx.arc(cx, archY, cx - 6, Math.PI, 0);
  ctx.arc(cx, archY, (innerR - innerL) / 2, 0, Math.PI, true);
  ctx.closePath();
  ctx.fill();
  // Keystone and joints.
  ctx.fillStyle = open ? '#f3d58a' : '#857a8a';
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
  ctx.fillStyle = '#3a3440';
  ctx.fillRect(2, DOOR_BASE - 4, DOOR_W - 4, 10);
  scene.textures.addCanvas(key, canvas);
  return key;
}

const ALTAR_W = 116;
const ALTAR_H = 96;
const ALTAR_BASE = 78;

/** A stepped stone altar with a rune-cut top; the crystal above it is a separate tinted image. */
function altarTexture(scene: Phaser.Scene): string {
  const key = 'room:altar';
  if (scene.textures.exists(key)) return key;
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
  slab(ALTAR_BASE, 56, 22, 12, '#4a4250', '#221e27');
  slab(ALTAR_BASE - 14, 40, 16, 12, '#5a5160', '#2a252e');
  slab(ALTAR_BASE - 28, 24, 10, 22, '#6d6372', '#332d38');
  // Runes on the front faces.
  ctx.strokeStyle = 'rgba(200,170,255,0.55)';
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

  constructor(private readonly scene: Phaser.Scene) {
    this.rings = scene.add.graphics().setDepth(GLOW_DEPTH);
    this.circle = scene.add.graphics().setDepth(GROUND_DEPTH);
  }

  /** Replaces whatever room was shown with template `t`. */
  build(t: RoomTemplate, doorRadius: number, altarRadius: number): void {
    this.clear();
    this.doorRadius = doorRadius;
    this.altarRadius = altarRadius;
    this.buildFloor(t.width, t.height);
    this.buildWalls(t.width, t.height);
    for (const o of t.obstacles ?? []) {
      const tex = pillarTexture(this.scene, o.radius);
      const s = toScreen(o.pos);
      const shadow = this.scene.add.ellipse(s.x + 8, s.y + 4, o.radius * 2.4, o.radius * 1.2, 0x000000, 0.35).setDepth(GROUND_DEPTH);
      const sprite = this.scene.add.image(s.x, s.y, tex.key).setOrigin(0.5, tex.originY).setDepth(s.y);
      this.objects.push(shadow, sprite);
      this.pillars.push({ sprite, x: s.x, y: s.y, r: o.radius });
    }
    if (t.kind === 'combat') {
      const s = toScreen(t.exit);
      const sprite = this.scene.add.image(s.x, s.y, doorTexture(this.scene, false)).setOrigin(0.5, DOOR_BASE / DOOR_H).setDepth(s.y);
      const glow = this.scene.add.image(s.x, s.y - 50, softDotTexture(this.scene)).setTint(DOOR_GLOW).setBlendMode(Phaser.BlendModes.ADD).setScale(3.4, 4).setDepth(GLOW_DEPTH).setAlpha(0);
      this.objects.push(sprite, glow);
      this.door = { sprite, glow, x: s.x, y: s.y, open: false };
    } else {
      const s = toScreen(t.altar);
      const stone = this.scene.add.image(s.x, s.y, altarTexture(this.scene)).setOrigin(0.5, ALTAR_BASE / ALTAR_H).setDepth(s.y);
      const crystal = this.scene.add.image(s.x, s.y - 70, crystalTexture(this.scene)).setDepth(s.y + 1);
      const glow = this.scene.add.image(s.x, s.y - 66, softDotTexture(this.scene)).setTint(ALTAR_READY).setBlendMode(Phaser.BlendModes.ADD).setScale(2.4).setDepth(GLOW_DEPTH);
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
    door.sprite.setTexture(doorTexture(this.scene, true));
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
    const rings = this.rings.clear();
    const door = this.door;
    if (door) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
      door.glow.setAlpha(door.open ? 0.35 + 0.25 * pulse : 0);
      if (door.open) {
        rings.lineStyle(3, DOOR_GLOW, 0.45 + 0.4 * pulse).strokeEllipse(door.x, door.y, this.doorRadius * 2, this.doorRadius);
        rings.lineStyle(1, 0xfff0c0, 0.3 * pulse).strokeEllipse(door.x, door.y, this.doorRadius * 2.6, this.doorRadius * 1.3);
      }
    }
    const altar = this.altar;
    if (altar) {
      const ready = f.altar === 'ready';
      const color = f.altar === 'summoning' ? ALTAR_SUMMON : ALTAR_READY;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * (f.altar === 'summoning' ? 12 : 3));
      altar.crystal.setTint(f.altar === 'spent' ? 0x4a4450 : color).setY(altar.y - 72 - (f.altar === 'spent' ? 0 : 4 * Math.sin(this.time * 2)));
      altar.glow.setTint(color).setAlpha(f.altar === 'spent' ? 0 : (f.altarInRange ? 0.7 : 0.4) + 0.3 * pulse);
      if (ready) {
        // Reach of the altar: the prompt appears inside this ring.
        rings.lineStyle(f.altarInRange ? 3 : 2, ALTAR_READY, (f.altarInRange ? 0.75 : 0.35) + 0.2 * pulse).strokeEllipse(altar.x, altar.y, this.altarRadius * 2, this.altarRadius);
      }
    }
    this.drawSummoning(f.summon);
    // A pillar between the camera and the hero turns see-through.
    for (const p of this.pillars) {
      const behind = f.hero.y < p.y && f.hero.y > p.y - PILLAR_H - 20 && Math.abs(f.hero.x - p.x) < p.r + 24;
      p.sprite.setAlpha(behind ? 0.45 : 1);
    }
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
    const cols = Math.ceil(width / TILE_WORLD);
    const rows = Math.ceil(height / TILE_WORLD);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const hash = (i * 73856093) ^ (j * 19349663);
        const pool = Math.abs(hash) % 5 === 0 ? DETAIL_FLOORS : PLAIN_FLOORS;
        const frame = pool[Math.abs(hash >> 3) % pool.length] ?? 0;
        const p = toScreen(vec((i + 0.5) * TILE_WORLD, (j + 0.5) * TILE_WORLD));
        this.objects.push(this.scene.add.image(p.x, p.y, 'floor', frame).setScale(TILE_SCALE).setDepth(FLOOR_DEPTH));
      }
    }
    // Tiles overhang the room edges by up to a tile: darkness over everything outside.
    const v = VOID_BAND;
    const g = this.scene.add.graphics().setDepth(VOID_DEPTH).fillStyle(BG, 1);
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
    const g = this.scene.add.graphics().setDepth(WALL_DEPTH);
    const top = toScreen(vec(0, 0));
    const right = toScreen(vec(width, 0));
    const left = toScreen(vec(0, height));
    const bottom = toScreen(vec(width, height));
    const wall = (a: Vec2, b: Vec2, shade: number, along: number): void => {
      const bands = 8;
      for (let i = 0; i < bands; i++) {
        const y0 = (WALL_H * i) / bands;
        const y1 = (WALL_H * (i + 1)) / bands;
        g.fillStyle(lerpColor(lerpColor(WALL_TOP, WALL_BOTTOM, i / (bands - 1)), 0x000000, shade), 1);
        g.fillPoints(pts([vec(a.x, a.y - y1), vec(b.x, b.y - y1), vec(b.x, b.y - y0), vec(a.x, a.y - y0)]), true);
      }
      // Mortar: courses parallel to the floor edge, staggered joints.
      g.lineStyle(1, MORTAR, 0.7);
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
      g.fillStyle(0x6a6070, 1 - shade).fillPoints(pts([vec(a.x, a.y - WALL_H - 6), vec(b.x, b.y - WALL_H - 6), vec(b.x, b.y - WALL_H), vec(a.x, a.y - WALL_H)]), true);
      g.fillStyle(0x000000, 0.45).fillPoints(pts([vec(a.x, a.y - 8), vec(b.x, b.y - 8), vec(b.x, b.y), vec(a.x, a.y)]), true);
    };
    wall(top, right, 0, 46);
    wall(top, left, 0.3, 46);
    const ledge = (a: Vec2, b: Vec2, shade: number): void => {
      g.fillStyle(lerpColor(LEDGE, 0x000000, shade), 1).fillPoints(pts([a, b, vec(b.x, b.y + LEDGE_H), vec(a.x, a.y + LEDGE_H)]), true);
      g.lineStyle(2, 0x4a4250, 0.8).lineBetween(a.x, a.y, b.x, b.y);
    };
    ledge(right, bottom, 0);
    ledge(left, bottom, 0.3);
    this.objects.push(g);
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
  }
}

import * as Phaser from 'phaser';
import { distance, vec, type Vec2 } from '../core/math';
import type { RoomTemplate } from '../core/run/types';
import type { BedrockLook, CryptDecorLook, EnvironmentLook, FlameLight } from '../data/environments';
import { softDotTexture } from './fxTextures';
import { toScreen } from './iso';
import { canvasTexture, css, decorRandom, fitTiles, prefersReducedMotion, stringHash, type GroundArea } from './proceduralArt';

// Decoration of a dungeon environment (the crypt, docs/design/maps.md «Зони»): the bedrock the room is carved into
// (rock, boulders, stalagmites, chasms glowing faintly from the abyss), and inside bones, cloth, rusty weapons, floor
// cracks and puddles, cobwebs, candles and braziers (warm light islands in the darkness), low fog and ghost wisps.
// Purely visual: nothing collides or is known to core. Static parts are images of canvas textures built once per
// environment and placed once per room (seeded by the room template id); only glows, fog and wisps animate, on pooled
// images, and they keep still / stay off with prefers-reduced-motion.

/** Below the floor (-100000): the bedrock beyond the room. */
const ROCK_DEPTH = -100003;
const CHASM_DEPTH = -100002.5;
const BOULDER_DEPTH = -100001.5;
/** Above the floor tiles, under walls (-90000): cracks and puddles. */
const FLAT_DEPTH = -99999;
/** Just above the walls: cobwebs in their corners. */
const WEB_DEPTH = -89999;
/** Under every body, ground ring (-1500) and floor effect (-1000): light pools, props, fog. */
const FLOOR_GLOW_DEPTH = -1700;
const PROP_DEPTH = -1600;
const FOG_DEPTH = -1590;
/** Above the darkness overlay (5000), like the door / altar glows: seen from across the dark room. */
const LIGHT_DEPTH = 5001;
const DEPTH_PER_PX = 1e-5;

const ROCK_W = 512;
const ROCK_H = 256;
/** Boulders closer than this (world units) in front of a front edge are low ones (tall ones would overlap the floor). */
const FRONT_LOW = 160;
const PROP_EDGE = 30;
const PROP_SPACING = 50;
/** Lights stand this far from the back walls when placed along them (world units). */
const WALL_INSET = 45;

const PROPS = ['bones', 'bones', 'bones', 'skull', 'skull', 'cloth', 'cloth', 'sword', 'shield'] as const;

interface Glow {
  readonly image: Phaser.GameObjects.Image;
  readonly alpha: number;
  readonly phase: number;
  /** Flicker speed (0: a slow pulse). */
  readonly flicker: number;
}

interface Drifter {
  readonly image: Phaser.GameObjects.Image;
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
  readonly phase: number;
  /** Wander radius, screen px. */
  readonly range: number;
  readonly speed: number;
}

/** Irregular closed polygon around (cx, cy) with radii rx × ry, `n` points jittered by `rough`. */
function roughPath(ctx: CanvasRenderingContext2D, rand: () => number, cx: number, cy: number, rx: number, ry: number, n: number, rough: number): void {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 - rough + rand() * rough * 2;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export class CryptDecor {
  private objects: Phaser.GameObjects.GameObject[] = [];
  private glows: Glow[] = [];
  private fog: Drifter[] = [];
  private wisps: Drifter[] = [];
  private ground: Phaser.GameObjects.TileSprite | undefined;
  private time = 0;
  private still = false;

  constructor(private readonly scene: Phaser.Scene) {}

  /** Decorates room `t` for environment `env` (nothing for environments without bedrock / crypt looks). */
  build(t: RoomTemplate, env: EnvironmentLook): void {
    this.clear();
    this.still = prefersReducedMotion();
    const seed = stringHash(`${env.id}:${t.id}`);
    if (env.bedrock) this.buildBedrock(t, env, env.bedrock, seed);
    if (env.crypt) {
      const keep: Vec2[] = [t.entry, ...t.spawnPoints, ...(t.kind === 'combat' ? [t.exit] : [t.altar, t.bossSpawn])];
      const placed: Vec2[] = [];
      this.buildLights(t, env, env.crypt, keep, placed, seed ^ 0x27d4eb2f);
      this.buildProps(t, env, env.crypt, keep, placed, seed ^ 0x165667b1);
      this.buildWebs(t, env, env.crypt, seed ^ 0x3c6ef372);
      this.buildFog(t, env.crypt, seed ^ 0x7f4a7c15);
      if (!this.still) this.buildWisps(t, env.crypt, seed ^ 0x2545f491);
    }
    this.update(0);
  }

  /** Flicker of the flames, slow pulse of the abyss glow, drifting fog and wisps. Allocation-free. */
  update(dt: number): void {
    if (this.still) return;
    this.time += dt;
    const t = this.time;
    for (const g of this.glows) {
      const k = g.flicker > 0 ? 0.85 + 0.09 * Math.sin(t * g.flicker + g.phase) + 0.06 * Math.sin(t * g.flicker * 1.7 + g.phase * 2) : 0.8 + 0.2 * Math.sin(t * 0.6 + g.phase);
      g.image.setAlpha(g.alpha * k);
    }
    for (const f of this.fog) {
      f.image.setPosition(f.x + Math.sin(t * f.speed + f.phase) * f.range, f.y);
      f.image.setAlpha(f.alpha * (0.8 + 0.2 * Math.sin(t * f.speed * 2 + f.phase)));
    }
    for (const w of this.wisps) {
      const a = t * w.speed + w.phase;
      w.image.setPosition(w.x + Math.sin(a) * w.range, w.y + Math.sin(a * 1.37 + 1) * w.range * 0.5 - Math.sin(a * 0.5) * 12);
      w.image.setAlpha(w.alpha * (0.55 + 0.45 * Math.sin(a * 2.3)));
    }
  }

  clear(): void {
    for (const o of this.objects) o.destroy();
    this.objects = [];
    this.glows = [];
    this.fog = [];
    this.wisps = [];
    this.ground = undefined;
  }

  /** Stretches the ground beyond the room over `area` (screen px); RoomView.fitView calls it on build and resize. */
  fitGround(area: GroundArea): void {
    fitTiles(this.ground, area);
  }

  // --- Outside: the bedrock ---

  private buildBedrock(t: RoomTemplate, env: EnvironmentLook, look: BedrockLook, seed: number): void {
    // Sized by fitGround to what the camera can show, not a huge fixed sheet (the Canvas renderer backs a TileSprite
    // with a canvas of its full size).
    this.ground = this.scene.add.tileSprite(0, 0, 1, 1, this.rockTexture(env, look)).setOrigin(0, 0).setDepth(ROCK_DEPTH);
    this.objects.push(this.ground);
    const rand = decorRandom(seed);
    // A point `o` world units outside side `side` (0: back y = 0, 1: back x = 0, 2: front x = width, 3: front y = height).
    const outside = (side: number, along: number, o: number): Vec2 =>
      side === 0 ? vec(along, -o) : side === 1 ? vec(-o, along) : side === 2 ? vec(t.width + o, along) : vec(along, t.height + o);
    const sideLength = (side: number): number => (side === 0 || side === 3 ? t.width : t.height);
    const place = (key: string, p: Vec2, depth: number, scale: number): Phaser.GameObjects.Image => {
      const s = toScreen(p);
      const image = this.scene.add.image(s.x, s.y, key).setOrigin(0.5, 0.85).setScale(scale).setFlipX(rand() < 0.5).setDepth(depth + s.y * DEPTH_PER_PX);
      this.objects.push(image);
      return image;
    };
    // Rough rock hugging the walls and the ledge: big boulders behind the walls and further out, low ones by the ledge.
    for (let i = 0; i < look.boulders; i++) {
      const side = Math.floor(rand() * 4);
      const along = -150 + rand() * (sideLength(side) + 300);
      const back = side < 2;
      const o = back ? 15 + rand() * rand() * 320 : 50 + rand() * rand() * 420;
      const low = !back && o < FRONT_LOW;
      place(this.boulderTexture(env, look, low ? 3 + (i % 2) : i % 3), outside(side, along, o), BOULDER_DEPTH, 0.8 + rand() * 0.6);
    }
    for (let i = 0; i < look.stalagmites; i++) {
      const side = Math.floor(rand() * 4);
      const back = side < 2;
      const o = back ? 40 + rand() * 380 : FRONT_LOW + 20 + rand() * 380;
      place(this.stalagmiteTexture(env, look, i % 2), outside(side, -100 + rand() * (sideLength(side) + 200), o), BOULDER_DEPTH, 0.7 + rand() * 0.6);
    }
    const dot = softDotTexture(this.scene);
    for (let i = 0; i < look.chasms; i++) {
      const side = i % 4;
      const p = outside(side, rand() * sideLength(side), (side < 2 ? 160 : 220) + rand() * 260);
      const s = toScreen(p);
      const scale = 0.8 + rand() * 0.5;
      this.objects.push(this.scene.add.image(s.x, s.y, this.chasmTexture(env, look, i % 2)).setScale(scale).setFlipX(rand() < 0.5).setDepth(CHASM_DEPTH + s.y * DEPTH_PER_PX));
      // Faint glow out of the abyss, above the darkness so it shows from across the room.
      const glow = this.scene.add.image(s.x, s.y, dot).setTint(look.chasmGlow).setBlendMode(Phaser.BlendModes.ADD).setScale(4.2 * scale, 1.4 * scale).setDepth(LIGHT_DEPTH).setAlpha(look.chasmGlowAlpha);
      this.objects.push(glow);
      this.glows.push({ image: glow, alpha: look.chasmGlowAlpha, phase: rand() * Math.PI * 2, flicker: 0 });
    }
  }

  // --- Inside ---

  /** A free spot on the floor away from play and from what is already placed; undefined when none was found. */
  private freeSpot(t: RoomTemplate, keep: readonly Vec2[], placed: Vec2[], pick: () => Vec2, clearance: number): Vec2 | undefined {
    for (let tries = 0; tries < 40; tries++) {
      const p = pick();
      if (p.x < PROP_EDGE || p.y < PROP_EDGE || p.x > t.width - PROP_EDGE || p.y > t.height - PROP_EDGE) continue;
      if (keep.some((k) => distance(k, p) < clearance)) continue;
      if ((t.obstacles ?? []).some((o) => distance(o.pos, p) < o.radius + 35)) continue;
      if (placed.some((q) => distance(q, p) < PROP_SPACING)) continue;
      placed.push(p);
      return p;
    }
    return undefined;
  }

  /** Braziers along the back walls, candles anywhere: the prop, a warm pool on the floor, a soft glow above the dark. */
  private buildLights(t: RoomTemplate, env: EnvironmentLook, look: CryptDecorLook, keep: readonly Vec2[], placed: Vec2[], seed: number): void {
    const rand = decorRandom(seed);
    const dot = softDotTexture(this.scene);
    const alongWall = (): Vec2 => (rand() < 0.5 ? vec(rand() * t.width, WALL_INSET) : vec(WALL_INSET, rand() * t.height));
    const anywhere = (): Vec2 => (rand() < 0.5 ? alongWall() : vec(rand() * t.width, rand() * t.height));
    const light = (kind: 'brazier' | 'candles', def: FlameLight, pick: () => Vec2): void => {
      for (let i = 0; i < def.count; i++) {
        const p = this.freeSpot(t, keep, placed, pick, look.clearance);
        if (!p) continue;
        const s = toScreen(p);
        const flameY = s.y - (kind === 'brazier' ? 44 : 20);
        this.objects.push(this.scene.add.image(s.x, s.y, this.lightPropTexture(env, look, kind)).setOrigin(0.5, 0.9).setDepth(PROP_DEPTH + s.y * DEPTH_PER_PX));
        // Warm pool on the floor (under the darkness: seen in the hero's light).
        const pool = this.scene.add.image(s.x, s.y, dot).setTint(def.color).setBlendMode(Phaser.BlendModes.ADD).setScale(def.scale * 1.5, def.scale * 0.75).setDepth(FLOOR_GLOW_DEPTH).setAlpha(0.3);
        // Soft glow and the flame's bright core above the darkness: a light island seen from afar. No hard rim.
        const halo = this.scene.add.image(s.x, flameY + 10, dot).setTint(def.color).setBlendMode(Phaser.BlendModes.ADD).setScale(def.scale).setDepth(LIGHT_DEPTH).setAlpha(def.alpha);
        const core = this.scene.add.image(s.x, flameY, dot).setTint(0xffe2a8).setBlendMode(Phaser.BlendModes.ADD).setScale(kind === 'brazier' ? 0.3 : 0.18).setDepth(LIGHT_DEPTH + 0.1).setAlpha(0.8);
        this.objects.push(pool, halo, core);
        const phase = rand() * Math.PI * 2;
        this.glows.push({ image: halo, alpha: def.alpha, phase, flicker: 9 + rand() * 4 }, { image: core, alpha: 0.8, phase, flicker: 11 + rand() * 4 }, { image: pool, alpha: 0.3, phase, flicker: 9 });
      }
    };
    light('brazier', look.braziers, alongWall);
    light('candles', look.candles, anywhere);
  }

  /** Bones, skulls, cloth and rusty weapons; cracks and puddles flat on the floor. */
  private buildProps(t: RoomTemplate, env: EnvironmentLook, look: CryptDecorLook, keep: readonly Vec2[], placed: Vec2[], seed: number): void {
    const rand = decorRandom(seed);
    const area = (t.width * t.height) / 1e6;
    const any = (): Vec2 => vec(rand() * t.width, rand() * t.height);
    const count = Math.round(area * look.density);
    for (let i = 0; i < count; i++) {
      const p = this.freeSpot(t, keep, placed, any, look.clearance);
      if (!p) continue;
      const s = toScreen(p);
      const kind = PROPS[Math.floor(rand() * PROPS.length)]!;
      this.objects.push(
        this.scene.add
          .image(s.x, s.y, this.propTexture(env, look, kind))
          .setOrigin(0.5, 0.8)
          .setScale(0.85 + rand() * 0.3)
          .setFlipX(rand() < 0.5)
          .setDepth(PROP_DEPTH + s.y * DEPTH_PER_PX),
      );
    }
    // Flat marks need less room (nothing stands up), but puddles still keep off spawn points and rings.
    const flats = Math.round(area * look.flats);
    for (let i = 0; i < flats; i++) {
      const p = this.freeSpot(t, keep, placed, any, look.clearance * 0.6);
      if (!p) continue;
      const s = toScreen(p);
      const puddle = rand() < 0.35;
      this.objects.push(
        this.scene.add
          .image(s.x, s.y, puddle ? this.puddleTexture(env, look) : this.crackTexture(env, look, i % 2))
          .setScale(0.8 + rand() * 0.5)
          .setFlipX(rand() < 0.5)
          .setDepth(FLAT_DEPTH),
      );
    }
  }

  /** Cobwebs in the wall corners: where the back walls meet and at their far ends, plus one hanging from a wall top. */
  private buildWebs(t: RoomTemplate, env: EnvironmentLook, look: CryptDecorLook, seed: number): void {
    const rand = decorRandom(seed);
    const key = this.webTexture(env, look);
    const wallTop = 118;
    const apex = toScreen(vec(0, 0));
    const right = toScreen(vec(t.width, 0));
    const left = toScreen(vec(0, t.height));
    const web = (x: number, y: number, ox: number, scale: number, flip: boolean): void => {
      this.objects.push(this.scene.add.image(x, y, key).setOrigin(ox, 0).setScale(scale).setFlipX(flip).setDepth(WEB_DEPTH).setAlpha(0.75));
    };
    web(apex.x, apex.y - wallTop, 0.5, 1, false);
    web(right.x - 2, right.y - wallTop, 1, 0.7, false);
    web(left.x + 2, left.y - wallTop, 0, 0.7, true);
    const d = 0.3 + rand() * 0.4;
    const hang = rand() < 0.5 ? toScreen(vec(d * t.width, 0)) : toScreen(vec(0, d * t.height));
    web(hang.x, hang.y - wallTop, 0.5, 0.55, rand() < 0.5);
  }

  /** Low fog banks in the corners and along the walls, slowly breathing. */
  private buildFog(t: RoomTemplate, look: CryptDecorLook, seed: number): void {
    const rand = decorRandom(seed);
    const dot = softDotTexture(this.scene);
    const inset = 70;
    const corners = [vec(inset, inset), vec(t.width - inset, inset), vec(inset, t.height - inset), vec(t.width - inset, t.height - inset)];
    for (let i = 0; i < look.fog.count; i++) {
      const p = corners[i] ?? (rand() < 0.5 ? vec(rand() * t.width, inset) : vec(inset, rand() * t.height));
      const s = toScreen(p);
      const image = this.scene.add
        .image(s.x, s.y, dot)
        .setTint(look.fog.color)
        .setScale(8 + rand() * 5, 2.6 + rand() * 1.4)
        .setDepth(FOG_DEPTH)
        .setAlpha(look.fog.alpha);
      this.objects.push(image);
      this.fog.push({ image, x: s.x, y: s.y, alpha: look.fog.alpha, phase: rand() * Math.PI * 2, range: 20 + rand() * 20, speed: 0.12 + rand() * 0.1 });
    }
  }

  /** Greenish ghost wisps wandering over the room (pooled; only with motion allowed). */
  private buildWisps(t: RoomTemplate, look: CryptDecorLook, seed: number): void {
    const rand = decorRandom(seed);
    const dot = softDotTexture(this.scene);
    for (let i = 0; i < look.wisps.count; i++) {
      const s = toScreen(vec(rand() * t.width, rand() * t.height));
      const image = this.scene.add
        .image(s.x, s.y - 30, dot)
        .setTint(look.wisps.color)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.14 + rand() * 0.08)
        .setDepth(LIGHT_DEPTH + 0.2)
        .setAlpha(0);
      this.objects.push(image);
      this.wisps.push({ image, x: s.x, y: s.y - 30 - rand() * 30, alpha: look.wisps.alpha, phase: rand() * Math.PI * 2, range: 40 + rand() * 50, speed: 0.25 + rand() * 0.25 });
    }
  }

  // --- Textures (one canvas per environment and kind) ---

  /** Seamless bedrock: dark rock with lighter and darker patches, cracks (wrapped, so the sheet tiles) and grit. */
  private rockTexture(env: EnvironmentLook, look: BedrockLook): string {
    return canvasTexture(this.scene, `crypt:rock:${env.id}`, ROCK_W, ROCK_H, (ctx) => {
      const rand = decorRandom(0x6a09e667);
      ctx.fillStyle = css(look.rock);
      ctx.fillRect(0, 0, ROCK_W, ROCK_H);
      const wrapped = (draw: (dx: number, dy: number) => void): void => {
        for (const dx of [-ROCK_W, 0, ROCK_W]) for (const dy of [-ROCK_H, 0, ROCK_H]) draw(dx, dy);
      };
      for (let i = 0; i < 26; i++) {
        const x = rand() * ROCK_W;
        const y = rand() * ROCK_H;
        const r = 25 + rand() * 70;
        const color = rand() < 0.45 ? look.rockLight : look.rockDark;
        const alpha = 0.2 + rand() * 0.25;
        wrapped((dx, dy) => {
          ctx.save();
          ctx.translate(x + dx, y + dy);
          ctx.scale(1, 0.55);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          g.addColorStop(0, css(color, alpha));
          g.addColorStop(1, css(color, 0));
          ctx.fillStyle = g;
          ctx.fillRect(-r, -r, 2 * r, 2 * r);
          ctx.restore();
        });
      }
      for (let i = 0; i < 18; i++) {
        let x = rand() * ROCK_W;
        let y = rand() * ROCK_H;
        const pts: Vec2[] = [vec(x, y)];
        for (let s = 0; s < 5; s++) {
          x += (rand() - 0.3) * 30;
          y += (rand() - 0.5) * 16;
          pts.push(vec(x, y));
        }
        wrapped((dx, dy) => {
          for (const [color, alpha, off] of [[look.rockLight, 0.35, 1], [look.crack, 0.9, 0]] as const) {
            ctx.strokeStyle = css(color, alpha);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            pts.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x + dx, p.y + dy + off) : ctx.lineTo(p.x + dx, p.y + dy + off)));
            ctx.stroke();
          }
        });
      }
      for (let i = 0; i < 1400; i++) {
        ctx.fillStyle = rand() < 0.5 ? css(look.rockDark, 0.45) : css(look.rockLight, 0.3);
        ctx.fillRect(Math.floor(rand() * ROCK_W), Math.floor(rand() * ROCK_H), 1 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 2));
      }
    });
  }

  /** Rough boulders: variants 0–2 tall masses, 3–4 low slabs. Lit from the top left. */
  private boulderTexture(env: EnvironmentLook, look: BedrockLook, variant: number): string {
    const low = variant >= 3;
    const w = low ? 110 : 130;
    const h = low ? 50 : 110;
    return canvasTexture(this.scene, `crypt:boulder:${env.id}:${variant}`, w, h, (ctx) => {
      const rand = decorRandom(0xbb67ae85 + variant * 977);
      const pieces = low ? 3 : 4;
      for (let k = 0; k < pieces; k++) {
        const rx = (low ? 26 : 30) + rand() * 18;
        const ry = low ? 10 + rand() * 6 : 26 + rand() * 22;
        const cx = w / 2 + (rand() - 0.5) * (w - 2 * rx) * 0.8;
        const cy = h - ry - 4 - rand() * (low ? 2 : 14);
        roughPath(ctx, rand, cx, cy, rx, ry, 9, 0.22);
        const g = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx * 0.6, cy + ry);
        g.addColorStop(0, css(look.rockLight));
        g.addColorStop(0.45, css(look.rock));
        g.addColorStop(1, css(look.rockDark));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = css(look.crack, 0.8);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // A facet line or two.
        ctx.strokeStyle = css(look.rockDark, 0.8);
        ctx.beginPath();
        ctx.moveTo(cx - rx * 0.3, cy - ry * 0.6);
        ctx.lineTo(cx + rx * 0.1, cy + ry * 0.2);
        ctx.lineTo(cx + rx * 0.6, cy + ry * 0.1);
        ctx.stroke();
      }
    });
  }

  /** A stalagmite: a lumpy cone with a lit left flank. */
  private stalagmiteTexture(env: EnvironmentLook, look: BedrockLook, variant: number): string {
    const w = 60;
    const h = 120;
    return canvasTexture(this.scene, `crypt:stalagmite:${env.id}:${variant}`, w, h, (ctx) => {
      const rand = decorRandom(0x3c6ef372 + variant * 131);
      const tip = 6 + rand() * 14;
      const g = ctx.createLinearGradient(8, 0, w - 8, 0);
      g.addColorStop(0, css(look.rockLight));
      g.addColorStop(0.5, css(look.rock));
      g.addColorStop(1, css(look.rockDark));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(6, h - 8);
      ctx.quadraticCurveTo(14 + rand() * 6, h * 0.5, w / 2 - 2, tip);
      ctx.lineTo(w / 2 + 3, tip + 2);
      ctx.quadraticCurveTo(w - 16 - rand() * 6, h * 0.55, w - 6, h - 8);
      ctx.quadraticCurveTo(w / 2, h, 6, h - 8);
      ctx.fill();
      ctx.strokeStyle = css(look.rockDark, 0.7);
      ctx.lineWidth = 1.2;
      for (let y = h * 0.4; y < h - 14; y += 14 + rand() * 8) {
        ctx.beginPath();
        ctx.moveTo(w / 2 - 12 * (y / h), y);
        ctx.quadraticCurveTo(w / 2, y + 3, w / 2 + 12 * (y / h), y);
        ctx.stroke();
      }
    });
  }

  /** A chasm: a ragged crack into blackness, its lit lip on the far side, a cold glow deep inside. */
  private chasmTexture(env: EnvironmentLook, look: BedrockLook, variant: number): string {
    const w = 260;
    const h = 110;
    return canvasTexture(this.scene, `crypt:chasm:${env.id}:${variant}`, w, h, (ctx) => {
      const rand = decorRandom(0x510e527f + variant * 733);
      const n = 18;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const k = 0.75 + rand() * 0.35;
        const x = w / 2 + Math.cos(a) * (w / 2 - 12) * k;
        const y = h / 2 + Math.sin(a) * (h / 2 - 14) * k * (0.7 + 0.3 * Math.abs(Math.cos(a)));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = '#030205';
      ctx.fill();
      ctx.save();
      ctx.clip();
      const g = ctx.createRadialGradient(w / 2, h / 2 + 6, 0, w / 2, h / 2 + 6, w / 2.4);
      g.addColorStop(0, css(look.chasmGlow, 0.35));
      g.addColorStop(0.5, css(look.chasmGlow, 0.1));
      g.addColorStop(1, css(look.chasmGlow, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // The near wall of the chasm falls away into the dark.
      const wall = ctx.createLinearGradient(0, 0, 0, h * 0.55);
      wall.addColorStop(0, css(look.rock, 1));
      wall.addColorStop(1, css(look.rock, 0));
      ctx.fillStyle = wall;
      ctx.fillRect(0, 0, w, h * 0.55);
      ctx.restore();
      ctx.strokeStyle = css(look.rockLight, 0.8);
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  private propTexture(env: EnvironmentLook, look: CryptDecorLook, kind: (typeof PROPS)[number]): string {
    const bone = css(look.bone);
    const shade = css(look.boneShade);
    const boneShape = (ctx: CanvasRenderingContext2D, x: number, y: number, len: number, angle: number): void => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = shade;
      ctx.fillRect(-len / 2, -1, len, 3.5);
      ctx.fillStyle = bone;
      ctx.fillRect(-len / 2, -2, len, 3);
      for (const ex of [-len / 2, len / 2]) {
        ctx.beginPath();
        ctx.arc(ex, -2, 2.4, 0, Math.PI * 2);
        ctx.arc(ex, 1.5, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };
    const skull = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void => {
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.ellipse(x + 1, y + 2, r, r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = bone;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x - r * 0.55, y + r * 0.5, r * 1.1, r * 0.5);
      ctx.fillStyle = '#1a1418';
      ctx.beginPath();
      ctx.arc(x - r * 0.38, y + r * 0.1, r * 0.25, 0, Math.PI * 2);
      ctx.arc(x + r * 0.38, y + r * 0.1, r * 0.25, 0, Math.PI * 2);
      ctx.fill();
    };
    const shadow = (ctx: CanvasRenderingContext2D, x: number, y: number, rx: number): void => {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(x, y, rx, rx * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    if (kind === 'bones') {
      return canvasTexture(this.scene, `crypt:prop:bones:${env.id}`, 60, 34, (ctx) => {
        const rand = decorRandom(0x9b05688c);
        shadow(ctx, 30, 27, 24);
        for (let i = 0; i < 6; i++) boneShape(ctx, 12 + rand() * 36, 16 + rand() * 12, 12 + rand() * 10, (rand() - 0.5) * 2.4);
        skull(ctx, 22 + rand() * 16, 14, 6);
      });
    }
    if (kind === 'skull') {
      return canvasTexture(this.scene, `crypt:prop:skull:${env.id}`, 40, 30, (ctx) => {
        shadow(ctx, 20, 24, 14);
        boneShape(ctx, 26, 22, 16, 0.4);
        skull(ctx, 17, 15, 8);
      });
    }
    if (kind === 'cloth') {
      return canvasTexture(this.scene, `crypt:prop:cloth:${env.id}`, 64, 34, (ctx) => {
        const rand = decorRandom(0x1f83d9ab);
        const color = look.cloth[0] ?? 0x6a2430;
        ctx.fillStyle = css(color);
        ctx.beginPath();
        ctx.moveTo(8, 18);
        ctx.quadraticCurveTo(20, 6, 40, 9);
        ctx.quadraticCurveTo(54, 10, 58, 18);
        // Tattered lower edge.
        for (let x = 56; x > 8; x -= 5) ctx.lineTo(x, 24 + rand() * 7);
        ctx.closePath();
        ctx.fill();
        // Lit upper hem and dark folds: it reads as fabric.
        ctx.strokeStyle = css(look.cloth[2] ?? 0x6e6280, 0.9);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(9, 17);
        ctx.quadraticCurveTo(20, 6, 40, 9);
        ctx.quadraticCurveTo(54, 10, 57, 17);
        ctx.stroke();
        ctx.strokeStyle = css(look.cloth[1] ?? 0x2e2838, 0.9);
        ctx.beginPath();
        ctx.moveTo(16, 14);
        ctx.quadraticCurveTo(28, 20, 22, 26);
        ctx.moveTo(36, 12);
        ctx.quadraticCurveTo(42, 18, 38, 27);
        ctx.stroke();
      });
    }
    const rust = look.rust.map((c) => css(c));
    if (kind === 'sword') {
      return canvasTexture(this.scene, `crypt:prop:sword:${env.id}`, 70, 30, (ctx) => {
        shadow(ctx, 35, 21, 26);
        ctx.save();
        ctx.translate(35, 17);
        ctx.rotate(Math.atan2(0.5, 1) - 0.1);
        const blade = ctx.createLinearGradient(0, -3, 0, 3);
        blade.addColorStop(0, rust[1] ?? '#5e5a58');
        blade.addColorStop(1, rust[0] ?? '#7a4a2a');
        ctx.fillStyle = blade;
        ctx.beginPath();
        ctx.moveTo(-14, -3);
        ctx.lineTo(24, -2);
        ctx.lineTo(30, 0);
        ctx.lineTo(24, 2);
        ctx.lineTo(-14, 3);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = rust[2] ?? '#8c5a32';
        ctx.fillRect(-17, -7, 3, 14);
        ctx.fillStyle = '#3a2a1e';
        ctx.fillRect(-28, -2, 11, 4);
        // Rust pits.
        ctx.fillStyle = 'rgba(122,74,42,0.8)';
        for (const x of [-6, 4, 13]) ctx.fillRect(x, -1, 3, 2);
        ctx.restore();
      });
    }
    return canvasTexture(this.scene, `crypt:prop:shield:${env.id}`, 50, 34, (ctx) => {
      shadow(ctx, 25, 26, 20);
      ctx.fillStyle = rust[0] ?? '#7a4a2a';
      ctx.beginPath();
      ctx.ellipse(25, 20, 19, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rust[1] ?? '#5e5a58';
      ctx.beginPath();
      ctx.ellipse(25, 18, 17, 8.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rust[2] ?? '#8c5a32';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(25, 18, 12, 6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rust[2] ?? '#8c5a32';
      ctx.beginPath();
      ctx.ellipse(25, 18, 3.5, 2, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** An iron brazier with burning coals, or three candles on a wax puddle. */
  private lightPropTexture(env: EnvironmentLook, look: CryptDecorLook, kind: 'brazier' | 'candles'): string {
    const flame = (ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void => {
      const g = ctx.createLinearGradient(0, y - h, 0, y);
      g.addColorStop(0, 'rgba(255,240,190,0.9)');
      g.addColorStop(0.5, 'rgba(255,170,60,1)');
      g.addColorStop(1, 'rgba(200,70,20,0.9)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.quadraticCurveTo(x + h * 0.45, y - h * 0.3, x, y);
      ctx.quadraticCurveTo(x - h * 0.45, y - h * 0.3, x, y - h);
      ctx.fill();
    };
    if (kind === 'brazier') {
      return canvasTexture(this.scene, `crypt:brazier:${env.id}`, 50, 64, (ctx) => {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(25, 58, 16, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2a2428';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(14, 58);
        ctx.lineTo(21, 30);
        ctx.moveTo(36, 58);
        ctx.lineTo(29, 30);
        ctx.moveTo(25, 60);
        ctx.lineTo(25, 30);
        ctx.stroke();
        const bowl = ctx.createLinearGradient(9, 0, 41, 0);
        bowl.addColorStop(0, '#4a4248');
        bowl.addColorStop(0.4, '#6a6068');
        bowl.addColorStop(1, '#221e22');
        ctx.fillStyle = bowl;
        ctx.beginPath();
        ctx.moveTo(8, 22);
        ctx.quadraticCurveTo(25, 40, 42, 22);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ff7a28';
        ctx.beginPath();
        ctx.ellipse(25, 22, 16, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffc060';
        for (const [x, y] of [[19, 21], [27, 23], [33, 21]] as const) ctx.fillRect(x, y, 3, 2);
        flame(ctx, 21, 22, 13);
        flame(ctx, 29, 22, 17);
      });
    }
    return canvasTexture(this.scene, `crypt:candles:${env.id}`, 36, 34, (ctx) => {
      ctx.fillStyle = css(look.bone, 0.85);
      ctx.beginPath();
      ctx.ellipse(18, 29, 14, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const [x, h] of [[11, 14], [18, 19], [25, 11]] as const) {
        ctx.fillStyle = css(look.bone);
        ctx.fillRect(x - 2.5, 29 - h, 5, h);
        ctx.fillStyle = css(look.boneShade, 0.8);
        ctx.fillRect(x + 1, 29 - h, 1.5, h);
        flame(ctx, x, 29 - h - 1, 6);
      }
    });
  }

  /** A branching floor crack with a pale lip. */
  private crackTexture(env: EnvironmentLook, look: CryptDecorLook, variant: number): string {
    return canvasTexture(this.scene, `crypt:crack:${env.id}:${variant}`, 130, 64, (ctx) => {
      const rand = decorRandom(0xa54ff53a + variant * 17);
      const branch = (x: number, y: number, steps: number, width: number): void => {
        for (let s = 0; s < steps; s++) {
          const nx = x + 6 + rand() * 12;
          const ny = y + (rand() - 0.5) * 10;
          ctx.strokeStyle = css(look.boneShade, 0.25);
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(x, y + 1.2);
          ctx.lineTo(nx, ny + 1.2);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(6,5,8,0.9)';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(nx, ny);
          ctx.stroke();
          if (rand() < 0.3 && width > 1) branch(nx, ny, 2 + Math.floor(rand() * 2), width * 0.6);
          x = nx;
          y = ny;
        }
      };
      branch(8, 32, 8, 2.2);
    });
  }

  /** A shallow dark puddle with a dull sheen (no glow, so it is never taken for a ground effect). */
  private puddleTexture(env: EnvironmentLook, look: CryptDecorLook): string {
    return canvasTexture(this.scene, `crypt:puddle:${env.id}`, 90, 44, (ctx) => {
      const rand = decorRandom(0x5be0cd19);
      roughPath(ctx, rand, 45, 22, 40, 17, 14, 0.15);
      ctx.fillStyle = css(look.puddle, 0.85);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,170,190,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(36, 16, 16, 4, -0.1, Math.PI * 1.05, Math.PI * 1.7);
      ctx.stroke();
    });
  }

  /** A cobweb hanging from a corner: radial threads and sagging rings. */
  private webTexture(env: EnvironmentLook, look: CryptDecorLook): string {
    return canvasTexture(this.scene, `crypt:web:${env.id}`, 120, 80, (ctx) => {
      const cx = 60;
      // Spokes fan downwards from the corner (angle 0 = right, π/2 = straight down).
      const spokes = [0.25, 0.6, 0.95, 1.3, 1.57, 1.85, 2.2, 2.55, 2.9];
      const reach = (a: number, r: number): Vec2 => vec(cx + Math.cos(a) * r * 0.85, Math.sin(a) * r);
      ctx.strokeStyle = css(look.web, 0.55);
      ctx.lineWidth = 1;
      for (const a of spokes) {
        const end = reach(a, 76);
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
      for (let r = 14; r < 72; r += 13) {
        ctx.beginPath();
        spokes.forEach((a, i) => {
          const p = reach(a, r);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else {
            // Threads sag towards the corner between spokes.
            const m = reach((a + spokes[i - 1]!) / 2, r * 0.82);
            ctx.quadraticCurveTo(m.x, m.y, p.x, p.y);
          }
        });
        ctx.stroke();
      }
    });
  }
}

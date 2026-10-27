import * as Phaser from 'phaser';
import { distance, vec, type Vec2 } from '../core/math';
import type { RoomTemplate } from '../core/run/types';
import type { DecorLook, EnvironmentLook, OutsideLook } from '../data/environments';
import { softDotTexture } from './fxTextures';
import { toScreen } from './iso';
import { canvasTexture, css, decorRandom, fitTiles, prefersReducedMotion, stringHash, type GroundArea } from './proceduralArt';

// Decoration of an open-air environment (the temple ruins, docs/design/maps.md «Зони»): sand and dunes with
// half-buried fragments beyond the room, sand drifting over the floor's edges, small props on the floor, sun rays with
// dust motes. Purely visual: nothing here collides or is known to core. Everything is drawn once per room from
// procedural canvas textures (built once per environment); only the dust motes move. Placement is seeded by the room
// template id, so a room looks the same on every visit.

/** Below the floor (-100000): the ground beyond the room, its dunes and fragments. */
const SAND_DEPTH = -100003;
const DUNE_DEPTH = -100002.5;
const FRAGMENT_DEPTH = -100001.5;
/** Above the floor tiles, under the walls (-90000): sand drifts over the floor edges. */
const DRIFT_DEPTH = -99999;
/** Under every body, ground ring and floor effect (ground rings -1500, floor fx -1000): props never hide play. */
const PROP_DEPTH = -1600;
/** Over the bodies, under the darkness overlay (5000): sun rays and dust. */
const RAY_DEPTH = 4500;
/** Depth step per screen px among objects of one layer (keeps a layer inside its 1-unit band). */
const DEPTH_PER_PX = 1e-5;

/** Ground sheet size; repeating horizontally and vertically. */
const SAND_W = 512;
const SAND_H = 256;
/** World units around the room where dunes and fragments are scattered. */
const OUTSIDE_BAND = 650;
/** Fragments stay this far (world units) behind the back walls / in front of the front edges (tall ones must not overlap the floor). */
const BACK_MARGIN = 40;
const FRONT_MARGIN = 150;
/** Props keep this far from the room's edges and from each other (world units). */
const PROP_EDGE = 30;
const PROP_SPACING = 55;
const RAY_W = 128;
const RAY_H = 512;
/** Sun direction: rays fall from the top left (radians of rotation of a downward strip). */
const RAY_ANGLE = -0.45;
const RAY_SCALE_X = 1.6;
const RAY_SCALE_Y = 2.2;

const FRAGMENTS = ['drum', 'toppled', 'block', 'capital'] as const;
const PROPS = ['rubble', 'rubble', 'rubble', 'bush', 'bush', 'flowers', 'flowers', 'urn', 'urnBroken'] as const;

interface Mote {
  readonly image: Phaser.GameObjects.Image;
  readonly cx: number;
  readonly cy: number;
  readonly lateral: number;
  readonly speed: number;
  readonly phase: number;
  readonly alpha: number;
  along: number;
}

/** Stone colours of an iso block face. */
function isoBlock(ctx: CanvasRenderingContext2D, cx: number, base: number, rx: number, ry: number, h: number, top: string, left: string, right: string): void {
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(cx - rx, base - h);
  ctx.lineTo(cx, base - h + ry);
  ctx.lineTo(cx, base + ry);
  ctx.lineTo(cx - rx, base);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(cx + rx, base - h);
  ctx.lineTo(cx, base - h + ry);
  ctx.lineTo(cx, base + ry);
  ctx.lineTo(cx + rx, base);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.moveTo(cx, base - h - ry);
  ctx.lineTo(cx + rx, base - h);
  ctx.lineTo(cx, base - h + ry);
  ctx.lineTo(cx - rx, base - h);
  ctx.closePath();
  ctx.fill();
}

/** A soft mound of sand over an object's foot (it looks half buried). */
function sandMound(ctx: CanvasRenderingContext2D, look: OutsideLook, x: number, y: number, rx: number, ry: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, css(look.sandLight, 1));
  g.addColorStop(0.55, css(look.sand, 0.95));
  g.addColorStop(1, css(look.sand, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export class RuinsDecor {
  private objects: Phaser.GameObjects.GameObject[] = [];
  private motes: Mote[] = [];
  private ground: Phaser.GameObjects.TileSprite | undefined;
  private time = 0;

  constructor(private readonly scene: Phaser.Scene) {}

  /** Decorates room `t` for environment `env` (nothing for environments without outside / decor looks). */
  build(t: RoomTemplate, env: EnvironmentLook): void {
    this.clear();
    const seed = stringHash(`${env.id}:${t.id}`);
    if (env.outside) {
      this.buildOutside(t, env, env.outside, seed);
      this.buildDrifts(t, env, env.outside, seed ^ 0x5bd1e995);
    }
    if (env.decor) {
      this.buildProps(t, env, env.decor, seed ^ 0x27d4eb2f);
      this.buildRays(t, env, env.decor, seed ^ 0x165667b1);
    }
  }

  /** Dust motes drift along the sun rays and fade in and out at their ends. */
  update(dt: number): void {
    if (this.motes.length === 0) return;
    this.time += dt;
    const ax = -Math.sin(RAY_ANGLE);
    const ay = Math.cos(RAY_ANGLE);
    const len = RAY_H * RAY_SCALE_Y;
    const width = RAY_W * RAY_SCALE_X;
    for (const m of this.motes) {
      m.along = (m.along + m.speed * dt) % 1;
      const wobble = Math.sin(this.time * 0.8 + m.phase) * 0.06;
      const s = (m.along - 0.5) * len;
      const l = (m.lateral + wobble) * width;
      m.image.setPosition(m.cx + ax * s + ay * l, m.cy + ay * s - ax * l);
      m.image.setAlpha(m.alpha * Math.sin(Math.PI * m.along));
    }
  }

  clear(): void {
    for (const o of this.objects) o.destroy();
    this.objects = [];
    this.motes = [];
    this.ground = undefined;
  }

  /** Stretches the ground beyond the room over `area` (screen px); RoomView.fitView calls it on build and resize. */
  fitGround(area: GroundArea): void {
    fitTiles(this.ground, area);
  }

  /** The ground far past the room, dunes on it and half-buried fragments and dry bushes around the room. */
  private buildOutside(t: RoomTemplate, env: EnvironmentLook, look: OutsideLook, seed: number): void {
    // Sized by fitGround to what the camera can show, not a huge fixed sheet (the Canvas renderer backs a TileSprite
    // with a canvas of its full size).
    this.ground = this.scene.add.tileSprite(0, 0, 1, 1, this.sandTexture(env, look)).setOrigin(0, 0).setDepth(SAND_DEPTH);
    this.objects.push(this.ground);
    const rand = decorRandom(seed);
    const band = (): Vec2 => vec(-OUTSIDE_BAND + rand() * (t.width + 2 * OUTSIDE_BAND), -OUTSIDE_BAND + rand() * (t.height + 2 * OUTSIDE_BAND));
    // Outside the room, with room for tall things in front of the front edges.
    const clearOfRoom = (p: Vec2): boolean => p.x < -BACK_MARGIN || p.y < -BACK_MARGIN || p.x > t.width + FRONT_MARGIN || p.y > t.height + FRONT_MARGIN;
    for (let i = 0; i < look.dunes; i++) {
      const p = band();
      if (p.x > 0 && p.y > 0 && p.x < t.width && p.y < t.height) continue;
      const s = toScreen(p);
      const scale = 0.7 + rand() * 0.9;
      this.objects.push(
        this.scene.add
          .image(s.x, s.y, this.duneTexture(env, look, i % 3))
          .setScale(scale, scale * (0.8 + rand() * 0.4))
          .setFlipX(rand() < 0.5)
          .setDepth(DUNE_DEPTH + s.y * DEPTH_PER_PX),
      );
    }
    const scatter = (count: number, key: (i: number) => string, scaleMin: number, scaleRange: number): void => {
      for (let i = 0, tries = 0; i < count && tries < count * 20; tries++) {
        const p = band();
        if (!clearOfRoom(p)) continue;
        i++;
        const s = toScreen(p);
        this.objects.push(
          this.scene.add
            .image(s.x, s.y, key(i))
            .setOrigin(0.5, 0.8)
            .setScale(scaleMin + rand() * scaleRange)
            .setFlipX(rand() < 0.5)
            .setDepth(FRAGMENT_DEPTH + s.y * DEPTH_PER_PX),
        );
      }
    };
    scatter(look.fragments, (i) => this.fragmentTexture(env, look, FRAGMENTS[i % FRAGMENTS.length]!), 0.85, 0.45);
    scatter(look.bushes, () => this.dryBushTexture(env, look), 0.7, 0.6);
  }

  /** Sand drifting in over the floor along every edge (under the walls, which hide the drifts' upper halves). */
  private buildDrifts(t: RoomTemplate, env: EnvironmentLook, look: OutsideLook, seed: number): void {
    const rand = decorRandom(seed);
    const key = this.driftTexture(env, look);
    const angleX = Math.atan2(0.5, 1);
    const edge = (length: number, at: (d: number) => Vec2, angle: number): void => {
      const count = Math.max(1, Math.round((length / 1000) * look.drifts));
      for (let i = 0; i < count; i++) {
        const d = ((i + 0.2 + rand() * 0.6) / count) * length;
        const s = toScreen(at(d));
        const scale = 0.6 + rand() * 0.7;
        this.objects.push(this.scene.add.image(s.x, s.y, key).setRotation(angle).setScale(scale, scale * (0.7 + rand() * 0.4)).setDepth(DRIFT_DEPTH));
      }
    };
    edge(t.width, (d) => vec(d, 14), angleX);
    edge(t.height, (d) => vec(14, d), -angleX);
    edge(t.height, (d) => vec(t.width - 6, d), -angleX);
    edge(t.width, (d) => vec(d, t.height - 6), angleX);
  }

  /** Props on the floor, clear of every place where play happens. */
  private buildProps(t: RoomTemplate, env: EnvironmentLook, look: DecorLook, seed: number): void {
    const rand = decorRandom(seed);
    const keep: Vec2[] = [t.entry, ...t.spawnPoints, ...(t.kind === 'combat' ? [t.exit] : [t.altar, t.bossSpawn])];
    const count = Math.round(((t.width * t.height) / 1e6) * look.density);
    const placed: Vec2[] = [];
    for (let tries = 0; placed.length < count && tries < count * 40; tries++) {
      const p = vec(PROP_EDGE + rand() * (t.width - 2 * PROP_EDGE), PROP_EDGE + rand() * (t.height - 2 * PROP_EDGE));
      if (keep.some((k) => distance(k, p) < look.clearance)) continue;
      if ((t.obstacles ?? []).some((o) => distance(o.pos, p) < o.radius + 35)) continue;
      if (placed.some((q) => distance(q, p) < PROP_SPACING)) continue;
      placed.push(p);
      const kind = PROPS[Math.floor(rand() * PROPS.length)]!;
      const s = toScreen(p);
      this.objects.push(
        this.scene.add
          .image(s.x, s.y, this.propTexture(env, look, kind))
          .setOrigin(0.5, 0.85)
          .setScale(0.85 + rand() * 0.3)
          .setFlipX(rand() < 0.5)
          .setDepth(PROP_DEPTH + s.y * DEPTH_PER_PX),
      );
    }
  }

  /** Slanted sun shafts over the room; dust motes drift in them unless the player prefers reduced motion. */
  private buildRays(t: RoomTemplate, env: EnvironmentLook, look: DecorLook, seed: number): void {
    const rand = decorRandom(seed);
    const key = this.rayTexture(env);
    const dust = softDotTexture(this.scene);
    const motes = prefersReducedMotion() ? 0 : look.rays.motes;
    for (let i = 0; i < look.rays.count; i++) {
      // Spread across the room's width, a random depth.
      const u = (i + 0.3 + rand() * 0.4) / look.rays.count;
      const c = toScreen(vec(u * t.width, (0.2 + rand() * 0.6) * t.height));
      const ray = this.scene.add
        .image(c.x, c.y, key)
        .setRotation(RAY_ANGLE)
        .setScale(RAY_SCALE_X * (0.8 + rand() * 0.4), RAY_SCALE_Y)
        .setTint(look.rays.color)
        .setAlpha(look.rays.alpha)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(RAY_DEPTH);
      this.objects.push(ray);
      for (let m = 0; m < motes; m++) {
        const image = this.scene.add
          .image(c.x, c.y, dust)
          .setScale(0.05 + rand() * 0.05)
          .setTint(look.rays.color)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(RAY_DEPTH + 0.5)
          .setAlpha(0);
        this.objects.push(image);
        this.motes.push({ image, cx: c.x, cy: c.y, lateral: (rand() - 0.5) * 0.5, speed: 0.012 + rand() * 0.025, phase: rand() * Math.PI * 2, alpha: 0.45 + rand() * 0.45, along: rand() });
      }
    }
    this.update(0);
  }

  // --- Textures (one canvas per environment and kind) ---

  /** Seamless sand: soft patches, wind ripples (periods divide the sheet, so it tiles) and grain. */
  private sandTexture(env: EnvironmentLook, look: OutsideLook): string {
    return canvasTexture(this.scene, `ruins:sand:${env.id}`, SAND_W, SAND_H, (ctx) => {
      const rand = decorRandom(0x51ed270b);
      ctx.fillStyle = css(look.sand);
      ctx.fillRect(0, 0, SAND_W, SAND_H);
      const wrapped = (draw: (dx: number, dy: number) => void): void => {
        for (const dx of [-SAND_W, 0, SAND_W]) for (const dy of [-SAND_H, 0, SAND_H]) draw(dx, dy);
      };
      for (let i = 0; i < 14; i++) {
        const x = rand() * SAND_W;
        const y = rand() * SAND_H;
        const r = 40 + rand() * 90;
        const color = rand() < 0.5 ? look.sandLight : look.sandShadow;
        const alpha = 0.18 + rand() * 0.15;
        wrapped((dx, dy) => {
          ctx.save();
          ctx.translate(x + dx, y + dy);
          ctx.scale(1, 0.5);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          g.addColorStop(0, css(color, alpha));
          g.addColorStop(1, css(color, 0));
          ctx.fillStyle = g;
          ctx.fillRect(-r, -r, 2 * r, 2 * r);
          ctx.restore();
        });
      }
      // Wind ripples: short shallow arcs in loose rows (wrapped, so the sheet tiles without seams).
      for (let k = 0; k < 70; k++) {
        const x = rand() * SAND_W;
        const y = rand() * SAND_H;
        const len = 30 + rand() * 90;
        const bow = 2 + rand() * 4;
        const alpha = 0.12 + rand() * 0.16;
        wrapped((dx, dy) => {
          const x0 = x + dx - len / 2;
          const x1 = x + dx + len / 2;
          const yy = y + dy;
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = css(look.sandShadow, alpha * 1.4);
          ctx.beginPath();
          ctx.moveTo(x0, yy + 1.5);
          ctx.quadraticCurveTo((x0 + x1) / 2, yy - bow + 1.5, x1, yy + 1.5);
          ctx.stroke();
          ctx.strokeStyle = css(look.sandLight, alpha * 2);
          ctx.beginPath();
          ctx.moveTo(x0, yy);
          ctx.quadraticCurveTo((x0 + x1) / 2, yy - bow, x1, yy);
          ctx.stroke();
        });
      }
      for (let i = 0; i < 1600; i++) {
        ctx.fillStyle = rand() < 0.5 ? css(look.sandShadow, 0.25) : css(look.sandLight, 0.35);
        ctx.fillRect(Math.floor(rand() * SAND_W), Math.floor(rand() * SAND_H), 1 + Math.floor(rand() * 2), 1);
      }
    });
  }

  /** A soft dune: a lit mound, its shaded lee side and a crest line. */
  private duneTexture(env: EnvironmentLook, look: OutsideLook, variant: number): string {
    const w = 480;
    const h = 200;
    return canvasTexture(this.scene, `ruins:dune:${env.id}:${variant}`, w, h, (ctx) => {
      const cx = w / 2;
      const cy = h * 0.6;
      const blob = (x: number, y: number, rx: number, ry: number, inner: string, outer: string): void => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, ry / rx);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        g.addColorStop(0, inner);
        g.addColorStop(1, outer);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      blob(cx - 20, cy - 6, 215, 66, css(look.sandLight, 0.9), css(look.sand, 0));
      blob(cx + 46, cy + 20, 175, 44, css(look.sandShadow, 0.7), css(look.sandShadow, 0));
      // Crest: a wind-cut ridge; the lee side below it lies in shade that fades out down the slope.
      const peak = [-26, -34, -20][variant] ?? -26;
      const skew = [0.15, -0.2, 0.35][variant] ?? 0;
      const span = 150;
      const qx = cx + skew * span;
      const qy = cy + peak * 2;
      const lee = ctx.createLinearGradient(0, cy + peak, 0, cy + 30);
      lee.addColorStop(0, css(look.sandShadow, 0.5));
      lee.addColorStop(1, css(look.sandShadow, 0));
      ctx.fillStyle = lee;
      ctx.beginPath();
      ctx.moveTo(cx - span, cy + 8);
      ctx.quadraticCurveTo(qx, qy, cx + span, cy + 10);
      ctx.quadraticCurveTo(qx + 30, cy + 22, cx - span, cy + 8);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = css(look.sandLight, 0.8);
      ctx.beginPath();
      ctx.moveTo(cx - span * 0.8, cy + 2);
      ctx.quadraticCurveTo(qx, qy, cx + span * 0.8, cy + 4);
      ctx.stroke();
    });
  }

  /** Sand drift on the floor edge: a soft-edged tongue of sand with a ripple or two. */
  private driftTexture(env: EnvironmentLook, look: OutsideLook): string {
    const w = 256;
    const h = 96;
    return canvasTexture(this.scene, `ruins:drift:${env.id}`, w, h, (ctx) => {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(1, (h / w) * 0.95);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
      g.addColorStop(0, css(look.sand, 0.95));
      g.addColorStop(0.55, css(look.sand, 0.75));
      g.addColorStop(1, css(look.sand, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = 1.2;
      for (const [dy, len] of [[-6, 70], [6, 52]] as const) {
        ctx.strokeStyle = css(look.sandShadow, 0.35);
        ctx.beginPath();
        ctx.moveTo(w / 2 - len, h / 2 + dy + 1);
        ctx.quadraticCurveTo(w / 2, h / 2 + dy - 5, w / 2 + len, h / 2 + dy + 1);
        ctx.stroke();
        ctx.strokeStyle = css(look.sandLight, 0.5);
        ctx.beginPath();
        ctx.moveTo(w / 2 - len, h / 2 + dy);
        ctx.quadraticCurveTo(w / 2, h / 2 + dy - 6, w / 2 + len, h / 2 + dy);
        ctx.stroke();
      }
    });
  }

  /** Half-buried ruin fragments: a standing column drum, a toppled column, a wall block, a fallen capital. */
  private fragmentTexture(env: EnvironmentLook, look: OutsideLook, kind: (typeof FRAGMENTS)[number]): string {
    const [lit, mid, dark] = look.stone.map((c) => css(c)) as [string, string, string];
    const crack = css(look.stone[2], 0.6);
    if (kind === 'drum') {
      return canvasTexture(this.scene, `ruins:frag:drum:${env.id}`, 80, 80, (ctx) => {
        const cx = 40;
        const base = 64;
        const rx = 24;
        const ry = 12;
        const hgt = 30;
        const g = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
        g.addColorStop(0, dark);
        g.addColorStop(0.35, lit);
        g.addColorStop(1, dark);
        ctx.fillStyle = g;
        ctx.fillRect(cx - rx, base - hgt, rx * 2, hgt);
        ctx.beginPath();
        ctx.ellipse(cx, base, rx, ry, 0, 0, Math.PI);
        ctx.fill();
        ctx.fillStyle = mid;
        ctx.beginPath();
        ctx.ellipse(cx, base - hgt, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1.5;
        for (const f of [-0.55, -0.15, 0.25, 0.65]) {
          ctx.beginPath();
          ctx.moveTo(cx + f * rx, base - hgt + ry * 0.9);
          ctx.lineTo(cx + f * rx, base);
          ctx.stroke();
        }
        sandMound(ctx, look, cx + 4, base + 6, 38, 14);
      });
    }
    if (kind === 'toppled') {
      return canvasTexture(this.scene, `ruins:frag:toppled:${env.id}`, 170, 90, (ctx) => {
        ctx.save();
        ctx.translate(85, 52);
        ctx.rotate(Math.atan2(0.5, 1));
        const len = 120;
        const r = 15;
        const g = ctx.createLinearGradient(0, -r, 0, r);
        g.addColorStop(0, lit);
        g.addColorStop(0.45, mid);
        g.addColorStop(1, dark);
        ctx.fillStyle = g;
        ctx.fillRect(-len / 2, -r, len, r * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        ctx.lineWidth = 1.5;
        for (const f of [-0.5, 0, 0.5]) {
          ctx.beginPath();
          ctx.moveTo(-len / 2 + 6, f * r);
          ctx.lineTo(len / 2 - 4, f * r);
          ctx.stroke();
        }
        // Broken end (jagged) on the left, round cut end on the right.
        ctx.fillStyle = mid;
        ctx.beginPath();
        ctx.ellipse(len / 2, 0, 7, r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.beginPath();
        ctx.ellipse(len / 2, 0, 4, r * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.moveTo(-len / 2, -r);
        ctx.lineTo(-len / 2 - 6, -r * 0.4);
        ctx.lineTo(-len / 2 + 3, 0);
        ctx.lineTo(-len / 2 - 4, r * 0.5);
        ctx.lineTo(-len / 2, r);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        sandMound(ctx, look, 70, 70, 56, 14);
        sandMound(ctx, look, 120, 66, 30, 10);
      });
    }
    if (kind === 'block') {
      return canvasTexture(this.scene, `ruins:frag:block:${env.id}`, 90, 80, (ctx) => {
        isoBlock(ctx, 45, 58, 30, 15, 26, lit, mid, dark);
        ctx.strokeStyle = crack;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(15, 45);
        ctx.lineTo(45, 60);
        ctx.moveTo(45, 47);
        ctx.lineTo(75, 32);
        ctx.moveTo(30, 40);
        ctx.lineTo(30, 52);
        ctx.stroke();
        isoBlock(ctx, 24, 70, 12, 6, 8, lit, mid, dark);
        sandMound(ctx, look, 50, 72, 42, 13);
      });
    }
    return canvasTexture(this.scene, `ruins:frag:capital:${env.id}`, 80, 60, (ctx) => {
      isoBlock(ctx, 40, 40, 30, 15, 9, lit, mid, dark);
      ctx.fillStyle = mid;
      for (const x of [16, 64]) {
        ctx.beginPath();
        ctx.arc(x, 37, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, 37, 3, 0, Math.PI * 1.6);
        ctx.stroke();
      }
      sandMound(ctx, look, 44, 50, 36, 10);
    });
  }

  /** A dry desert bush: thin twigs fanning out of the sand. */
  private dryBushTexture(env: EnvironmentLook, look: OutsideLook): string {
    return canvasTexture(this.scene, `ruins:drybush:${env.id}`, 60, 44, (ctx) => {
      const rand = decorRandom(0x3c6ef372);
      ctx.lineCap = 'round';
      for (let i = 0; i < 16; i++) {
        const a = -Math.PI / 2 + (rand() - 0.5) * 2.4;
        const len = 10 + rand() * 18;
        const x0 = 30 + (rand() - 0.5) * 8;
        const y0 = 36;
        ctx.strokeStyle = css(look.dryBush[i % look.dryBush.length] ?? 0x8a6a3a, 0.95);
        ctx.lineWidth = 1 + rand() * 0.8;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x0 + Math.cos(a) * len * 0.5 + (rand() - 0.5) * 6, y0 + Math.sin(a) * len * 0.5, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len * 0.75);
        ctx.stroke();
      }
      sandMound(ctx, look, 30, 38, 16, 5);
    });
  }

  /** Floor props: rubble, a green bush, a flowering bush, an urn and a broken urn. */
  private propTexture(env: EnvironmentLook, look: DecorLook, kind: (typeof PROPS)[number]): string {
    const stone = env.walls;
    const [tLit, tMid, tDark] = look.terracotta.map((c) => css(c)) as [string, string, string];
    if (kind === 'rubble') {
      return canvasTexture(this.scene, `ruins:prop:rubble:${env.id}`, 60, 36, (ctx) => {
        const rand = decorRandom(0x1b873593);
        for (let i = 0; i < 6; i++) {
          const s = 4 + rand() * 6;
          isoBlock(ctx, 12 + rand() * 36, 22 + rand() * 8, s, s / 2, s * 0.6, css(stone.top), css(stone.bottom), css(stone.shadow, 0.9));
        }
      });
    }
    if (kind === 'bush' || kind === 'flowers') {
      return canvasTexture(this.scene, `ruins:prop:${kind}:${env.id}`, 50, 40, (ctx) => {
        const rand = decorRandom(kind === 'bush' ? 0x7f4a7c15 : 0x2545f491);
        ctx.fillStyle = 'rgba(40,28,10,0.25)';
        ctx.beginPath();
        ctx.ellipse(25, 33, 18, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 22; i++) {
          const color = look.bush[i % look.bush.length] ?? 0x5f7f30;
          ctx.fillStyle = css(color);
          ctx.beginPath();
          ctx.arc(25 + (rand() - 0.5) * 28, 24 - rand() * 14 + i * 0.25, 3 + rand() * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        if (kind === 'flowers') {
          for (let i = 0; i < 9; i++) {
            ctx.fillStyle = css(look.flowers[Math.floor(rand() * look.flowers.length)] ?? 0xf2d34a);
            ctx.beginPath();
            ctx.arc(25 + (rand() - 0.5) * 26, 14 + rand() * 14, 1.8 + rand() * 1.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      });
    }
    if (kind === 'urn') {
      return canvasTexture(this.scene, `ruins:prop:urn:${env.id}`, 34, 48, (ctx) => {
        ctx.fillStyle = 'rgba(40,28,10,0.25)';
        ctx.beginPath();
        ctx.ellipse(18, 43, 13, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        const g = ctx.createLinearGradient(5, 0, 29, 0);
        g.addColorStop(0, tMid);
        g.addColorStop(0.35, tLit);
        g.addColorStop(1, tDark);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(13, 12);
        ctx.bezierCurveTo(2, 18, 3, 36, 12, 42);
        ctx.lineTo(22, 42);
        ctx.bezierCurveTo(31, 36, 32, 18, 21, 12);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(13, 5, 8, 8);
        ctx.fillStyle = tLit;
        ctx.beginPath();
        ctx.ellipse(17, 5, 6, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = tDark;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(10, 14, 4, Math.PI * 0.5, Math.PI * 1.4);
        ctx.arc(24, 14, 4, Math.PI * 1.6, Math.PI * 0.5);
        ctx.stroke();
        // Painted band (gold accent).
        ctx.strokeStyle = 'rgba(217,168,56,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(6, 25);
        ctx.quadraticCurveTo(17, 29, 28, 25);
        ctx.stroke();
      });
    }
    return canvasTexture(this.scene, `ruins:prop:urnBroken:${env.id}`, 48, 30, (ctx) => {
      ctx.fillStyle = 'rgba(40,28,10,0.22)';
      ctx.beginPath();
      ctx.ellipse(24, 24, 18, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      // Lower half of an urn lying on its side, open to the left, shards around.
      ctx.fillStyle = tMid;
      ctx.beginPath();
      ctx.ellipse(26, 17, 12, 8, 0.2, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(16, 23);
      ctx.lineTo(18, 13);
      ctx.lineTo(14, 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = tDark;
      ctx.beginPath();
      ctx.ellipse(17, 16, 3, 6, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = tLit;
      for (const [x, y] of [[6, 22], [40, 24], [10, 26]] as const) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 5, y - 2);
        ctx.lineTo(x + 3, y + 2);
        ctx.closePath();
        ctx.fill();
      }
    });
  }

  /** White sun shaft: bright along its middle, fading to the sides and towards its lower end. */
  private rayTexture(env: EnvironmentLook): string {
    return canvasTexture(this.scene, `ruins:ray:${env.id}`, RAY_W, RAY_H, (ctx) => {
      const across = ctx.createLinearGradient(0, 0, RAY_W, 0);
      across.addColorStop(0, 'rgba(255,255,255,0)');
      across.addColorStop(0.5, 'rgba(255,255,255,1)');
      across.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = across;
      ctx.fillRect(0, 0, RAY_W, RAY_H);
      ctx.globalCompositeOperation = 'destination-in';
      const along = ctx.createLinearGradient(0, 0, 0, RAY_H);
      along.addColorStop(0, 'rgba(255,255,255,0)');
      along.addColorStop(0.2, 'rgba(255,255,255,1)');
      along.addColorStop(1, 'rgba(255,255,255,0.1)');
      ctx.fillStyle = along;
      ctx.fillRect(0, 0, RAY_W, RAY_H);
      ctx.globalCompositeOperation = 'source-over';
    });
  }
}

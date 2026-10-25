import * as Phaser from 'phaser';
import type { HostileZone } from '../core/world/world';
import { softDotTexture, sparkTexture } from './fxTextures';

// Visuals of elite modifiers (docs/design/mobs.md «Еліти», decisions 2026-10-25): the per-modifier outline / glow and
// colour, the exploding elite's death circle and blast, fiery projectiles and zones, the hero burning (fiery hits) and
// the fast elite's speed streaks. Render-only: every number here is a visual constant; radii, timers and who is
// burning come from core state (MobState.eliteModifier, HostileZone, PlayerState.ignite).
// Cheap on purpose: drawn into the scene's two fx Graphics, bursts pooled, two particle emitters for the whole run.

/** Colour of each modifier (designer: fast yellow, fat green, fiery orange, explosive red); `css` for its name label. */
export interface EliteLook {
  readonly color: number;
  readonly css: string;
}

const ELITE_LOOKS: Readonly<Record<string, EliteLook>> = {
  fast: { color: 0xffe14a, css: '#ffe45a' },
  fat: { color: 0x5ee05a, css: '#7af070' },
  fiery: { color: 0xff8a1e, css: '#ff9a3a' },
  explosive: { color: 0xff2e2e, css: '#ff5a50' },
};
/** A modifier without a look of its own (new data before its colour is picked): the old elite gold. */
const DEFAULT_LOOK: EliteLook = { color: 0xffc23a, css: '#ffd36a' };

export function eliteLook(modifier: string): EliteLook {
  return ELITE_LOOKS[modifier] ?? DEFAULT_LOOK;
}

/** Fire palette (fiery projectiles / zones, the death blast, hero burn). */
const FIRE_DARK = 0x3a0800;
const FIRE_RED = 0xff3a12;
const FIRE = 0xff7a1a;
const FIRE_LIGHT = 0xffc060;
const FIRE_CORE = 0xfff0b0;

/** Glow outline round an elite sprite (WebGL filter): strength breathes between these. */
const GLOW_STRENGTH = 2.6;
const GLOW_PULSE = 0.9;
const GLOW_QUALITY = 6;
const GLOW_DISTANCE = 7;

const BLAST_TTL = 0.6;
const MAX_BURSTS = 24;
/** Flame tongues licking round the rim of the death circle. */
const RIM_FLAMES = 12;
/** Embers per second off a fiery elite, off a death circle, off the burning hero, off a fiery projectile. */
const FIERY_EMBER_RATE = 4;
const ZONE_EMBER_RATE = 10;
const HERO_EMBER_RATE = 16;
const PROJECTILE_EMBER_RATE = 22;
/** Flames on the burning hero. */
const HERO_FLAMES = 5;

interface Burst {
  active: boolean;
  x: number;
  y: number;
  /** World radius (2r × r ellipse on screen). */
  radius: number;
  age: number;
  ttl: number;
  spin: number;
}

/** Hashes a number into 0..1 (stable per zone, so shapes do not jump between frames). */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class EliteFx {
  private readonly embers: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bursts: Burst[] = [];
  private readonly webgl: boolean;

  constructor(scene: Phaser.Scene) {
    this.webgl = scene.sys.game.renderer.type === Phaser.WEBGL;
    this.embers = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speedY: { min: -45, max: -95 },
        speedX: { min: -16, max: 16 },
        scale: { start: 0.24, end: 0.02 },
        alpha: { start: 0.95, end: 0 },
        color: [FIRE_CORE, 0xffa030, FIRE_RED],
        lifespan: { min: 360, max: 640 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 220,
        reserve: 48,
      })
      .setDepth(4002);
    this.sparks = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 80, max: 220 },
        angle: { min: 0, max: 360 },
        gravityY: 220,
        scale: { start: 1.5, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, FIRE_LIGHT, FIRE],
        lifespan: { min: 260, max: 520 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 140,
        reserve: 32,
      })
      .setDepth(4002);
  }

  /** Drops running bursts (room change). */
  clear(): void {
    for (const b of this.bursts) b.active = false;
  }

  /**
   * A coloured glow outline on an elite's sprite (WebGL only; the canvas renderer keeps the coloured ground ring and
   * the name). Returns the filter so the scene can make it breathe and drop it when the elite dies.
   */
  addGlow(sprite: Phaser.GameObjects.Sprite, modifier: string): Phaser.Filters.Glow | undefined {
    if (!this.webgl) return undefined;
    sprite.enableFilters();
    return sprite.filters?.internal.addGlow(eliteLook(modifier).color, GLOW_STRENGTH, 0, 1, false, GLOW_QUALITY, GLOW_DISTANCE);
  }

  /** Breathing glow strength; `phase` desynchronises elites. */
  pulseGlow(glow: Phaser.Filters.Glow, time: number, phase: number): void {
    glow.outerStrength = GLOW_STRENGTH + GLOW_PULSE * Math.sin(time * 4 + phase);
  }

  /** Removes an elite's glow (it died: the corpse fades without it). */
  removeGlow(sprite: Phaser.GameObjects.Sprite, glow: Phaser.Filters.Glow | undefined): void {
    if (glow) sprite.filters?.internal.remove(glow, true);
  }

  /**
   * Per-frame extras of a living elite at screen (x, y) (feet), body height `h` px: embers off one whose damage is
   * fire, speed streaks behind a moving faster one (`vx`, `vy`: its screen velocity, px/s). The flags come from the
   * modifier's data (RunScene), the colour from its id.
   */
  drawElite(top: Phaser.GameObjects.Graphics, elite: { readonly modifier: string; readonly fire: boolean; readonly fast: boolean }, x: number, y: number, radius: number, h: number, vx: number, vy: number, time: number, dt: number): void {
    if (elite.fire && Math.random() < FIERY_EMBER_RATE * dt) {
      this.embers.emitParticleAt(x + (Math.random() - 0.5) * radius * 1.6, y - 10 - Math.random() * h * 0.6, 1);
    }
    if (elite.fast) {
      const speed = Math.hypot(vx, vy);
      if (speed < 20) return;
      const ux = vx / speed;
      const uy = vy / speed;
      const look = eliteLook(elite.modifier).color;
      const a = Math.min(1, speed / 160);
      // Three streaks trailing behind the body at hip, chest and head height, flickering in length.
      for (let i = 0; i < 3; i++) {
        const hy = y - h * (0.25 + 0.25 * i);
        const side = (i - 1) * radius * 0.35;
        const sx = x - ux * radius * 0.9 + -uy * side;
        const sy = hy - uy * radius * 0.45 + ux * side * 0.5;
        const len = (22 + 10 * Math.sin(time * 30 + i * 2.1)) * a;
        top.lineStyle(i === 1 ? 3 : 2, look, (0.5 - 0.1 * i) * a).lineBetween(sx, sy, sx - ux * len, sy - uy * len);
      }
    }
  }

  /**
   * The exploding elite's death circle at screen (x, y): a red danger disc whose orange core fills up over the delay,
   * a countdown ring closing in from the rim, flame tongues on the rim and a white-hot flicker just before it blows.
   * Deliberately red / orange so it never reads as the necromancer's violet grave circles.
   */
  drawDeathZone(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, zone: HostileZone, x: number, y: number, time: number, dt: number): void {
    const p = zone.total > 0 ? Phaser.Math.Clamp(1 - zone.remaining / zone.total, 0, 1) : 1;
    const r = zone.radius;
    const appear = Math.min(1, p * 8);
    const late = zone.remaining < 0.25;
    const flicker = late && Math.floor(time * 24) % 2 === 0;
    const pulse = 0.5 + 0.5 * Math.sin(time * 18);
    g.fillStyle(FIRE_DARK, 0.55 * appear).fillEllipse(x, y, r * 2, r);
    g.fillStyle(FIRE_RED, (0.16 + 0.1 * pulse) * appear).fillEllipse(x, y, r * 2, r);
    g.fillStyle(late ? FIRE_LIGHT : FIRE, (0.3 + 0.35 * p) * appear).fillEllipse(x, y, r * 2 * p, r * p);
    // Countdown: a bright ring closing in from the rim to the centre as the blast nears.
    const c = 1 - p;
    if (c > 0.02) g.lineStyle(2, FIRE_LIGHT, 0.75 * appear).strokeEllipse(x, y, r * 2 * c, r * c);
    g.lineStyle(flicker ? 5 : 3, flicker ? 0xffffff : FIRE_RED, (0.75 + 0.25 * p) * appear).strokeEllipse(x, y, r * 2, r);
    g.lineStyle(1.5, FIRE, 0.6 * appear).strokeEllipse(x, y, r * 2 * 1.08, r * 1.08);
    // Flame tongues round the rim, growing as it charges (stable per zone, flickering in height).
    const height = (6 + 12 * p) * appear;
    for (let i = 0; i < RIM_FLAMES; i++) {
      const a = (i / RIM_FLAMES) * Math.PI * 2 + hash01(zone.id + i) * 0.4;
      const fx = x + Math.cos(a) * r;
      const fy = y + Math.sin(a) * r * 0.5;
      const w = 4 + 2 * hash01(zone.id * 5 + i);
      const fh = height * (0.65 + 0.35 * Math.sin(time * 20 + i * 1.7));
      top.fillStyle(FIRE, 0.8 * appear).fillTriangle(fx - w, fy, fx + w, fy, fx, fy - fh);
      top.fillStyle(FIRE_CORE, 0.85 * appear).fillTriangle(fx - w * 0.45, fy, fx + w * 0.45, fy, fx, fy - fh * 0.5);
    }
    if (Math.random() < ZONE_EMBER_RATE * dt) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * r;
      this.embers.emitParticleAt(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.5 - 4, 1);
    }
  }

  /** The death circle blew at screen (x, y), world radius r: a white-hot flash, a red shockwave and sparks. */
  blast(x: number, y: number, r: number): void {
    let b = this.bursts.find((s) => !s.active);
    if (!b) {
      if (this.bursts.length >= MAX_BURSTS) return;
      b = { active: false, x: 0, y: 0, radius: 0, age: 0, ttl: 1, spin: 0 };
      this.bursts.push(b);
    }
    b.active = true;
    b.x = x;
    b.y = y;
    b.radius = r;
    b.age = 0;
    b.ttl = BLAST_TTL;
    b.spin = Math.random() * Math.PI * 2;
    this.sparks.emitParticleAt(x, y - 10, 18);
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * r * 0.9;
      this.embers.emitParticleAt(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.5 - 6, 1);
    }
  }

  /** A fiery mob attacked at screen (x, y) (feet), facing screen direction (dx, dy): a few sparks at its weapon. */
  fireSwing(x: number, y: number, dx: number, dy: number, h: number): void {
    const len = Math.hypot(dx, dy) || 1;
    this.sparks.emitParticleAt(x + (dx / len) * 24, y - h * 0.5 + (dy / len) * 12, 5);
  }

  /** A fiery zone (not a death circle) erupted at screen (x, y): fire sparks over the regular eruption. */
  fireErupt(x: number, y: number): void {
    this.sparks.emitParticleAt(x, y - 8, 10);
    for (let i = 0; i < 5; i++) this.embers.emitParticleAt(x + (Math.random() - 0.5) * 40, y - Math.random() * 10, 1);
  }

  /** The hero just caught fire at screen (x, y): a puff of embers. */
  ignited(x: number, y: number, h: number): void {
    this.sparks.emitParticleAt(x, y - h * 0.5, 8);
    for (let i = 0; i < 6; i++) this.embers.emitParticleAt(x + (Math.random() - 0.5) * 30, y - Math.random() * h * 0.7, 1);
  }

  /**
   * The hero burning at screen (x, y) (feet), body height `h` px: flames flickering round the body, a hot ground
   * glow and embers rising. `fade` 0..1 dims it over the last moments of the burn.
   */
  drawHeroBurn(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, x: number, y: number, h: number, time: number, dt: number, fade: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 15);
    g.fillStyle(FIRE, (0.18 + 0.1 * pulse) * fade).fillEllipse(x, y, 54, 27);
    // A warm haze round the body, then flames hugging it: flanks and front at different heights, each flickering,
    // with a rounded base and a swaying tip so they read as fire rather than spikes.
    top.fillStyle(FIRE, (0.1 + 0.06 * pulse) * fade).fillEllipse(x, y - h * 0.4, 44, h * 0.85);
    for (let i = 0; i < HERO_FLAMES; i++) {
      const side = (i / (HERO_FLAMES - 1) - 0.5) * 2;
      const fx = x + side * 14;
      const fy = y - 4 - h * (0.12 + 0.22 * (1 - Math.abs(side))) + (i % 2) * 6;
      const fh = (13 + 11 * Math.abs(Math.sin(time * 11 + i * 1.9))) * fade;
      const w = 5 + (i % 2) * 2;
      const sway = Math.sin(time * 9 + i * 2.3) * 3;
      top.fillStyle(FIRE, 0.75 * fade).fillCircle(fx, fy, w).fillTriangle(fx - w, fy, fx + w, fy, fx + sway, fy - fh);
      top.fillStyle(FIRE_LIGHT, 0.85 * fade).fillCircle(fx, fy + 1, w * 0.55).fillTriangle(fx - w * 0.55, fy + 1, fx + w * 0.55, fy + 1, fx + sway * 0.6, fy - fh * 0.55);
    }
    if (Math.random() < HERO_EMBER_RATE * dt * fade) this.embers.emitParticleAt(x + (Math.random() - 0.5) * 28, y - 8 - Math.random() * h * 0.7, 1);
  }

  /**
   * A fiery mob projectile: screen head (x, y) and tail (tx, ty), already lifted. `halo` only: a fire glow round a
   * projectile that keeps its own shape (thrown bones); otherwise a full fire bolt.
   */
  drawFireBolt(top: Phaser.GameObjects.Graphics, x: number, y: number, tx: number, ty: number, radius: number, dt: number, halo: boolean): void {
    top.fillStyle(FIRE_RED, 0.25).fillCircle(x, y, radius * 2.6);
    top.lineStyle(radius * 1.4, FIRE, 0.35).lineBetween(tx, ty, x, y);
    if (!halo) {
      top.lineStyle(radius * 0.7, FIRE_LIGHT, 0.8).lineBetween(tx + (x - tx) * 0.4, ty + (y - ty) * 0.4, x, y);
      top.fillStyle(FIRE, 0.9).fillCircle(x, y, radius * 1.3);
      top.fillStyle(FIRE_CORE, 1).fillCircle(x, y, radius * 0.7);
    }
    if (Math.random() < PROJECTILE_EMBER_RATE * dt) this.embers.emitParticleAt(tx, ty, 1);
  }

  /** Advances and draws the blasts: ground parts into `g`, flames into `top`. */
  drawBursts(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, dt: number): void {
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.ttl) {
        b.active = false;
        continue;
      }
      const t = b.age / b.ttl;
      const fade = 1 - t;
      const r = b.radius;
      const grow = 1 - (1 - Math.min(1, t * 2.2)) ** 3;
      // White-hot flash filling the circle, then a red fireball disc and a shockwave rolling past the rim.
      if (t < 0.18) g.fillStyle(FIRE_CORE, 0.75 * (1 - t / 0.18)).fillEllipse(b.x, b.y, r * 2, r);
      g.fillStyle(FIRE_RED, 0.4 * fade).fillEllipse(b.x, b.y, r * 2 * (0.5 + 0.5 * grow), r * (0.5 + 0.5 * grow));
      g.fillStyle(FIRE_LIGHT, 0.5 * fade * fade).fillEllipse(b.x, b.y, r * 1.1 * grow, r * 0.55 * grow);
      const shock = r * (0.6 + 0.65 * grow);
      g.lineStyle(7 * fade + 1, FIRE, 0.9 * fade).strokeEllipse(b.x, b.y, shock * 2, shock);
      g.lineStyle(2, 0xffffff, 0.7 * fade).strokeEllipse(b.x, b.y, shock * 1.85, shock * 0.925);
      // A rising fireball over the centre.
      const lift = 10 + 30 * grow;
      top.fillStyle(FIRE, 0.55 * fade).fillCircle(b.x, b.y - lift, 10 + r * 0.22 * grow);
      top.fillStyle(FIRE_LIGHT, 0.7 * fade * fade).fillCircle(b.x, b.y - lift, 6 + r * 0.12 * grow);
      // Flame tongues on the rolling edge.
      const height = (14 + r * 0.3) * (1 - t * 0.7);
      for (let i = 0; i < RIM_FLAMES; i++) {
        const a = b.spin + (i * Math.PI * 2) / RIM_FLAMES;
        const fx = b.x + Math.cos(a) * shock * 0.9;
        const fy = b.y + Math.sin(a) * shock * 0.45;
        const w = 5 + (i % 3) * 2;
        const fh = height * (0.7 + 0.3 * Math.sin(a * 3 + b.age * 30));
        top.fillStyle(FIRE, 0.85 * fade).fillTriangle(fx - w, fy, fx + w, fy, fx, fy - fh);
        top.fillStyle(FIRE_CORE, 0.9 * fade).fillTriangle(fx - w * 0.45, fy, fx + w * 0.45, fy, fx, fy - fh * 0.55);
      }
    }
  }
}

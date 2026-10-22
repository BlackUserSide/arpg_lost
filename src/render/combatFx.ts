import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';

// Combat VFX that read core state but never change it: status looks on mobs (ignite embers, freeze ice patch,
// stun dots, stun bar), death explosion bursts and the Guardian counter cue. Everything here is visual-only constants; screen coordinates in.
// Cheap on purpose: one pooled particle emitter, everything else drawn into the scene's two fx Graphics.

/** Approximate body height of a mob sprite above its feet, in screen px (sprites are 128 px, feet at 104). */
const BODY_HEIGHT = 52;

export interface StatusLook {
  readonly color: number;
  readonly mode: Phaser.TintModes;
}

/** Screen tint washes the sprite towards pale ice instead of darkening it. */
const FREEZE_LOOK: StatusLook = { color: 0x3f86c0, mode: Phaser.TintModes.SCREEN };
const STUN_LOOK: StatusLook = { color: 0xfff27a, mode: Phaser.TintModes.MULTIPLY };
/** Additive warm glow, flickering between two strengths. */
const IGNITE_LOOKS: readonly StatusLook[] = [
  { color: 0x6a2400, mode: Phaser.TintModes.ADD },
  { color: 0x3c1400, mode: Phaser.TintModes.ADD },
];
const SLOW_LOOK: StatusLook = { color: 0xb4dcff, mode: Phaser.TintModes.MULTIPLY };
/** Embers per second rising from an ignited mob. */
const EMBER_RATE = 7;

const FIRE_BURST_TTL = 0.5;
const ICE_BURST_TTL = 0.6;
const FLAME_TONGUES = 10;
const ICE_SHARDS = 12;
const MAX_BURSTS = 48;

/**
 * Stun bar under a mob's feet (screen px): clear of the damage numbers and stun dots overhead. Offset below the feet.
 */
const STUN_BAR_WIDTH = 30;
const STUN_BAR_HEIGHT = 4;
const STUN_BAR_DROP = 9;
const STUN_BAR_COLOR = 0xffc93c;
const STUN_BAR_BACK = 0x14110a;
/** Seconds the bar flashes full after it stunned (visual only). */
export const STUN_BAR_FLASH = 0.4;

/** Counter cue: a golden slash crescent toward the target and a shield icon popping over the hero. */
const COUNTER_TTL = 0.45;
const COUNTER_COLOR = 0xffd36a;
const COUNTER_REACH = 42;

export type BurstKind = 'fire' | 'ice';

interface Burst {
  active: boolean;
  kind: BurstKind | 'counter';
  x: number;
  y: number;
  /** World radius: on screen a 2r × r ellipse. */
  radius: number;
  age: number;
  ttl: number;
  /** Per-burst angle offset so neighbouring bursts do not look stamped; for 'counter' the screen facing angle. */
  spin: number;
}

/** Tint for a mob's statuses, strongest first: freeze, stun, ignite (flickering), slow; undefined = no tint. */
export function statusLook(freeze: number, stun: number, ignite: number, slow: number, time: number, id: number): StatusLook | undefined {
  if (freeze > 0) return FREEZE_LOOK;
  if (stun > 0) return STUN_LOOK;
  if (ignite > 0) return IGNITE_LOOKS[Math.floor(time * 9 + id * 0.37) % 2];
  if (slow > 0) return SLOW_LOOK;
  return undefined;
}

export class CombatFx {
  private readonly embers: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly guardSparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bursts: Burst[] = [];

  constructor(scene: Phaser.Scene) {
    // Embers rising off burning mobs and fire bursts.
    this.embers = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speedY: { min: -40, max: -90 },
        speedX: { min: -14, max: 14 },
        scale: { start: 0.22, end: 0.02 },
        alpha: { start: 0.95, end: 0 },
        color: [0xfff0a0, 0xffa030, 0xff5a1a],
        lifespan: { min: 380, max: 620 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 240,
        reserve: 64,
      })
      .setDepth(4002);
    // Ice glints for frost bursts.
    this.sparks = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 40, max: 140 },
        angle: { min: 180, max: 360 },
        gravityY: 160,
        scale: { start: 1.3, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, 0xcff2ff, 0x8fd3ff],
        lifespan: { min: 300, max: 520 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 160,
        reserve: 32,
      })
      .setDepth(4002);
    // Golden sparks for the counter cue and the full stun bar.
    this.guardSparks = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 50, max: 150 },
        angle: { min: 0, max: 360 },
        gravityY: 120,
        scale: { start: 1.2, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, 0xffe9a8, COUNTER_COLOR],
        lifespan: { min: 220, max: 420 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 96,
        reserve: 24,
      })
      .setDepth(4002);
  }

  /**
   * Stun bar under a living mob at screen (x, y) (its feet). `fill` 0..1 is the displayed fill; `flash` > 0 is the
   * remaining full-bar flash time after a stun (STUN_BAR_FLASH..0). Draws nothing when both are 0.
   */
  drawStunBar(top: Phaser.GameObjects.Graphics, x: number, y: number, fill: number, flash: number): void {
    if (fill <= 0 && flash <= 0) return;
    const by = y + STUN_BAR_DROP;
    if (flash > 0) {
      // Full bar flickering white / gold, swelling a little, fading out over its last third.
      const t = 1 - flash / STUN_BAR_FLASH;
      const fade = Math.min(1, flash / (STUN_BAR_FLASH / 3));
      const w = STUN_BAR_WIDTH * (1 + 0.25 * Math.sin(Math.PI * Math.min(1, t * 2)));
      const h = STUN_BAR_HEIGHT + 2;
      top.fillStyle(COUNTER_COLOR, 0.35 * fade).fillRect(x - w / 2 - 3, by - h / 2 - 3, w + 6, h + 6);
      top.fillStyle(Math.floor(t * 12) % 2 === 0 ? 0xffffff : STUN_BAR_COLOR, fade).fillRect(x - w / 2, by - h / 2, w, h);
      return;
    }
    const w = STUN_BAR_WIDTH;
    const h = STUN_BAR_HEIGHT;
    const left = x - w / 2;
    const filled = w * Math.min(1, fill);
    top.fillStyle(STUN_BAR_BACK, 0.75).fillRect(left - 1, by - h / 2 - 1, w + 2, h + 2);
    top.fillStyle(STUN_BAR_COLOR, 1).fillRect(left, by - h / 2, filled, h);
    // Bright top edge so the thin bar reads on dark floors.
    top.fillStyle(0xfff4c4, 0.8).fillRect(left, by - h / 2, filled, 1);
  }

  /** Golden sparks at a mob's stun bar when the full bar stuns it; (x, y) are its feet. */
  stunBarBurst(x: number, y: number): void {
    this.guardSparks.emitParticleAt(x, y + STUN_BAR_DROP, 8);
  }

  /** Counter cue at the hero's feet (x, y), toward screen direction (dx, dy). */
  counter(x: number, y: number, dx: number, dy: number): void {
    const burst = this.bursts.find((b) => !b.active) ?? (this.bursts.length < MAX_BURSTS ? this.newBurst() : undefined);
    if (!burst) return;
    burst.active = true;
    burst.kind = 'counter';
    burst.x = x;
    burst.y = y;
    burst.radius = COUNTER_REACH;
    burst.age = 0;
    burst.ttl = COUNTER_TTL;
    burst.spin = Math.atan2(dy, dx);
    this.guardSparks.emitParticleAt(x + Math.cos(burst.spin) * COUNTER_REACH, y - BODY_HEIGHT * 0.5 + Math.sin(burst.spin) * COUNTER_REACH * 0.5, 7);
  }

  /**
   * Per-frame status visuals of one living mob at screen (x, y) (its feet). `radius` is the mob's world radius.
   * Ground layer (ice patch) goes into `ground`, overhead marks (stun dots) into `top`.
   */
  drawMobStatus(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, x: number, y: number, radius: number, freeze: number, stun: number, ignite: number, time: number, dt: number, id: number): void {
    if (freeze > 0) {
      // Ice patch under the frozen mob; fades out over its last half second.
      const a = Math.min(1, freeze / 0.5);
      ground.fillStyle(0x9fe4ff, 0.32 * a).fillEllipse(x, y, radius * 3, radius * 1.5);
      ground.lineStyle(1.5, 0xe6f8ff, 0.7 * a).strokeEllipse(x, y, radius * 3, radius * 1.5);
    }
    if (stun > 0) {
      // Three dots circling over the head.
      const hy = y - BODY_HEIGHT - 8;
      for (let i = 0; i < 3; i++) {
        const a = time * 5 + (i * Math.PI * 2) / 3 + id;
        const sx = x + Math.cos(a) * 11;
        const sy = hy + Math.sin(a) * 4;
        top.fillStyle(0xfff27a, Math.sin(a) > 0 ? 1 : 0.55).fillCircle(sx, sy, 2.5);
      }
    }
    // Frozen mobs do not burn visibly (the ice reads first); the ignite is still on and shows when the ice melts.
    if (ignite > 0 && freeze <= 0 && Math.random() < EMBER_RATE * dt) {
      this.embers.emitParticleAt(x + (Math.random() - 0.5) * radius * 1.6, y - 8 - Math.random() * (BODY_HEIGHT - 12), 1);
    }
  }

  /** Death explosion centred at screen (x, y) with world radius `radius`. */
  deathExplosion(kind: BurstKind, x: number, y: number, radius: number): void {
    const burst = this.bursts.find((b) => !b.active) ?? (this.bursts.length < MAX_BURSTS ? this.newBurst() : undefined);
    if (!burst) return;
    burst.active = true;
    burst.kind = kind;
    burst.x = x;
    burst.y = y;
    burst.radius = radius;
    burst.age = 0;
    burst.ttl = kind === 'fire' ? FIRE_BURST_TTL : ICE_BURST_TTL;
    burst.spin = Math.random() * Math.PI * 2;
    // A handful of particles on top of the drawn burst; capped so chain reactions stay cheap.
    const count = Math.min(14, 4 + Math.round(radius / 10));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * radius * 0.8;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d * 0.5;
      if (kind === 'fire') this.embers.emitParticleAt(px, py - 6, 1);
      else this.sparks.emitParticleAt(px, py - 4, 1);
    }
  }

  /** Advances and draws the bursts: ground layers into `ground`, flames / shards into `top`. */
  drawBursts(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, dt: number): void {
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.ttl) {
        b.active = false;
        continue;
      }
      if (b.kind === 'fire') this.drawFire(ground, top, b);
      else if (b.kind === 'ice') this.drawIce(ground, top, b);
      else this.drawCounter(top, b);
    }
  }

  private newBurst(): Burst {
    const burst: Burst = { active: false, kind: 'fire', x: 0, y: 0, radius: 0, age: 0, ttl: 1, spin: 0 };
    this.bursts.push(burst);
    return burst;
  }

  /** Pyre: a hot flash that rolls out to the edge, a ring of flame tongues licking upwards. */
  private drawFire(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const grow = 1 - (1 - Math.min(1, t * 1.8)) ** 3;
    const r = b.radius * (0.35 + 0.65 * grow);
    g.fillStyle(0xff4a12, 0.3 * fade).fillEllipse(b.x, b.y, r * 2, r);
    g.fillStyle(0xffc060, 0.45 * fade * fade).fillEllipse(b.x, b.y, r * 1.1, r * 0.55);
    g.lineStyle(3, 0xffa040, 0.9 * fade).strokeEllipse(b.x, b.y, r * 2, r);
    // Flame tongues on the rolling edge, tallest at the start.
    const height = (10 + b.radius * 0.35) * (1 - t * 0.7);
    for (let i = 0; i < FLAME_TONGUES; i++) {
      const a = b.spin + (i * Math.PI * 2) / FLAME_TONGUES;
      const fx = b.x + Math.cos(a) * r * 0.92;
      const fy = b.y + Math.sin(a) * r * 0.46;
      const w = 5 + (i % 3) * 2;
      const h = height * (0.7 + 0.3 * Math.sin(a * 3 + b.age * 30));
      top.fillStyle(0xff6a1a, 0.85 * fade).fillTriangle(fx - w, fy, fx + w, fy, fx, fy - h);
      top.fillStyle(0xffe08a, 0.9 * fade).fillTriangle(fx - w * 0.45, fy, fx + w * 0.45, fy, fx, fy - h * 0.55);
    }
  }

  /** Counter: a quick golden crescent swept toward the target at chest height and a shield icon popping overhead. */
  private drawCounter(top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    // Crescent: an arc of short strokes around the facing (iso-squashed), widening as it sweeps.
    const cy = b.y - BODY_HEIGHT * 0.5;
    const sweep = Math.min(1, t * 4);
    const reach = b.radius * (0.85 + 0.15 * sweep);
    const half = 0.5 + 0.6 * sweep;
    const segments = 6;
    let px = b.x + Math.cos(b.spin - half) * reach;
    let py = cy + Math.sin(b.spin - half) * reach * 0.5;
    for (let i = 1; i <= segments; i++) {
      const a = b.spin - half + (2 * half * i) / segments;
      const nx = b.x + Math.cos(a) * reach;
      const ny = cy + Math.sin(a) * reach * 0.5;
      // Thickest in the middle of the crescent.
      top.lineStyle(i === 1 || i === segments ? 2 : 4, COUNTER_COLOR, 0.95 * fade).lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }
    // Shield icon in front of the hero, toward the attacker (no text, so nothing to translate; clear of the
    // damage numbers overhead): pops in with overshoot, fades.
    const pop = t < 0.2 ? 0.6 + 0.6 * (t / 0.2) : 1.2 - 0.2 * Math.min(1, (t - 0.2) / 0.15);
    const sx = b.x + Math.cos(b.spin) * b.radius * 0.55;
    const sy = cy + Math.sin(b.spin) * b.radius * 0.275 - 6;
    const w = 8 * pop;
    const h = 10 * pop;
    const alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    top.fillStyle(0x2a1d08, 0.9 * alpha);
    this.shield(top, sx, sy, w + 1.5, h + 1.5);
    top.fillStyle(COUNTER_COLOR, alpha);
    this.shield(top, sx, sy, w, h);
    top.fillStyle(0xfff4c4, alpha).fillRect(sx - 0.75 * pop, sy - h * 0.7, 1.5 * pop, h * 1.4);
  }

  /** Heater shield centred at (x, y), half-width w and half-height h, in the current fill style. */
  private shield(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number): void {
    g.fillRect(x - w, y - h, 2 * w, h);
    g.fillTriangle(x - w, y, x + w, y, x, y + h * 1.1);
  }

  /** Shatter: a cold flash and ice shards flying out to the edge in a low arc, plus a frost ring. */
  private drawIce(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t * t;
    const grow = 1 - (1 - Math.min(1, t * 1.6)) ** 2;
    const r = b.radius;
    g.fillStyle(0x8fd3ff, 0.3 * fade).fillEllipse(b.x, b.y, r * 2 * grow, r * grow);
    g.lineStyle(2, 0xe6f8ff, 0.85 * fade).strokeEllipse(b.x, b.y, r * 2 * grow, r * grow);
    if (t < 0.25) top.fillStyle(0xffffff, 0.8 * (1 - t / 0.25)).fillEllipse(b.x, b.y - 10, 30, 22);
    const lift = Math.sin(Math.PI * Math.min(1, t * 1.6)) * (8 + r * 0.12);
    for (let i = 0; i < ICE_SHARDS; i++) {
      const a = b.spin + (i * Math.PI * 2) / ICE_SHARDS + (i % 2) * 0.18;
      const reach = r * (0.15 + 0.85 * grow) * (i % 3 === 0 ? 0.8 : 1);
      // Direction on screen (iso: vertical squashed by half), normalised.
      const dx = Math.cos(a);
      const dy = Math.sin(a) * 0.5;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      const cx = b.x + dx * reach;
      const cy = b.y + dy * reach - lift;
      const l = 9 + (i % 3) * 3;
      const w = 3;
      const tipX = cx + ux * l;
      const tipY = cy + uy * l;
      const tailX = cx - ux * l * 0.6;
      const tailY = cy - uy * l * 0.6;
      const sx = -uy * w;
      const sy = ux * w;
      top.fillStyle(0xd8f4ff, fade).fillTriangle(tipX, tipY, cx + sx, cy + sy, cx - sx, cy - sy);
      top.fillStyle(0x6fc8ff, fade).fillTriangle(tailX, tailY, cx + sx, cy + sy, cx - sx, cy - sy);
    }
  }
}

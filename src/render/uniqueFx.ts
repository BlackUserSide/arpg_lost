import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';

// Visuals of unique item mechanics (docs/design/items.md, sub-package 6b): the Ancestral Horn stun shockwave round a
// Battle Cry, the Rift Ring lightning rift left where a Teleport started, the Bloody Pupil crit heal flash and the
// Shadow Boots "next attack crits" glint above the hero. Render-only: radii, who is stunned / healed and whether the
// next attack crits all come from core events and state (area trigger 'burst' / 'originBlast', 'critHeal',
// PlayerState.nextAttackCrit); every number here is a visual constant.
// Cheap on purpose: bursts are pooled and drawn into the scene's two fx Graphics; four particle emitters per run.

const SHOCKWAVE_TTL = 0.55;
const RIFT_TTL = 0.6;
const HEAL_TTL = 0.45;
const MAX_BURSTS = 16;

/** Stun shockwave: warm gold rings with white crests (reads as a war horn blast, not as damage). */
const SHOCK_COLOR = 0xffcf5a;
const SHOCK_LIGHT = 0xfff2c4;
/** Lightning rift: violet tear with electric cyan bolts (Teleport's violet + lightning). */
const RIFT_DARK = 0x2a0f4a;
const RIFT_VIOLET = 0xb58cff;
const RIFT_BOLT = 0xc8f0ff;
/** Crit heal: soft green. */
const HEAL_COLOR = 0x5cff8a;
/** Next attack crits: a shadowy violet glint with a white core. */
const MARK_SHADOW = 0x3a1460;
const MARK_GLOW = 0xc070ff;
const MARK_CORE = 0xffffff;
/**
 * Glint beside the hero's head: height above the feet relative to the body height, offset to the right (clear of the
 * damage numbers rising over the hero) and its size (screen px).
 */
const MARK_LIFT = 0.98;
const MARK_SIDE = 28;
const MARK_SIZE = 12;
/** Seconds of the pop when the mark appears / of the flare when the crit is spent. */
const MARK_POP = 0.25;
const MARK_SPEND = 0.35;
/** Shadow wisps per second off the armed hero. */
const MARK_WISP_RATE = 7;
/** Jagged bolts radiating out of a rift. */
const RIFT_BOLTS = 7;
const BOLT_SEGMENTS = 5;

type BurstKind = 'shockwave' | 'rift' | 'heal';

interface Burst {
  active: boolean;
  kind: BurstKind;
  x: number;
  y: number;
  /** World radius: a 2r × r ellipse on screen (heal: screen px of the body height). */
  radius: number;
  age: number;
  ttl: number;
  spin: number;
}

export class UniqueFx {
  private readonly goldSparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly boltSparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly healMotes: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly wisps: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bursts: Burst[] = [];
  /** Mark state: shown last frame, seconds since it appeared, flare left after it was spent, wisp accumulator. */
  private markShown = false;
  private markAge = 0;
  private markSpend = 0;
  private wispDebt = 0;

  constructor(scene: Phaser.Scene) {
    this.goldSparks = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 60, max: 160 },
        angle: { min: 0, max: 360 },
        scale: { start: 1.6, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, SHOCK_LIGHT, SHOCK_COLOR],
        lifespan: { min: 280, max: 520 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 96,
        reserve: 32,
      })
      .setDepth(4002);
    this.boltSparks = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 40, max: 140 },
        angle: { min: 0, max: 360 },
        scale: { start: 1.4, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, RIFT_BOLT, RIFT_VIOLET],
        lifespan: { min: 200, max: 420 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 80,
        reserve: 24,
      })
      .setDepth(4002);
    this.healMotes = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speedY: { min: -40, max: -80 },
        speedX: { min: -12, max: 12 },
        scale: { start: 1.5, end: 0.2 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, 0xb8ffcc, HEAL_COLOR],
        lifespan: { min: 380, max: 640 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 64,
        reserve: 16,
      })
      .setDepth(4002);
    this.wisps = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speedY: { min: -14, max: -30 },
        speedX: { min: -8, max: 8 },
        scale: { start: 0.22, end: 0.05 },
        alpha: { start: 0.55, end: 0 },
        tint: [MARK_SHADOW, 0x5a2a8a, MARK_GLOW],
        lifespan: { min: 420, max: 720 },
        maxAliveParticles: 40,
        reserve: 12,
      })
      .setDepth(4001);
  }

  /** Drops running bursts and the mark flare (room change). */
  clear(): void {
    for (const b of this.bursts) b.active = false;
    this.markSpend = 0;
  }

  /** A stun burst round the hero at screen (x, y), world radius `radius`: gold shock rings and star sparks. */
  shockwave(x: number, y: number, radius: number): void {
    if (!this.startBurst('shockwave', x, y, radius, SHOCKWAVE_TTL)) return;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      this.goldSparks.emitParticleAt(x + Math.cos(a) * radius * 0.35, y + Math.sin(a) * radius * 0.175 - 6, 1);
    }
  }

  /** The blast left where a teleport started, at screen (x, y), world radius `radius`: a violet tear and bolts. */
  rift(x: number, y: number, radius: number): void {
    if (!this.startBurst('rift', x, y, radius, RIFT_TTL)) return;
    for (let i = 0; i < 12; i++) this.boltSparks.emitParticleAt(x + (Math.random() - 0.5) * radius * 0.8, y + (Math.random() - 0.5) * radius * 0.4 - 10, 1);
  }

  /** A crit healed the hero standing at screen (x, y), body `bodyPx` tall: a green flash and rising motes. */
  heal(x: number, y: number, bodyPx: number): void {
    if (!this.startBurst('heal', x, y, bodyPx, HEAL_TTL)) return;
    for (let i = 0; i < 6; i++) this.healMotes.emitParticleAt(x + (Math.random() - 0.5) * 30, y - bodyPx * (0.2 + Math.random() * 0.6), 1);
  }

  /**
   * The "next attack crits" glint beside the hero's head at screen (x, y), body `bodyPx` tall, while `armed`
   * (PlayerState.nextAttackCrit): pops in when armed, twinkles with shadow wisps, flares out when the crit is spent.
   */
  drawCritMark(top: Phaser.GameObjects.Graphics, x: number, y: number, bodyPx: number, armed: boolean, time: number, dt: number): void {
    const cy = y - bodyPx * MARK_LIFT;
    const mx = x + MARK_SIDE;
    if (armed !== this.markShown) {
      if (armed) this.markAge = 0;
      else {
        this.markSpend = MARK_SPEND;
        for (let i = 0; i < 8; i++) this.boltSparks.emitParticleAt(mx, cy, 1);
      }
      this.markShown = armed;
    }
    if (armed) {
      this.markAge += dt;
      const pop = this.markAge < MARK_POP ? 1 + 1.4 * (1 - this.markAge / MARK_POP) : 1;
      const twinkle = 0.85 + 0.15 * Math.sin(time * 9);
      const size = MARK_SIZE * pop * twinkle;
      top.fillStyle(MARK_SHADOW, 0.55).fillCircle(mx, cy, size * 1.25);
      top.fillStyle(MARK_GLOW, 0.35).fillCircle(mx, cy, size * 0.9);
      this.drawStar(top, mx, cy, size * 1.6, size * 0.32, MARK_GLOW, 0.95, time * 1.5);
      this.drawStar(top, mx, cy, size * 0.95, size * 0.2, MARK_CORE, 1, time * 1.5);
      // A shadow haze at the feet so the state also reads in a crowd.
      top.lineStyle(2, MARK_GLOW, 0.35 + 0.2 * twinkle).strokeEllipse(x, y, 40, 20);
      this.wispDebt += dt * MARK_WISP_RATE;
      while (this.wispDebt >= 1) {
        this.wispDebt -= 1;
        this.wisps.emitParticleAt(x + (Math.random() - 0.5) * 26, y - bodyPx * (0.1 + Math.random() * 0.5), 1);
      }
    } else if (this.markSpend > 0) {
      this.markSpend = Math.max(0, this.markSpend - dt);
      const k = this.markSpend / MARK_SPEND;
      const size = MARK_SIZE * (1 + 1.6 * (1 - k));
      this.drawStar(top, mx, cy, size * 1.6, size * 0.25, MARK_CORE, k, 0);
      top.lineStyle(2, MARK_GLOW, k).strokeCircle(mx, cy, size * 1.4);
    }
  }

  /** Advances and draws the bursts: ground parts into `ground`, raised parts into `top`. */
  drawBursts(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, dt: number): void {
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.ttl) {
        b.active = false;
        continue;
      }
      if (b.kind === 'shockwave') this.drawShockwave(ground, top, b);
      else if (b.kind === 'rift') this.drawRift(ground, top, b);
      else this.drawHeal(top, b);
    }
  }

  private startBurst(kind: BurstKind, x: number, y: number, radius: number, ttl: number): Burst | undefined {
    let burst = this.bursts.find((b) => !b.active);
    if (!burst) {
      if (this.bursts.length >= MAX_BURSTS) return undefined;
      burst = { active: false, kind, x: 0, y: 0, radius: 0, age: 0, ttl: 1, spin: 0 };
      this.bursts.push(burst);
    }
    burst.active = true;
    burst.kind = kind;
    burst.x = x;
    burst.y = y;
    burst.radius = radius;
    burst.age = 0;
    burst.ttl = ttl;
    burst.spin = Math.random() * Math.PI * 2;
    return burst;
  }

  /** Three staggered rings racing out to the stun radius, a bright flash at the centre, a raised crest ring. */
  private drawShockwave(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    if (t < 0.25) ground.fillStyle(SHOCK_LIGHT, 0.4 * (1 - t / 0.25)).fillEllipse(b.x, b.y, b.radius * 0.9, b.radius * 0.45);
    for (let i = 0; i < 3; i++) {
      const local = (t - i * 0.12) / 0.7;
      if (local <= 0 || local >= 1) continue;
      const grow = 1 - (1 - local) ** 3;
      const r = b.radius * grow;
      const fade = 1 - local;
      ground.fillStyle(SHOCK_COLOR, 0.1 * fade).fillEllipse(b.x, b.y, r * 2, r);
      ground.lineStyle((i === 0 ? 6 : 3) * fade + 1, i === 0 ? SHOCK_COLOR : SHOCK_LIGHT, 0.9 * fade).strokeEllipse(b.x, b.y, r * 2, r);
      if (i === 0) top.lineStyle(2, 0xffffff, 0.5 * fade).strokeEllipse(b.x, b.y - 10 * fade, r * 1.9, r * 0.95);
    }
  }

  /** A jagged violet tear at the start point, flickering bolts out to the blast radius, an electric rim. */
  private drawRift(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const grow = 1 - (1 - Math.min(1, t * 3)) ** 2;
    const r = b.radius * grow;
    ground.fillStyle(RIFT_DARK, 0.45 * fade).fillEllipse(b.x, b.y, r * 2, r);
    ground.fillStyle(RIFT_VIOLET, 0.18 * fade).fillEllipse(b.x, b.y, r * 1.6, r * 0.8);
    ground.lineStyle(3 * fade + 1, RIFT_VIOLET, 0.9 * fade).strokeEllipse(b.x, b.y, r * 2, r);
    // The tear: a tall jagged slit standing on the start point, closing as the blast fades.
    const h = 54 * (t < 0.15 ? t / 0.15 : fade);
    const w = 7 * fade + 2;
    top.fillStyle(RIFT_DARK, 0.9 * fade).fillTriangle(b.x - w, b.y - h * 0.5, b.x + w, b.y - h * 0.5, b.x, b.y);
    top.fillStyle(RIFT_DARK, 0.9 * fade).fillTriangle(b.x - w, b.y - h * 0.5, b.x + w, b.y - h * 0.5, b.x + 2, b.y - h);
    top.lineStyle(2, RIFT_VIOLET, fade).lineBetween(b.x, b.y, b.x - w * 0.6, b.y - h * 0.5).lineBetween(b.x - w * 0.6, b.y - h * 0.5, b.x + 2, b.y - h);
    top.lineStyle(2, RIFT_BOLT, fade).lineBetween(b.x, b.y, b.x + w * 0.6, b.y - h * 0.5).lineBetween(b.x + w * 0.6, b.y - h * 0.5, b.x + 2, b.y - h);
    // Bolts: re-jittered every frame so they crackle; only while the blast is fresh.
    if (t > 0.6) return;
    const boltFade = 1 - t / 0.6;
    for (let i = 0; i < RIFT_BOLTS; i++) {
      const a = b.spin + (i / RIFT_BOLTS) * Math.PI * 2;
      const len = r * (0.75 + 0.25 * Math.random());
      let px = b.x;
      let py = b.y - 8;
      for (let s = 1; s <= BOLT_SEGMENTS; s++) {
        const k = s / BOLT_SEGMENTS;
        const jitter = (Math.random() - 0.5) * 0.7;
        const nx = b.x + Math.cos(a + jitter) * len * k;
        const ny = b.y - 8 * (1 - k) + Math.sin(a + jitter) * len * k * 0.5;
        top.lineStyle(3.5 * (1 - k) + 1, s < 3 ? 0xffffff : RIFT_BOLT, boltFade).lineBetween(px, py, nx, ny);
        px = nx;
        py = ny;
      }
    }
  }

  /** Crit heal: a green glow over the body, a small rising plus. */
  private drawHeal(top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const body = b.radius;
    top.fillStyle(HEAL_COLOR, 0.22 * fade).fillEllipse(b.x, b.y - body * 0.45, body * 0.9, body * 1.1);
    top.lineStyle(2, HEAL_COLOR, 0.7 * fade).strokeEllipse(b.x, b.y, 40 + 16 * t, 20 + 8 * t);
    const cy = b.y - body * (0.95 + 0.35 * t);
    const arm = 6;
    top.fillStyle(0xffffff, fade).fillRect(b.x - arm, cy - 1.5, arm * 2, 3).fillRect(b.x - 1.5, cy - arm, 3, arm * 2);
    top.lineStyle(1.5, HEAL_COLOR, fade).strokeRect(b.x - arm - 1, cy - 2.5, arm * 2 + 2, 5).strokeRect(b.x - 2.5, cy - arm - 1, 5, arm * 2 + 2);
  }

  /** A four-pointed star at (x, y): arms `long` from the centre, `thin` wide, rotated by `angle`. */
  private drawStar(g: Phaser.GameObjects.Graphics, x: number, y: number, long: number, thin: number, color: number, alpha: number, angle: number): void {
    g.fillStyle(color, alpha);
    for (let i = 0; i < 4; i++) {
      const a = angle + (i * Math.PI) / 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Arm tip, and two base corners perpendicular to it.
      g.fillTriangle(x + ca * long, y + sa * long, x - sa * thin, y + ca * thin, x + sa * thin, y - ca * thin);
    }
  }
}

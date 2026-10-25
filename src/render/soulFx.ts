import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';

// Visuals of the souls mechanic (legendary Devourer's Crown, docs/design/items.md): a soul wisp flying from a fallen
// mob to the hero ('soulGain'), soul motes circling the hero while the counter is full, the crown flare when a use
// takes the souls ('soulEcho') and the purple-green burst of the free echo itself ('echo' with souls).
// Render-only: who gets a soul, the max and when it is spent all come from core events and PlayerState.souls;
// every number here is a visual constant. Screen coordinates in.
// Cheap on purpose: wisps and bursts are pooled records drawn into the scene's fx Graphics, two particle emitters.

/** Soul colours: a violet shell round a pale green core (apart from the plain violet Echo support). */
export const SOUL_VIOLET = 0xa060ff;
export const SOUL_GREEN = 0x6dffb0;
const SOUL_DEEP = 0x2a0f3a;
const SOUL_CORE = 0xeafff2;

/** Seconds a wisp takes to reach the hero (plus up to WISP_TTL_JITTER) and the most wisps in flight. */
const WISP_TTL = 0.55;
const WISP_TTL_JITTER = 0.2;
const MAX_WISPS = 24;
/** How high the wisp's arc bows above the straight line (px) and its sideways sway. */
const WISP_ARC = 70;
const WISP_SWAY = 40;
/** Trail motes per second per wisp. */
const WISP_TRAIL_RATE = 45;

const ABSORB_TTL = 0.3;
const CHARGE_TTL = 0.45;
const ECHO_TTL = 0.6;
const FULL_TTL = 0.5;
const MAX_BURSTS = 16;

/** Full counter: motes circling the hero's chest (count, orbit size px, turns per second). */
const ORBIT_MOTES = 3;
const ORBIT_RX = 27;
const ORBIT_RY = 11;
const ORBIT_SPEED = 1.1;

type BurstKind = 'absorb' | 'charge' | 'echo' | 'full';

interface Wisp {
  active: boolean;
  /** Start (screen) and the bow of its arc. */
  sx: number;
  sy: number;
  bowX: number;
  bowY: number;
  age: number;
  ttl: number;
  trailDebt: number;
}

interface Burst {
  active: boolean;
  kind: BurstKind;
  x: number;
  y: number;
  /** Body height (px) of the hero the burst sits on. */
  body: number;
  age: number;
  ttl: number;
}

export class SoulFx {
  private readonly trail: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly wisps: Wisp[] = [];
  private readonly bursts: Burst[] = [];
  /** The full-counter motes were shown last frame (a pop when they appear). */
  private fullShown = false;

  constructor(scene: Phaser.Scene) {
    this.trail = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speed: { min: 2, max: 14 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.16, end: 0.02 },
        alpha: { start: 0.7, end: 0 },
        tint: [SOUL_VIOLET, SOUL_GREEN, 0x7a3ac8],
        lifespan: { min: 220, max: 420 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 160,
        reserve: 40,
      })
      .setDepth(4002);
    this.sparks = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 50, max: 170 },
        angle: { min: 0, max: 360 },
        scale: { start: 1.5, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [SOUL_CORE, SOUL_GREEN, SOUL_VIOLET],
        lifespan: { min: 260, max: 520 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 96,
        reserve: 32,
      })
      .setDepth(4002);
  }

  /** Drops wisps in flight and running bursts (room change). */
  clear(): void {
    for (const w of this.wisps) w.active = false;
    for (const b of this.bursts) b.active = false;
  }

  /** A soul rises from a fallen mob at screen (x, y) (its chest) and flies to the hero. */
  gain(x: number, y: number): void {
    let wisp = this.wisps.find((w) => !w.active);
    if (!wisp) {
      if (this.wisps.length >= MAX_WISPS) return;
      wisp = { active: false, sx: 0, sy: 0, bowX: 0, bowY: 0, age: 0, ttl: 1, trailDebt: 0 };
      this.wisps.push(wisp);
    }
    wisp.active = true;
    wisp.sx = x;
    wisp.sy = y;
    wisp.bowX = (Math.random() - 0.5) * 2 * WISP_SWAY;
    wisp.bowY = -WISP_ARC * (0.7 + Math.random() * 0.5);
    wisp.age = 0;
    wisp.ttl = WISP_TTL + Math.random() * WISP_TTL_JITTER;
    wisp.trailDebt = 0;
    for (let i = 0; i < 4; i++) this.trail.emitParticleAt(x + (Math.random() - 0.5) * 12, y + (Math.random() - 0.5) * 8, 1);
  }

  /** A use took the full souls count (its free echo follows): a crown of soul fire flares over the hero. */
  charge(x: number, y: number, bodyPx: number): void {
    this.startBurst('charge', x, y, bodyPx, CHARGE_TTL);
  }

  /** The crown's free echo fired: a purple-green soul burst round the hero; the circling souls scatter. */
  echo(x: number, y: number, bodyPx: number): void {
    if (!this.startBurst('echo', x, y, bodyPx, ECHO_TTL)) return;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      this.sparks.emitParticleAt(x + Math.cos(a) * 16, y - bodyPx * 0.5 + Math.sin(a) * 10, 1);
    }
  }

  /**
   * Advances and draws wisps, bursts and the full-counter motes. (heroX, heroY): the hero's feet, `bodyPx` its body
   * height; `full`: the souls counter is at its max (PlayerState.souls), `time` world seconds.
   */
  update(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, dt: number, heroX: number, heroY: number, bodyPx: number, full: boolean, time: number): void {
    const tx = heroX;
    const ty = heroY - bodyPx * 0.5;
    for (const w of this.wisps) {
      if (!w.active) continue;
      w.age += dt;
      if (w.age >= w.ttl) {
        w.active = false;
        this.startBurst('absorb', heroX, heroY, bodyPx, ABSORB_TTL);
        for (let i = 0; i < 3; i++) this.sparks.emitParticleAt(tx + (Math.random() - 0.5) * 14, ty + (Math.random() - 0.5) * 14, 1);
        continue;
      }
      // Pulled in: slow lift off the corpse, faster at the end, along a bowed quadratic curve to the hero's chest.
      const k = (w.age / w.ttl) ** 1.6;
      const cx = (w.sx + tx) / 2 + w.bowX;
      const cy = Math.min(w.sy, ty) + w.bowY;
      const u = 1 - k;
      const x = u * u * w.sx + 2 * u * k * cx + k * k * tx;
      const y = u * u * w.sy + 2 * u * k * cy + k * k * ty;
      const flicker = 0.85 + 0.15 * Math.sin(time * 30 + w.sx);
      top.fillStyle(SOUL_VIOLET, 0.3 * flicker).fillCircle(x, y, 10);
      top.fillStyle(SOUL_GREEN, 0.75).fillCircle(x, y, 5 * flicker);
      top.fillStyle(SOUL_CORE, 1).fillCircle(x, y, 2.2);
      w.trailDebt += dt * WISP_TRAIL_RATE;
      while (w.trailDebt >= 1) {
        w.trailDebt -= 1;
        this.trail.emitParticleAt(x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 6, 1);
      }
    }
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.ttl) {
        b.active = false;
        continue;
      }
      if (b.kind === 'absorb') this.drawAbsorb(top, b);
      else if (b.kind === 'charge') this.drawCharge(top, b);
      else if (b.kind === 'echo') this.drawEcho(ground, top, b);
      else this.drawFull(ground, b);
    }
    if (full !== this.fullShown) {
      this.fullShown = full;
      if (full) this.startBurst('full', heroX, heroY, bodyPx, FULL_TTL);
    }
    if (full) this.drawOrbit(ground, top, heroX, heroY, bodyPx, time);
  }

  private startBurst(kind: BurstKind, x: number, y: number, body: number, ttl: number): Burst | undefined {
    let burst = this.bursts.find((b) => !b.active);
    if (!burst) {
      if (this.bursts.length >= MAX_BURSTS) return undefined;
      burst = { active: false, kind, x: 0, y: 0, body: 0, age: 0, ttl: 1 };
      this.bursts.push(burst);
    }
    burst.active = true;
    burst.kind = kind;
    burst.x = x;
    burst.y = y;
    burst.body = body;
    burst.age = 0;
    burst.ttl = ttl;
    return burst;
  }

  /** A soul sinks into the hero: a ring closing in on the chest. */
  private drawAbsorb(top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const r = 22 * (1 - t) + 4;
    top.lineStyle(2, SOUL_GREEN, 0.8 * fade).strokeEllipse(b.x, b.y - b.body * 0.5, r * 2, r * 1.3);
  }

  /** Full counter: three soul motes circling the chest, a faint violet ring at the feet. */
  private drawOrbit(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, x: number, y: number, bodyPx: number, time: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 4);
    ground.lineStyle(2, SOUL_VIOLET, 0.45 + 0.3 * pulse).strokeEllipse(x, y, 50, 25);
    ground.lineStyle(1.5, SOUL_GREEN, 0.3 + 0.25 * pulse).strokeEllipse(x, y, 36, 18);
    const cy = y - bodyPx * 0.55;
    for (let i = 0; i < ORBIT_MOTES; i++) {
      const a = time * ORBIT_SPEED * Math.PI * 2 + (i / ORBIT_MOTES) * Math.PI * 2;
      const mx = x + Math.cos(a) * ORBIT_RX;
      const my = cy + Math.sin(a) * ORBIT_RY;
      // Behind the body on the far half of the orbit: dimmer.
      const near = Math.sin(a) > 0 ? 1 : 0.45;
      top.fillStyle(SOUL_VIOLET, 0.35 * near).fillCircle(mx, my, 9);
      top.fillStyle(SOUL_GREEN, 0.85 * near).fillCircle(mx, my, 4.5);
      top.fillStyle(SOUL_CORE, near).fillCircle(mx, my, 2);
    }
  }

  /** The counter just filled: a soul ring popping out of the hero's feet. */
  private drawFull(ground: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const r = 18 + 40 * (1 - (1 - t) ** 2);
    ground.lineStyle(3 * fade + 1, SOUL_GREEN, 0.9 * fade).strokeEllipse(b.x, b.y, r * 2, r);
    ground.lineStyle(2 * fade + 1, SOUL_VIOLET, 0.8 * fade).strokeEllipse(b.x, b.y, r * 1.5, r * 0.75);
  }

  /** A use took the souls: a soul-fire crown flares over the head, souls drawn up into it. */
  private drawCharge(top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
    const cy = b.y - b.body * 1.08 - 6 * t;
    const w = 26 * (1 + 0.25 * (1 - t));
    top.fillStyle(SOUL_VIOLET, 0.35 * fade).fillEllipse(b.x, cy - w * 0.25, w * 1.9, w * 1.2);
    drawCrown(top, b.x, cy, w, SOUL_VIOLET, 0.95 * fade);
    drawCrown(top, b.x, cy - 2, w * 0.62, SOUL_GREEN, fade);
    // Streaks drawn up from the body into the crown.
    for (let i = -1; i <= 1; i++) {
      const sx = b.x + i * 16;
      top.lineStyle(2, SOUL_GREEN, 0.6 * fade).lineBetween(sx, b.y - b.body * (0.2 + 0.4 * t), b.x + i * 6, cy + 4);
    }
  }

  /** The crown's echo: twin violet / green rings racing out, a swirl over the body and the crown fading upward. */
  private drawEcho(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const grow = 1 - (1 - t) ** 3;
    const r = 20 + 56 * grow;
    if (t < 0.2) ground.fillStyle(SOUL_GREEN, 0.3 * (1 - t / 0.2)).fillEllipse(b.x, b.y, r * 1.6, r * 0.8);
    ground.fillStyle(SOUL_DEEP, 0.25 * fade).fillEllipse(b.x, b.y, r * 2, r);
    ground.lineStyle(4 * fade + 1, SOUL_VIOLET, 0.9 * fade).strokeEllipse(b.x, b.y, r * 2, r);
    const r2 = 14 + 40 * (1 - (1 - Math.max(0, t - 0.1) / 0.9) ** 3);
    ground.lineStyle(3 * fade + 1, SOUL_GREEN, 0.9 * fade).strokeEllipse(b.x, b.y, r2 * 2, r2);
    // A swirl round the body: two arcs turning in opposite directions.
    const cy = b.y - b.body * 0.5;
    const spin = t * Math.PI * 3;
    top.lineStyle(3, SOUL_VIOLET, 0.8 * fade);
    top.beginPath();
    top.arc(b.x, cy, 22 + 8 * t, spin, spin + Math.PI * 0.9, false);
    top.strokePath();
    top.lineStyle(3, SOUL_GREEN, 0.8 * fade);
    top.beginPath();
    top.arc(b.x, cy, 18 + 8 * t, -spin + Math.PI, -spin + Math.PI * 1.9, false);
    top.strokePath();
    drawCrown(top, b.x, b.y - b.body * 1.08 - 26 * t, 22, SOUL_GREEN, 0.9 * fade);
  }
}

/** A three-pointed crown of width `w` standing on (x, y): a band and three spikes (no allocation). */
function drawCrown(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, color: number, alpha: number): void {
  if (alpha <= 0) return;
  const h = w * 0.55;
  const band = w * 0.18;
  const half = w / 2;
  g.fillStyle(color, alpha);
  g.fillRect(x - half, y - band, w, band);
  g.fillTriangle(x - half, y - band, x - half * 0.25, y - band, x - half, y - h);
  g.fillTriangle(x - half * 0.45, y - band, x + half * 0.45, y - band, x, y - h * 1.2);
  g.fillTriangle(x + half * 0.25, y - band, x + half, y - band, x + half, y - h);
}

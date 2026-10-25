import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';

// Raised allies of the legendary Eye of the Abyss (docs/design/items.md): the spectral look of a friendly skeleton
// (teal wash, translucency, outline glow), its ground ring, life bar and lifetime line, and its moments: rising from
// the corpse, the swing, crumbling (time ran out / pushed over the cap) and shattering (killed).
// Render-only: life, lifetime and every event come from core (WorldState.allies, ally* events); every number here is a
// visual constant. Cheap on purpose: marks go into the scene's fx Graphics, bursts are pooled, three particle emitters.

/** The ally colour: spectral green-teal, apart from enemy bone white, elite gold and the hero's gold ring. */
export const ALLY_TEAL = 0x3fffc8;
const ALLY_DEEP = 0x0f6a58;
const ALLY_PALE = 0xc8fff0;
/** Multiply tint on the bone sprite: keeps its shading and detail, turns the bone spectral green-teal. */
const ALLY_WASH = 0x7affd6;
/** Body opacity of a living ally (translucent, so it never reads as a solid enemy). */
const ALLY_ALPHA = 0.8;
/** Seconds before the end of its lifetime the ally starts to fade and flicker. */
const FADE_WARNING = 2;
const FADE_MIN_ALPHA = 0.3;

const GLOW_STRENGTH = 1.1;
const GLOW_PULSE = 0.4;
const GLOW_QUALITY = 6;
const GLOW_DISTANCE = 5;

const RISE_TTL = 0.7;
const CRUMBLE_TTL = 0.6;
const SHATTER_TTL = 0.45;
const SWING_TTL = 0.22;
const MAX_BURSTS = 32;

type AllyBurstKind = 'rise' | 'crumble' | 'shatter' | 'swing';

interface Burst {
  active: boolean;
  kind: AllyBurstKind;
  x: number;
  y: number;
  /** World body radius (a 2r × r ellipse on screen); for 'swing' the reach in px. */
  radius: number;
  /** 'swing': screen direction of the strike (radians). */
  angle: number;
  age: number;
  ttl: number;
}

export class AllyFx {
  private readonly wisps: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly shards: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bursts: Burst[] = [];
  private readonly webgl: boolean;

  constructor(scene: Phaser.Scene) {
    this.webgl = scene.sys.game.renderer.type === Phaser.WEBGL;
    const dot = softDotTexture(scene);
    const spark = sparkTexture(scene);
    this.wisps = scene.add
      .particles(0, 0, dot, {
        emitting: false,
        speedY: { min: -30, max: -70 },
        speedX: { min: -14, max: 14 },
        scale: { start: 0.28, end: 0.04 },
        alpha: { start: 0.85, end: 0 },
        tint: [ALLY_TEAL, 0x2ac8a0, ALLY_PALE],
        lifespan: { min: 420, max: 820 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 120,
        reserve: 32,
      })
      .setDepth(4002);
    this.shards = scene.add
      .particles(0, 0, spark, {
        emitting: false,
        speed: { min: 70, max: 190 },
        angle: { min: 0, max: 360 },
        gravityY: 260,
        scale: { start: 1.5, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [ALLY_PALE, ALLY_TEAL, 0xffffff],
        lifespan: { min: 300, max: 560 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 160,
        reserve: 32,
      })
      .setDepth(4002);
    this.dust = scene.add
      .particles(0, 0, dot, {
        emitting: false,
        speedY: { min: -8, max: -30 },
        speedX: { min: -24, max: 24 },
        scale: { start: 0.3, end: 0.7 },
        alpha: { start: 0.45, end: 0 },
        tint: [0x6a8a80, 0x8aa89c, 0x40564e],
        lifespan: { min: 450, max: 850 },
        maxAliveParticles: 96,
        reserve: 24,
      })
      .setDepth(4001);
  }

  /** Gives a fresh ally sprite its spectral look; returns its outline glow (WebGL only) to pulse and remove later. */
  dress(sprite: Phaser.GameObjects.Sprite): Phaser.Filters.Glow | undefined {
    sprite.setTint(ALLY_WASH).setTintMode(Phaser.TintModes.MULTIPLY).setAlpha(ALLY_ALPHA);
    if (!this.webgl) return undefined;
    sprite.enableFilters();
    return sprite.filters?.internal.addGlow(ALLY_TEAL, GLOW_STRENGTH, 0, 1, false, GLOW_QUALITY, GLOW_DISTANCE);
  }

  /** Removes the glow (the ally is gone: its remains fade without it). */
  undress(sprite: Phaser.GameObjects.Sprite, glow: Phaser.Filters.Glow | undefined): void {
    if (glow) sprite.filters?.internal.remove(glow, true);
  }

  /**
   * Per-frame look of a living ally from its lifetime left (`remaining` s): steady, then in the last seconds the body
   * thins out and flickers while the glow dims. `struck` 0..1: a pale flash after an enemy hit.
   */
  style(sprite: Phaser.GameObjects.Sprite, glow: Phaser.Filters.Glow | undefined, remaining: number, time: number, phase: number, struck: number): void {
    const fading = Phaser.Math.Clamp(remaining / FADE_WARNING, 0, 1);
    const flicker = fading < 1 ? 0.12 * (1 - fading) * Math.sin(time * 22 + phase) : 0;
    const alpha = FADE_MIN_ALPHA + (ALLY_ALPHA - FADE_MIN_ALPHA) * fading + flicker;
    sprite.setAlpha(Phaser.Math.Clamp(alpha, 0.1, 1));
    // A hit: the plain bone flashes through for a moment.
    sprite.setTint(struck > 0 ? 0xffffff : ALLY_WASH);
    if (glow) glow.outerStrength = (GLOW_STRENGTH + GLOW_PULSE * Math.sin(time * 3.5 + phase)) * (0.35 + 0.65 * fading);
  }

  /**
   * Ground ring under a living ally at screen (x, y) (feet), world body `radius`, plus its small life bar and the
   * lifetime line under it, `h` px above the feet. `life` / `left`: fractions 0..1 of max life / lifetime.
   */
  drawAlly(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, x: number, y: number, radius: number, h: number, life: number, left: number, time: number, phase: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 4 + phase);
    const rx = radius * 2.4;
    const fade = 0.45 + 0.55 * Phaser.Math.Clamp(left * 4, 0, 1);
    g.fillStyle(ALLY_TEAL, (0.1 + 0.06 * pulse) * fade).fillEllipse(x, y, rx, rx / 2);
    g.lineStyle(2, ALLY_TEAL, (0.55 + 0.3 * pulse) * fade).strokeEllipse(x, y, rx, rx / 2);
    // Life bar (only once hurt: a full squad of six bars would clutter the fight) and the lifetime line.
    const w = 30;
    const by = y - h - 6;
    if (life < 0.999) {
      top.fillStyle(0x000000, 0.7).fillRect(x - w / 2 - 1, by - 1, w + 2, 6);
      top.fillStyle(0x0a2a24, 1).fillRect(x - w / 2, by, w, 4);
      top.fillStyle(ALLY_TEAL, 1).fillRect(x - w / 2, by, w * Phaser.Math.Clamp(life, 0, 1), 4);
    }
    const ly = by + 6;
    const lw = w * Phaser.Math.Clamp(left, 0, 1);
    top.fillStyle(0x000000, 0.5).fillRect(x - w / 2, ly, w, 2);
    top.fillStyle(left * 4 < 1 ? 0xffffff : ALLY_PALE, left * 4 < 1 ? 0.5 + 0.5 * pulse : 0.75).fillRect(x - w / 2, ly, lw, 2);
  }

  /** An ally rises from the corpse at screen (x, y): a teal ground glow and wisps climbing up. */
  rise(x: number, y: number): void {
    this.start('rise', x, y, 26, RISE_TTL, 0);
    this.wisps.emitParticleAt(x, y - 8, 8);
    this.dust.emitParticleAt(x, y - 2, 3);
  }

  /** Its time ran out (or a newer one took its place): the bones crumble to grey dust with a last wisp. */
  crumble(x: number, y: number): void {
    this.start('crumble', x, y, 22, CRUMBLE_TTL, 0);
    this.dust.emitParticleAt(x, y - 16, 8);
    this.wisps.emitParticleAt(x, y - 30, 3);
  }

  /** Enemies destroyed it: a bright pop and spectral shards flying apart. */
  shatter(x: number, y: number, h: number): void {
    this.start('shatter', x, y - h * 0.5, 22, SHATTER_TTL, 0);
    this.shards.emitParticleAt(x, y - h * 0.5, 14);
    this.wisps.emitParticleAt(x, y - h * 0.4, 4);
  }

  /** The ally swings at screen direction (dx, dy) from (x, y) (feet), body height `h`: a short teal slash arc. */
  swing(x: number, y: number, dx: number, dy: number, h: number): void {
    this.start('swing', x, y - h * 0.45, h * 0.55, SWING_TTL, Math.atan2(dy, dx));
  }

  /** Advances and draws the bursts: ground parts into `g`, raised parts into `top`. */
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
      switch (b.kind) {
        case 'rise': {
          const r = b.radius * (0.5 + 1.1 * t);
          g.fillStyle(ALLY_DEEP, 0.45 * fade).fillEllipse(b.x, b.y, r * 2.4, r * 1.2);
          g.lineStyle(2, ALLY_TEAL, 0.9 * fade).strokeEllipse(b.x, b.y, r * 2.4, r * 1.2);
          // A pale column fading up out of the ground.
          top.fillStyle(ALLY_TEAL, 0.18 * fade).fillRect(b.x - 9 * fade, b.y - 70 * t - 10, 18 * fade, 70 * t + 10);
          break;
        }
        case 'crumble':
          g.fillStyle(0x40564e, 0.4 * fade).fillEllipse(b.x, b.y, b.radius * 2.6, b.radius * 1.3);
          break;
        case 'shatter': {
          const r = 8 + 26 * (1 - fade * fade);
          top.fillStyle(0xffffff, 0.55 * fade * fade).fillCircle(b.x, b.y, 10 * fade + 3);
          top.lineStyle(3 * fade + 1, ALLY_TEAL, 0.9 * fade).strokeCircle(b.x, b.y, r);
          break;
        }
        case 'swing': {
          const sweep = 1.6;
          const from = b.angle - sweep / 2 + sweep * Math.max(0, t - 0.35);
          const to = b.angle - sweep / 2 + sweep * Math.min(1, t * 1.6);
          if (to > from) {
            top.lineStyle(4 * fade + 1, ALLY_TEAL, 0.75 * fade);
            top.beginPath();
            top.arc(b.x, b.y, b.radius, from, to, false);
            top.strokePath();
          }
          break;
        }
      }
    }
  }

  clear(): void {
    for (const b of this.bursts) b.active = false;
    this.wisps.killAll();
    this.shards.killAll();
    this.dust.killAll();
  }

  /** Takes a free pooled burst and starts it (skipped when the pool is exhausted). */
  private start(kind: AllyBurstKind, x: number, y: number, radius: number, ttl: number, angle: number): void {
    let burst = this.bursts.find((b) => !b.active);
    if (!burst) {
      if (this.bursts.length >= MAX_BURSTS) return;
      burst = { active: false, kind, x: 0, y: 0, radius: 0, angle: 0, age: 0, ttl: 1 };
      this.bursts.push(burst);
    }
    burst.active = true;
    burst.kind = kind;
    burst.x = x;
    burst.y = y;
    burst.radius = radius;
    burst.angle = angle;
    burst.age = 0;
    burst.ttl = ttl;
  }
}

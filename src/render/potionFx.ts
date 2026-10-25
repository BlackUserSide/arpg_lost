import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';

// Visuals of the life potion on the hero (docs/design/combat.md, decision 2026-10-26): the drink burst ('potionDrink')
// and the rose glow with rising motes while a heal runs (PlayerState.potion.heals). PEGI 12: the liquid reads as a
// glowing ruby potion (additive light, golden glints, motes rise), never as splashing blood.
// Render-only: when the hero drinks and how long it heals come from core; every number here is a visual constant.
// Cheap on purpose: bursts are pooled records drawn into the scene's fx Graphics, two particle emitters.

/** Potion colours: ruby body, rose light, pale core, golden glints. */
export const POTION_RUBY = 0xe0284a;
export const POTION_ROSE = 0xff7a92;
const POTION_CORE = 0xffe0e6;
const POTION_GOLD = 0xffd27a;

const DRINK_TTL = 0.6;
const MAX_BURSTS = 6;
/** Rising motes per second while a heal runs. */
const MOTE_RATE = 22;
/** Seconds the healing aura takes to fade in / out. */
const AURA_FADE = 0.2;

interface Burst {
  active: boolean;
  body: number;
  age: number;
}

export class PotionFx {
  private readonly motes: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly glints: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bursts: Burst[] = [];
  /** Healing aura strength 0..1 (eases towards whether a heal runs). */
  private aura = 0;
  private moteDebt = 0;
  private time = 0;

  constructor(scene: Phaser.Scene) {
    this.motes = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speedY: { min: -40, max: -75 },
        speedX: { min: -10, max: 10 },
        scale: { start: 0.2, end: 0.03 },
        alpha: { start: 0.85, end: 0 },
        tint: [POTION_ROSE, POTION_RUBY, POTION_CORE],
        lifespan: { min: 420, max: 700 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 60,
        reserve: 20,
      })
      .setDepth(4002);
    this.glints = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 50, max: 130 },
        angle: { min: 200, max: 340 },
        gravityY: 120,
        scale: { start: 1.5, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, POTION_GOLD, POTION_ROSE],
        lifespan: { min: 300, max: 560 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 48,
        reserve: 16,
      })
      .setDepth(4002);
  }

  /** Drops running bursts and the aura (room change). */
  clear(): void {
    for (const b of this.bursts) b.active = false;
    this.aura = 0;
    this.moteDebt = 0;
  }

  /** The hero standing at screen (x, y), body `bodyPx` tall, drank: a rose flash rising round the body, glints. */
  drink(x: number, y: number, bodyPx: number): void {
    let burst = this.bursts.find((b) => !b.active);
    if (!burst) {
      if (this.bursts.length >= MAX_BURSTS) return;
      burst = { active: false, body: 0, age: 0 };
      this.bursts.push(burst);
    }
    burst.active = true;
    burst.body = bodyPx;
    burst.age = 0;
    for (let i = 0; i < 14; i++) this.glints.emitParticleAt(x + (Math.random() - 0.5) * 22, y - bodyPx * (0.45 + Math.random() * 0.3), 1);
    for (let i = 0; i < 10; i++) this.motes.emitParticleAt(x + (Math.random() - 0.5) * 34, y - bodyPx * Math.random() * 0.8, 1);
  }

  /**
   * Per frame: the drink bursts (on `g` under the actors / `top` over them) and, while `healing`, the rose aura at the
   * hero's feet (screen x, y) with motes rising off the body.
   */
  update(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, dt: number, x: number, y: number, bodyPx: number, healing: boolean): void {
    this.time += dt;
    this.aura = Phaser.Math.Clamp(this.aura + (healing ? dt : -dt) / AURA_FADE, 0, 1);
    if (this.aura > 0) {
      const pulse = 0.75 + 0.25 * Math.sin(this.time * 10);
      const a = this.aura * pulse;
      g.fillStyle(POTION_RUBY, 0.18 * a).fillEllipse(x, y, 62, 30);
      g.lineStyle(2, POTION_ROSE, 0.6 * a).strokeEllipse(x, y, 54 + 6 * pulse, 26 + 3 * pulse);
      top.fillStyle(POTION_ROSE, 0.07 * a).fillEllipse(x, y - bodyPx * 0.5, 46, bodyPx * 0.95);
    }
    if (healing) {
      this.moteDebt += dt * MOTE_RATE;
      while (this.moteDebt >= 1) {
        this.moteDebt -= 1;
        this.motes.emitParticleAt(x + (Math.random() - 0.5) * 36, y - bodyPx * (0.1 + Math.random() * 0.7), 1);
      }
    } else this.moteDebt = 0;

    for (const b of this.bursts) {
      if (!b.active) continue;
      b.age += dt;
      const k = b.age / DRINK_TTL;
      if (k >= 1) {
        b.active = false;
        continue;
      }
      const fade = 1 - k;
      const ease = 1 - fade * fade;
      // Ring spreading from the feet, and a column of light rising up the body.
      const rx = 18 + 44 * ease;
      // Follows the hero (drinking does not stop movement).
      g.lineStyle(4 * fade + 1, POTION_RUBY, 0.85 * fade).strokeEllipse(x, y, rx * 2, rx);
      g.lineStyle(2, POTION_CORE, 0.6 * fade).strokeEllipse(x, y, rx * 1.4, rx * 0.7);
      const colH = b.body * (0.6 + 0.6 * ease);
      top.fillStyle(POTION_ROSE, 0.28 * fade).fillEllipse(x, y - colH / 2, 34 * (1 - 0.4 * k), colH);
      top.fillStyle(POTION_CORE, 0.35 * fade * fade).fillCircle(x, y - b.body * 0.55, 10 + 14 * ease);
    }
  }
}

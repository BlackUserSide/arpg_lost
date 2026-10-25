import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';

// Visuals of the legendary Clock of the Last Moment (docs/design/items.md): the cheat-death trigger (a clock face
// flaring over the hero and shattering into glass and brass shards) and the time stop that follows (the world goes
// cold blue and grey while a ground dial under the hero sweeps out the seconds left; the hero keeps full colour).
// Render-only: when it triggers, how long time stands still and who is frozen all come from core (the 'cheatDeath' /
// 'timeStopEnd' events, WorldState.timeStop via timeStopped); every number here is a visual constant.
//
// Layering (depths): world sprites sit at their screen y (always < ENEMY_FX_DEPTH), then the scene's enemy fx Graphics
// (mob marks, mob projectiles), then this overlay, the dial and the raised hero (HERO_STOP_DEPTH), then the scene's
// fxTop with the hero's effects. So everything of the enemies is tinted and the hero stands out in normal colours.

/** Depth of the scene Graphics with enemy marks and projectiles (under the tint). */
export const ENEMY_FX_DEPTH = 3990;
const OVERLAY_DEPTH = 3994;
const DIAL_DEPTH = 3995;
/** The hero sprite is lifted to this depth while the tint is on (above it, under the hero's fx). */
export const HERO_STOP_DEPTH = 3996;
/** The trigger's clock face sits in front of the hero and its fx. */
const FACE_DEPTH = 4003;
/** The chime flash: over the whole world and its fx, under the darkness vignette and the HUD. */
const FLASH_DEPTH = 4004;

/** Clock colours: icy time blue, pale glass, brass. */
export const TIME_BLUE = 0x8fd8ff;
export const TIME_GLASS = 0xe8f8ff;
export const TIME_BRASS = 0xd8b060;
const TIME_DEEP = 0x1a3a5a;

/** Tint: a cold grey-blue wash (desaturates) under a blue multiply (cools), both scaled by the stop look 0..1. */
const WASH_COLOR = 0x5a6c8c;
const WASH_ALPHA = 0.4;
const TONE_COLOR = 0xa8c8ff;
const TONE_ALPHA = 0.85;
/** Seconds for the tint to come in (with the ripple) and to fade out when time runs again. */
const TINT_IN = 0.35;
const TINT_OUT = 0.55;

/** Trigger: the clock face over the hero (seconds, then it shatters), its radius (px). */
const FACE_TTL = 0.5;
const FACE_RADIUS = 34;
/** Ripple racing out of the hero when time stops (seconds, final world-screen radius px). */
const RIPPLE_TTL = 0.6;
const RIPPLE_RADIUS = 900;
/** Resume pulse when time runs again. */
const RESUME_TTL = 0.45;
const RESUME_RADIUS = 260;
/** Ground dial under the hero during the stop (screen px, a 2r × r ellipse). */
const DIAL_RADIUS = 66;
const SHARDS = 26;
/** Chime flash: an additive icy-white wash fading out (seconds, peak alpha). */
const FLASH_TTL = 0.24;
const FLASH_COLOR = 0xbfe6ff;
const FLASH_ALPHA = 0.55;

export class ClockFx {
  private readonly wash: Phaser.GameObjects.Rectangle;
  private readonly tone: Phaser.GameObjects.Rectangle;
  private readonly flash: Phaser.GameObjects.Rectangle;
  private flashAge = FLASH_TTL;
  private readonly dial: Phaser.GameObjects.Graphics;
  /** The trigger's clock face, in front of the hero. */
  private readonly face: Phaser.GameObjects.Graphics;
  private readonly shards: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly motes: Phaser.GameObjects.Particles.ParticleEmitter;
  /** 0..1: how much of the time-stop look is on (eases toward the core state). */
  private look = 0;
  /** Seconds since the last trigger (face + ripple) / resume pulse; past their ttl = not shown. */
  private faceAge = FACE_TTL;
  private rippleAge = RIPPLE_TTL;
  private resumeAge = RESUME_TTL;
  /** Where the ripple / resume pulse started (screen). */
  private originX = 0;
  private originY = 0;
  /** Stop length of the last trigger (dial sweep reference), seconds. */
  private stopTotal = 1;
  private shardsPending = false;

  constructor(scene: Phaser.Scene) {
    this.wash = scene.add.rectangle(0, 0, 10, 10, WASH_COLOR, 1).setOrigin(0).setScrollFactor(0).setDepth(OVERLAY_DEPTH).setAlpha(0).setVisible(false);
    this.tone = scene.add
      .rectangle(0, 0, 10, 10, TONE_COLOR, 1)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(OVERLAY_DEPTH)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setAlpha(0)
      .setVisible(false);
    this.flash = scene.add.rectangle(0, 0, 10, 10, FLASH_COLOR, 1).setOrigin(0).setScrollFactor(0).setDepth(FLASH_DEPTH).setBlendMode(Phaser.BlendModes.ADD).setVisible(false);
    this.dial = scene.add.graphics().setDepth(DIAL_DEPTH);
    this.face = scene.add.graphics().setDepth(FACE_DEPTH);
    this.shards = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 120, max: 330 },
        angle: { min: 0, max: 360 },
        gravityY: 260,
        rotate: { min: 0, max: 360 },
        scale: { start: 1.8, end: 0.2 },
        alpha: { start: 1, end: 0 },
        tint: [TIME_GLASS, TIME_BLUE, TIME_BRASS, 0xffffff],
        lifespan: { min: 380, max: 720 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 64,
        reserve: SHARDS,
      })
      .setDepth(4002);
    this.motes = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speed: { min: 4, max: 18 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.2, end: 0.03 },
        alpha: { start: 0.7, end: 0 },
        tint: [TIME_BLUE, TIME_GLASS],
        lifespan: { min: 300, max: 600 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 48,
        reserve: 16,
      })
      .setDepth(4001);
  }

  /** Sizes the screen tint (call on resize). */
  layout(width: number, height: number): void {
    this.wash.setSize(width, height);
    this.tone.setSize(width, height);
    this.flash.setSize(width, height);
  }

  /**
   * Room change / restart: drops the one-shot bursts (face, ripple, resume pulse, flash). `keepStop`: core time is
   * still stopped (timeStopped), so the tint, dial and the hero's raised depth carry on without a flicker.
   */
  clear(keepStop = false): void {
    if (!keepStop) this.look = 0;
    this.faceAge = FACE_TTL;
    this.rippleAge = RIPPLE_TTL;
    this.resumeAge = RESUME_TTL;
    this.shardsPending = false;
    this.flashAge = FLASH_TTL;
    this.flash.setVisible(false);
    this.applyLook();
    this.dial.clear();
    this.face.clear();
  }

  /** Cheat death fired on the hero at screen feet (x, y): clock face flare, then it shatters; the ripple stops time. */
  trigger(x: number, y: number, stopDuration: number): void {
    this.originX = x;
    this.originY = y;
    this.stopTotal = Math.max(0.01, stopDuration);
    this.faceAge = 0;
    this.rippleAge = 0;
    this.resumeAge = RESUME_TTL;
    this.shardsPending = true;
    this.flashAge = 0;
  }

  /** Time runs again: a warm pulse out of the hero at screen feet (x, y) while the tint fades. */
  resume(x: number, y: number): void {
    this.originX = x;
    this.originY = y;
    this.resumeAge = 0;
  }

  /** True while any of the time-stop look is on screen (the hero should stay lifted above the tint). */
  active(): boolean {
    return this.look > 0.001;
  }

  /**
   * Advances and draws. `stopped`: core time stop running (timeStopped); `remaining`: its seconds left;
   * (heroX, heroY): the hero's feet on screen, `bodyPx` its body height.
   */
  update(dt: number, stopped: boolean, remaining: number, heroX: number, heroY: number, bodyPx: number, time: number): void {
    const target = stopped ? 1 : 0;
    // The tint comes in with the ripple (fast) and drains slowly when time runs again.
    const rate = stopped ? 1 / TINT_IN : 1 / TINT_OUT;
    this.look = target > this.look ? Math.min(target, this.look + rate * dt) : Math.max(target, this.look - rate * dt);
    if (this.flashAge < FLASH_TTL) {
      this.flashAge += dt;
      const k = Math.min(1, this.flashAge / FLASH_TTL);
      this.flash.setVisible(k < 1).setAlpha(FLASH_ALPHA * (1 - k) ** 2);
    }
    this.applyLook();

    const g = this.dial.clear();
    const fg = this.face.clear();
    if (this.look > 0.001) this.drawDial(g, heroX, heroY, stopped ? remaining / this.stopTotal : 0, time);

    if (this.rippleAge < RIPPLE_TTL) {
      this.rippleAge += dt;
      this.drawRipple(g, Math.min(1, this.rippleAge / RIPPLE_TTL));
    }
    if (this.resumeAge < RESUME_TTL) {
      this.resumeAge += dt;
      this.drawResume(g, Math.min(1, this.resumeAge / RESUME_TTL));
    }
    if (this.faceAge < FACE_TTL) {
      this.faceAge += dt;
      const k = Math.min(1, this.faceAge / FACE_TTL);
      this.drawFace(fg, heroX, heroY - bodyPx * 0.55, k);
      // The face bursts into shards a little past half its life.
      if (this.shardsPending && k >= 0.55) {
        this.shardsPending = false;
        const cy = heroY - bodyPx * 0.55;
        for (let i = 0; i < SHARDS; i++) {
          const a = (i / SHARDS) * Math.PI * 2;
          this.shards.emitParticleAt(heroX + Math.cos(a) * FACE_RADIUS, cy + Math.sin(a) * FACE_RADIUS, 1);
        }
      }
    }
    if (stopped && Math.random() < 10 * dt) {
      const a = Math.random() * Math.PI * 2;
      this.motes.emitParticleAt(heroX + Math.cos(a) * DIAL_RADIUS, heroY + Math.sin(a) * DIAL_RADIUS * 0.5, 1);
    }
  }

  private applyLook(): void {
    const on = this.look > 0.001;
    // Ease-out so the colour drains in fast and lingers a moment on the way back.
    const k = 1 - (1 - this.look) ** 2;
    this.wash.setVisible(on).setAlpha(WASH_ALPHA * k);
    this.tone.setVisible(on).setAlpha(TONE_ALPHA * k);
  }

  /** Ground dial: rim, 12 ticks and a hand sweeping back over the seconds left (frac 1 → 0). */
  private drawDial(g: Phaser.GameObjects.Graphics, x: number, y: number, frac: number, time: number): void {
    const a = this.look;
    const r = DIAL_RADIUS * (0.85 + 0.15 * a);
    const ry = r * 0.5;
    g.fillStyle(TIME_DEEP, 0.28 * a).fillEllipse(x, y, r * 2, ry * 2);
    // Remaining time as a filled wedge (from 12 o'clock, clockwise).
    if (frac > 0.002) {
      const start = -Math.PI / 2;
      const end = start + Math.PI * 2 * Math.min(1, frac);
      g.fillStyle(TIME_BLUE, 0.16 * a);
      g.beginPath();
      g.moveTo(x, y);
      const steps = 40;
      for (let i = 0; i <= steps; i++) {
        const t = start + ((end - start) * i) / steps;
        g.lineTo(x + Math.cos(t) * r, y + Math.sin(t) * ry);
      }
      g.closePath();
      g.fillPath();
      // The hand on the wedge's edge.
      g.lineStyle(3, TIME_GLASS, 0.85 * a).lineBetween(x, y, x + Math.cos(end) * r * 0.92, y + Math.sin(end) * ry * 0.92);
    }
    const pulse = 0.5 + 0.5 * Math.sin(time * 6);
    g.lineStyle(2.5, TIME_BRASS, (0.6 + 0.25 * pulse) * a).strokeEllipse(x, y, r * 2, ry * 2);
    g.lineStyle(1.5, TIME_BLUE, 0.55 * a).strokeEllipse(x, y, r * 2.24, ry * 2.24);
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const inner = i % 3 === 0 ? 0.74 : 0.84;
      g.lineStyle(i % 3 === 0 ? 3 : 1.5, TIME_BRASS, 0.8 * a).lineBetween(x + c * r * inner, y + s * ry * inner, x + c * r * 0.97, y + s * ry * 0.97);
    }
  }

  /** Trigger ripple: a glassy double ring racing out over the screen from the hero. */
  private drawRipple(g: Phaser.GameObjects.Graphics, k: number): void {
    const grow = 1 - (1 - k) ** 2;
    const r = 30 + RIPPLE_RADIUS * grow;
    const fade = 1 - k;
    g.lineStyle(10 * fade + 2, TIME_BLUE, 0.55 * fade).strokeEllipse(this.originX, this.originY, r * 2, r);
    g.lineStyle(3, TIME_GLASS, 0.9 * fade).strokeEllipse(this.originX, this.originY, r * 1.9, r * 0.95);
    const r2 = r * 0.7;
    g.lineStyle(2, TIME_BRASS, 0.6 * fade).strokeEllipse(this.originX, this.originY, r2 * 2, r2);
  }

  /** Time runs again: a warm ring out of the hero, colour flowing back. */
  private drawResume(g: Phaser.GameObjects.Graphics, k: number): void {
    const grow = 1 - (1 - k) ** 3;
    const r = 24 + RESUME_RADIUS * grow;
    const fade = 1 - k;
    g.lineStyle(6 * fade + 1, TIME_BRASS, 0.75 * fade).strokeEllipse(this.originX, this.originY, r * 2, r);
    g.lineStyle(2, 0xffffff, 0.6 * fade).strokeEllipse(this.originX, this.originY, r * 1.8, r * 0.9);
  }

  /** The clock face over the hero's chest: pops in, hands spin backward, cracks, then shatters (fades). */
  private drawFace(g: Phaser.GameObjects.Graphics, x: number, y: number, k: number): void {
    const pop = k < 0.2 ? 1 - (1 - k / 0.2) ** 3 : 1;
    const fade = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
    const r = FACE_RADIUS * (0.5 + 0.5 * pop) * (k < 0.55 ? 1 : 1 + 0.4 * (k - 0.55));
    // Chime flash: a white disc on the first frames.
    if (k < 0.18) g.fillStyle(0xffffff, 0.7 * (1 - k / 0.18)).fillCircle(x, y, r * 1.6);
    g.fillStyle(TIME_BLUE, 0.25 * fade).fillCircle(x, y, r * 1.35);
    g.fillStyle(TIME_DEEP, 0.55 * fade).fillCircle(x, y, r);
    g.fillStyle(TIME_GLASS, 0.18 * fade).fillCircle(x, y, r * 0.92);
    g.lineStyle(3, TIME_BRASS, fade).strokeCircle(x, y, r);
    g.lineStyle(1.5, TIME_GLASS, 0.8 * fade).strokeCircle(x, y, r * 0.86);
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2;
      const inner = i % 3 === 0 ? 0.62 : 0.72;
      g.lineStyle(i % 3 === 0 ? 2.5 : 1.2, TIME_BRASS, 0.9 * fade).lineBetween(x + Math.cos(t) * r * inner, y + Math.sin(t) * r * inner, x + Math.cos(t) * r * 0.82, y + Math.sin(t) * r * 0.82);
    }
    // Hands spin backward (the clock rewinds), slowing to a stop on 12.
    const spin = (1 - Math.min(1, k / 0.55)) ** 2;
    const minute = -Math.PI / 2 - spin * Math.PI * 6;
    const hour = -Math.PI / 2 - spin * Math.PI * 1.5;
    g.lineStyle(3, TIME_GLASS, fade).lineBetween(x, y, x + Math.cos(minute) * r * 0.75, y + Math.sin(minute) * r * 0.75);
    g.lineStyle(4, TIME_BRASS, fade).lineBetween(x, y, x + Math.cos(hour) * r * 0.48, y + Math.sin(hour) * r * 0.48);
    g.fillStyle(TIME_BRASS, fade).fillCircle(x, y, 3);
    // Cracks across the glass just before it breaks.
    if (k > 0.35) {
      const c = Math.min(1, (k - 0.35) / 0.2) * fade;
      g.lineStyle(1.5, 0xffffff, 0.9 * c);
      for (let i = 0; i < 5; i++) {
        const t = i * 1.37 + 0.4;
        const mx = x + Math.cos(t) * r * 0.45;
        const my = y + Math.sin(t) * r * 0.45;
        g.lineBetween(x, y, mx, my);
        g.lineBetween(mx, my, x + Math.cos(t + 0.35) * r, y + Math.sin(t + 0.35) * r);
      }
    }
  }
}

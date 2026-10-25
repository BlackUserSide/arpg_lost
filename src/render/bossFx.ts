import * as Phaser from 'phaser';
import { fanOffsets } from '../core/math';
import type { MobAbilityDef } from '../core/world/content';
import type { HostileZone, MobCast } from '../core/world/world';
import { softDotTexture, sparkTexture } from './fxTextures';
import { ISO_K } from './iso';

// Visuals of the necromancer boss (docs/design/mobs.md «Бос») and of mob abilities in general: wind-up telegraphs
// drawn from MobState.casting every frame (nova danger circle, bone spear lanes, summoning glyphs), grave circles
// from WorldState.hostileZones, and short bursts for resolves, interruptions, the phase roar and crumbling minions.
// Render-only: every number here is a visual constant; radii, counts and spreads come from core state / ability defs.
// Cheap on purpose: everything is drawn into the scene's two fx Graphics, bursts are pooled, four particle emitters.
//
// Danger circles are drawn at the ability's radius: core hits the hero when their centre is within radius + hero
// radius, i.e. exactly when the hero's body touches the drawn circle.

/** Palette: dark violet for necrotic magic, icy cyan for the nova's cold, bone white for spears, sickly green for summons. */
const VIOLET = 0x9b5cff;
const VIOLET_DARK = 0x2a0a40;
const VIOLET_PALE = 0xd8b8ff;
const COLD = 0x9fe4ff;
const BONE = 0xe8dcc0;
const NECRO_GREEN = 0x7dff9a;
const GRAVE_RIM = 0xc04cff;
/** Grave earth flung by the gravedigger. */
const EARTH = 0x5a3f26;
const EARTH_LIGHT = 0x8a6a46;
const EARTH_DUST = 0x9a8466;

const NOVA_TTL = 0.55;
const RAISE_TTL = 0.75;
const ERUPT_TTL = 0.5;
const INTERRUPT_TTL = 0.4;
const ROAR_TTL = 0.95;
const DROP_TTL = 0.25;
const MAX_BURSTS = 40;
/** Bone spikes thrusting out of an erupting grave circle. */
const ERUPT_SPIKES = 7;
/** Glyphs drawn on the summoning ring while the boss raises the dead. */
const SUMMON_GLYPHS_MIN = 3;
/** Wisps per second rising off the boss during the immune roar and in later phases. */
const AURA_WISP_RATE = 16;
const PHASE_WISP_RATE = 3;

export type BossBurstKind = 'nova' | 'raise' | 'erupt' | 'interrupt' | 'roar' | 'drop';

interface Burst {
  active: boolean;
  kind: BossBurstKind;
  x: number;
  y: number;
  /** World radius (2r × r ellipse on screen); for 'interrupt' the body height. */
  radius: number;
  age: number;
  ttl: number;
  spin: number;
}

/** Hashes a number into 0..1 (stable per zone / glyph, so shapes do not jump between frames). */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** World → screen without allocating (render/iso toScreen, inlined for the per-frame lane drawing). */
const isoX = (x: number, y: number): number => (x - y) * ISO_K;
const isoY = (x: number, y: number): number => ((x + y) * ISO_K) / 2;

export class BossFx {
  private readonly wisps: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly greenWisps: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly shards: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bones: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bursts: Burst[] = [];

  constructor(scene: Phaser.Scene) {
    const dot = softDotTexture(scene);
    const spark = sparkTexture(scene);
    // Dark smoke: normal blending with dark tints, so it reads as shadow rather than light.
    this.wisps = scene.add
      .particles(0, 0, dot, {
        emitting: false,
        speedY: { min: -30, max: -70 },
        speedX: { min: -12, max: 12 },
        scale: { start: 0.35, end: 0.9 },
        alpha: { start: 0.55, end: 0 },
        tint: [0x3a1660, 0x5a2a9a, 0x1a0a2a],
        lifespan: { min: 500, max: 900 },
        maxAliveParticles: 120,
        reserve: 32,
      })
      .setDepth(4001);
    this.greenWisps = scene.add
      .particles(0, 0, dot, {
        emitting: false,
        speedY: { min: -25, max: -60 },
        speedX: { min: -10, max: 10 },
        scale: { start: 0.25, end: 0.05 },
        alpha: { start: 0.8, end: 0 },
        tint: [NECRO_GREEN, 0x3aa860, 0xb8ffc8],
        lifespan: { min: 400, max: 750 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 96,
        reserve: 24,
      })
      .setDepth(4002);
    this.shards = scene.add
      .particles(0, 0, spark, {
        emitting: false,
        speed: { min: 60, max: 170 },
        angle: { min: 0, max: 360 },
        gravityY: 120,
        scale: { start: 1.4, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, COLD, VIOLET_PALE],
        lifespan: { min: 280, max: 520 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 160,
        reserve: 32,
      })
      .setDepth(4002);
    this.bones = scene.add
      .particles(0, 0, spark, {
        emitting: false,
        speed: { min: 50, max: 150 },
        angle: { min: 200, max: 340 },
        gravityY: 380,
        scale: { start: 1.3, end: 0.6 },
        alpha: { start: 1, end: 0 },
        tint: [BONE, 0xc8bca0, 0xffffff],
        lifespan: { min: 380, max: 620 },
        maxAliveParticles: 120,
        reserve: 32,
      })
      .setDepth(4002);
    this.dust = scene.add
      .particles(0, 0, dot, {
        emitting: false,
        speed: { min: 20, max: 70 },
        angle: { min: 0, max: 360 },
        gravityY: -8,
        scale: { start: 0.3, end: 0.8 },
        alpha: { start: 0.5, end: 0 },
        tint: [0xb8a888, 0x8a7c66, 0xd8ccb0],
        lifespan: { min: 420, max: 700 },
        maxAliveParticles: 120,
        reserve: 32,
      })
      .setDepth(4001);
  }

  /** Drops running bursts (room change). */
  clear(): void {
    for (const b of this.bursts) b.active = false;
  }

  /**
   * A mob winding up `ability`: the telegraph for its kind. (bx, by) world position of the caster (display), (x, y)
   * its feet on screen, `bodyRadius` its world body radius, `bodyHeight` its sprite height in screen px.
   */
  drawCast(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, cast: MobCast, ability: MobAbilityDef | undefined, bx: number, by: number, x: number, y: number, bodyRadius: number, bodyHeight: number, time: number, dt: number): void {
    const p = cast.total > 0 ? Phaser.Math.Clamp(1 - cast.remaining / cast.total, 0, 1) : 1;
    const pulse = 0.5 + 0.5 * Math.sin(time * 14);
    // Gathering power at the staff / hands: every wind-up shows it, so any cast reads as "something is coming".
    const hy = y - bodyHeight * 0.78;
    const glow = cast.kind === 'summon' ? NECRO_GREEN : cast.kind === 'projectileFan' ? BONE : VIOLET;
    top.fillStyle(glow, 0.12 + 0.18 * p).fillCircle(x, hy, 10 + 14 * p);
    top.fillStyle(0xffffff, 0.25 + 0.35 * p * pulse).fillCircle(x, hy, 3 + 3 * p);
    g.fillStyle(VIOLET_DARK, 0.25 + 0.2 * p).fillEllipse(x, y, bodyRadius * 3.4, bodyRadius * 1.7);

    switch (cast.kind) {
      case 'nova':
        this.drawNovaTelegraph(g, x, y, cast.radius ?? (ability?.kind === 'nova' ? ability.radius : bodyRadius * 4), p, time);
        break;
      case 'projectileFan':
        if (ability?.kind === 'projectileFan') this.drawSpearLanes(g, top, cast, ability.count, ability.spreadDeg, ability.flightRange, ability.radius, bx, by, bodyRadius, p, time);
        break;
      case 'summon':
        this.drawSummonGlyphs(g, x, y, ability?.kind === 'summon' ? ability.ringRadius : bodyRadius * 3, ability?.kind === 'summon' ? ability.count : 4, p, time, dt);
        break;
      case 'groundZones':
        // Zones are placed under the target when the wind-up ends: a dark swirl round the caster is enough.
        g.lineStyle(2, GRAVE_RIM, 0.25 + 0.4 * p).strokeEllipse(x, y, bodyRadius * 4.4 * (1.2 - 0.2 * p), bodyRadius * 2.2 * (1.2 - 0.2 * p));
        if (Math.random() < 20 * dt) this.wisps.emitParticleAt(x + (Math.random() - 0.5) * bodyRadius * 2, y - Math.random() * bodyHeight * 0.6, 1);
        break;
    }
  }

  /** Nova: the danger disc fills from the centre over the wind-up; the rim pulses and flashes cold near the end. */
  private drawNovaTelegraph(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, p: number, time: number): void {
    const late = p > 0.75;
    const flicker = late ? Math.floor(time * 18) % 2 : 0;
    g.fillStyle(VIOLET_DARK, 0.28 + 0.12 * p).fillEllipse(x, y, r * 2, r);
    g.fillStyle(VIOLET, 0.12 + 0.2 * p).fillEllipse(x, y, r * 2 * p, r * p);
    g.lineStyle(1.5, COLD, 0.35 + 0.4 * p).strokeEllipse(x, y, r * 2 * p, r * p);
    g.lineStyle(3, flicker ? 0xffffff : late ? COLD : VIOLET_PALE, 0.55 + 0.45 * p).strokeEllipse(x, y, r * 2, r);
    // Rune ticks turning round the rim.
    const spin = time * 1.6;
    g.lineStyle(2, VIOLET_PALE, 0.4 + 0.5 * p);
    for (let i = 0; i < 12; i++) {
      const a = spin + (i / 12) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      g.lineBetween(x + c * r * 0.86, y + s * r * 0.43, x + c * r * 0.96, y + s * r * 0.48);
    }
  }

  /**
   * Bone spears: one faint lane per spear along the fan (aimed where the hero stood when the wind-up began), each
   * charging outwards over the wind-up, so the gaps between them read before anything flies.
   */
  private drawSpearLanes(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, cast: MobCast, countDef: number, spreadDeg: number, length: number, spearRadius: number, bx: number, by: number, bodyRadius: number, p: number, time: number): void {
    const base = Math.atan2(cast.dir.y, cast.dir.x);
    const reach = length * (0.15 + 0.85 * p);
    const pulse = 0.5 + 0.5 * Math.sin(time * 10);
    // The same offsets core fires the spears along (abilities.ts projectileFan).
    for (const offset of fanOffsets(Math.max(1, Math.floor(countDef)), spreadDeg)) {
      const a = base + offset;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const x0 = bx + dx * bodyRadius;
      const y0 = by + dy * bodyRadius;
      const x1 = bx + dx * length;
      const y1 = by + dy * length;
      const xr = bx + dx * reach;
      const yr = by + dy * reach;
      const sx0 = isoX(x0, y0);
      const sy0 = isoY(x0, y0);
      // The whole lane, very faint; the charged part brighter; a bright head where the charge has got to.
      g.lineStyle(spearRadius * 2, BONE, 0.06 + 0.06 * p).lineBetween(sx0, sy0, isoX(x1, y1), isoY(x1, y1));
      g.lineStyle(spearRadius * 1.2, BONE, 0.12 + 0.2 * p).lineBetween(sx0, sy0, isoX(xr, yr), isoY(xr, yr));
      g.lineStyle(1.5, 0xffffff, 0.25 + 0.4 * p).lineBetween(sx0, sy0, isoX(xr, yr), isoY(xr, yr));
      top.fillStyle(0xffffff, (0.3 + 0.5 * p) * (0.6 + 0.4 * pulse)).fillCircle(isoX(xr, yr), isoY(xr, yr), 2.5 + 2 * p);
    }
  }

  /** Raise dead: a green rune ring at the summoning radius with glyphs where the dead will climb out. */
  private drawSummonGlyphs(g: Phaser.GameObjects.Graphics, x: number, y: number, ring: number, countDef: number, p: number, time: number, dt: number): void {
    const count = Math.max(SUMMON_GLYPHS_MIN, Math.floor(countDef));
    const spin = time * 0.6;
    g.lineStyle(2, NECRO_GREEN, 0.2 + 0.35 * p).strokeEllipse(x, y, ring * 2, ring);
    g.lineStyle(1, NECRO_GREEN, 0.15 + 0.25 * p).strokeEllipse(x, y, ring * 2 * 0.82, ring * 0.82);
    for (let i = 0; i < count; i++) {
      const a = spin + (i / count) * Math.PI * 2;
      const gx = x + Math.cos(a) * ring;
      const gy = y + Math.sin(a) * ring * 0.5;
      const s = 9 + 7 * p;
      g.fillStyle(0x0a1a10, 0.4 * p + 0.1).fillEllipse(gx, gy, s * 2.4, s * 1.2);
      g.lineStyle(2, NECRO_GREEN, 0.35 + 0.55 * p).strokeEllipse(gx, gy, s * 2.4, s * 1.2);
      // A cross-shaped grave glyph.
      g.lineBetween(gx - s * 0.8, gy, gx + s * 0.8, gy);
      g.lineBetween(gx, gy - s * 0.4, gx, gy + s * 0.4);
      if (Math.random() < 5 * p * dt) this.greenWisps.emitParticleAt(gx + (Math.random() - 0.5) * s, gy - 2, 1);
    }
  }

  /** A grave circle at screen (x, y): a dark warning disc filling up over its delay, flashing just before it erupts. */
  drawHostileZone(g: Phaser.GameObjects.Graphics, zone: HostileZone, x: number, y: number, time: number): void {
    const p = zone.total > 0 ? Phaser.Math.Clamp(1 - zone.remaining / zone.total, 0, 1) : 1;
    const r = zone.radius;
    const appear = Math.min(1, p * 6);
    const late = zone.remaining < 0.2;
    const flicker = late && Math.floor(time * 24) % 2 === 0;
    g.fillStyle(0x12040c, 0.45 * appear).fillEllipse(x, y, r * 2, r);
    g.fillStyle(late ? 0xe070ff : 0x8a2ac0, (0.25 + 0.3 * p) * appear).fillEllipse(x, y, r * 2 * p, r * p);
    // Cracks radiating from the centre (stable per zone).
    g.lineStyle(1.5, GRAVE_RIM, (0.25 + 0.45 * p) * appear);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + hash01(zone.id + i) * 0.6;
      const d = (0.45 + 0.4 * hash01(zone.id * 3 + i)) * p;
      g.lineBetween(x, y, x + Math.cos(a) * r * d, y + Math.sin(a) * r * d * 0.5);
    }
    g.lineStyle(flicker ? 4 : 2.5, flicker ? 0xffffff : GRAVE_RIM, (0.6 + 0.4 * p) * appear).strokeEllipse(x, y, r * 2, r);
  }

  /** Immune roar (phase change pause) round a boss at screen (x, y): a pulsing violet shell and rising dark smoke. */
  drawImmuneAura(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, x: number, y: number, radius: number, bodyHeight: number, progress: number, time: number, dt: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 16);
    const fade = Math.min(1, (1 - progress) * 4);
    g.fillStyle(VIOLET, (0.18 + 0.12 * pulse) * fade).fillEllipse(x, y, radius * 4, radius * 2);
    g.lineStyle(3, VIOLET_PALE, (0.5 + 0.4 * pulse) * fade).strokeEllipse(x, y, radius * 4, radius * 2);
    // Shell round the body: two tilted rings at waist and chest height, turning.
    for (let i = 0; i < 2; i++) {
      const hy = y - bodyHeight * (0.35 + 0.3 * i);
      const w = radius * (2.6 - 0.4 * i) * (1 + 0.06 * Math.sin(time * 9 + i));
      top.lineStyle(2, i === 0 ? VIOLET_PALE : COLD, (0.35 + 0.35 * pulse) * fade).strokeEllipse(x, hy, w * 2, w * 0.7);
    }
    if (Math.random() < AURA_WISP_RATE * dt) this.wisps.emitParticleAt(x + (Math.random() - 0.5) * radius * 2.4, y - Math.random() * bodyHeight * 0.4, 1);
  }

  /** Later phases: a faint violet ring and a wisp now and then, so the angrier boss stays recognisable. */
  drawPhaseMark(g: Phaser.GameObjects.Graphics, x: number, y: number, radius: number, time: number, dt: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 3);
    g.lineStyle(2, VIOLET, 0.35 + 0.25 * pulse).strokeEllipse(x, y, radius * 3.6, radius * 1.8);
    if (Math.random() < PHASE_WISP_RATE * dt) this.wisps.emitParticleAt(x + (Math.random() - 0.5) * radius * 2, y - 4, 1);
  }

  /** A bone spear in flight: screen head (x, y) and tail (tx, ty), both already lifted to projectile height. */
  drawBoneSpear(top: Phaser.GameObjects.Graphics, x: number, y: number, tx: number, ty: number, radius: number): void {
    const dx = x - tx;
    const dy = y - ty;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // Longer than a plain bolt: the shaft starts further back.
    const bx = x - ux * len * 1.6;
    const by = y - uy * len * 1.6;
    top.lineStyle(radius * 1.6, VIOLET, 0.22).lineBetween(bx - ux * 10, by - uy * 10, x, y);
    top.lineStyle(radius * 0.9, 0x3a2a24, 0.9).lineBetween(bx, by, x, y);
    top.lineStyle(radius * 0.55, BONE, 1).lineBetween(bx, by, x, y);
    const tipX = x + ux * radius * 1.4;
    const tipY = y + uy * radius * 1.4;
    const px = -uy * radius * 0.7;
    const py = ux * radius * 0.7;
    top.fillStyle(0xffffff, 1).fillTriangle(tipX, tipY, x + px, y + py, x - px, y - py);
  }

  /**
   * A thrown bone (the bone thrower): a short bone tumbling end over end, knobs at both ends. (x, y) screen centre,
   * `radius` the projectile's world radius, `spin` its turn angle (radians).
   */
  drawThrownBone(top: Phaser.GameObjects.Graphics, x: number, y: number, radius: number, spin: number): void {
    const half = radius * 1.5;
    const cx = Math.cos(spin) * half;
    // Turning in the screen plane but squashed a little, so it reads as tumbling rather than a flat propeller.
    const cy = Math.sin(spin) * half * 0.7;
    top.fillStyle(BONE, 0.18).fillCircle(x, y, radius * 1.8);
    top.lineStyle(radius * 0.9, 0x3a2a24, 0.9).lineBetween(x - cx, y - cy, x + cx, y + cy);
    top.lineStyle(radius * 0.5, BONE, 1).lineBetween(x - cx, y - cy, x + cx, y + cy);
    const knob = radius * 0.42;
    const px = -Math.sin(spin) * knob * 0.8;
    const py = Math.cos(spin) * knob * 0.8 * 0.7;
    top.fillStyle(BONE, 1);
    top.fillCircle(x + cx + px, y + cy + py, knob).fillCircle(x + cx - px, y + cy - py, knob);
    top.fillCircle(x - cx + px, y - cy + py, knob).fillCircle(x - cx - px, y - cy - py, knob);
  }

  /** The gravedigger's flung clod of grave earth: a dark brown lump with a dusty trail. */
  drawEarthClod(top: Phaser.GameObjects.Graphics, x: number, y: number, tx: number, ty: number, radius: number): void {
    top.lineStyle(radius * 1.4, EARTH_DUST, 0.3).lineBetween(tx, ty, x, y);
    top.fillStyle(EARTH_DUST, 0.3).fillCircle(x, y, radius * 1.8);
    top.fillStyle(EARTH, 1).fillCircle(x, y, radius * 1.05);
    top.fillStyle(EARTH_LIGHT, 1).fillCircle(x - radius * 0.3, y - radius * 0.35, radius * 0.4);
    top.lineStyle(1.5, 0x1a1008, 0.9).strokeCircle(x, y, radius * 1.05);
  }

  /** The boss's weak dark bolt: a dark core in a violet glow with a short trail. */
  drawDarkBolt(top: Phaser.GameObjects.Graphics, x: number, y: number, tx: number, ty: number, radius: number): void {
    top.lineStyle(radius * 1.2, VIOLET, 0.35).lineBetween(tx, ty, x, y);
    top.fillStyle(VIOLET, 0.3).fillCircle(x, y, radius * 2.2);
    top.fillStyle(VIOLET_DARK, 1).fillCircle(x, y, radius * 1.05);
    top.lineStyle(1.5, VIOLET_PALE, 0.95).strokeCircle(x, y, radius * 1.05);
  }

  /** Nova resolved at screen (x, y), world radius r: a cold violet shockwave with ice shards. */
  nova(x: number, y: number, r: number): void {
    if (!this.start('nova', x, y, r, NOVA_TTL)) return;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      this.shards.emitParticleAt(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.42 - 6, 1);
    }
  }

  /** A minion climbs out at screen (x, y): green ground glow, dark smoke and dirt. */
  raise(x: number, y: number): void {
    if (!this.start('raise', x, y, 26, RAISE_TTL)) return;
    this.greenWisps.emitParticleAt(x, y - 6, 4);
    this.wisps.emitParticleAt(x, y - 4, 3);
    this.dust.emitParticleAt(x, y - 2, 4);
  }

  /** A grave circle erupted at screen (x, y), world radius r: bone spikes thrust up, splinters and dust. */
  erupt(x: number, y: number, r: number): void {
    if (!this.start('erupt', x, y, r, ERUPT_TTL)) return;
    this.bones.emitParticleAt(x, y - 8, 8);
    this.dust.emitParticleAt(x, y - 2, 5);
  }

  /** A grave circle appeared at screen (x, y): a small dark pop. */
  zoneDropped(x: number, y: number, r: number): void {
    this.start('drop', x, y, r, DROP_TTL);
  }

  /** A wind-up was cut at screen (x, y) (feet), body height `h` px: a violet-white starburst and shards at the hands. */
  interrupt(x: number, y: number, h: number): void {
    if (!this.start('interrupt', x, y, h, INTERRUPT_TTL)) return;
    this.shards.emitParticleAt(x, y - h * 0.75, 12);
  }

  /** Phase change roar at screen (x, y): dark rings rolling out and a burst of smoke. */
  roar(x: number, y: number, radius: number): void {
    if (!this.start('roar', x, y, radius, ROAR_TTL)) return;
    for (let i = 0; i < 10; i++) this.wisps.emitParticleAt(x + (Math.random() - 0.5) * radius * 2, y - Math.random() * 30, 1);
  }

  /** A hit glanced off an immune mob at screen (x, y) (mid-body): a few pale sparks. */
  deflect(x: number, y: number): void {
    this.shards.emitParticleAt(x, y, 4);
  }

  /** A minion crumbles (its summoner died) at screen (x, y): bone dust and splinters. */
  crumble(x: number, y: number): void {
    this.dust.emitParticleAt(x, y - 14, 7);
    this.bones.emitParticleAt(x, y - 20, 5);
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
      switch (b.kind) {
        case 'nova':
          this.drawNova(g, b, t);
          break;
        case 'raise':
          this.drawRaise(g, b, t);
          break;
        case 'erupt':
          this.drawErupt(g, top, b, t);
          break;
        case 'interrupt':
          this.drawInterrupt(top, b, t);
          break;
        case 'roar':
          this.drawRoar(g, b, t);
          break;
        case 'drop':
          g.lineStyle(3 * (1 - t) + 1, GRAVE_RIM, 0.8 * (1 - t)).strokeEllipse(b.x, b.y, b.radius * 2 * (0.4 + 0.6 * t), b.radius * (0.4 + 0.6 * t));
          break;
      }
    }
  }

  private start(kind: BossBurstKind, x: number, y: number, radius: number, ttl: number): boolean {
    let burst = this.bursts.find((b) => !b.active);
    if (!burst) {
      if (this.bursts.length >= MAX_BURSTS) return false;
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
    return true;
  }

  private drawNova(g: Phaser.GameObjects.Graphics, b: Burst, t: number): void {
    const fade = 1 - t;
    const grow = 1 - (1 - Math.min(1, t * 2)) ** 3;
    const r = b.radius * (0.25 + 0.8 * grow);
    if (t < 0.25) g.fillStyle(0xffffff, 0.35 * (1 - t / 0.25)).fillEllipse(b.x, b.y, b.radius * 1.2, b.radius * 0.6);
    g.fillStyle(VIOLET, 0.3 * fade).fillEllipse(b.x, b.y, r * 2, r);
    g.lineStyle(8 * fade + 2, VIOLET, 0.9 * fade).strokeEllipse(b.x, b.y, r * 2, r);
    g.lineStyle(2.5, COLD, 0.9 * fade).strokeEllipse(b.x, b.y, r * 1.8, r * 0.9);
    g.lineStyle(1.5, 0xffffff, 0.6 * fade).strokeEllipse(b.x, b.y, r * 2.1, r * 1.05);
  }

  private drawRaise(g: Phaser.GameObjects.Graphics, b: Burst, t: number): void {
    const fade = 1 - t;
    const r = b.radius * (0.6 + 0.8 * t);
    g.fillStyle(0x0a1a10, 0.5 * fade).fillEllipse(b.x, b.y, r * 2.4, r * 1.2);
    g.fillStyle(NECRO_GREEN, 0.25 * fade).fillEllipse(b.x, b.y, r * 1.6, r * 0.8);
    g.lineStyle(2, NECRO_GREEN, 0.8 * fade).strokeEllipse(b.x, b.y, r * 2.4, r * 1.2);
  }

  private drawErupt(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst, t: number): void {
    const fade = 1 - t;
    const r = b.radius;
    if (t < 0.2) g.fillStyle(0xf0d0ff, 0.5 * (1 - t / 0.2)).fillEllipse(b.x, b.y, r * 2, r);
    const ring = r * (0.8 + 0.4 * t);
    g.fillStyle(0x3a0a50, 0.35 * fade).fillEllipse(b.x, b.y, r * 2, r);
    g.lineStyle(4 * fade + 1, GRAVE_RIM, 0.9 * fade).strokeEllipse(b.x, b.y, ring * 2, ring);
    // Spikes shoot up fast, hold, then sink.
    const rise = t < 0.3 ? t / 0.3 : 1 - Math.max(0, (t - 0.6) / 0.4);
    for (let i = 0; i < ERUPT_SPIKES; i++) {
      const a = b.spin + (i / ERUPT_SPIKES) * Math.PI * 2 + hash01(i + b.spin) * 0.5;
      const d = r * (i === 0 ? 0 : 0.3 + 0.45 * hash01(i * 7 + b.spin));
      const px = b.x + Math.cos(a) * d;
      const py = b.y + Math.sin(a) * d * 0.5;
      const h = (22 + 18 * hash01(i * 3 + b.spin)) * rise;
      const w = 5 + 2 * hash01(i);
      top.fillStyle(0x3a2a24, 0.9 * fade).fillTriangle(px - w - 1, py, px + w + 1, py, px, py - h - 2);
      top.fillStyle(BONE, fade).fillTriangle(px - w, py, px + w, py, px, py - h);
    }
  }

  private drawInterrupt(top: Phaser.GameObjects.Graphics, b: Burst, t: number): void {
    const fade = 1 - t;
    const cx = b.x;
    const cy = b.y - b.radius * 0.75;
    const r = 10 + 30 * (1 - (1 - t) ** 2);
    top.fillStyle(0xffffff, 0.6 * fade * fade).fillCircle(cx, cy, 10 * fade + 4);
    top.lineStyle(3 * fade + 1, VIOLET_PALE, 0.9 * fade).strokeCircle(cx, cy, r);
    top.lineStyle(2, 0xffffff, 0.9 * fade);
    for (let i = 0; i < 8; i++) {
      const a = b.spin + (i / 8) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      top.lineBetween(cx + c * r * 0.6, cy + s * r * 0.6, cx + c * r * 1.15, cy + s * r * 1.15);
    }
  }

  private drawRoar(g: Phaser.GameObjects.Graphics, b: Burst, t: number): void {
    for (let i = 0; i < 3; i++) {
      const k = t * 1.4 - i * 0.2;
      if (k <= 0 || k >= 1) continue;
      const r = b.radius * (1 + 7 * k);
      g.lineStyle(6 * (1 - k) + 1, i === 1 ? COLD : VIOLET, 0.8 * (1 - k)).strokeEllipse(b.x, b.y, r * 2, r);
    }
    g.fillStyle(VIOLET_DARK, 0.4 * (1 - t)).fillEllipse(b.x, b.y, b.radius * 8, b.radius * 4);
  }
}

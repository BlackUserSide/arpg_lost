import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';
import { UI } from './ui';

// Visuals of skill modifiers ("supports", docs/design/skill-modifiers.md): Chain Lightning bolts, the Echo repeat
// ghost, Knockback dust and streaks, bleed drops on mobs and the support drop glint. Render-only: driven by world
// events and read-only mob state; every number here is a visual constant. Screen coordinates in.
// Cheap on purpose: bolts and bursts are pooled records drawn into the scene's fx Graphics, ghosts and drop glints
// are pooled game objects, two shared particle emitters.

/** Approximate body height of a mob sprite above its feet, in screen px (matches combatFx). */
const BODY_HEIGHT = 52;

const BOLT_TTL = 0.26;
/** Most points in one bolt (impact target + hops); extra points are dropped. */
const BOLT_MAX_POINTS = 8;
const MAX_BOLTS = 24;
/** Jagged sub-segments per hop and their sideways jitter (px). */
const BOLT_SUBDIV = 5;
const BOLT_JITTER = 9;
const BOLT_GLOW = 0x6fa8ff;
const BOLT_CORE = 0xf4f8ff;

const ECHO_TTL = 0.42;
const ECHO_TINT = 0x9a7aff;
const ECHO_RING = 0xc4a8ff;

const KNOCK_TTL = 0.32;
const KNOCK_COLOR = 0xe8dcc0;
const MAX_BURSTS = 32;

/** Bleed drops under a mob's feet, below the stun bar. */
const BLEED_DROP_Y = 21;
const BLEED_STEP = 11;
const BLEED_COLOR = 0xc0202c;
const BLEED_LIGHT = 0xff7a7a;

/** Support drop glint: pop, hover, fly to the hero, flash. Seconds. */
const DROP_POP = 0.25;
const DROP_HOVER = 1.9;
const DROP_FLY = 0.45;
const DROP_LABEL_TIME = 2.6;
/** Vertical step between stacked drop labels (px). */
const LABEL_STEP = 20;
/** Height the gem hovers above the floor (px). */
const DROP_LIFT = 34;
/** Above the darkness overlay (5000): a drop should catch the eye even at the edge of the light. */
const DROP_DEPTH = 5100;
/** Light pillar size as soft-dot texture scale (64 px texture). */
const BEAM_WIDTH = 0.42;
const BEAM_HEIGHT = 2.8;

interface Bolt {
  active: boolean;
  n: number;
  xs: number[];
  ys: number[];
  age: number;
}

interface Burst {
  active: boolean;
  kind: 'echo' | 'knock';
  x: number;
  y: number;
  /** Screen direction (knockback). */
  dx: number;
  dy: number;
  /** Streak length (knockback), px. */
  len: number;
  /** Ring colour (echo). */
  color: number;
  age: number;
  ttl: number;
}

interface Ghost {
  sprite: Phaser.GameObjects.Sprite;
  age: number;
  dx: number;
  dy: number;
}

interface Drop {
  gem: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  /** Soft light pillar: the soft dot stretched tall. */
  beam: Phaser.GameObjects.Image;
  text: Phaser.GameObjects.Text;
  x: number;
  y: number;
  age: number;
  active: boolean;
  /** Where the fly started (screen). */
  flyX: number;
  flyY: number;
  /** Extra label lift so labels of drops close together do not overlap (px). */
  labelLift: number;
}

export class SupportFx {
  private readonly sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bolts: Bolt[] = [];
  private readonly bursts: Burst[] = [];
  private readonly ghosts: Ghost[] = [];
  private readonly ghostPool: Phaser.GameObjects.Sprite[] = [];
  private readonly drops: Drop[] = [];

  constructor(private readonly scene: Phaser.Scene) {
    this.sparks = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speed: { min: 50, max: 160 },
        angle: { min: 0, max: 360 },
        scale: { start: 1.2, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, 0xcfe0ff, 0x8fb8ff],
        lifespan: { min: 180, max: 360 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 120,
        reserve: 32,
      })
      .setDepth(4003);
    this.dust = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speed: { min: 20, max: 70 },
        angle: { min: 0, max: 360 },
        gravityY: -12,
        scale: { start: 0.3, end: 0.65 },
        alpha: { start: 0.4, end: 0 },
        tint: [0xb8a888, 0x8a7c66, 0xd8ccb0],
        lifespan: { min: 300, max: 520 },
        maxAliveParticles: 96,
        reserve: 24,
      })
      .setDepth(4001);
  }

  /**
   * A Chain Lightning bolt through screen points (already lifted to body height): `xs` / `ys` from the impact target
   * through every hop. Sparks crackle at each struck target.
   */
  chain(xs: readonly number[], ys: readonly number[]): void {
    const n = Math.min(BOLT_MAX_POINTS, xs.length, ys.length);
    if (n < 2) return;
    let bolt = this.bolts.find((b) => !b.active);
    if (!bolt) {
      if (this.bolts.length >= MAX_BOLTS) return;
      bolt = { active: false, n: 0, xs: new Array<number>(BOLT_MAX_POINTS).fill(0), ys: new Array<number>(BOLT_MAX_POINTS).fill(0), age: 0 };
      this.bolts.push(bolt);
    }
    bolt.active = true;
    bolt.n = n;
    bolt.age = 0;
    for (let i = 0; i < n; i++) {
      bolt.xs[i] = xs[i]!;
      bolt.ys[i] = ys[i]!;
      if (i > 0) this.sparks.emitParticleAt(xs[i]!, ys[i]!, 4);
    }
  }

  /**
   * Echo repeat: an afterimage of the hero (copy of `hero`'s current frame) drifting back from screen facing
   * (fx, fy), and a violet ring at the feet. `tint` / `ring` recolour the ghost and the ring (Devourer's Crown echo).
   */
  echo(hero: Phaser.GameObjects.Sprite, fx: number, fy: number, tint: number = ECHO_TINT, ring: number = ECHO_RING): void {
    const sprite = this.ghostPool.pop() ?? this.scene.add.sprite(0, 0, hero.texture.key);
    sprite
      .setTexture(hero.texture.key, hero.frame.name)
      .setOrigin(hero.originX, hero.originY)
      .setPosition(hero.x, hero.y)
      .setDepth(hero.depth - 1)
      .setTint(tint)
      .setTintMode(Phaser.TintModes.SCREEN)
      .setAlpha(0.7)
      .setScale(1)
      .setVisible(true);
    const len = Math.hypot(fx, fy) || 1;
    this.ghosts.push({ sprite, age: 0, dx: -fx / len, dy: -fy / len });
    const burst = this.startBurst('echo', hero.x, hero.y, 0, 0, 0, ECHO_TTL);
    if (burst) burst.color = ring;
  }

  /** Knockback at screen (x, y) (mob feet) along screen direction (dx, dy) over about `len` px: dust and streaks. */
  knockback(x: number, y: number, dx: number, dy: number, len: number): void {
    const d = Math.hypot(dx, dy) || 1;
    this.startBurst('knock', x, y, dx / d, dy / d, len, KNOCK_TTL);
    for (let i = 0; i < 4; i++) this.dust.emitParticleAt(x + (Math.random() - 0.5) * 16, y - 2 + (Math.random() - 0.5) * 6, 1);
  }

  /** Speed streaks behind a mob still flying from a knockback; (x, y) its feet, (dx, dy) screen direction. */
  drawKnockbackTrail(top: Phaser.GameObjects.Graphics, x: number, y: number, dx: number, dy: number): void {
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    // Perpendicular offsets so the three streaks frame the body.
    const px = -uy;
    const py = ux;
    for (let i = -1; i <= 1; i++) {
      const ox = x + px * i * 9;
      const oy = y - BODY_HEIGHT * 0.45 + py * i * 9;
      const len = i === 0 ? 30 : 20;
      top.lineStyle(2, KNOCK_COLOR, i === 0 ? 0.75 : 0.45).lineBetween(ox - ux * 8, oy - uy * 8, ox - ux * (8 + len), oy - uy * (8 + len));
    }
  }

  /**
   * Bleed stacks on a mob whose feet are at screen (x, y): one small stylised drop per stack, in a row under the
   * feet; each bobs gently.
   */
  drawBleed(top: Phaser.GameObjects.Graphics, x: number, y: number, stacks: number, time: number, id: number): void {
    if (stacks <= 0) return;
    const first = x - ((stacks - 1) * BLEED_STEP) / 2;
    for (let i = 0; i < stacks; i++) {
      const bx = first + i * BLEED_STEP;
      const by = y + BLEED_DROP_Y + Math.sin(time * 4 + i * 1.7 + id) * 1.2;
      // Outline, body (a point on top of a round bottom), highlight.
      top.fillStyle(0x000000, 0.8).fillCircle(bx, by + 1.5, 5).fillTriangle(bx - 4.7, by + 0.5, bx + 4.7, by + 0.5, bx, by - 9);
      top.fillStyle(BLEED_COLOR, 1).fillCircle(bx, by + 1.5, 3.7).fillTriangle(bx - 3.5, by + 1, bx + 3.5, by + 1, bx, by - 7);
      top.fillStyle(BLEED_LIGHT, 0.9).fillCircle(bx - 1.3, by + 0.5, 1.2);
    }
  }

  /**
   * A support dropped at screen (x, y) (the mob's feet): a beam and a hovering gem (`iconKey`) with its name in the
   * tier colour; after a moment the gem flies to the hero (it is kept for the run's end, see the run results).
   */
  supportDrop(x: number, y: number, iconKey: string, labelText: string, color: string, colorNum: number): void {
    let drop = this.drops.find((d) => !d.active);
    if (!drop) {
      const glow = this.scene.add.image(0, 0, softDotTexture(this.scene)).setBlendMode(Phaser.BlendModes.ADD).setDepth(DROP_DEPTH);
      const beam = this.scene.add.image(0, 0, softDotTexture(this.scene)).setOrigin(0.5, 0.85).setBlendMode(Phaser.BlendModes.ADD).setDepth(DROP_DEPTH);
      const gem = this.scene.add.image(0, 0, iconKey).setDepth(DROP_DEPTH + 1);
      const text = this.scene.add
        .text(0, 0, '', { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '17px', stroke: '#000', strokeThickness: 4 })
        .setOrigin(0.5)
        .setDepth(DROP_DEPTH + 2);
      drop = { gem, glow, beam, text, x: 0, y: 0, age: 0, active: false, flyX: 0, flyY: 0, labelLift: 0 };
      this.drops.push(drop);
    }
    drop.active = true;
    drop.age = 0;
    drop.x = x;
    drop.y = y;
    drop.gem.setTexture(iconKey).setDisplaySize(30, 30).setVisible(true).setAlpha(1);
    drop.glow.setTint(colorNum).setVisible(true);
    drop.beam.setTint(colorNum).setVisible(true);
    // Stack the label above labels of other recent drops nearby.
    let near = 0;
    for (const d of this.drops) if (d !== drop && d.active && d.age < DROP_LABEL_TIME && Math.abs(d.x - x) < 160 && Math.abs(d.y - y) < 60) near = Math.max(near, d.labelLift / LABEL_STEP + 1);
    drop.labelLift = near * LABEL_STEP;
    drop.text.setText(labelText).setColor(color).setVisible(true).setAlpha(0);
    this.sparks.emitParticleAt(x, y - DROP_LIFT, 10);
  }

  /**
   * The hero entered another room: gems still in the air (and chain bolts / knockback bursts) belong to the old room's
   * screen positions, so they vanish at once. The drops themselves are already in core (WorldState.supportDrops).
   */
  clearRoom(): void {
    for (const drop of this.drops) this.hideDrop(drop);
    for (const bolt of this.bolts) bolt.active = false;
    for (const burst of this.bursts) burst.active = false;
  }

  /** Advances everything; ground parts into `ground`, raised parts into `top`. (heroX, heroY): the hero's feet. */
  update(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, dt: number, heroX: number, heroY: number): void {
    for (const bolt of this.bolts) {
      if (!bolt.active) continue;
      bolt.age += dt;
      if (bolt.age >= BOLT_TTL) bolt.active = false;
      else this.drawBolt(top, bolt);
    }
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.ttl) b.active = false;
      else if (b.kind === 'echo') this.drawEchoRing(ground, b);
      else this.drawKnock(ground, top, b);
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const ghost = this.ghosts[i]!;
      ghost.age += dt;
      const t = ghost.age / ECHO_TTL;
      if (t >= 1) {
        ghost.sprite.setVisible(false);
        this.ghostPool.push(ghost.sprite);
        this.ghosts.splice(i, 1);
        continue;
      }
      ghost.sprite.setAlpha(0.7 * (1 - t)).setScale(1 + 0.12 * t);
      ghost.sprite.x += ghost.dx * 40 * dt;
      ghost.sprite.y += ghost.dy * 40 * dt;
    }
    for (const drop of this.drops) if (drop.active) this.updateDrop(drop, dt, heroX, heroY);
  }

  private startBurst(kind: Burst['kind'], x: number, y: number, dx: number, dy: number, len: number, ttl: number): Burst | undefined {
    let burst = this.bursts.find((b) => !b.active);
    if (!burst) {
      if (this.bursts.length >= MAX_BURSTS) return undefined;
      burst = { active: false, kind, x: 0, y: 0, dx: 0, dy: 0, len: 0, color: ECHO_RING, age: 0, ttl: 1 };
      this.bursts.push(burst);
    }
    burst.active = true;
    burst.kind = kind;
    burst.x = x;
    burst.y = y;
    burst.dx = dx;
    burst.dy = dy;
    burst.len = len;
    burst.age = 0;
    burst.ttl = ttl;
    burst.color = ECHO_RING;
    return burst;
  }

  /** Jagged bolt: re-jittered every frame so it crackles; a wide soft glow under a thin white core. */
  private drawBolt(top: Phaser.GameObjects.Graphics, bolt: Bolt): void {
    const t = bolt.age / BOLT_TTL;
    const fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
    for (let layer = 0; layer < 2; layer++) {
      if (layer === 0) top.lineStyle(10, BOLT_GLOW, 0.45 * fade);
      else top.lineStyle(3, BOLT_CORE, fade);
      top.beginPath();
      top.moveTo(bolt.xs[0]!, bolt.ys[0]!);
      for (let i = 1; i < bolt.n; i++) {
        const x0 = bolt.xs[i - 1]!;
        const y0 = bolt.ys[i - 1]!;
        const x1 = bolt.xs[i]!;
        const y1 = bolt.ys[i]!;
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const nx = -(y1 - y0) / len;
        const ny = (x1 - x0) / len;
        for (let k = 1; k < BOLT_SUBDIV; k++) {
          const f = k / BOLT_SUBDIV;
          const j = (Math.random() - 0.5) * 2 * BOLT_JITTER;
          top.lineTo(x0 + (x1 - x0) * f + nx * j, y0 + (y1 - y0) * f + ny * j);
        }
        top.lineTo(x1, y1);
      }
      top.strokePath();
    }
    // Small flashes on the struck targets.
    for (let i = 0; i < bolt.n; i++) top.fillStyle(BOLT_CORE, 0.7 * fade).fillCircle(bolt.xs[i]!, bolt.ys[i]!, 4 * fade + 1);
  }

  private drawEchoRing(ground: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const r = 18 + 34 * (1 - (1 - t) ** 2);
    ground.lineStyle(3 * fade + 1, b.color, 0.85 * fade).strokeEllipse(b.x, b.y, r * 2, r);
    ground.lineStyle(1.5, 0xffffff, 0.5 * fade).strokeEllipse(b.x, b.y, r * 1.4, r * 0.7);
  }

  /** A shock arc at the impact, facing the push, and streaks running ahead along the push. */
  private drawKnock(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const angle = Math.atan2(b.dy, b.dx);
    const r = 12 + 18 * t;
    ground.lineStyle(3 * fade + 1, KNOCK_COLOR, 0.7 * fade);
    ground.beginPath();
    ground.arc(b.x, b.y - BODY_HEIGHT * 0.4, r, angle - 0.9, angle + 0.9);
    ground.strokePath();
    const reach = b.len * Math.min(1, t * 2.5);
    const px = -b.dy;
    const py = b.dx;
    for (let i = -1; i <= 1; i++) {
      const ox = b.x + px * i * 10;
      const oy = b.y - BODY_HEIGHT * 0.4 + py * i * 10;
      top.lineStyle(1.5, 0xffffff, 0.55 * fade).lineBetween(ox + b.dx * reach * 0.3, oy + b.dy * reach * 0.3, ox + b.dx * reach, oy + b.dy * reach);
    }
  }

  private updateDrop(drop: Drop, dt: number, heroX: number, heroY: number): void {
    drop.age += dt;
    const age = drop.age;
    const flyStart = DROP_POP + DROP_HOVER;
    // Label: fades in, rises slowly, fades out.
    const lt = age / DROP_LABEL_TIME;
    drop.text
      .setPosition(drop.x, drop.y - DROP_LIFT - 30 - drop.labelLift - 14 * lt)
      .setAlpha(lt < 0.1 ? lt / 0.1 : lt > 0.75 ? Math.max(0, 1 - (lt - 0.75) / 0.25) : 1);
    if (age < flyStart) {
      const pop = Math.min(1, age / DROP_POP);
      const bob = Math.sin(age * 5) * 3;
      const gy = drop.y - DROP_LIFT * pop + bob;
      const scale = (0.4 + 0.6 * Phaser.Math.Easing.Back.Out(pop)) * 30;
      drop.gem.setPosition(drop.x, gy).setDisplaySize(scale, scale).setRotation(Math.sin(age * 3) * 0.12);
      const pulse = 0.75 + 0.25 * Math.sin(age * 9);
      drop.glow.setPosition(drop.x, gy).setScale(0.9 * pulse * pop).setAlpha(0.9);
      drop.beam.setPosition(drop.x, drop.y).setScale(BEAM_WIDTH * pop * (0.8 + 0.2 * pulse), BEAM_HEIGHT).setAlpha(0.6 * (1 - age / flyStart) + 0.25);
      drop.flyX = drop.x;
      drop.flyY = gy;
      // A glint star now and then.
      if (Math.random() < dt * 3) this.sparks.emitParticleAt(drop.x + (Math.random() - 0.5) * 14, gy + (Math.random() - 0.5) * 14, 1);
      return;
    }
    const f = Math.min(1, (age - flyStart) / DROP_FLY);
    const e = f * f;
    const hx = heroX;
    const hy = heroY - 40;
    const x = drop.flyX + (hx - drop.flyX) * e;
    const y = drop.flyY + (hy - drop.flyY) * e - Math.sin(f * Math.PI) * 40;
    const size = 30 * (1 - 0.6 * f);
    drop.gem.setPosition(x, y).setDisplaySize(size, size);
    drop.glow.setPosition(x, y).setScale(0.7 * (1 - f) + 0.2);
    drop.beam.setAlpha(Math.max(0, 0.2 * (1 - f * 3)));
    if (f >= 1) {
      this.sparks.emitParticleAt(hx, hy, 12);
      this.hideDrop(drop);
    }
  }

  private hideDrop(drop: Drop): void {
    drop.active = false;
    drop.gem.setVisible(false);
    drop.glow.setVisible(false);
    drop.beam.setVisible(false);
    drop.text.setVisible(false);
  }
}

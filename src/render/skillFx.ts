import * as Phaser from 'phaser';
import { softDotTexture, sparkTexture } from './fxTextures';
import { spriteFrame, textureKey } from './sprites';

// Visuals of the level-3 skill effects (docs/design/classes.md «Ефекти 3-го рівня»): burning / frozen ground zones,
// the Roll decoy ghost, the Fireball split burst, the Cleave full-circle swoosh and the Shield Charge landing slam.
// Render-only: reads core state (world.zones, world.decoys) and events; every number here is a visual constant.
// Cheap on purpose: ground zones and bursts are drawn into the scene's two fx Graphics, three pooled particle
// emitters, decoy ghosts are pooled sprites.

/** Seconds a zone fades in after it appears / fades out before it expires. */
const ZONE_FADE_IN = 0.2;
const ZONE_FADE_OUT = 0.6;
/** Embers per second rising off a fire puddle of radius 70 (scaled by area). */
const PUDDLE_EMBER_RATE = 9;
/** Glints per second on an ice field of radius 150 (scaled by area). */
const ICE_GLINT_RATE = 5;
/** Flickering flame patches inside a fire puddle. */
const PUDDLE_PATCHES = 7;
/** Frost cracks radiating inside an ice field. */
const ICE_CRACKS = 9;

/** Decoy ghost look. */
const GHOST_TINT = 0x8fc4ff;
const GHOST_WASH = 0x3f78c8;
const GHOST_FADE_OUT = 0.35;
const GHOST_FADE_IN = 0.15;

const SPLIT_TTL = 0.28;
const WHIRL_TTL = 0.42;
const SLAM_TTL = 0.5;
const MAX_BURSTS = 24;

const WHIRL_COLOR = 0xffd8a0;
const SLAM_COLOR = 0xd8c49a;

export type SkillBurstKind = 'split' | 'whirl' | 'slam';

interface Burst {
  active: boolean;
  kind: SkillBurstKind;
  x: number;
  y: number;
  /** World radius: a 2r × r ellipse on screen. */
  radius: number;
  age: number;
  ttl: number;
  spin: number;
  /** Split of a fireball converted to cold (Heart of Winter): frost colours instead of fire. */
  icy: boolean;
}

interface Ghost {
  sprite: Phaser.GameObjects.Sprite;
  set: string;
  row: number;
  age: number;
  /** Seconds left of the fade-out after the decoy expired; undefined while the decoy lives. */
  fading: number | undefined;
  /** Short flare when a mob swings at the decoy. */
  flare: number;
}

/** A ground zone as render needs it (structurally matches core GroundZone). */
interface ZoneView {
  readonly id: number;
  readonly kind: string;
  readonly radius: number;
  readonly remaining: number;
  /** The action snapshot: a fire zone whose action converts to cold (Heart of Winter) is drawn as frost. */
  readonly action?: { readonly damageConversion?: { readonly to: string } };
}

/** Hashes an id into 0..1 (stable per zone, so its patches do not jump between frames). */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class SkillFx {
  private readonly embers: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly frost: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly bursts: Burst[] = [];
  /** Zone id → its full duration (from zoneSpawn), for the fade-in. */
  private readonly zoneDurations = new Map<number, number>();
  private readonly ghosts = new Map<number, Ghost>();
  private readonly fadingGhosts: Ghost[] = [];
  private readonly ghostPool: Phaser.GameObjects.Sprite[] = [];

  constructor(private readonly scene: Phaser.Scene) {
    this.embers = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speedY: { min: -30, max: -70 },
        speedX: { min: -10, max: 10 },
        scale: { start: 0.18, end: 0.02 },
        alpha: { start: 0.9, end: 0 },
        color: [0xfff0a0, 0xffa030, 0xff5a1a],
        lifespan: { min: 360, max: 640 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 160,
        reserve: 48,
      })
      .setDepth(4002);
    this.frost = scene.add
      .particles(0, 0, sparkTexture(scene), {
        emitting: false,
        speedY: { min: -6, max: -18 },
        scale: { start: 1.1, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, 0xcff2ff, 0x8fd3ff],
        lifespan: { min: 350, max: 650 },
        blendMode: Phaser.BlendModes.ADD,
        maxAliveParticles: 96,
        reserve: 24,
      })
      .setDepth(4002);
    this.dust = scene.add
      .particles(0, 0, softDotTexture(scene), {
        emitting: false,
        speed: { min: 30, max: 90 },
        angle: { min: 0, max: 360 },
        gravityY: -10,
        scale: { start: 0.35, end: 0.75 },
        alpha: { start: 0.45, end: 0 },
        tint: [0xb8a888, 0x8a7c66, 0xd8ccb0],
        lifespan: { min: 380, max: 620 },
        maxAliveParticles: 96,
        reserve: 32,
      })
      .setDepth(4001);
  }

  zoneSpawned(id: number, duration: number): void {
    this.zoneDurations.set(id, duration);
  }

  zoneExpired(id: number): void {
    this.zoneDurations.delete(id);
  }

  /**
   * One ground zone at screen (x, y) (its centre on the floor), into the ground layer under mobs. Fire puddle:
   * smouldering ellipse with flickering flame patches and rising embers; ice field: pale frost with cracks and glints.
   */
  drawZone(ground: Phaser.GameObjects.Graphics, zone: ZoneView, x: number, y: number, time: number, dt: number): void {
    const duration = this.zoneDurations.get(zone.id) ?? zone.remaining;
    const age = Math.max(0, duration - zone.remaining);
    const fade = Math.min(1, age / ZONE_FADE_IN, zone.remaining / ZONE_FADE_OUT);
    if (fade <= 0) return;
    const rx = zone.radius;
    const ry = zone.radius / 2;
    if (zone.kind === 'ice_field' || zone.action?.damageConversion?.to === 'cold') this.drawIceField(ground, zone, x, y, rx, ry, fade, time, dt);
    else this.drawFirePuddle(ground, zone, x, y, rx, ry, fade, time, dt);
  }

  private drawFirePuddle(g: Phaser.GameObjects.Graphics, zone: ZoneView, x: number, y: number, rx: number, ry: number, fade: number, time: number, dt: number): void {
    const breathe = 0.5 + 0.5 * Math.sin(time * 5 + zone.id);
    g.fillStyle(0x3a0a04, 0.55 * fade).fillEllipse(x, y, rx * 2, ry * 2);
    g.fillStyle(0xc0300c, (0.28 + 0.08 * breathe) * fade).fillEllipse(x, y, rx * 1.7, ry * 1.7);
    // Flame patches: fixed spots per zone, each flickering at its own pace.
    for (let i = 0; i < PUDDLE_PATCHES; i++) {
      const h = hash01(zone.id * 13 + i);
      const a = h * Math.PI * 2;
      const d = 0.15 + 0.6 * hash01(zone.id * 7 + i * 3);
      const px = x + Math.cos(a) * rx * d;
      const py = y + Math.sin(a) * ry * d;
      const flick = 0.55 + 0.45 * Math.sin(time * (7 + i * 1.3) + h * 20);
      const s = rx * (0.18 + 0.1 * hash01(i + zone.id));
      g.fillStyle(0xff7a1a, 0.5 * flick * fade).fillEllipse(px, py, s * 2, s);
      g.fillStyle(0xffd070, 0.45 * flick * fade).fillEllipse(px, py, s * 0.9, s * 0.45);
    }
    g.lineStyle(2, 0xff8a2a, (0.45 + 0.25 * breathe) * fade).strokeEllipse(x, y, rx * 2, ry * 2);
    const rate = PUDDLE_EMBER_RATE * ((rx * rx) / (70 * 70)) * fade;
    if (Math.random() < rate * dt) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * 0.85;
      this.embers.emitParticleAt(x + Math.cos(a) * rx * d, y + Math.sin(a) * ry * d - 2, 1);
    }
  }

  private drawIceField(g: Phaser.GameObjects.Graphics, zone: ZoneView, x: number, y: number, rx: number, ry: number, fade: number, time: number, dt: number): void {
    const breathe = 0.5 + 0.5 * Math.sin(time * 1.8 + zone.id);
    g.fillStyle(0x7fc8f0, (0.14 + 0.04 * breathe) * fade).fillEllipse(x, y, rx * 2, ry * 2);
    g.fillStyle(0xd8f4ff, 0.1 * fade).fillEllipse(x, y, rx * 1.2, ry * 1.2);
    // Frost cracks: short jagged lines radiating from near the centre.
    g.lineStyle(1.5, 0xe6f8ff, 0.5 * fade);
    for (let i = 0; i < ICE_CRACKS; i++) {
      const a = (i / ICE_CRACKS) * Math.PI * 2 + hash01(zone.id + i) * 0.5;
      const d0 = 0.2 + 0.2 * hash01(zone.id * 3 + i);
      const d1 = 0.6 + 0.3 * hash01(zone.id * 5 + i);
      const bend = (hash01(zone.id * 11 + i) - 0.5) * 0.5;
      const mx = (d0 + d1) / 2;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * rx * d0, y + Math.sin(a) * ry * d0);
      g.lineTo(x + Math.cos(a + bend) * rx * mx, y + Math.sin(a + bend) * ry * mx);
      g.lineTo(x + Math.cos(a) * rx * d1, y + Math.sin(a) * ry * d1);
      g.strokePath();
    }
    g.lineStyle(2, 0xe6f8ff, (0.5 + 0.2 * breathe) * fade).strokeEllipse(x, y, rx * 2, ry * 2);
    g.lineStyle(1, 0x8fd3ff, 0.35 * fade).strokeEllipse(x, y, rx * 1.84, ry * 1.84);
    const rate = ICE_GLINT_RATE * ((rx * rx) / (150 * 150)) * fade;
    if (Math.random() < rate * dt) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * 0.9;
      this.frost.emitParticleAt(x + Math.cos(a) * rx * d, y + Math.sin(a) * ry * d - 3, 1);
    }
  }

  /** A decoy appeared: a ghost of the hero's current idle pose (sprite set `set`, direction row `row`). */
  decoySpawned(id: number, set: string, row: number): void {
    const sprite = this.ghostPool.pop() ?? this.scene.add.sprite(0, 0, textureKey(set, 'idle'), 0);
    sprite
      .setTexture(textureKey(set, 'idle'))
      // Screen tint washes the hero towards pale spectral blue but keeps the silhouette's detail.
      .setTint(GHOST_WASH)
      .setTintMode(Phaser.TintModes.SCREEN)
      .setAlpha(0)
      .setVisible(true);
    this.ghosts.set(id, { sprite, set, row, age: 0, fading: undefined, flare: 0 });
  }

  decoyExpired(id: number): void {
    const ghost = this.ghosts.get(id);
    if (!ghost) return;
    this.ghosts.delete(id);
    ghost.fading = GHOST_FADE_OUT;
    this.fadingGhosts.push(ghost);
    this.dust.emitParticleAt(ghost.sprite.x, ghost.sprite.y - 20, 5);
  }

  /** A mob swung at the decoy `id`: the ghost flickers. */
  decoyStruck(id: number): void {
    const ghost = this.ghosts.get(id);
    if (ghost) ghost.flare = 0.25;
  }

  /**
   * Places a live decoy's ghost at screen (x, y) (its feet) with sprite origin `originY`, and draws its ground ring.
   * Call once per living decoy per frame.
   */
  drawDecoy(ground: Phaser.GameObjects.Graphics, id: number, x: number, y: number, radius: number, originY: number, dt: number): void {
    const ghost = this.ghosts.get(id);
    if (!ghost) return;
    ghost.age += dt;
    ghost.flare = Math.max(0, ghost.flare - dt);
    const pulse = 0.5 + 0.5 * Math.sin(ghost.age * 6);
    const appear = Math.min(1, ghost.age / GHOST_FADE_IN);
    const flare = ghost.flare > 0 ? 0.3 * Math.sin((ghost.flare / 0.25) * Math.PI) : 0;
    ghost.sprite
      .setOrigin(0.5, originY)
      .setPosition(x, y - 2 * pulse)
      .setDepth(y)
      .setFrame(spriteFrame(ghost.set, 'idle', ghost.row, ghost.age))
      .setAlpha(appear * Math.min(1, 0.6 + 0.15 * pulse + flare));
    ground.fillStyle(GHOST_TINT, (0.14 + 0.08 * pulse) * appear).fillEllipse(x, y, radius * 3.2, radius * 1.6);
    ground.lineStyle(2, GHOST_TINT, (0.5 + 0.3 * pulse) * appear).strokeEllipse(x, y, radius * 3.2, radius * 1.6);
  }

  /** Fades out ghosts of expired decoys and returns them to the pool. */
  updateFadingGhosts(dt: number): void {
    for (let i = this.fadingGhosts.length - 1; i >= 0; i--) {
      const ghost = this.fadingGhosts[i]!;
      ghost.fading = (ghost.fading ?? 0) - dt;
      const t = Math.max(0, ghost.fading / GHOST_FADE_OUT);
      ghost.sprite.setAlpha(0.6 * t).setScale(1 + 0.15 * (1 - t));
      ghost.sprite.y -= 20 * dt;
      if (ghost.fading <= 0) {
        ghost.sprite.setVisible(false).setScale(1);
        this.ghostPool.push(ghost.sprite);
        this.fadingGhosts.splice(i, 1);
      }
    }
  }

  /**
   * Fireball split at screen (x, y) (already lifted to projectile height): a small hot pop and a few embers; `icy`
   * (converted to cold): a frosty pop with glints.
   */
  split(x: number, y: number, icy = false): void {
    const burst = this.startBurst('split', x, y, 26, SPLIT_TTL);
    if (!burst) return;
    burst.icy = icy;
    const sparks = icy ? this.frost : this.embers;
    for (let i = 0; i < 5; i++) sparks.emitParticleAt(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 8, 1);
  }

  /** Cleave's every-N-th full circle at screen (x, y), world radius `radius`: a white-hot swoosh spinning round. */
  whirl(x: number, y: number, radius: number, facingAngle: number): void {
    this.startBurst('whirl', x, y, radius, WHIRL_TTL, facingAngle);
  }

  /** Shield Charge landing at screen (x, y), world radius `radius`: a ground slam ring, cracks and dust. */
  slam(x: number, y: number, radius: number): void {
    if (!this.startBurst('slam', x, y, radius, SLAM_TTL)) return;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      this.dust.emitParticleAt(x + Math.cos(a) * radius * 0.5, y + Math.sin(a) * radius * 0.25 - 4, 1);
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
      if (b.kind === 'split') this.drawSplit(top, b);
      else if (b.kind === 'whirl') this.drawWhirl(ground, top, b);
      else this.drawSlam(ground, b);
    }
  }

  private startBurst(kind: SkillBurstKind, x: number, y: number, radius: number, ttl: number, spin = Math.random() * Math.PI * 2): Burst | undefined {
    let burst = this.bursts.find((b) => !b.active);
    if (!burst) {
      if (this.bursts.length >= MAX_BURSTS) return undefined;
      burst = { active: false, kind, x: 0, y: 0, radius: 0, age: 0, ttl: 1, spin: 0, icy: false };
      this.bursts.push(burst);
    }
    burst.active = true;
    burst.kind = kind;
    burst.x = x;
    burst.y = y;
    burst.radius = radius;
    burst.age = 0;
    burst.ttl = ttl;
    burst.spin = spin;
    burst.icy = false;
    return burst;
  }

  private drawSplit(top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const r = b.radius * (0.4 + 0.6 * (1 - (1 - t) ** 2));
    top.fillStyle(b.icy ? 0xe6f8ff : 0xffe08a, 0.8 * fade * fade).fillCircle(b.x, b.y, r * 0.55);
    top.lineStyle(2.5, b.icy ? 0x8fd3ff : 0xff7a1a, 0.9 * fade).strokeCircle(b.x, b.y, r);
  }

  /**
   * Whirl: a crescent sweeping one and a half turns round the hero; brightest at its head, tapering behind. Drawn
   * on the floor ring and again at blade height, so it reads apart from the regular cleave arc.
   */
  private drawWhirl(ground: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    const head = b.spin + t * Math.PI * 3;
    const tailLen = Math.PI * 1.4;
    const segments = 18;
    const rx = b.radius * 0.92;
    const ry = rx / 2;
    ground.fillStyle(WHIRL_COLOR, 0.12 * fade).fillEllipse(b.x, b.y, rx * 2, ry * 2);
    ground.lineStyle(2, 0xffffff, 0.45 * fade).strokeEllipse(b.x, b.y, rx * 2, ry * 2);
    for (let layer = 0; layer < 2; layer++) {
      const g = layer === 0 ? ground : top;
      const lift = layer === 0 ? 0 : 26;
      const scale = layer === 0 ? 1 : 0.62;
      let px = b.x + Math.cos(head) * rx * scale;
      let py = b.y - lift + Math.sin(head) * ry * scale;
      for (let i = 1; i <= segments; i++) {
        const k = i / segments;
        const a = head - tailLen * k;
        const nx = b.x + Math.cos(a) * rx * scale;
        const ny = b.y - lift + Math.sin(a) * ry * scale;
        const strength = (1 - k) * fade;
        g.lineStyle((layer === 0 ? 11 : 7) * (1 - k) + 1.5, i < 4 ? 0xffffff : WHIRL_COLOR, 0.95 * strength).lineBetween(px, py, nx, ny);
        px = nx;
        py = ny;
      }
    }
  }

  /** Slam: a heavy ring thumping out past the landing radius, a flash at the centre and short ground cracks. */
  private drawSlam(g: Phaser.GameObjects.Graphics, b: Burst): void {
    const t = b.age / b.ttl;
    const fade = 1 - t;
    const grow = 1 - (1 - Math.min(1, t * 2.2)) ** 3;
    const r = b.radius * (0.3 + 0.8 * grow);
    if (t < 0.3) g.fillStyle(0xfff4d8, 0.45 * (1 - t / 0.3)).fillEllipse(b.x, b.y, b.radius * 1.2, b.radius * 0.6);
    g.fillStyle(SLAM_COLOR, 0.16 * fade).fillEllipse(b.x, b.y, r * 2, r);
    g.lineStyle(6 * fade + 1.5, SLAM_COLOR, 0.85 * fade).strokeEllipse(b.x, b.y, r * 2, r);
    g.lineStyle(1.5, 0xffffff, 0.6 * fade).strokeEllipse(b.x, b.y, r * 1.7, r * 0.85);
    g.lineStyle(2, 0x2a2016, 0.6 * fade);
    for (let i = 0; i < 6; i++) {
      const a = b.spin + (i / 6) * Math.PI * 2;
      const d0 = b.radius * 0.18;
      const d1 = b.radius * (0.45 + 0.15 * (i % 2));
      g.lineBetween(b.x + Math.cos(a) * d0, b.y + Math.sin(a) * d0 * 0.5, b.x + Math.cos(a) * d1, b.y + Math.sin(a) * d1 * 0.5);
    }
  }
}

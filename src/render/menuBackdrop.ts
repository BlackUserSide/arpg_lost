import * as Phaser from 'phaser';
import { vec } from '../core/math';
import { softDotTexture, sparkTexture } from './fxTextures';
import { toScreen } from './iso';
import { ORIGIN_Y, SPRITE_SETS, spriteFrame, textureKey } from './sprites';

// Animated menu background: a hero resting by a campfire on a patch of dungeon floor, lit by
// flickering firelight, embers rising into darkness. Render-only, no game logic.

const FLOOR_TILE = 68;
const FLOOR_RADIUS = 5;
const PLAIN_FLOORS = [0, 1, 2, 3, 20, 21, 22, 23];
/** Hero seat relative to the fire, screen px (west of the fire, facing it). */
const HERO_DX = -115;
const HERO_DY = 8;
const HERO_SCALE = 1.9;
/** Direction row facing the fire (east, see render/iso directionRow). */
const HERO_ROW = 4;

export function preloadBackdrop(scene: Phaser.Scene): void {
  if (!scene.textures.exists('floor')) scene.load.spritesheet('floor', 'assets/test/floor.png', { frameWidth: 192, frameHeight: 96 });
}

/** Full-screen radial darkness: transparent around the fire, black at the edges. */
function vignetteTexture(scene: Phaser.Scene, w: number, h: number, cx: number, cy: number): string {
  const key = `fx:vignette:${Math.round(w)}x${Math.round(h)}:${Math.round(cx)}:${Math.round(cy)}`;
  if (scene.textures.exists(key)) return key;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d')!;
  const r = Math.max(w, h) * 0.75;
  const g = ctx.createRadialGradient(cx, cy, 40, cx, cy, r);
  g.addColorStop(0, 'rgba(10,9,12,0)');
  g.addColorStop(0.35, 'rgba(10,9,12,0.55)');
  g.addColorStop(0.7, 'rgba(10,9,12,0.95)');
  g.addColorStop(1, 'rgba(10,9,12,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  scene.textures.addCanvas(key, canvas);
  return key;
}

export class MenuBackdrop {
  private readonly root: Phaser.GameObjects.Container;
  private readonly floor: Phaser.GameObjects.Image[] = [];
  private readonly logs: Phaser.GameObjects.Graphics;
  private readonly glow: Phaser.GameObjects.Image;
  private readonly flames: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly embers: Phaser.GameObjects.Particles.ParticleEmitter;
  private hero: Phaser.GameObjects.Sprite | undefined;
  private heroSet = '';
  private heroAnim = 'idle';
  private vignette: Phaser.GameObjects.Image | undefined;
  private time = 0;
  private fireX = 0;
  private fireY = 0;

  constructor(private readonly scene: Phaser.Scene) {
    this.root = scene.add.container(0, 0).setDepth(-100);
    for (let j = -FLOOR_RADIUS; j <= FLOOR_RADIUS; j++) {
      for (let i = -FLOOR_RADIUS; i <= FLOOR_RADIUS; i++) {
        if (Math.hypot(i, j) > FLOOR_RADIUS + 0.3) continue;
        const hash = Math.abs((i * 73856093) ^ (j * 19349663));
        const tile = scene.add.image(0, 0, 'floor', PLAIN_FLOORS[hash % PLAIN_FLOORS.length]).setScale(0.5);
        tile.setData('ij', [i, j]);
        // Firelight falloff baked into the tile tint.
        const light = Math.max(0.15, 1 - Math.hypot(i, j) / (FLOOR_RADIUS + 0.5));
        const r = Math.round(255 * light);
        const gb = Math.round(200 * light * light);
        tile.setTint(Phaser.Display.Color.GetColor(r, Math.round(gb * 0.9), Math.round(gb * 0.6)));
        this.floor.push(tile);
      }
    }
    // Back-to-front so tile edges overlap correctly.
    this.floor.sort((a, b) => sumIJ(a) - sumIJ(b));
    this.root.add(this.floor);

    this.glow = scene.add.image(0, 0, softDotTexture(scene)).setTint(0xff7a2a).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.5);
    this.logs = scene.add.graphics();
    this.root.add([this.glow, this.logs]);

    this.flames = scene.add.particles(0, 0, softDotTexture(scene), {
      x: { min: -12, max: 12 },
      speedY: { min: -70, max: -120 },
      speedX: { min: -10, max: 10 },
      scale: { start: 0.55, end: 0.05 },
      alpha: { start: 0.9, end: 0 },
      color: [0xfff0a0, 0xffa030, 0xff5a1a, 0x8a1a08],
      lifespan: { min: 450, max: 850 },
      frequency: 22,
      blendMode: Phaser.BlendModes.ADD,
    });
    this.embers = scene.add.particles(0, 0, sparkTexture(scene), {
      x: { min: -16, max: 16 },
      speedY: { min: -50, max: -130 },
      speedX: { min: -35, max: 35 },
      scale: { start: 0.8, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: 0xffb347,
      lifespan: { min: 1400, max: 2600 },
      frequency: 140,
      blendMode: Phaser.BlendModes.ADD,
    });
    this.flames.setDepth(-50);
    this.embers.setDepth(-40);
  }

  /** Places the fire at (x, y) in screen coordinates and rebuilds the darkness overlay. */
  layout(x: number, y: number, width: number, height: number): void {
    this.fireX = x;
    this.fireY = y;
    for (const tile of this.floor) {
      const [i, j] = tile.getData('ij') as [number, number];
      const p = toScreen(vec(i * FLOOR_TILE, j * FLOOR_TILE));
      tile.setPosition(x + p.x, y + p.y);
    }
    this.glow.setPosition(x, y - 10);
    this.flames.setPosition(x, y - 6);
    this.embers.setPosition(x, y - 10);
    this.drawLogs(x, y);
    this.hero?.setPosition(x + HERO_DX, y + HERO_DY);
    this.vignette?.destroy();
    this.vignette = this.scene.add.image(0, 0, vignetteTexture(this.scene, width, height, x, y - 20)).setOrigin(0).setDepth(-30);
  }

  /** Shows a character sprite resting by the fire (or nothing). */
  setHero(set: string | undefined): void {
    if (set === this.heroSet) return;
    this.heroSet = set ?? '';
    this.hero?.destroy();
    this.hero = undefined;
    if (!set) return;
    // Sitting pose when baked for this set; standing idle otherwise. Both share the feet origin.
    this.heroAnim = SPRITE_SETS[set]?.sit ? 'sit' : 'idle';
    this.hero = this.scene.add
      .sprite(this.fireX + HERO_DX, this.fireY + HERO_DY, textureKey(set, this.heroAnim), spriteFrame(set, this.heroAnim, HERO_ROW, 0))
      .setOrigin(0.5, ORIGIN_Y)
      .setScale(HERO_SCALE)
      .setDepth(-45);
    this.hero.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.hero.setTint(0xffd2a0);
    this.hero.setAlpha(0);
    this.scene.tweens.add({ targets: this.hero, alpha: 1, duration: 300 });
  }

  update(dt: number): void {
    this.time += dt;
    const flicker = 0.45 + 0.1 * Math.sin(this.time * 11) + 0.07 * Math.sin(this.time * 23.7) + 0.05 * Math.sin(this.time * 5.3);
    this.glow.setAlpha(flicker).setScale(5 + flicker * 2);
    // Hero faces the fire and breathes with the slow sitting loop.
    if (this.hero) this.hero.setFrame(spriteFrame(this.heroSet, this.heroAnim, HERO_ROW, this.time));
  }

  private drawLogs(x: number, y: number): void {
    const g = this.logs.clear();
    g.fillStyle(0x000000, 0.5).fillEllipse(x, y + 4, 70, 26);
    g.lineStyle(7, 0x3a2414, 1);
    g.lineBetween(x - 22, y + 6, x + 18, y - 4);
    g.lineBetween(x - 18, y - 4, x + 22, y + 6);
    g.lineStyle(3, 0x6a4020, 1);
    g.lineBetween(x - 22, y + 4, x + 18, y - 6);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      g.fillStyle(0x2a2a30, 1).fillEllipse(x + Math.cos(a) * 30, y + Math.sin(a) * 13, 12, 8);
    }
  }
}

function sumIJ(tile: Phaser.GameObjects.Image): number {
  const [i, j] = tile.getData('ij') as [number, number];
  return i + j;
}

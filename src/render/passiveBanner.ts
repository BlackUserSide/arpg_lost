import * as Phaser from 'phaser';
import { unspentBanner } from './passiveText';
import { makeButton, pinToScreen, UI } from './ui';

// "You have N talent points" call-to-action, shared by the hub and the in-run HUD. Click opens the tree.
// Rebuilt only when the numbers change, so it can be fed every frame without allocating.

const PULSE_MS = 900;

export class PointsBanner {
  private button: Phaser.GameObjects.Container | undefined;
  private glow: Phaser.GameObjects.Rectangle | undefined;
  private points = 0;
  private specPoints = 0;
  private x = 0;
  private y = 0;
  private height = 40;
  private maxWidth: number;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onClick: () => void,
    private readonly opts: { depth: number; pinned: boolean; parent?: Phaser.GameObjects.Container; maxWidth?: number },
  ) {
    this.maxWidth = opts.maxWidth ?? Number.POSITIVE_INFINITY;
  }

  /** Centre of the banner; `maxWidth` caps it on narrow screens (the caption shrinks instead). */
  setPosition(x: number, y: number, height = this.height, maxWidth = this.maxWidth): void {
    if (x === this.x && y === this.y && height === this.height && maxWidth === this.maxWidth) return;
    this.x = x;
    this.y = y;
    this.height = height;
    this.maxWidth = maxWidth;
    this.rebuild();
  }

  setPoints(points: number, specPoints: number): void {
    if (points === this.points && specPoints === this.specPoints) return;
    this.points = points;
    this.specPoints = specPoints;
    this.rebuild();
  }

  get visible(): boolean {
    return this.points > 0 || this.specPoints > 0;
  }

  destroy(): void {
    this.button?.destroy();
    if (this.glow) this.scene.tweens.killTweensOf(this.glow);
    this.glow?.destroy();
    this.button = undefined;
    this.glow = undefined;
  }

  private rebuild(): void {
    this.destroy();
    if (!this.visible) return;
    const text = unspentBanner(Math.max(0, this.points), Math.max(0, this.specPoints));
    const fontSize = Math.round(Math.min(this.height * 0.42, 24));
    // Measure with the same font the button uses (heading font for primary buttons).
    const probe = this.scene.add.text(0, 0, text, { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: `${fontSize}px` });
    // Long translations: the button never grows past maxWidth, its caption shrinks to fit instead (makeButton).
    const width = Math.min(Math.ceil(probe.width + 44), this.maxWidth);
    probe.destroy();
    this.glow = this.scene.add.rectangle(this.x, this.y, width + 10, this.height + 10, 0xff7a2a, 0.35).setBlendMode(Phaser.BlendModes.ADD);
    this.button = makeButton(this.scene, this.x, this.y, width, this.height, text, this.onClick, 'primary');
    const glow = this.glow;
    this.scene.tweens.add({ targets: glow, alpha: 0.05, duration: PULSE_MS, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    // The glow may die with a parent container (screen rebuild); never leave an endless tween behind.
    glow.once(Phaser.GameObjects.Events.DESTROY, () => this.scene.tweens.killTweensOf(glow));
    const { depth, pinned, parent } = this.opts;
    for (const o of [this.glow, this.button]) {
      if (pinned) pinToScreen(o, depth);
      else o.setDepth(depth);
      parent?.add(o);
    }
  }
}

/**
 * In-run version of the call to action: a small pulsing badge with the number of unspent points (talent +
 * specialization) on the corner of the Talents button, so it never covers the fight. Not interactive: taps go to the
 * button under it. Rebuilt only when the numbers or the place change.
 */
export class PointsBadge {
  private parts: Phaser.GameObjects.GameObject[] = [];
  private glow: Phaser.GameObjects.Arc | undefined;
  private total = 0;
  private x = 0;
  private y = 0;
  private radius = 11;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly depth: number,
  ) {}

  setPosition(x: number, y: number, radius: number): void {
    if (x === this.x && y === this.y && radius === this.radius) return;
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.rebuild();
  }

  setPoints(points: number, specPoints: number): void {
    const total = Math.max(0, points) + Math.max(0, specPoints);
    if (total === this.total) return;
    this.total = total;
    this.rebuild();
  }

  destroy(): void {
    if (this.glow) this.scene.tweens.killTweensOf(this.glow);
    for (const p of this.parts) p.destroy();
    this.parts = [];
    this.glow = undefined;
  }

  private rebuild(): void {
    this.destroy();
    if (this.total <= 0) return;
    const r = this.radius;
    const caption = this.total > 99 ? '99+' : String(this.total);
    const glow = this.scene.add.circle(this.x, this.y, r + 5, 0xff7a2a, 0.45).setBlendMode(Phaser.BlendModes.ADD);
    const disc = this.scene.add.circle(this.x, this.y, r, 0xb4451a, 1).setStrokeStyle(2, 0xf3d58a, 1);
    const text = this.scene.add
      .text(this.x, this.y, caption, { fontFamily: UI.bodyFont, fontStyle: 'bold', fontSize: `${Math.round(r * (caption.length > 2 ? 0.9 : 1.15))}px`, color: '#fff1c4', stroke: '#120a04', strokeThickness: 3 })
      .setOrigin(0.5);
    this.parts = [glow, disc, text];
    this.parts.forEach((p, i) => pinToScreen(p, this.depth + i));
    this.glow = glow;
    this.scene.tweens.add({ targets: glow, alpha: 0.05, scale: 1.25, duration: PULSE_MS, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
  }
}

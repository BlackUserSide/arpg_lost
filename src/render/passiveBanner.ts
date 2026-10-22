import * as Phaser from 'phaser';
import { unspentBanner } from './passiveText';
import { makeButton, pinToScreen, UI } from './ui';

// "Маєте N очок талантів" call-to-action, shared by the hub and the in-run HUD. Click opens the tree.
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

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onClick: () => void,
    private readonly opts: { depth: number; pinned: boolean; parent?: Phaser.GameObjects.Container },
  ) {}

  /** Centre of the banner. */
  setPosition(x: number, y: number, height = this.height): void {
    if (x === this.x && y === this.y && height === this.height) return;
    this.x = x;
    this.y = y;
    this.height = height;
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
    const width = Math.ceil(probe.width + 44);
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

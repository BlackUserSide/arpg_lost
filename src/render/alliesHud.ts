import * as Phaser from 'phaser';
import { raiseAlliesStats, type WorldState } from '../core/world/world';
import { getLocale, t, upper } from '../i18n';
import { ALLY_TEAL } from './allyFx';
import { label, UI } from './ui';

// The raised-skeletons counter of the legendary Eye of the Abyss (docs/design/items.md): a pill over the resource orb
// (stacked with the souls / clock badges) with a skull glyph, "N/6" and a caption, shown only while the hero has the
// raiseAllies mechanic. Render-only: the count is the living allies in core state, the cap the mechanic's `max`.

/** Seconds of the flash when a skeleton rises / of the dim pulse when one is lost. */
const GAIN_FLASH = 0.25;
const LOSS_FLASH = 0.35;

const TEAL_DEEP = 0x0f5a4a;
const RIM = 0x9a6a22;

export class AlliesBadge {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly count: Phaser.GameObjects.Text;
  private readonly caption: Phaser.GameObjects.Text;
  private x = 0;
  private y = 0;
  private w = 104;
  private h = 28;
  private captionH = 17;
  private maxRight = Number.POSITIVE_INFINITY;
  private mechanicsFor: unknown;
  private max: number | undefined;
  private shownCount = -1;
  private shownLocale = '';
  private gainFlash = 0;
  private lossFlash = 0;
  private time = 0;
  private shown = false;

  constructor(scene: Phaser.Scene, depth: number) {
    this.gfx = scene.add.graphics().setScrollFactor(0).setDepth(depth).setVisible(false);
    this.count = label(scene, 0, 0, '', 16, UI.text, true).setOrigin(0.5).setScrollFactor(0).setDepth(depth + 1).setVisible(false);
    this.count.setStroke('#000', 4);
    this.caption = label(scene, 0, 0, '', 13, '#9dffe0', true).setOrigin(0.5, 1).setScrollFactor(0).setDepth(depth + 1).setVisible(false);
    this.caption.setStroke('#000', 3).setLetterSpacing(1);
  }

  /** Visible this frame (the hero has the raiseAllies mechanic). */
  get visible(): boolean {
    return this.shown;
  }

  /** Height the pill and its caption take (px), for stacking. */
  get stackHeight(): number {
    return this.h + this.captionH + 6;
  }

  /** Places the pill centred on x with its bottom edge at `bottom` (screen px); the caption stays left of maxRight. */
  layout(x: number, bottom: number, compact: boolean, maxRight: number): void {
    this.w = compact ? 92 : 108;
    this.h = compact ? 26 : 30;
    this.captionH = compact ? 16 : 18;
    this.x = x;
    this.y = bottom - this.h / 2;
    this.maxRight = maxRight;
    this.count.setFontSize(compact ? 16 : 18).setPosition(x + this.h / 2 - 2, this.y);
    this.caption.setFontSize(compact ? 13 : 14);
    this.placeCaption();
  }

  /** Reads whether the badge shows (call before layout decisions); cheap, no allocation. */
  refresh(world: Pick<WorldState, 'player'>): void {
    const player = world.player;
    if (this.mechanicsFor !== player.mechanics) {
      this.mechanicsFor = player.mechanics;
      this.max = raiseAlliesStats(player)?.max;
    }
    this.shown = this.max !== undefined && this.max > 0;
  }

  update(world: Pick<WorldState, 'player' | 'allies'>, dt: number): void {
    this.time += dt;
    this.refresh(world);
    const visible = this.shown;
    this.gfx.setVisible(visible);
    this.count.setVisible(visible);
    this.caption.setVisible(visible);
    const max = this.max;
    if (!visible || max === undefined) return;

    let n = 0;
    for (const a of world.allies) if (a.life > 0) n++;
    if (this.shownCount >= 0 && n > this.shownCount) this.gainFlash = GAIN_FLASH;
    if (this.shownCount >= 0 && n < this.shownCount) this.lossFlash = LOSS_FLASH;
    const locale = getLocale();
    if (n !== this.shownCount || locale !== this.shownLocale) {
      this.count.setText(`${n}/${max}`).setColor(n > 0 ? UI.text : '#8a9a94');
      this.caption.setText(upper(t('hud.allies')));
      this.placeCaption();
      this.shownCount = n;
      this.shownLocale = locale;
    }
    this.gainFlash = Math.max(0, this.gainFlash - dt);
    this.lossFlash = Math.max(0, this.lossFlash - dt);
    this.draw(n / max, n >= max);
  }

  private placeCaption(): void {
    const half = this.caption.width / 2;
    const cx = Math.min(this.x, this.maxRight - half);
    this.caption.setPosition(cx, this.y - this.h / 2 - 3);
  }

  private draw(frac: number, full: boolean): void {
    const { x, y, w, h } = this;
    const g = this.gfx.clear();
    const left = x - w / 2;
    const top = y - h / 2;
    const r = h / 2;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    if (full) {
      g.fillStyle(ALLY_TEAL, 0.1 + 0.1 * pulse).fillRoundedRect(left - 6, top - 6, w + 12, h + 12, r + 6);
      g.lineStyle(2, ALLY_TEAL, 0.3 + 0.3 * pulse).strokeRoundedRect(left - 4, top - 4, w + 8, h + 8, r + 4);
    }
    g.fillStyle(0x000000, 0.75).fillRoundedRect(left - 2, top - 2, w + 4, h + 4, r + 2);
    g.fillStyle(0x06120f, 0.95).fillRoundedRect(left, top, w, h, r);
    const inset = 3;
    const fw = (w - inset * 2) * Phaser.Math.Clamp(frac, 0, 1);
    if (fw > 1) {
      const fh = h - inset * 2;
      const fr = Math.min(fh / 2, fw / 2);
      g.fillStyle(TEAL_DEEP, 1).fillRoundedRect(left + inset, top + inset, fw, fh, fr);
      g.fillStyle(ALLY_TEAL, 0.3).fillRoundedRect(left + inset, top + inset, fw, fh * 0.4, Math.min(fr, fh * 0.2));
    }
    g.lineStyle(2, frac > 0 ? ALLY_TEAL : RIM, frac > 0 ? 0.9 : 0.8).strokeRoundedRect(left, top, w, h, r);
    this.drawSkull(g, left + r, y, h / 30, frac > 0);
    if (this.gainFlash > 0) g.fillStyle(0xffffff, 0.28 * (this.gainFlash / GAIN_FLASH)).fillRoundedRect(left, top, w, h, r);
    if (this.lossFlash > 0) g.fillStyle(0x000000, 0.35 * (this.lossFlash / LOSS_FLASH)).fillRoundedRect(left, top, w, h, r);
  }

  /** Skull glyph in the left cap: teal while skeletons walk, dim grey when none. */
  private drawSkull(g: Phaser.GameObjects.Graphics, cx: number, cy: number, s: number, lit: boolean): void {
    const bone = lit ? 0xc8fff0 : 0x6a7a74;
    g.fillStyle(lit ? ALLY_TEAL : 0x3a4a44, lit ? 0.35 : 0.2).fillCircle(cx, cy, 11 * s);
    g.fillStyle(bone, 1).fillCircle(cx, cy - 2 * s, 7.5 * s);
    g.fillRect(cx - 4.5 * s, cy + 2 * s, 9 * s, 5 * s);
    g.fillStyle(0x06120f, 1).fillCircle(cx - 3 * s, cy - 2 * s, 2.2 * s).fillCircle(cx + 3 * s, cy - 2 * s, 2.2 * s);
    g.fillRect(cx - 0.8 * s, cy + 3 * s, 1.6 * s, 4 * s);
  }
}

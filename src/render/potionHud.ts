import * as Phaser from 'phaser';
import type { ClassDef, Content, LifePotionDef } from '../core/world/content';
import { lifeRecoveryPool, potionHealAmount, type PlayerState } from '../core/world/world';
import { t } from '../i18n';
import { POTION_ROSE, POTION_RUBY } from './potionFx';
import { formatCost } from './resourceText';
import { frameTexture, label, makeFrame, UI } from './ui';

// The life potion slot of the in-run HUD (docs/design/combat.md, decision 2026-10-26), left of the skill bar:
// - a flask whose ruby liquid shows how full the potion is (stored charges + the progress to the next one in a paler
//   layer), tick marks between charges, dimmed glass at 0 charges;
// - under the frame (the skill slots' level row): one diamond pip per charge and a bar of kill points to the next;
// - key hint "1"; a tap / click on the slot drinks too (the touch hook until 0.5 brings the touch controls);
// - feedback: a shake, red flash and a short caption on a denied drink ("Empty" / "Life full"), a pulse on a new
//   charge, a rose flash on a drink;
// - a hover tooltip (mouse) with the heal one drink gives now (core's potionHealAmount), charges and how they refill.
// Render-only: charges, points and the heal come from core state / functions; every number here is a visual constant.

const DENY_TTL = 0.45;
const DENY_TEXT_TTL = 1.1;
const CHARGE_TTL = 0.6;
const DRINK_TTL = 0.4;
/** Seconds between tooltip refreshes while it shows (the heal changes with the hero's stats). */
const TOOLTIP_REFRESH = 0.5;
/** Milliseconds after a touch during which hover events count as the browser's emulated mouse, not a real mouse. */
const TOUCH_HOVER_GUARD = 1500;

const GLASS = 0x1a0b12;
const GLASS_RIM = 0xd8c8b8;
const CORK = 0x8a6038;
const PIP_ON = POTION_ROSE;
const PIP_OFF = 0x2e1418;
const PIP_RIM = 0x9a4a58;
const FULL_BAR = 0xf3d58a;
const DENY_RED = 0xff4a3a;

/** Points of the bulb's liquid polygon (preallocated: no per-frame allocations). */
const LIQUID_STEPS = 16;

interface Pt {
  x: number;
  y: number;
}

export class PotionSlot {
  private readonly frame: Phaser.GameObjects.Image;
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly fxGfx: Phaser.GameObjects.Graphics;
  private readonly key: Phaser.GameObjects.Text;
  private readonly denyText: Phaser.GameObjects.Text;
  private readonly tipBg: Phaser.GameObjects.Graphics;
  private readonly tipTitle: Phaser.GameObjects.Text;
  private readonly tipText: Phaser.GameObjects.Text;
  private readonly liquid: Pt[] = [];
  private x = 0;
  private y = 0;
  private size = 56;
  private compact = false;
  private time = 0;
  private deny = 0;
  private denyAge = DENY_TEXT_TTL;
  private charge = 0;
  private drink = 0;
  private tipShown = false;
  private tipRefresh = 0;
  /** Scene time (ms) of the last touch on the slot. */
  private lastTouch = Number.NEGATIVE_INFINITY;
  /** The last player seen (tooltip text is built from it). */
  private player: PlayerState | undefined;

  constructor(
    private readonly scene: Phaser.Scene,
    depth: number,
    private readonly def: LifePotionDef,
    private readonly content: Content,
    private readonly classDef: ClassDef,
    onPress: () => void,
  ) {
    this.frame = makeFrame(scene, 0, 0, 56, 56, 'secondary').setScrollFactor(0).setDepth(depth).setInteractive();
    this.frame.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.wasTouch) {
        this.lastTouch = scene.time.now;
        this.hideTooltip();
      }
      onPress();
    });
    this.frame.on('pointerover', (pointer: Phaser.Input.Pointer) => {
      // Mouse only: on touch a tap drinks and the tooltip would cover the fight. Browsers follow a tap with emulated
      // mouse events (not flagged as touch), hence the guard after the last touch.
      if (!pointer.wasTouch && scene.time.now - this.lastTouch > TOUCH_HOVER_GUARD) this.showTooltip();
    });
    this.frame.on('pointerout', () => this.hideTooltip());
    this.gfx = scene.add.graphics().setScrollFactor(0).setDepth(depth + 1);
    this.fxGfx = scene.add.graphics().setScrollFactor(0).setDepth(depth + 2);
    this.key = label(scene, 0, 0, '1', 12, UI.goldBrightText, true).setOrigin(0.5).setScrollFactor(0).setDepth(depth + 3);
    this.key.setStroke('#000', 3);
    this.denyText = label(scene, 0, 0, '', 14, '#ff8a7a', true).setOrigin(0.5, 1).setScrollFactor(0).setDepth(depth + 4).setVisible(false);
    this.denyText.setStroke('#000', 4);
    this.tipBg = scene.add.graphics().setScrollFactor(0).setDepth(depth + 20).setVisible(false);
    this.tipTitle = label(scene, 0, 0, '', 18, UI.goldBrightText, true).setFontFamily(UI.headingFont).setScrollFactor(0).setDepth(depth + 21).setVisible(false);
    this.tipText = label(scene, 0, 0, '', 14, UI.text).setScrollFactor(0).setDepth(depth + 21).setVisible(false).setLineSpacing(3);
    for (let i = 0; i < (LIQUID_STEPS + 1) * 2; i++) this.liquid.push({ x: 0, y: 0 });
  }

  /** Slot centred at (x, y), `size` px square. */
  layout(x: number, y: number, size: number, compact: boolean): void {
    this.x = x;
    this.y = y;
    this.size = size;
    this.compact = compact;
    this.frame.setTexture(frameTexture(this.scene, size, size, 'secondary')).setPosition(x, y);
    this.frame.input?.hitArea.setTo(0, 0, this.frame.width, this.frame.height);
    this.key.setPosition(x, y + size / 2 - 2);
    this.denyText.setFontSize(compact ? 14 : 15);
    this.hideTooltip();
  }

  /** A drink was refused: shake, flash and say why. */
  denied(reason: 'empty' | 'full', player: PlayerState): void {
    this.deny = DENY_TTL;
    this.denyAge = 0;
    const shield = lifeRecoveryPool(player.mechanics) === 'energyShield';
    this.denyText.setText(reason === 'empty' ? t('hud.potionEmpty') : t(shield ? 'hud.potionFullShield' : 'hud.potionFull')).setVisible(true);
  }

  /** Kills filled a charge. */
  charged(): void {
    this.charge = CHARGE_TTL;
  }

  /** The hero drank. */
  drank(): void {
    this.drink = DRINK_TTL;
  }

  update(player: PlayerState, dt: number): void {
    this.time += dt;
    this.player = player;
    this.deny = Math.max(0, this.deny - dt);
    this.charge = Math.max(0, this.charge - dt);
    this.drink = Math.max(0, this.drink - dt);
    const max = this.def.maxCharges;
    const charges = Phaser.Math.Clamp(player.potion.charges, 0, max);
    const progress = charges >= max ? 0 : Phaser.Math.Clamp(player.potion.points / this.def.pointsPerCharge, 0, 1);
    const empty = charges <= 0;

    // Denied: a quick horizontal shake of the whole slot.
    const shake = this.deny > 0 ? Math.sin(this.deny * 70) * 4 * (this.deny / DENY_TTL) : 0;
    const x = this.x + shake;
    const y = this.y;
    this.frame.setX(x).setAlpha(empty ? 0.75 : 1);
    this.key.setX(x).setAlpha(empty ? 0.6 : 1);

    const g = this.gfx.clear();
    this.drawFlask(g, x, y, charges / max, (charges + progress) / max, empty);
    this.drawRow(g, x, charges, max, progress);

    const fx = this.fxGfx.clear();
    const half = this.size / 2;
    if (this.drink > 0) {
      const a = this.drink / DRINK_TTL;
      fx.fillStyle(POTION_ROSE, 0.3 * a).fillRect(x - half + 4, y - half + 4, this.size - 8, this.size - 8);
    }
    if (this.charge > 0) {
      const a = this.charge / CHARGE_TTL;
      const grow = 3 + 10 * (1 - a);
      fx.lineStyle(3, POTION_ROSE, 0.9 * a).strokeRoundedRect(x - half - grow, y - half - grow, this.size + grow * 2, this.size + grow * 2, 6 + grow * 0.5);
      fx.fillStyle(0xffe0e6, 0.25 * a).fillRect(x - half + 4, y - half + 4, this.size - 8, this.size - 8);
    }
    if (this.deny > 0) {
      const a = this.deny / DENY_TTL;
      fx.fillStyle(DENY_RED, 0.3 * a).fillRect(x - half + 4, y - half + 4, this.size - 8, this.size - 8);
      fx.lineStyle(2, DENY_RED, 0.9 * a).strokeRect(x - half + 2, y - half + 2, this.size - 4, this.size - 4);
    }

    // Deny caption rising above the slot.
    if (this.denyAge < DENY_TEXT_TTL) {
      this.denyAge += dt;
      const k = Math.min(1, this.denyAge / DENY_TEXT_TTL);
      this.denyText.setPosition(this.x, y - half - 22 - 14 * k).setAlpha(k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
      if (k >= 1) this.denyText.setVisible(false);
    }

    if (this.tipShown) {
      this.tipRefresh -= dt;
      if (this.tipRefresh <= 0) this.showTooltip();
    }
  }

  /**
   * The flask: a round bulb with a neck and cork. Liquid: `stored` (charges / max) in solid ruby, up to `total`
   * (with the progress to the next charge) in a paler layer; tick marks between charges.
   */
  private drawFlask(g: Phaser.GameObjects.Graphics, x: number, y: number, stored: number, total: number, empty: boolean): void {
    const s = this.size;
    const rb = s * 0.25;
    const cy = y + s * 0.07;
    const neckW = s * 0.16;
    const neckTop = y - s * 0.3;
    const neckBottom = cy - rb * 0.8;
    // Glass body.
    g.fillStyle(GLASS, 1).fillCircle(x, cy, rb);
    g.fillRect(x - neckW / 2, neckTop, neckW, neckBottom - neckTop);
    // Liquid: paler progress layer first, the stored charges over it.
    if (total > stored) this.fillBulb(g, x, cy, rb, total, POTION_ROSE, 0.45);
    if (stored > 0) {
      this.fillBulb(g, x, cy, rb, stored, POTION_RUBY, 1);
      // Inner glow, brighter with a fresh charge.
      g.fillStyle(POTION_ROSE, 0.25 + 0.35 * (this.charge / CHARGE_TTL)).fillCircle(x - rb * 0.15, cy + rb * 0.25, rb * 0.45);
    }
    // A full potion fills the neck as well.
    if (stored >= 1) g.fillStyle(POTION_RUBY, 1).fillRect(x - neckW / 2 + 1.5, neckBottom - (neckBottom - neckTop) * 0.55, neckW - 3, (neckBottom - neckTop) * 0.55 + 2);
    // Tick marks between charges on the bulb's left side.
    const max = this.def.maxCharges;
    g.lineStyle(1.5, 0x000000, 0.7);
    for (let i = 1; i < max; i++) {
      const ly = cy + rb - 2 * rb * (i / max);
      const hw = Math.sqrt(Math.max(0, rb * rb - (ly - cy) * (ly - cy)));
      g.lineBetween(x - hw + 1, ly, x - hw + rb * 0.4, ly);
    }
    // Glass rim, neck and cork; dimmed when empty.
    const rimA = empty ? 0.45 : 0.95;
    g.lineStyle(2, GLASS_RIM, rimA).strokeCircle(x, cy, rb);
    g.lineBetween(x - neckW / 2, neckTop, x - neckW / 2, neckBottom);
    g.lineBetween(x + neckW / 2, neckTop, x + neckW / 2, neckBottom);
    g.fillStyle(CORK, empty ? 0.5 : 1).fillRect(x - neckW * 0.7, neckTop - s * 0.07, neckW * 1.4, s * 0.08);
    // Glass highlight.
    g.fillStyle(0xffffff, empty ? 0.12 : 0.28).fillEllipse(x - rb * 0.4, cy - rb * 0.35, rb * 0.42, rb * 0.6);
  }

  /** Liquid in the bulb (circle at (x, cy), radius r) filled to `frac` of its height. */
  private fillBulb(g: Phaser.GameObjects.Graphics, x: number, cy: number, r: number, frac: number, color: number, alpha: number): void {
    const f = Phaser.Math.Clamp(frac, 0, 1);
    const level = cy + r - 2 * r * f;
    const wave = f < 1 ? 1.2 : 0;
    const pts = this.liquid;
    for (let i = 0; i <= LIQUID_STEPS; i++) {
      const dx = -r + (2 * r * i) / LIQUID_STEPS;
      const half = Math.sqrt(Math.max(0, r * r - dx * dx));
      const p = pts[i]!;
      p.x = x + dx;
      p.y = Math.min(cy + half, Math.max(cy - half, level + Math.sin(this.time * 3 + dx * 0.3) * wave));
      const q = pts[LIQUID_STEPS * 2 + 1 - i]!;
      q.x = x + dx;
      q.y = cy + half;
    }
    g.fillStyle(color, alpha).fillPoints(pts as unknown as Phaser.Math.Vector2[], true);
  }

  /** Under the frame: a diamond pip per charge (filled = stored) and the kill-point bar to the next charge. */
  private drawRow(g: Phaser.GameObjects.Graphics, x: number, charges: number, max: number, progress: number): void {
    const half = this.size / 2;
    const pip = this.compact ? 3 : 3.5;
    const step = this.compact ? 8 : 9;
    const barH = this.compact ? 3 : 4;
    const rowY = this.y + half + (this.compact ? 7 : 9);
    const firstPip = x - half + 2 + pip;
    for (let i = 1; i <= max; i++) {
      const px = firstPip + (i - 1) * step;
      const on = i <= charges;
      // The newest charge swells with the pulse.
      const r = on && i === charges ? pip * (1 + 0.6 * (this.charge / CHARGE_TTL)) : pip;
      diamond(g, px, rowY, r + 1.2);
      g.fillStyle(0x000000, 0.85).fillPath();
      diamond(g, px, rowY, r);
      g.fillStyle(on ? PIP_ON : PIP_OFF, 1).fillPath();
      if (!on) g.lineStyle(1, PIP_RIM, 1).strokePath();
    }
    const bx = firstPip + (max - 1) * step + pip + 4;
    const bw = x + half - bx;
    const by = rowY - barH / 2;
    const full = charges >= max;
    g.fillStyle(0x000000, 0.8).fillRect(bx - 1, by - 1, bw + 2, barH + 2);
    g.fillStyle(PIP_OFF, 1).fillRect(bx, by, bw, barH);
    g.fillStyle(full ? FULL_BAR : POTION_ROSE, 1).fillRect(bx, by, full ? bw : bw * progress, barH);
  }

  private showTooltip(): void {
    const p = this.player;
    if (!p) return;
    this.tipShown = true;
    this.tipRefresh = TOOLTIP_REFRESH;
    const shield = lifeRecoveryPool(p.mechanics) === 'energyShield';
    const amount = formatCost(potionHealAmount(this.content, this.classDef, p));
    const seconds = String(Math.round(this.def.duration * 10) / 10);
    const text = [
      t(shield ? 'hud.potionHealShield' : 'hud.potionHeal', { amount, seconds }),
      t('hud.potionCharges', { charges: p.potion.charges, max: this.def.maxCharges }),
      t('hud.potionRefill'),
    ].join('\n');
    const title = t('hud.potion');
    if (title !== this.tipTitle.text) this.tipTitle.setText(title);
    const maxW = Math.min(280, this.scene.scale.width - 16);
    this.tipText.setFontSize(this.compact ? 14 : 15).setWordWrapWidth(maxW - 24);
    if (text !== this.tipText.text) this.tipText.setText(text);
    this.tipTitle.setFontSize(this.compact ? 16 : 18);
    const w = Math.min(maxW, Math.max(this.tipText.width, this.tipTitle.width) + 24);
    const h = this.tipTitle.height + this.tipText.height + 20;
    const left = Phaser.Math.Clamp(this.x - this.size / 2, 8, this.scene.scale.width - w - 8);
    const top = Math.max(8, this.y - this.size / 2 - 22 - h);
    this.tipTitle.setPosition(left + 14, top + 8).setVisible(true);
    this.tipText.setPosition(left + 14, top + 12 + this.tipTitle.height).setVisible(true);
    const bg = this.tipBg.clear().setVisible(true);
    bg.fillStyle(0x0e0b10, 0.94).fillRoundedRect(left, top, w, h, 6);
    bg.lineStyle(2, 0x9a6a22, 1).strokeRoundedRect(left, top, w, h, 6);
    bg.fillStyle(POTION_RUBY, 1).fillRect(left + 6, top + 6, 3, h - 12);
  }

  private hideTooltip(): void {
    this.tipShown = false;
    this.tipBg.setVisible(false);
    this.tipTitle.setVisible(false);
    this.tipText.setVisible(false);
  }
}

function diamond(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number): void {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
}

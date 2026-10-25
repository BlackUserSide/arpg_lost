import * as Phaser from 'phaser';
import type { PassiveMechanic } from '../core/passives/types';
import { cheatDeathStats, type PlayerState } from '../core/world/world';
import { getLocale, t, upper } from '../i18n';
import { TIME_BLUE, TIME_BRASS, TIME_GLASS } from './clockFx';
import { pct } from './statText';
import { label, UI } from './ui';

// The recharge badge of the legendary Clock of the Last Moment (docs/design/items.md): a pill over the resource orb
// (stacked above the Devourer's Crown souls pill when both are worn) with a clock glyph, the state and a caption,
// shown only while the hero has the cheatDeath mechanic (cheatDeathStats). Two looks:
// - ready: icy blue glow, "Ready", caption with the clock's name;
// - rewinding: blood-red rim, seconds left, the fill growing back, caption "+20% damage taken" (the clock's cost).
// Render-only: cooldown and its length come from core (PlayerState.cheatDeathCooldown, the mechanic), the cost's
// percentage from the clock's own conditionalModifiers mechanic (data); every number here is a visual constant.

/** Seconds of the burst when the clock is spent / of the flash when it is ready again. */
const SPENT_FLASH = 0.7;
const READY_FLASH = 0.45;

const TIME_DEEP = 0x1f4a6a;
const BLOOD = 0xc0403a;

type ClockLook = 'ready' | 'rewinding';

const CAPTION_COLOR: Readonly<Record<ClockLook, string>> = { ready: '#bfeaff', rewinding: '#ff8a7a' };
const COUNT_COLOR: Readonly<Record<ClockLook, string>> = { ready: '#dff6ff', rewinding: UI.text };

/** The clock's cost read from the hero's mechanics: "more" damage taken while it recharges (0.2 = 20% more). */
function rechargePenalty(mechanics: readonly PassiveMechanic[]): number {
  for (const m of mechanics) {
    if (m.kind !== 'conditionalModifiers' || m.condition.kind !== 'cheatDeathRecharging') continue;
    let more = 1;
    for (const mod of m.modifiers) if (mod.stat === 'damageTaken' && mod.kind === 'more') more *= 1 + mod.value;
    return more - 1;
  }
  return 0;
}

export class ClockBadge {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly count: Phaser.GameObjects.Text;
  private readonly caption: Phaser.GameObjects.Text;
  private x = 0;
  private y = 0;
  private w = 104;
  private h = 28;
  /** Caption line height above the pill (px). */
  private captionH = 17;
  /** Right screen edge the caption must stay inside (px). */
  private maxRight = Number.POSITIVE_INFINITY;
  /** Mechanics list the cooldown / penalty were read from (the world replaces the array on change). */
  private mechanicsFor: unknown;
  private cooldown: number | undefined;
  private penalty = 0;
  /** What the texts show now (re-set only on change: setText re-renders the texture). */
  private shownSeconds = -1;
  private shownLook: ClockLook | undefined;
  private shownLocale = '';
  private spentFlash = 0;
  private readyFlash = 0;
  private time = 0;
  private shown = false;

  constructor(scene: Phaser.Scene, depth: number) {
    this.gfx = scene.add.graphics().setScrollFactor(0).setDepth(depth).setVisible(false);
    this.count = label(scene, 0, 0, '', 16, UI.text, true).setOrigin(0.5).setScrollFactor(0).setDepth(depth + 1).setVisible(false);
    this.count.setStroke('#000', 4);
    this.caption = label(scene, 0, 0, '', 13, CAPTION_COLOR.ready, true).setOrigin(0.5, 1).setScrollFactor(0).setDepth(depth + 1).setVisible(false);
    this.caption.setStroke('#000', 3).setLetterSpacing(1);
  }

  /** Visible this frame (the hero wears the clock). */
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

  update(player: Pick<PlayerState, 'mechanics' | 'cheatDeathCooldown'>, dt: number): void {
    this.time += dt;
    if (this.mechanicsFor !== player.mechanics) {
      this.mechanicsFor = player.mechanics;
      this.cooldown = cheatDeathStats(player)?.cooldown;
      this.penalty = rechargePenalty(player.mechanics);
      this.shownLook = undefined;
    }
    const total = this.cooldown;
    const visible = total !== undefined;
    this.shown = visible;
    this.gfx.setVisible(visible);
    this.count.setVisible(visible);
    this.caption.setVisible(visible);
    if (!visible) return;

    const left = player.cheatDeathCooldown;
    const look: ClockLook = left > 0 ? 'rewinding' : 'ready';
    if (this.shownLook === 'ready' && look === 'rewinding') this.spentFlash = SPENT_FLASH;
    if (this.shownLook === 'rewinding' && look === 'ready') this.readyFlash = READY_FLASH;
    const seconds = look === 'ready' ? 0 : Math.ceil(left);
    const locale = getLocale();
    if (seconds !== this.shownSeconds || look !== this.shownLook || locale !== this.shownLocale) {
      const countText = look === 'ready' ? upper(t('hud.clockReady')) : t('hud.buffSeconds', { seconds });
      this.count.setText(countText).setColor(COUNT_COLOR[look]);
      this.caption.setText(upper(look === 'ready' ? t('hud.clock') : this.penaltyText())).setColor(CAPTION_COLOR[look]);
      this.placeCaption();
      this.shownSeconds = seconds;
      this.shownLook = look;
      this.shownLocale = locale;
    }
    this.spentFlash = Math.max(0, this.spentFlash - dt);
    this.readyFlash = Math.max(0, this.readyFlash - dt);
    this.draw(total > 0 ? 1 - left / total : 1, look);
  }

  private penaltyText(): string {
    return this.penalty > 0 ? t('hud.clockPenalty', { pct: pct(this.penalty) }) : t('hud.clock');
  }

  /** Caption centred over the pill, nudged left when it would leave the screen. */
  private placeCaption(): void {
    const half = this.caption.width / 2;
    const cx = Math.min(this.x, this.maxRight - half);
    this.caption.setPosition(cx, this.y - this.h / 2 - 3);
  }

  private draw(frac: number, look: ClockLook): void {
    const { x, y, w, h } = this;
    const g = this.gfx.clear();
    const left = x - w / 2;
    const top = y - h / 2;
    const r = h / 2;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (look === 'ready' ? 4 : 3));
    // Outer glow: icy blue while ready, a slow red throb while the cost applies.
    if (look === 'ready') {
      g.fillStyle(TIME_BLUE, 0.1 + 0.1 * pulse).fillRoundedRect(left - 6, top - 6, w + 12, h + 12, r + 6);
      g.lineStyle(2, TIME_BLUE, 0.3 + 0.3 * pulse).strokeRoundedRect(left - 4, top - 4, w + 8, h + 8, r + 4);
    } else {
      g.fillStyle(BLOOD, 0.1 + 0.12 * pulse).fillRoundedRect(left - 4, top - 4, w + 8, h + 8, r + 4);
    }
    g.fillStyle(0x000000, 0.75).fillRoundedRect(left - 2, top - 2, w + 4, h + 4, r + 2);
    g.fillStyle(look === 'rewinding' ? 0x1c0c10 : 0x08121c, 0.95).fillRoundedRect(left, top, w, h, r);
    // Fill: the recharge growing back; full and bright when ready.
    const inset = 3;
    const fw = (w - inset * 2) * Phaser.Math.Clamp(frac, 0, 1);
    if (fw > 1) {
      const fh = h - inset * 2;
      const fr = Math.min(fh / 2, fw / 2);
      g.fillStyle(TIME_DEEP, look === 'ready' ? 1 : 0.8).fillRoundedRect(left + inset, top + inset, fw, fh, fr);
      g.fillStyle(TIME_BLUE, look === 'ready' ? 0.35 : 0.18).fillRoundedRect(left + inset, top + inset, fw, fh * 0.4, Math.min(fr, fh * 0.2));
    }
    const rim = look === 'ready' ? TIME_BLUE : BLOOD;
    g.lineStyle(2, rim, look === 'rewinding' ? 0.65 + 0.35 * pulse : 1).strokeRoundedRect(left, top, w, h, r);
    this.drawGlyph(g, left + r, y, h / 30, look, frac);
    // Spent: glass rings bursting out of the pill; ready again: a quick bright wash.
    if (this.readyFlash > 0) g.fillStyle(0xffffff, 0.3 * (this.readyFlash / READY_FLASH)).fillRoundedRect(left, top, w, h, r);
    if (this.spentFlash > 0) {
      const k = 1 - this.spentFlash / SPENT_FLASH;
      const grow = 4 + 18 * k;
      g.lineStyle(3 * (1 - k) + 1, TIME_GLASS, 1 - k).strokeRoundedRect(left - grow, top - grow, w + grow * 2, h + grow * 2, r + grow);
      g.lineStyle(2, TIME_BRASS, 0.8 * (1 - k)).strokeRoundedRect(left - grow * 0.5, top - grow * 0.5, w + grow, h + grow, r + grow * 0.5);
    }
  }

  /** Clock glyph in the left cap: brass rim, face, the hand winding round with the recharge (on 12 when ready). */
  private drawGlyph(g: Phaser.GameObjects.Graphics, cx: number, cy: number, s: number, look: ClockLook, frac: number): void {
    const r = 10 * s;
    const ready = look === 'ready';
    g.fillStyle(ready ? 0x16324a : 0x2a1a20, 1).fillCircle(cx, cy, r);
    // Recharge wedge on the face.
    if (!ready && frac > 0.01) g.fillStyle(TIME_BLUE, 0.35).slice(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac, false).fillPath();
    g.lineStyle(2 * s, ready ? TIME_BRASS : 0x8a6a40, 1).strokeCircle(cx, cy, r);
    // Crown knob on top.
    g.fillStyle(ready ? TIME_BRASS : 0x8a6a40, 1).fillRect(cx - 2 * s, cy - r - 4 * s, 4 * s, 3 * s);
    const hand = ready ? -Math.PI / 2 : -Math.PI / 2 + Math.PI * 2 * frac;
    const color = ready ? TIME_GLASS : 0xc8b8a8;
    g.lineStyle(2 * s, color, 1).lineBetween(cx, cy, cx + Math.cos(hand) * r * 0.75, cy + Math.sin(hand) * r * 0.75);
    g.lineStyle(2 * s, color, 1).lineBetween(cx, cy, cx + r * 0.45, cy);
    g.fillStyle(color, 1).fillCircle(cx, cy, 1.6 * s);
  }
}

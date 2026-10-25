import * as Phaser from 'phaser';
import type { PassiveMechanic } from '../core/passives/types';
import { soulsMax } from '../core/world/souls';
import type { PlayerState } from '../core/world/state';
import { getLocale, t, upper } from '../i18n';
import { SOUL_GREEN, SOUL_VIOLET } from './soulFx';
import { pct } from './statText';
import { label, UI } from './ui';

// The souls counter of the legendary Devourer's Crown (docs/design/items.md): a pill above the resource orb with a
// soul glyph, "N/30" and a caption, shown only while the hero has the souls mechanic (soulsMax). Three looks:
// - penalty (the crown's "no souls" cost applies): blood-red rim and text, caption "−30% damage";
// - filling: violet fill growing with the count, caption "Souls";
// - ready (count at max): green glow and caption "Ready" (the next fitting use echoes for free).
// Render-only: the count and max come from core state, the penalty's percentage and threshold from the crown's own
// conditionalModifiers mechanic (data); every number here is a visual constant.

/** Seconds of the flash on each new soul / of the burst when the souls are spent. */
const GAIN_FLASH = 0.25;
const SPENT_FLASH = 0.6;

const VIOLET_DEEP = 0x4a1f78;
const GREEN_DEEP = 0x1f7a52;
const BLOOD = 0xc0403a;
const RIM = 0x9a6a22;

type SoulsLook = 'penalty' | 'filling' | 'ready';

const CAPTION_COLOR: Readonly<Record<SoulsLook, string>> = { penalty: '#ff8a7a', filling: '#c8a8f0', ready: '#9dffc8' };
const COUNT_COLOR: Readonly<Record<SoulsLook, string>> = { penalty: '#ff8a7a', filling: UI.text, ready: UI.goldBrightText };

/** The crown's "no souls" cost read from the hero's mechanics: applies at `atMost` souls or fewer, `damage` more. */
interface SoulsPenalty {
  readonly atMost: number;
  /** Combined "more" damage of the cost (−0.3 = 30% less); 0 when it is not about damage. */
  readonly damage: number;
}

function soulsPenalty(mechanics: readonly PassiveMechanic[]): SoulsPenalty | undefined {
  for (const m of mechanics) {
    if (m.kind !== 'conditionalModifiers' || m.condition.kind !== 'soulsAtMost') continue;
    let more = 1;
    for (const mod of m.modifiers) if (mod.stat === 'damage' && mod.kind === 'more') more *= 1 + mod.value;
    return { atMost: m.condition.value, damage: more - 1 };
  }
  return undefined;
}

export class SoulsBadge {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly count: Phaser.GameObjects.Text;
  private readonly caption: Phaser.GameObjects.Text;
  private x = 0;
  private y = 0;
  private w = 104;
  private h = 28;
  /** Caption line height above the pill (px). */
  private captionH = 17;
  /** Mechanics list max / penalty were read from (the world replaces the array on change). */
  private mechanicsFor: unknown;
  private max: number | undefined;
  private penalty: SoulsPenalty | undefined;
  /** What the texts show now (re-set only on change: setText re-renders the texture). */
  private shownSouls = -1;
  private shownLook: SoulsLook | undefined;
  private shownLocale = '';
  private gainFlash = 0;
  private spentFlash = 0;
  private time = 0;
  private shown = false;

  constructor(scene: Phaser.Scene, depth: number) {
    this.gfx = scene.add.graphics().setScrollFactor(0).setDepth(depth).setVisible(false);
    this.count = label(scene, 0, 0, '', 16, UI.text, true).setOrigin(0.5).setScrollFactor(0).setDepth(depth + 1).setVisible(false);
    this.count.setStroke('#000', 4);
    this.caption = label(scene, 0, 0, '', 13, CAPTION_COLOR.filling, true).setOrigin(0.5, 1).setScrollFactor(0).setDepth(depth + 1).setVisible(false);
    this.caption.setStroke('#000', 3).setLetterSpacing(1);
  }

  /** Visible this frame (the hero has the souls mechanic). */
  get visible(): boolean {
    return this.shown;
  }

  /** Height the pill and its caption take (px), for stacking another badge above. */
  get stackHeight(): number {
    return this.h + this.captionH + 6;
  }

  /** Places the pill centred on x with its bottom edge at `bottom` (screen px). */
  layout(x: number, bottom: number, compact: boolean): void {
    this.w = compact ? 92 : 108;
    this.h = compact ? 26 : 30;
    this.captionH = compact ? 16 : 18;
    this.x = x;
    this.y = bottom - this.h / 2;
    this.count.setFontSize(compact ? 16 : 18).setPosition(x + this.h / 2 - 2, this.y);
    this.caption.setFontSize(compact ? 13 : 14).setPosition(x, this.y - this.h / 2 - 3);
  }

  update(player: Pick<PlayerState, 'mechanics' | 'souls'>, dt: number): void {
    this.time += dt;
    if (this.mechanicsFor !== player.mechanics) {
      this.mechanicsFor = player.mechanics;
      this.max = soulsMax(player);
      this.penalty = soulsPenalty(player.mechanics);
      this.shownLook = undefined;
    }
    const max = this.max;
    const visible = max !== undefined && max > 0;
    this.shown = visible;
    this.gfx.setVisible(visible);
    this.count.setVisible(visible);
    this.caption.setVisible(visible);
    if (!visible) return;

    const souls = player.souls;
    const look: SoulsLook = souls >= max ? 'ready' : this.penalty && souls <= this.penalty.atMost ? 'penalty' : 'filling';
    if (this.shownSouls >= 0 && souls > this.shownSouls) this.gainFlash = GAIN_FLASH;
    if (this.shownSouls >= max && souls < this.shownSouls) this.spentFlash = SPENT_FLASH;
    const locale = getLocale();
    if (souls !== this.shownSouls || look !== this.shownLook || locale !== this.shownLocale) {
      this.count.setText(`${souls}/${max}`).setColor(COUNT_COLOR[look]);
      this.caption.setText(upper(this.captionText(look))).setColor(CAPTION_COLOR[look]);
      this.shownSouls = souls;
      this.shownLook = look;
      this.shownLocale = locale;
    }
    this.gainFlash = Math.max(0, this.gainFlash - dt);
    this.spentFlash = Math.max(0, this.spentFlash - dt);
    this.draw(souls / max, look);
  }

  private captionText(look: SoulsLook): string {
    if (look === 'ready') return t('hud.soulsReady');
    if (look === 'penalty' && this.penalty && this.penalty.damage < 0) return t('hud.soulsPenalty', { pct: pct(this.penalty.damage) });
    return t('hud.souls');
  }

  private draw(frac: number, look: SoulsLook): void {
    const { x, y, w, h } = this;
    const g = this.gfx.clear();
    const left = x - w / 2;
    const top = y - h / 2;
    const r = h / 2;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (look === 'ready' ? 5 : 3));
    // Outer glow: green while ready, a slow red throb while the penalty applies.
    if (look === 'ready') {
      g.fillStyle(SOUL_GREEN, 0.12 + 0.12 * pulse).fillRoundedRect(left - 6, top - 6, w + 12, h + 12, r + 6);
      g.lineStyle(2, SOUL_GREEN, 0.35 + 0.35 * pulse).strokeRoundedRect(left - 4, top - 4, w + 8, h + 8, r + 4);
    } else if (look === 'penalty') {
      g.fillStyle(BLOOD, 0.1 + 0.12 * pulse).fillRoundedRect(left - 4, top - 4, w + 8, h + 8, r + 4);
    }
    g.fillStyle(0x000000, 0.75).fillRoundedRect(left - 2, top - 2, w + 4, h + 4, r + 2);
    g.fillStyle(look === 'penalty' ? 0x220a0c : 0x0e0a14, 0.95).fillRoundedRect(left, top, w, h, r);
    // Fill: violet growing with the count, green when full.
    const inset = 3;
    const fw = (w - inset * 2) * Phaser.Math.Clamp(frac, 0, 1);
    if (fw > 1) {
      const fh = h - inset * 2;
      const fr = Math.min(fh / 2, fw / 2);
      g.fillStyle(look === 'ready' ? GREEN_DEEP : VIOLET_DEEP, 1).fillRoundedRect(left + inset, top + inset, fw, fh, fr);
      g.fillStyle(look === 'ready' ? SOUL_GREEN : SOUL_VIOLET, 0.35).fillRoundedRect(left + inset, top + inset, fw, fh * 0.4, Math.min(fr, fh * 0.2));
    }
    const rim = look === 'ready' ? SOUL_GREEN : look === 'penalty' ? BLOOD : RIM;
    g.lineStyle(2, rim, look === 'penalty' ? 0.65 + 0.35 * pulse : 1).strokeRoundedRect(left, top, w, h, r);
    // Soul glyph in the left cap: a flame (dim grey-violet while the penalty applies).
    const gx = left + r;
    const gy = y + 1;
    const s = h / 30;
    const outer = look === 'penalty' ? 0x5a4a66 : SOUL_VIOLET;
    const inner = look === 'penalty' ? 0x8a7a96 : SOUL_GREEN;
    g.fillStyle(outer, 1).fillCircle(gx, gy + 2 * s, 6.5 * s).fillTriangle(gx - 6.2 * s, gy + 1 * s, gx + 6.2 * s, gy + 1 * s, gx + 1 * s, gy - 11 * s);
    g.fillStyle(inner, 1).fillCircle(gx, gy + 3 * s, 3.4 * s).fillTriangle(gx - 3.2 * s, gy + 2.5 * s, gx + 3.2 * s, gy + 2.5 * s, gx + 0.5 * s, gy - 5 * s);
    // A new soul: a quick bright wash; the souls spent: green rings bursting out of the pill.
    if (this.gainFlash > 0) g.fillStyle(0xffffff, 0.28 * (this.gainFlash / GAIN_FLASH)).fillRoundedRect(left, top, w, h, r);
    if (this.spentFlash > 0) {
      const k = 1 - this.spentFlash / SPENT_FLASH;
      const grow = 4 + 18 * k;
      g.lineStyle(3 * (1 - k) + 1, SOUL_GREEN, 1 - k).strokeRoundedRect(left - grow, top - grow, w + grow * 2, h + grow * 2, r + grow);
      g.lineStyle(2, SOUL_VIOLET, 0.8 * (1 - k)).strokeRoundedRect(left - grow * 0.5, top - grow * 0.5, w + grow, h + grow, r + grow * 0.5);
    }
  }
}

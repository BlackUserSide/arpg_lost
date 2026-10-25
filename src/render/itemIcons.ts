import type * as Phaser from 'phaser';
import type { BaseDef, Rarity } from '../core/items/types';
import { UI } from './ui';

// Procedural item icons: a metal-toned glyph per item type on a tile tinted by rarity. Cached per base+rarity.
// Uniques and legendaries get a framed tile in their rarity colour; legendaries also a pulsing glow (legendaryGlow).

export const ITEM_ICON_SIZE = 64;

type Glyph = 'sword' | 'crossbow' | 'wand' | 'helmet' | 'armour' | 'gloves' | 'boots' | 'ring' | 'amulet';

function glyphOf(base: BaseDef): Glyph {
  if (base.weapon) return base.weapon.type;
  return base.slot as Glyph;
}

/** Accent colour by defence type, so armour / ES / hybrid read differently at a glance. */
function accentOf(base: BaseDef): string {
  if (base.weapon?.type === 'wand') return '#b58cff';
  if (base.armour && base.energyShield) return '#d9b26a';
  if (base.energyShield) return '#8fd3ff';
  if (base.slot === 'ring' || base.slot === 'amulet') return '#f3d58a';
  return '#c9c2b4';
}

export function itemIcon(scene: Phaser.Scene, base: BaseDef, rarity: Rarity): string {
  const key = `item:${base.id}:${rarity}`;
  if (scene.textures.exists(key)) return key;
  const s = ITEM_ICON_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const tint = UI.rarity[rarity];
  const bg = ctx.createRadialGradient(s / 2, s * 0.45, 4, s / 2, s / 2, s * 0.72);
  bg.addColorStop(0, withAlpha(tint, rarity === 'normal' ? 0.12 : 0.32));
  bg.addColorStop(1, '#0b090d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);

  ctx.save();
  ctx.translate(s / 2, s / 2);
  const accent = accentOf(base);
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 4;
  drawGlyph(ctx, glyphOf(base));
  ctx.restore();
  if (rarity === 'unique' || rarity === 'legendary') drawUniqueFrame(ctx, s, tint);

  scene.textures.addCanvas(key, canvas);
  return key;
}

/** Double border with corner notches in the rarity colour: a unique reads apart from a rare at a glance. */
function drawUniqueFrame(ctx: CanvasRenderingContext2D, s: number, tint: string): void {
  ctx.save();
  ctx.strokeStyle = tint;
  ctx.shadowColor = tint;
  ctx.shadowBlur = 6;
  ctx.lineWidth = 3;
  ctx.strokeRect(2.5, 2.5, s - 5, s - 5);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.strokeRect(7.5, 7.5, s - 15, s - 15);
  ctx.globalAlpha = 1;
  ctx.fillStyle = tint;
  const c = 9;
  for (const [x, y, dx, dy] of [[0, 0, 1, 1], [s, 0, -1, 1], [0, s, 1, -1], [s, s, -1, -1]] as const) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + c * dx, y);
    ctx.lineTo(x, y + c * dy);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Soft ring texture (rarity colour) drawn round a legendary's icon; pulsed by legendaryGlow. */
function glowTexture(scene: Phaser.Scene, tint: string): string {
  const key = `item:glow:${tint}`;
  if (scene.textures.exists(key)) return key;
  const s = ITEM_ICON_SIZE + GLOW_PAD * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = tint;
  ctx.shadowColor = tint;
  ctx.lineWidth = 4;
  for (const blur of [16, 8]) {
    ctx.shadowBlur = blur;
    ctx.strokeRect(GLOW_PAD, GLOW_PAD, ITEM_ICON_SIZE, ITEM_ICON_SIZE);
  }
  scene.textures.addCanvas(key, canvas);
  return key;
}

const GLOW_PAD = 14;
const GLOW_PULSE_MS = 900;

/**
 * A pulsing glow border round a legendary's icon of display size `size` at (x, y). The caller adds it to its
 * container (under or over the icon); the tween dies with the object.
 */
export function legendaryGlow(scene: Phaser.Scene, x: number, y: number, size: number): Phaser.GameObjects.Image {
  const scale = size / ITEM_ICON_SIZE;
  const glow = scene.add.image(x, y, glowTexture(scene, UI.rarity.legendary)).setScale(scale).setBlendMode('ADD').setAlpha(0.35);
  const tween = scene.tweens.add({ targets: glow, alpha: 1, scale: scale * 1.04, duration: GLOW_PULSE_MS, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
  glow.once('destroy', () => tween.remove());
  return glow;
}

function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph): void {
  const path = (points: Array<[number, number]>, close = true): void => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (close) ctx.closePath();
  };
  switch (glyph) {
    case 'sword':
      path([[-16, 16], [12, -12]], false);
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.lineWidth = 4;
      path([[-6, 4], [-14, -4]], false);
      ctx.stroke();
      path([[-17, 17], [-11, 11]], false);
      ctx.stroke();
      path([[12, -12], [17, -17]], false);
      ctx.stroke();
      break;
    case 'crossbow':
      ctx.beginPath();
      ctx.arc(0, 14, 20, -Math.PI * 0.85, -Math.PI * 0.15);
      ctx.stroke();
      path([[0, -10], [0, 20]], false);
      ctx.stroke();
      path([[-6, -4], [0, -12], [6, -4]], false);
      ctx.stroke();
      break;
    case 'wand':
      path([[-14, 16], [8, -8]], false);
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(11, -11, 6, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'helmet':
      ctx.beginPath();
      ctx.arc(0, 4, 16, Math.PI, 0);
      ctx.lineTo(16, 14);
      ctx.lineTo(-16, 14);
      ctx.closePath();
      ctx.stroke();
      path([[-10, 6], [10, 6]], false);
      ctx.stroke();
      break;
    case 'armour':
      path([[-14, -16], [-6, -16], [0, -10], [6, -16], [14, -16], [18, -4], [12, -2], [12, 18], [-12, 18], [-12, -2], [-18, -4]]);
      ctx.stroke();
      break;
    case 'gloves':
      path([[-10, 18], [-10, -2], [-14, -10], [-10, -12], [-6, -4], [-6, -16], [-2, -16], [-2, -6], [2, -18], [6, -18], [6, -6], [10, -14], [14, -12], [12, 18]]);
      ctx.stroke();
      break;
    case 'boots':
      path([[-10, -18], [4, -18], [4, 6], [16, 10], [16, 18], [-10, 18]]);
      ctx.stroke();
      break;
    case 'ring':
      ctx.beginPath();
      ctx.arc(0, 4, 13, 0, Math.PI * 2);
      ctx.stroke();
      path([[-5, -12], [0, -18], [5, -12], [0, -7]]);
      ctx.fill();
      break;
    case 'amulet':
      ctx.beginPath();
      ctx.moveTo(-14, -18);
      ctx.quadraticCurveTo(0, 0, 14, -18);
      ctx.stroke();
      path([[0, -2], [9, 8], [0, 20], [-9, 8]]);
      ctx.fill();
      break;
  }
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

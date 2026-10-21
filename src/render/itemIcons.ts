import type * as Phaser from 'phaser';
import type { BaseDef, Rarity } from '../core/items/types';
import { UI } from './ui';

// Procedural item icons: a metal-toned glyph per item type on a tile tinted by rarity. Cached per base+rarity.

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

  scene.textures.addCanvas(key, canvas);
  return key;
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

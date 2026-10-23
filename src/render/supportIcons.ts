import type * as Phaser from 'phaser';
import type { SupportDef } from '../core/supports/types';

// Procedural skill modifier ("support") icons: a cut gem in the support group's colour with a glyph per support and
// tier pips. Painted once per (support, tier) and cached; visual-only constants.

export const SUPPORT_ICON_SIZE = 64;

/** Gem colours per design group. */
const GROUP_COLORS: Record<SupportDef['group'], { light: string; deep: string }> = {
  melee: { light: '#ff8a5a', deep: '#6a1a0c' },
  projectile: { light: '#8fe38a', deep: '#1a4a16' },
  spell: { light: '#8fb3ff', deep: '#14245a' },
  general: { light: '#e0b0ff', deep: '#3a1a5a' },
};

/** Tier accent (text / glints): cool, gold, hot. */
export const TIER_COLORS: readonly string[] = ['#a8d4ff', '#f3d58a', '#ff9a4a'];
export const TIER_COLOR_NUM: readonly number[] = [0xa8d4ff, 0xf3d58a, 0xff9a4a];

export function tierColor(tier: number): string {
  return TIER_COLORS[Math.min(TIER_COLORS.length, Math.max(1, tier)) - 1] ?? TIER_COLORS[0]!;
}

export function tierColorNum(tier: number): number {
  return TIER_COLOR_NUM[Math.min(TIER_COLOR_NUM.length, Math.max(1, tier)) - 1] ?? 0xffffff;
}

type Draw = (ctx: CanvasRenderingContext2D) => void;

/** Glyphs centred on (0, 0), roughly within ±14 px. */
const GLYPHS: Record<string, Draw> = {
  wider_swing: (c) => {
    c.beginPath();
    c.arc(0, 8, 16, Math.PI * 1.1, Math.PI * 1.9);
    c.stroke();
    c.beginPath();
    c.arc(0, 8, 9, Math.PI * 1.15, Math.PI * 1.85);
    c.stroke();
  },
  stun: (c) => star(c, 4, 14, 4),
  bleed: (c) => {
    c.beginPath();
    c.moveTo(0, -14);
    c.bezierCurveTo(10, -2, 10, 12, 0, 12);
    c.bezierCurveTo(-10, 12, -10, -2, 0, -14);
    c.fill();
  },
  knockback: (c) => {
    for (const x of [-7, 4]) {
      c.beginPath();
      c.moveTo(x - 4, -10);
      c.lineTo(x + 5, 0);
      c.lineTo(x - 4, 10);
      c.stroke();
    }
  },
  extra_projectiles: (c) => {
    for (const a of [-0.45, 0, 0.45]) {
      c.save();
      c.rotate(a);
      arrow(c, 14);
      c.restore();
    }
  },
  pierce: (c) => {
    c.fillRect(-2, -13, 4, 26);
    arrowLine(c, -14, 14);
  },
  fast_projectiles: (c) => {
    arrowLine(c, -6, 14);
    c.lineWidth = 2.5;
    for (const y of [-7, 0, 7]) {
      c.beginPath();
      c.moveTo(-15, y);
      c.lineTo(-9, y);
      c.stroke();
    }
  },
  increased_area: (c) => {
    for (const r of [5, 10, 15]) {
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.stroke();
    }
  },
  ignite_on_hit: (c) => {
    c.beginPath();
    c.moveTo(0, -15);
    c.bezierCurveTo(4, -6, 11, -2, 9, 6);
    c.bezierCurveTo(8, 12, 3, 14, 0, 14);
    c.bezierCurveTo(-3, 14, -9, 12, -9, 5);
    c.bezierCurveTo(-9, 0, -5, -2, -4, -7);
    c.bezierCurveTo(-1, -4, 0, -2, 0, -15);
    c.fill();
  },
  chain_lightning: (c) => {
    c.beginPath();
    c.moveTo(5, -15);
    c.lineTo(-5, -1);
    c.lineTo(3, -1);
    c.lineTo(-5, 15);
    c.stroke();
  },
  cast_speed: (c) => {
    c.beginPath();
    c.moveTo(-9, -13);
    c.lineTo(9, -13);
    c.lineTo(-9, 13);
    c.lineTo(9, 13);
    c.closePath();
    c.stroke();
  },
  pure_power: (c) => {
    star(c, 8, 15, 6);
  },
  vampirism: (c) => {
    c.beginPath();
    c.moveTo(0, 13);
    c.bezierCurveTo(-16, 2, -12, -14, 0, -6);
    c.bezierCurveTo(12, -14, 16, 2, 0, 13);
    c.fill();
  },
  echo: (c) => {
    for (const x of [-6, 2]) {
      c.beginPath();
      c.arc(x, 0, 11, -Math.PI * 0.4, Math.PI * 0.4);
      c.stroke();
    }
    c.beginPath();
    c.arc(-10, 0, 3, 0, Math.PI * 2);
    c.fill();
  },
};

function star(c: CanvasRenderingContext2D, points: number, outer: number, inner: number): void {
  c.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    if (i === 0) c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  c.closePath();
  c.fill();
}

/** Arrow pointing up from the centre, `len` long. */
function arrow(c: CanvasRenderingContext2D, len: number): void {
  c.beginPath();
  c.moveTo(0, len * 0.6);
  c.lineTo(0, -len);
  c.stroke();
  c.beginPath();
  c.moveTo(-5, -len + 6);
  c.lineTo(0, -len);
  c.lineTo(5, -len + 6);
  c.stroke();
}

/** Horizontal arrow from x0 to x1 (pointing right). */
function arrowLine(c: CanvasRenderingContext2D, x0: number, x1: number): void {
  c.beginPath();
  c.moveTo(x0, 0);
  c.lineTo(x1, 0);
  c.stroke();
  c.beginPath();
  c.moveTo(x1 - 6, -5);
  c.lineTo(x1, 0);
  c.lineTo(x1 - 6, 5);
  c.stroke();
}

/** Texture key of a support's icon at `tier`: an octagonal gem, glyph, tier pips. */
export function supportIcon(scene: Phaser.Scene, def: Pick<SupportDef, 'id' | 'group'>, tier: number): string {
  const key = `support:${def.id}:${tier}`;
  if (scene.textures.exists(key)) return key;
  const s = SUPPORT_ICON_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const colors = GROUP_COLORS[def.group];
  const accent = tierColor(tier);
  const cx = s / 2;
  const cy = s / 2 - 2;
  const r = s * 0.4;

  // Octagonal cut gem: deep body, light facet at the top left, rim in the tier accent.
  const gem = (radius: number): void => {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const x = cx + Math.cos(a) * radius;
      const y = cy + Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  ctx.save();
  ctx.shadowColor = colors.light;
  ctx.shadowBlur = 6 + tier * 2;
  gem(r);
  const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, 2, cx, cy, r * 1.1);
  body.addColorStop(0, colors.light);
  body.addColorStop(0.45, colors.deep);
  body.addColorStop(1, '#07060a');
  ctx.fillStyle = body;
  ctx.fill();
  ctx.restore();
  gem(r);
  ctx.lineWidth = 2;
  ctx.strokeStyle = accent;
  ctx.stroke();
  gem(r - 4);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#fff6e0';
  ctx.fillStyle = '#fff6e0';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = colors.light;
  ctx.shadowBlur = 8;
  (GLYPHS[def.id] ?? ((c: CanvasRenderingContext2D) => star(c, 5, 12, 5)))(ctx);
  ctx.restore();

  // Tier pips along the bottom (diamonds); tooltips spell the tier out.
  const pip = 3.5;
  const step = 10;
  const first = cx - ((tier - 1) * step) / 2;
  for (let i = 0; i < tier; i++) {
    const px = first + i * step;
    const py = s - 6;
    ctx.beginPath();
    ctx.moveTo(px, py - pip - 1.5);
    ctx.lineTo(px + pip + 1.5, py);
    ctx.lineTo(px, py + pip + 1.5);
    ctx.lineTo(px - pip - 1.5, py);
    ctx.closePath();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px, py - pip);
    ctx.lineTo(px + pip, py);
    ctx.lineTo(px, py + pip);
    ctx.lineTo(px - pip, py);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.fill();
  }

  scene.textures.addCanvas(key, canvas);
  return key;
}

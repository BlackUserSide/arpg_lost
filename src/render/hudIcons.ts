import type * as Phaser from 'phaser';

// Procedural skill icons: a glowing glyph on a tinted, framed tile. Painted once per action and cached.

type Glyph = 'slash' | 'arc' | 'shield' | 'horn' | 'arrow' | 'arrows' | 'burst' | 'swirl' | 'star' | 'orb' | 'flake';

interface IconSpec {
  glyph: Glyph;
  color: string;
}

const ICONS: Record<string, IconSpec> = {
  warrior_strike: { glyph: 'slash', color: '#d8d2c4' },
  cleave: { glyph: 'arc', color: '#ffa04a' },
  shield_charge: { glyph: 'shield', color: '#d8d2c4' },
  battle_cry: { glyph: 'horn', color: '#ff6a3a' },
  ranger_bolt: { glyph: 'arrow', color: '#d8d2c4' },
  volley: { glyph: 'arrows', color: '#e8e2cf' },
  explosive_trap: { glyph: 'burst', color: '#ff7a2a' },
  roll: { glyph: 'swirl', color: '#8fe38a' },
  wand_bolt: { glyph: 'star', color: '#c4a0ff' },
  fireball: { glyph: 'orb', color: '#ff7a2a' },
  frost_nova: { glyph: 'flake', color: '#8fd3ff' },
  teleport: { glyph: 'swirl', color: '#b58cff' },
};

export const ICON_SIZE = 64;

export function skillIcon(scene: Phaser.Scene, actionId: string): string {
  const key = `icon:${actionId}`;
  if (scene.textures.exists(key)) return key;
  const spec = ICONS[actionId] ?? { glyph: 'star', color: '#d9a94a' };
  const s = ICON_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;

  // Tile: dark centre lit by the glyph colour.
  const bg = ctx.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s * 0.7);
  bg.addColorStop(0, hexA(spec.color, 0.35));
  bg.addColorStop(1, '#0b090d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);

  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.strokeStyle = spec.color;
  ctx.fillStyle = spec.color;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = spec.color;
  ctx.shadowBlur = 10;
  drawGlyph(ctx, spec.glyph);
  ctx.restore();

  scene.textures.addCanvas(key, canvas);
  return key;
}

function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph): void {
  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const arrow = (x: number, y: number, angle: number, len: number): void => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    line(-len / 2, 0, len / 2, 0);
    ctx.beginPath();
    ctx.moveTo(len / 2 - 8, -6);
    ctx.lineTo(len / 2, 0);
    ctx.lineTo(len / 2 - 8, 6);
    ctx.stroke();
    ctx.restore();
  };
  switch (glyph) {
    case 'slash':
      line(-16, 16, 16, -16);
      ctx.lineWidth = 3;
      line(-10, 18, 18, -10);
      break;
    case 'arc':
      ctx.beginPath();
      ctx.arc(-6, 8, 22, -Math.PI * 0.85, -Math.PI * 0.1);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(-6, 8, 14, -Math.PI * 0.8, -Math.PI * 0.15);
      ctx.stroke();
      break;
    case 'shield':
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(15, -11);
      ctx.lineTo(13, 6);
      ctx.lineTo(0, 18);
      ctx.lineTo(-13, 6);
      ctx.lineTo(-15, -11);
      ctx.closePath();
      ctx.stroke();
      line(0, -10, 0, 10);
      break;
    case 'horn':
      for (const r of [8, 15, 22]) {
        ctx.beginPath();
        ctx.arc(-10, 0, r, -Math.PI / 4, Math.PI / 4);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(-14, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'arrow':
      arrow(0, 0, -Math.PI / 4, 40);
      break;
    case 'arrows':
      for (const a of [-0.45, 0, 0.45]) arrow(Math.sin(a) * 6, 0, -Math.PI / 2 + a, 34);
      break;
    case 'burst':
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        line(Math.cos(a) * 7, Math.sin(a) * 7, Math.cos(a) * (i % 2 ? 14 : 20), Math.sin(a) * (i % 2 ? 14 : 20));
      }
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'swirl':
      ctx.beginPath();
      for (let t = 0; t < Math.PI * 3.2; t += 0.15) {
        const r = 3 + t * 2.2;
        const x = Math.cos(t) * r;
        const y = Math.sin(t) * r;
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    case 'star':
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 7 : 18;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case 'orb': {
      ctx.beginPath();
      ctx.moveTo(-20, 16);
      ctx.quadraticCurveTo(-4, 8, 2, -2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(6, -6, 11, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'flake':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = Math.cos(a) * 20;
        const y = Math.sin(a) * 20;
        line(0, 0, x, y);
        ctx.lineWidth = 3;
        line(x * 0.6, y * 0.6, x * 0.6 + Math.cos(a + 0.8) * 6, y * 0.6 + Math.sin(a + 0.8) * 6);
        line(x * 0.6, y * 0.6, x * 0.6 + Math.cos(a - 0.8) * 6, y * 0.6 + Math.sin(a - 0.8) * 6);
        ctx.lineWidth = 5;
      }
      break;
  }
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

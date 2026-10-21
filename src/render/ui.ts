import * as Phaser from 'phaser';
import { BODY_FONT, HEADING_FONT } from './fonts';

// UI kit: design tokens (docs/design/ui-style.md) and procedurally drawn components.
// Frames are painted once per size/variant onto a canvas texture and reused.

export const UI = {
  bg: 0x0a090c,
  gold: 0xd9a94a,
  goldText: '#d9a94a',
  goldBrightText: '#f3d58a',
  ember: 0xff7a2a,
  text: '#efe6d2',
  muted: '#9b917f',
  danger: '#e06c6c',
  headingFont: HEADING_FONT,
  bodyFont: BODY_FONT,
  size: { display: 44, title: 28, heading: 20, body: 16, small: 14 },
  rarity: { normal: '#c9c4b8', magic: '#7aa2ff', rare: '#f3d58a', unique: '#e07a2e', legendary: '#ff5fd2' },
} as const;

export type FrameVariant =
  | 'panel'
  | 'card'
  | 'cardHover'
  | 'cardSelected'
  | 'primary'
  | 'primaryHover'
  | 'secondary'
  | 'secondaryHover'
  | 'danger'
  | 'dangerHover';

interface FrameLook {
  top: string;
  bottom: string;
  border: [string, string];
  glow?: string;
  ornaments: boolean;
}

const LOOKS: Record<FrameVariant, FrameLook> = {
  panel: { top: '#1c1720', bottom: '#0e0b10', border: ['#b48a3c', '#5a4320'], ornaments: true },
  card: { top: '#1a1519', bottom: '#0d0a0e', border: ['#8a6a32', '#3e2e18'], ornaments: false },
  cardHover: { top: '#241c22', bottom: '#120d12', border: ['#d9a94a', '#6b4f22'], ornaments: false },
  cardSelected: { top: '#2b1d16', bottom: '#120b0a', border: ['#f3d58a', '#9a6a22'], glow: 'rgba(255,122,42,0.55)', ornaments: true },
  primary: { top: '#7a4a1a', bottom: '#3a1d08', border: ['#f3d58a', '#9a6a22'], glow: 'rgba(255,122,42,0.35)', ornaments: true },
  primaryHover: { top: '#9a5c20', bottom: '#4a250a', border: ['#fff0c0', '#c08a30'], glow: 'rgba(255,140,50,0.7)', ornaments: true },
  secondary: { top: '#26202a', bottom: '#120f14', border: ['#8a6a32', '#3e2e18'], ornaments: false },
  secondaryHover: { top: '#322a36', bottom: '#18131a', border: ['#d9a94a', '#6b4f22'], ornaments: false },
  danger: { top: '#4a1616', bottom: '#220909', border: ['#c0504a', '#5a1a16'], ornaments: false },
  dangerHover: { top: '#6a2020', bottom: '#2e0c0c', border: ['#ff7a6a', '#7a2420'], glow: 'rgba(255,60,40,0.45)', ornaments: false },
};

const FRAME_PAD = 14;

function chamferPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number): void {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

/** Returns a texture key for a frame of this size and look (cached). */
export function frameTexture(scene: Phaser.Scene, width: number, height: number, variant: FrameVariant): string {
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round(height));
  const key = `frame:${variant}:${w}x${h}`;
  if (scene.textures.exists(key)) return key;

  const look = LOOKS[variant];
  const canvas = document.createElement('canvas');
  canvas.width = w + FRAME_PAD * 2;
  canvas.height = h + FRAME_PAD * 2;
  const ctx = canvas.getContext('2d')!;
  const x = FRAME_PAD;
  const y = FRAME_PAD;
  const c = Math.min(12, h / 4, w / 4);

  // Drop shadow or glow, using the outer dark rim as the casting shape.
  ctx.save();
  ctx.shadowColor = look.glow ?? 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = look.glow ? 14 : 8;
  ctx.shadowOffsetY = look.glow ? 0 : 3;
  chamferPath(ctx, x, y, w, h, c);
  ctx.fillStyle = '#060507';
  ctx.fill();
  ctx.restore();

  // Body: vertical gradient + faint stone speckle.
  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, look.top);
  body.addColorStop(1, look.bottom);
  chamferPath(ctx, x + 2, y + 2, w - 4, h - 4, c - 1);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // 32-bit LCG via Math.imul: plain float multiplication loses precision and degenerates.
  let seed = (Math.imul(w, 73856093) ^ Math.imul(h, 19349663)) | 0;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < (w * h) / 40; i++) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(x + rand() * w, y + rand() * h, 1 + rand() * 2, 1);
  }
  // Soft top sheen.
  const sheen = ctx.createLinearGradient(0, y, 0, y + Math.min(h, 40));
  sheen.addColorStop(0, 'rgba(255,230,180,0.10)');
  sheen.addColorStop(1, 'rgba(255,230,180,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, Math.min(h, 40));
  ctx.restore();

  // Metallic rim: bright top, dark bottom; dark inner line for depth.
  const rim = ctx.createLinearGradient(0, y, 0, y + h);
  rim.addColorStop(0, look.border[0]);
  rim.addColorStop(1, look.border[1]);
  chamferPath(ctx, x + 1, y + 1, w - 2, h - 2, c);
  ctx.lineWidth = 2;
  ctx.strokeStyle = rim;
  ctx.stroke();
  chamferPath(ctx, x + 4, y + 4, w - 8, h - 8, Math.max(1, c - 2));
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();

  if (look.ornaments && w > 60 && h > 30) {
    const d = 4;
    ctx.fillStyle = look.border[0];
    for (const [ox, oy] of [
      [x + w / 2, y + 1],
      [x + w / 2, y + h - 1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(ox, oy - d);
      ctx.lineTo(ox + d, oy);
      ctx.lineTo(ox, oy + d);
      ctx.lineTo(ox - d, oy);
      ctx.closePath();
      ctx.fill();
    }
  }

  scene.textures.addCanvas(key, canvas);
  return key;
}

export function makeFrame(scene: Phaser.Scene, x: number, y: number, w: number, h: number, variant: FrameVariant): Phaser.GameObjects.Image {
  return scene.add.image(x, y, frameTexture(scene, w, h, variant));
}

export function heading(scene: Phaser.Scene, x: number, y: number, text: string, size: number = UI.size.title): Phaser.GameObjects.Text {
  const t = scene.add.text(x, y, text, {
    fontFamily: UI.headingFont,
    fontStyle: 'bold',
    fontSize: `${size}px`,
    color: UI.goldBrightText,
    stroke: '#1a1006',
    strokeThickness: Math.max(2, Math.round(size / 9)),
  });
  t.setShadow(0, 0, 'rgba(255,122,42,0.45)', Math.round(size / 3), false, true);
  const gradient = t.context.createLinearGradient(0, 0, 0, t.height);
  gradient.addColorStop(0.15, '#fff1c4');
  gradient.addColorStop(0.55, '#e3b45a');
  gradient.addColorStop(1, '#9a6a22');
  t.setFill(gradient);
  return t;
}

export function label(scene: Phaser.Scene, x: number, y: number, text: string, size: number = UI.size.body, color: string = UI.text, bold = false): Phaser.GameObjects.Text {
  return scene.add.text(x, y, text, { fontFamily: UI.bodyFont, fontStyle: bold ? 'bold' : 'normal', fontSize: `${size}px`, color });
}

export type ButtonStyle = 'primary' | 'secondary' | 'danger' | 'link';

const frameHitArea = (w: number, h: number): Phaser.Types.Input.InputConfiguration => ({
  useHandCursor: true,
  hitArea: new Phaser.Geom.Rectangle(FRAME_PAD, FRAME_PAD, w, h),
  hitAreaCallback: Phaser.Geom.Rectangle.Contains,
});

export function makeButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  onClick: () => void,
  style: ButtonStyle = 'secondary',
): Phaser.GameObjects.Container {
  if (style === 'link') {
    const t = label(scene, 0, 0, text, UI.size.small, UI.goldText).setOrigin(0.5);
    const hit = scene.add.rectangle(0, 0, Math.max(w, t.width + 12), Math.max(h, 32), 0x000000, 0.001);
    const link = scene.add.container(x, y, [hit, t]);
    hit.setInteractive({ useHandCursor: true })
      .on('pointerover', () => t.setColor(UI.goldBrightText))
      .on('pointerout', () => t.setColor(UI.goldText))
      .on('pointerup', onClick);
    return link;
  }
  const normal = frameTexture(scene, w, h, style);
  const hover = frameTexture(scene, w, h, `${style}Hover`);
  const bg = scene.add.image(0, 0, normal);
  const size = Math.round(Math.min(h * 0.42, UI.size.heading + 4));
  const t = scene.add
    .text(0, 0, text, {
      fontFamily: style === 'primary' ? UI.headingFont : UI.bodyFont,
      fontStyle: 'bold',
      fontSize: `${size}px`,
      color: style === 'primary' ? '#fff1c4' : UI.text,
      stroke: '#120a04',
      strokeThickness: style === 'primary' ? 3 : 0,
    })
    .setOrigin(0.5);
  const button = scene.add.container(x, y, [bg, t]);
  const tweenTo = (scale: number): void => {
    scene.tweens.add({ targets: button, scale, duration: 120, ease: 'Quad.easeOut' });
  };
  bg.setInteractive(frameHitArea(w, h))
    .on('pointerover', () => {
      bg.setTexture(hover);
      tweenTo(1.04);
    })
    .on('pointerout', () => {
      bg.setTexture(normal);
      tweenTo(1);
    })
    .on('pointerdown', () => tweenTo(0.96))
    .on('pointerup', () => {
      tweenTo(1.04);
      onClick();
    });
  return button;
}

/** Clickable card frame that swaps looks on hover/selection. */
export function makeCard(scene: Phaser.Scene, x: number, y: number, w: number, h: number, selected: boolean, onClick: () => void): Phaser.GameObjects.Image {
  const normal = frameTexture(scene, w, h, selected ? 'cardSelected' : 'card');
  const hover = frameTexture(scene, w, h, selected ? 'cardSelected' : 'cardHover');
  const card = scene.add.image(x, y, normal);
  card
    .setInteractive(frameHitArea(w, h))
    .on('pointerover', () => card.setTexture(hover))
    .on('pointerout', () => card.setTexture(normal))
    .on('pointerup', onClick);
  return card;
}

/** Modal confirmation above everything. */
export function confirmDialog(scene: Phaser.Scene, message: string, confirmLabel: string, onConfirm: () => void): void {
  const { width, height } = scene.scale;
  const shade = scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.7).setInteractive();
  const w = Math.min(440, width - 32);
  const panel = makeFrame(scene, width / 2, height / 2, w, 180, 'panel');
  const text = label(scene, width / 2, height / 2 - 36, message, UI.size.body + 2).setOrigin(0.5).setWordWrapWidth(w - 48).setAlign('center');
  const parts: Phaser.GameObjects.GameObject[] = [];
  const close = (): void => parts.forEach((p) => p.destroy());
  const yes = makeButton(scene, width / 2 - 90, height / 2 + 44, 150, 46, confirmLabel, () => {
    close();
    onConfirm();
  }, 'danger');
  const no = makeButton(scene, width / 2 + 90, height / 2 + 44, 150, 46, 'Cancel', close);
  parts.push(shade, panel, text, yes, no);
  for (const p of [shade, panel, text, yes, no]) p.setDepth(1000);
  for (const p of [panel, text, yes, no]) p.setAlpha(0);
  scene.tweens.add({ targets: [panel, text, yes, no], alpha: 1, duration: 160 });
}

/** Framed avatar from a loaded texture, or an initial letter. */
export function makeAvatar(scene: Phaser.Scene, x: number, y: number, size: number, textureKey: string | undefined, name: string): Phaser.GameObjects.Container {
  const frame = makeFrame(scene, 0, 0, size + 8, size + 8, 'card');
  const parts: Phaser.GameObjects.GameObject[] = [frame];
  if (textureKey && scene.textures.exists(textureKey)) parts.push(scene.add.image(0, 0, textureKey).setDisplaySize(size, size));
  else parts.push(heading(scene, 0, 1, (name[0] ?? '?').toUpperCase(), Math.round(size * 0.6)).setOrigin(0.5));
  return scene.add.container(x, y, parts);
}

/** Standard screen entrance. */
export function fadeIn(scene: Phaser.Scene): void {
  scene.cameras.main.fadeIn(250, 10, 9, 12);
}

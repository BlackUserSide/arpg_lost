import * as Phaser from 'phaser';

// Small UI kit for menus: dark-fantasy palette, buttons, panels, modal confirm.

export const UI = {
  gold: 0xe8c15a,
  goldText: '#e8c15a',
  text: '#e6e1d6',
  muted: '#8b8578',
  panel: 0x15141a,
  panelBorder: 0x3a3542,
  danger: 0x9b2c2c,
  primary: 0x7a5a1c,
  font: 'Georgia, "Times New Roman", serif',
};

export type ButtonStyle = 'primary' | 'secondary' | 'danger' | 'link';

export function makeButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  onClick: () => void,
  style: ButtonStyle = 'secondary',
): Phaser.GameObjects.Container {
  const fill = style === 'primary' ? UI.primary : style === 'danger' ? UI.danger : style === 'link' ? 0x000000 : 0x24222b;
  const border = style === 'primary' ? UI.gold : style === 'link' ? 0x000000 : UI.panelBorder;
  const bg = scene.add.rectangle(0, 0, w, h, fill, style === 'link' ? 0.001 : 1).setStrokeStyle(style === 'link' ? 0 : 2, border);
  const text = scene.add
    .text(0, 0, label, {
      fontFamily: UI.font,
      fontSize: style === 'link' ? '13px' : `${Math.round(h * 0.42)}px`,
      color: style === 'link' ? UI.goldText : UI.text,
    })
    .setOrigin(0.5);
  const button = scene.add.container(x, y, [bg, text]);
  bg.setInteractive({ useHandCursor: true })
    .on('pointerover', () => (style === 'link' ? text.setColor('#fff') : bg.setStrokeStyle(2, UI.gold)))
    .on('pointerout', () => (style === 'link' ? text.setColor(UI.goldText) : bg.setStrokeStyle(2, border)))
    .on('pointerup', onClick);
  return button;
}

export function makePanel(scene: Phaser.Scene, x: number, y: number, w: number, h: number, highlighted = false): Phaser.GameObjects.Rectangle {
  return scene.add.rectangle(x, y, w, h, UI.panel, 0.92).setStrokeStyle(2, highlighted ? UI.gold : UI.panelBorder);
}

export function label(scene: Phaser.Scene, x: number, y: number, text: string, size = 16, color = UI.text): Phaser.GameObjects.Text {
  return scene.add.text(x, y, text, { fontFamily: UI.font, fontSize: `${size}px`, color });
}

/** Modal yes/no dialog above everything; resolves via callbacks. */
export function confirmDialog(scene: Phaser.Scene, message: string, confirmLabel: string, onConfirm: () => void): void {
  const { width, height } = scene.scale;
  const shade = scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.65).setInteractive();
  const w = Math.min(420, width - 32);
  const panel = makePanel(scene, width / 2, height / 2, w, 170, true);
  const text = label(scene, width / 2, height / 2 - 40, message, 18).setOrigin(0.5).setWordWrapWidth(w - 32).setAlign('center');
  const close = (): void => {
    for (const obj of [shade, panel, text, yes, no]) obj.destroy();
  };
  const yes = makeButton(scene, width / 2 - 80, height / 2 + 40, 140, 40, confirmLabel, () => {
    close();
    onConfirm();
  }, 'danger');
  const no = makeButton(scene, width / 2 + 80, height / 2 + 40, 140, 40, 'Cancel', close);
  for (const obj of [shade, panel, text, yes, no]) obj.setDepth(1000);
}

/** Framed avatar from a loaded texture, or an initial letter when there is none. */
export function makeAvatar(scene: Phaser.Scene, x: number, y: number, size: number, textureKey: string | undefined, name: string): Phaser.GameObjects.Container {
  const frame = scene.add.rectangle(0, 0, size + 4, size + 4, UI.gold);
  const parts: Phaser.GameObjects.GameObject[] = [frame];
  if (textureKey && scene.textures.exists(textureKey)) {
    parts.push(scene.add.image(0, 0, textureKey).setDisplaySize(size, size));
  } else {
    parts.push(scene.add.rectangle(0, 0, size, size, 0x2a2633));
    parts.push(label(scene, 0, 0, (name[0] ?? '?').toUpperCase(), Math.round(size * 0.5), UI.goldText).setOrigin(0.5));
  }
  return scene.add.container(x, y, parts);
}

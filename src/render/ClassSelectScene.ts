import * as Phaser from 'phaser';
import { CLASS_LOOKS, loadSprites, spriteFrame, textureKey } from './sprites';

const CARD_W = 220;
const CARD_H = 300;

/** Pick a class before the run. Hub comes in M3; this is the minimal entry point. */
export class ClassSelectScene extends Phaser.Scene {
  constructor() {
    super('class-select');
  }

  preload(): void {
    loadSprites(this);
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0b0b10');
    const title = this.add.text(0, 0, 'Choose your class', { color: '#e8c15a', fontSize: '32px' }).setOrigin(0.5);
    const hint = this.add.text(0, 0, 'Click a card or press 1 / 2 / 3', { color: '#999', fontSize: '16px' }).setOrigin(0.5);

    const cards = CLASS_LOOKS.map((look, i) => {
      const container = this.add.container(0, 0);
      const bg = this.add.rectangle(0, 0, CARD_W, CARD_H, 0x1a1a22).setStrokeStyle(2, 0x444455);
      const sprite = this.add.sprite(0, -30, textureKey(look.sprite, 'idle'), spriteFrame(look.sprite, 'idle', 6, 0)).setScale(1.6);
      sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      const name = this.add.text(0, 70, look.name, { color: '#fff', fontSize: '24px' }).setOrigin(0.5);
      const desc = this.add.text(0, 110, look.description, { color: '#aaa', fontSize: '14px', align: 'center', wordWrap: { width: CARD_W - 24 } }).setOrigin(0.5, 0);
      const key = this.add.text(-CARD_W / 2 + 12, -CARD_H / 2 + 8, String(i + 1), { color: '#666', fontSize: '16px' });
      container.add([bg, sprite, name, desc, key]);
      bg.setInteractive({ useHandCursor: true })
        .on('pointerover', () => bg.setStrokeStyle(2, 0xe8c15a))
        .on('pointerout', () => bg.setStrokeStyle(2, 0x444455))
        .on('pointerdown', () => this.start(look.classId));
      return { container, sprite, look };
    });

    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      const index = Number(e.key) - 1;
      const card = cards[index];
      if (card) this.start(card.look.classId);
    });

    let time = 0;
    this.events.on('update', (_t: number, dt: number) => {
      time += dt / 1000;
      for (const card of cards) card.sprite.setFrame(spriteFrame(card.look.sprite, 'idle', 6, time));
    });

    const layout = (): void => {
      const { width, height } = this.scale;
      const compact = width < cards.length * (CARD_W + 24);
      const scale = compact ? Math.min(1, (width - 32) / (cards.length * (CARD_W + 16))) : 1;
      title.setPosition(width / 2, height / 2 - CARD_H * scale / 2 - 60);
      hint.setPosition(width / 2, height / 2 + CARD_H * scale / 2 + 40);
      cards.forEach((card, i) => {
        const offset = (i - (cards.length - 1) / 2) * (CARD_W + 24) * scale;
        card.container.setPosition(width / 2 + offset, height / 2).setScale(scale);
      });
    };
    layout();
    this.scale.on('resize', layout);
    this.events.once('shutdown', () => this.scale.off('resize', layout));
  }

  private start(classId: string): void {
    this.scene.start('iso-arena', { classId });
  }
}

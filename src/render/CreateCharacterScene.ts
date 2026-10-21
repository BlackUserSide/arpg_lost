import * as Phaser from 'phaser';
import { createCharacter, type CreateCharacterError } from '../core/progression/profile';
import { content } from '../data';
import { profileRules } from '../data/profile';
import { getApp } from './app';
import { CLASS_LOOKS, loadSprites, spriteFrame, textureKey } from './sprites';
import { label, makeButton, UI } from './ui';

const CARD_W = 200;
const CARD_H = 270;

const SUGGESTED_NAMES: Record<string, readonly string[]> = {
  warrior: ['Borin', 'Hilda', 'Garrick', 'Torvin'],
  ranger: ['Wren', 'Ashe', 'Kestrel', 'Rook'],
  mage: ['Elowen', 'Mordecai', 'Ysolde', 'Zarek'],
};

const ERRORS: Record<CreateCharacterError, string> = {
  limit: `You can have up to ${profileRules.maxCharacters} characters.`,
  'name-length': `Name must be ${profileRules.nameMinLength}–${profileRules.nameMaxLength} characters.`,
  'name-chars': 'Use letters, digits, spaces, "-" or "_".',
  'unknown-class': 'Pick a class.',
};

function pickName(classId: string): string {
  const names = SUGGESTED_NAMES[classId] ?? ['Hero'];
  return names[Math.floor(Math.random() * names.length)] ?? 'Hero';
}

/** Pick a class and a name. The name field is a DOM input so mobile keyboards work. */
export class CreateCharacterScene extends Phaser.Scene {
  private classId = 'warrior';
  private nameInput: HTMLInputElement | undefined;
  private nameEdited = false;
  private time0 = 0;
  private cardSprites: Array<{ sprite: Phaser.GameObjects.Sprite; set: string }> = [];

  constructor() {
    super('create-character');
  }

  preload(): void {
    loadSprites(this);
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0b0a0e');
    this.classId = CLASS_LOOKS[0]?.classId ?? 'warrior';
    this.nameEdited = false;
    this.cardSprites = [];
    const input = this.createNameInput();

    const title = label(this, 0, 0, 'New character', 30, UI.goldText).setOrigin(0.5);
    const error = label(this, 0, 0, '', 15, '#e06c6c').setOrigin(0.5);
    const cards = CLASS_LOOKS.map((look, i) => {
      const bg = this.add.rectangle(0, 0, CARD_W, CARD_H, UI.panel).setStrokeStyle(2, UI.panelBorder);
      const sprite = this.add.sprite(0, -40, textureKey(look.sprite, 'idle'), 0).setScale(1.5);
      sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.cardSprites.push({ sprite, set: look.sprite });
      const name = label(this, 0, 50, look.name, 22).setOrigin(0.5);
      const desc = label(this, 0, 82, look.description, 13, UI.muted).setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(CARD_W - 24);
      const key = label(this, -CARD_W / 2 + 10, -CARD_H / 2 + 6, String(i + 1), 14, UI.muted);
      const container = this.add.container(0, 0, [bg, sprite, name, desc, key]);
      bg.setInteractive({ useHandCursor: true }).on('pointerup', () => select(look.classId));
      return { container, bg, look };
    });

    const select = (classId: string): void => {
      this.classId = classId;
      for (const card of cards) card.bg.setStrokeStyle(2, card.look.classId === classId ? UI.gold : UI.panelBorder);
      if (!this.nameEdited) input.value = pickName(classId);
      error.setText('');
    };
    select(this.classId);

    const create = (): void => {
      const app = getApp(this);
      const result = createCharacter(app.profile, { name: input.value, classId: this.classId }, profileRules, Object.keys(content.classes));
      if (!result.ok) {
        error.setText(ERRORS[result.error]);
        return;
      }
      app.selectedCharacterId = result.character.id;
      app.save();
      this.scene.start('main-menu');
    };
    const createButton = makeButton(this, 0, 0, 200, 48, 'Create', create, 'primary');
    const backButton = makeButton(this, 0, 0, 120, 40, 'Back', () => this.scene.start('main-menu'));

    // Typing must not trigger game shortcuts.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') create();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('input', () => (this.nameEdited = true));

    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (document.activeElement === input) return;
      const look = CLASS_LOOKS[Number(e.key) - 1];
      if (look) select(look.classId);
      if (e.key === 'Escape') this.scene.start('main-menu');
    });

    const layout = (): void => {
      const { width, height } = this.scale;
      const scale = Math.min(1, (width - 24) / (cards.length * (CARD_W + 16)));
      const cardsY = height / 2 - 40;
      title.setPosition(width / 2, cardsY - (CARD_H * scale) / 2 - 40);
      cards.forEach((card, i) => {
        const offset = (i - (cards.length - 1) / 2) * (CARD_W + 16) * scale;
        card.container.setPosition(width / 2 + offset, cardsY).setScale(scale);
      });
      const formY = cardsY + (CARD_H * scale) / 2 + 40;
      this.positionInput(width / 2 - 110, formY - 20, 220, 40);
      createButton.setPosition(width / 2, formY + 68);
      backButton.setPosition(width / 2, formY + 124);
      error.setPosition(width / 2, formY + 34);
    };
    layout();
    this.scale.on('resize', layout);
    this.events.once('shutdown', () => {
      this.scale.off('resize', layout);
      this.nameInput?.remove();
      this.nameInput = undefined;
    });
  }

  override update(_t: number, dtMs: number): void {
    this.time0 += dtMs / 1000;
    for (const { sprite, set } of this.cardSprites) sprite.setFrame(spriteFrame(set, 'idle', 6, this.time0));
  }

  private createNameInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = profileRules.nameMaxLength;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Character name');
    Object.assign(input.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      background: '#15141a',
      color: '#e6e1d6',
      border: '2px solid #3a3542',
      font: '18px Georgia, serif',
      textAlign: 'center',
      outline: 'none',
      zIndex: '10',
    });
    input.addEventListener('focus', () => (input.style.borderColor = '#e8c15a'));
    input.addEventListener('blur', () => (input.style.borderColor = '#3a3542'));
    document.body.appendChild(input);
    this.nameInput = input;
    return input;
  }

  /** Places the DOM input over canvas coordinates. */
  private positionInput(x: number, y: number, w: number, h: number): void {
    if (!this.nameInput) return;
    const rect = this.game.canvas.getBoundingClientRect();
    const sx = rect.width / this.scale.width;
    const sy = rect.height / this.scale.height;
    Object.assign(this.nameInput.style, {
      left: `${rect.left + window.scrollX + x * sx}px`,
      top: `${rect.top + window.scrollY + y * sy}px`,
      width: `${w * sx}px`,
      height: `${h * sy}px`,
    });
  }
}

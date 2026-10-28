import * as Phaser from 'phaser';
import { createCharacter, type CreateCharacterError } from '../core/progression/profile';
import { content } from '../data';
import { profileRules } from '../data/profile';
import { t, type MessageKey } from '../i18n';
import { getApp } from './app';
import { classDescription, className } from './contentText';
import { BODY_FONT } from './fonts';
import { MenuBackdrop, preloadBackdrop } from './menuBackdrop';
import { CLASS_LOOKS, HERO_SETS, loadSprites, ORIGIN_Y, spriteFrame, textureKey } from './sprites';
import { densityOf, fadeIn, heading, label, makeButton, makeCard, makeFrame, UI } from './ui';

const SUGGESTED_NAMES: Record<string, readonly string[]> = {
  warrior: ['Borin', 'Hilda', 'Garrick', 'Torvin'],
  ranger: ['Wren', 'Ashe', 'Kestrel', 'Rook'],
  mage: ['Elowen', 'Mordecai', 'Ysolde', 'Zarek'],
};

const ERROR_KEY: Readonly<Record<CreateCharacterError, MessageKey>> = {
  limit: 'create.error.limit',
  'name-length': 'create.error.nameLength',
  'name-chars': 'create.error.nameChars',
  'unknown-class': 'create.error.unknownClass',
};

const errorText = (error: CreateCharacterError): string =>
  t(ERROR_KEY[error], { max: error === 'limit' ? profileRules.maxCharacters : profileRules.nameMaxLength, min: profileRules.nameMinLength });

function pickName(classId: string): string {
  const names = SUGGESTED_NAMES[classId] ?? ['Hero'];
  return names[Math.floor(Math.random() * names.length)] ?? 'Hero';
}

/** Choose a class (previewed by the campfire) and a name. The name field is a DOM input for mobile keyboards. */
export class CreateCharacterScene extends Phaser.Scene {
  private classId = 'warrior';
  private nameInput: HTMLInputElement | undefined;
  private nameEdited = false;
  private errorText = '';
  private backdrop!: MenuBackdrop;
  private root!: Phaser.GameObjects.Container;

  constructor() {
    super('create-character');
  }

  preload(): void {
    loadSprites(this, HERO_SETS);
    preloadBackdrop(this);
  }

  create(): void {
    this.cameras.main.setBackgroundColor(UI.bg);
    this.classId = CLASS_LOOKS[0]?.classId ?? 'warrior';
    this.nameEdited = false;
    this.errorText = '';
    this.backdrop = new MenuBackdrop(this);
    const input = this.createNameInput();
    input.value = pickName(this.classId);

    input.addEventListener('keydown', (e) => {
      // Typing must not trigger game shortcuts.
      e.stopPropagation();
      if (e.key === 'Enter') this.submit();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('input', () => (this.nameEdited = true));
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (document.activeElement === input) return;
      const look = CLASS_LOOKS[Number(e.key) - 1];
      if (look) this.select(look.classId);
      if (e.key === 'Escape') this.back();
    });

    this.build();
    fadeIn(this);
    const rebuild = (): void => this.build();
    this.scale.on('resize', rebuild);
    this.events.once('shutdown', () => {
      this.scale.off('resize', rebuild);
      this.nameInput?.remove();
      this.nameInput = undefined;
    });
  }

  override update(_t: number, dtMs: number): void {
    this.backdrop.update(dtMs / 1000);
  }

  private select(classId: string): void {
    this.classId = classId;
    if (this.nameInput && !this.nameEdited) this.nameInput.value = pickName(classId);
    this.errorText = '';
    this.build();
  }

  private build(): void {
    this.root?.destroy();
    this.root = this.add.container(0, 0);
    const { width, height } = this.scale;
    const compact = width < 820 || height < 520;
    // Phones: the hub's title and edge sizes (MainMenuScene), a slimmer name field and buttons.
    const phone = densityOf(width, height, compact) === 'phone';
    const edge = phone ? 8 : compact ? 12 : 28;
    const panelW = compact ? Math.min(300, width * 0.48) : 380;
    const panelX = width - panelW / 2 - edge;
    const sceneW = width - panelW - edge * 2;

    this.backdrop.layout(sceneW * 0.55, height * 0.62, width, height);
    this.backdrop.setHero(CLASS_LOOKS.find((l) => l.classId === this.classId)?.sprite);
    this.root.add(heading(this, phone ? 12 : compact ? 16 : 32, phone ? 6 : compact ? 10 : 22, t('create.title'), phone ? 24 : compact ? 30 : UI.size.display));

    const top = edge;
    const bottom = height - top;
    this.root.add(makeFrame(this, panelX, (top + bottom) / 2, panelW, bottom - top, 'panel'));
    this.root.add(heading(this, panelX - panelW / 2 + 18, top + 10, t('create.chooseClass'), compact ? 18 : 22));

    const rowW = panelW - 24;
    const rowH = compact ? Math.max(44, Math.min(66, (bottom - top - 200) / 3)) : 92;
    let y = top + (compact ? 44 : 58) + rowH / 2;
    for (const [i, look] of CLASS_LOOKS.entries()) {
      const isSelected = look.classId === this.classId;
      this.root.add(makeCard(this, panelX, y, rowW, rowH, isSelected, () => this.select(look.classId)));
      const left = panelX - rowW / 2;
      const portrait = this.add
        .sprite(left + rowH * 0.5, y + rowH / 2 - 6, textureKey(look.sprite, 'idle'), spriteFrame(look.sprite, 'idle', 6, 0))
        .setOrigin(0.5, ORIGIN_Y)
        .setScale((rowH - 10) / 66);
      portrait.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.root.add(portrait);
      const textX = left + rowH + 4;
      this.root.add(label(this, textX, y - rowH / 2 + (compact ? 6 : 12), className(look.classId), compact ? UI.size.body : UI.size.heading, isSelected ? UI.goldBrightText : UI.text, true));
      if (rowH >= 56) {
        this.root.add(label(this, textX, y - rowH / 2 + (compact ? 28 : 40), classDescription(look.classId), UI.size.small, UI.muted).setWordWrapWidth(rowW - rowH - 16));
      }
      this.root.add(label(this, panelX + rowW / 2 - 12, y - rowH / 2 + 8, String(i + 1), 12, UI.muted).setOrigin(1, 0));
      y += rowH + (compact ? 6 : 10);
    }

    const nameTop = y - rowH / 2 + (compact ? 2 : 8);
    this.root.add(label(this, panelX - rowW / 2, nameTop, t('create.name'), UI.size.small, UI.muted));
    const inputY = nameTop + 22;
    const inputH = phone ? 34 : compact ? 36 : 42;
    this.positionInput(panelX - rowW / 2, inputY, rowW, inputH);
    if (this.errorText) this.root.add(label(this, panelX, inputY + inputH + 8, this.errorText, UI.size.small, UI.danger).setOrigin(0.5, 0));

    const buttonH = phone ? 38 : compact ? 42 : 52;
    const buttonsY = bottom - (phone ? 29 : compact ? 32 : 44);
    this.root.add(makeButton(this, panelX + rowW / 4 + 6, buttonsY, rowW / 2 - 6, buttonH, t('create.create'), () => this.submit(), 'primary'));
    this.root.add(makeButton(this, panelX - rowW / 4 - 6, buttonsY, rowW / 2 - 6, buttonH, t('common.back'), () => this.back()));
  }

  private submit(): void {
    const app = getApp(this);
    const result = createCharacter(app.profile, { name: this.nameInput?.value ?? '', classId: this.classId }, profileRules, Object.keys(content.classes));
    if (!result.ok) {
      this.errorText = errorText(result.error);
      this.build();
      return;
    }
    app.selectedCharacterId = result.character.id;
    app.save();
    this.back();
  }

  private back(): void {
    this.nameInput?.blur();
    this.scene.start('main-menu');
  }

  private createNameInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = profileRules.nameMaxLength;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', t('create.nameLabel'));
    Object.assign(input.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      background: 'linear-gradient(#0d0a0e, #1a1519)',
      color: UI.text,
      border: '2px solid #8a6a32',
      borderRadius: '2px',
      boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.8)',
      font: `bold 18px ${BODY_FONT}`,
      padding: '0 12px',
      outline: 'none',
      zIndex: '10',
    });
    input.addEventListener('focus', () => (input.style.borderColor = '#f3d58a'));
    input.addEventListener('blur', () => (input.style.borderColor = '#8a6a32'));
    // Inside the game container (not body): in full screen only the shell around it is shown (scale fullscreenTarget).
    // The container blocks text selection and touch gestures for the game: the input opts back in.
    Object.assign(input.style, { userSelect: 'text', webkitUserSelect: 'text', touchAction: 'manipulation' });
    (this.game.canvas.parentElement ?? document.body).appendChild(input);
    this.nameInput = input;
    return input;
  }

  /** Places the DOM input over canvas coordinates (relative to its positioned container). */
  private positionInput(x: number, y: number, w: number, h: number): void {
    if (!this.nameInput) return;
    const rect = this.game.canvas.getBoundingClientRect();
    const host = this.nameInput.offsetParent ?? document.body;
    const hostRect = host.getBoundingClientRect();
    const sx = rect.width / this.scale.width;
    const sy = rect.height / this.scale.height;
    Object.assign(this.nameInput.style, {
      left: `${rect.left - hostRect.left - host.clientLeft + x * sx}px`,
      top: `${rect.top - hostRect.top - host.clientTop + y * sy}px`,
      width: `${w * sx}px`,
      height: `${h * sy}px`,
    });
  }
}

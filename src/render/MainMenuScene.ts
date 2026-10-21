import * as Phaser from 'phaser';
import { deleteCharacter, findCharacter, type CharacterRecord } from '../core/progression/profile';
import { profileRules } from '../data/profile';
import { getApp, type App } from './app';
import { CLASS_LOOKS, loadSprites, spriteFrame, textureKey } from './sprites';
import { confirmDialog, label, makeAvatar, makeButton, makePanel, UI } from './ui';

const AVATAR_KEY = 'user-avatar';

/** Hub entry: account widget, character slots, records, play. */
export class MainMenuScene extends Phaser.Scene {
  private app!: App;
  private root!: Phaser.GameObjects.Container;
  private idleSprites: Array<{ sprite: Phaser.GameObjects.Sprite; set: string }> = [];
  private time0 = 0;

  constructor() {
    super('main-menu');
  }

  preload(): void {
    this.app = getApp(this);
    this.app.platform.loadingStart();
    loadSprites(this);
    const avatar = this.app.user?.avatarUrl;
    if (avatar && !this.textures.exists(AVATAR_KEY)) {
      this.load.setCORS('anonymous');
      this.load.image(AVATAR_KEY, avatar);
    }
  }

  create(): void {
    this.app.platform.loadingStop();
    this.cameras.main.setBackgroundColor('#0b0a0e');
    this.build();
    const rebuild = (): void => this.build();
    this.scale.on('resize', rebuild);
    const onAuth = (): void => {
      // Fresh identity and possibly cloud-synced data: restart to reload avatar and profile.
      this.app.reloadProfile();
      this.scene.restart();
    };
    this.game.events.on('auth-changed', onAuth);
    this.events.once('shutdown', () => {
      this.scale.off('resize', rebuild);
      this.game.events.off('auth-changed', onAuth);
    });
  }

  override update(_t: number, dtMs: number): void {
    this.time0 += dtMs / 1000;
    for (const { sprite, set } of this.idleSprites) sprite.setFrame(spriteFrame(set, 'idle', 6, this.time0));
  }

  private build(): void {
    this.root?.destroy();
    this.idleSprites = [];
    this.root = this.add.container(0, 0);
    const { width, height } = this.scale;
    const compact = width < 760;

    this.root.add(label(this, 20, 18, 'ARPG Lost', compact ? 24 : 32, UI.goldText));
    this.buildAccountWidget(width);

    const characters = this.app.profile.characters;
    if (!findCharacter(this.app.profile, this.app.selectedCharacterId ?? '')) this.app.selectedCharacterId = characters[0]?.id;

    // Character slots: one row on desktop, two columns on narrow screens.
    const slots = profileRules.maxCharacters;
    const cardW = compact ? Math.min(160, (width - 48) / 2) : Math.min(170, (width - 80) / slots);
    const cardH = compact ? 150 : 210;
    const cols = compact ? 2 : slots;
    const top = compact ? 90 : 120;
    for (let i = 0; i < slots; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = width / 2 + (col - (cols - 1) / 2) * (cardW + 12);
      const y = top + cardH / 2 + row * (cardH + 12);
      const character = characters[i];
      if (character) this.buildCharacterCard(character, x, y, cardW, cardH);
      else if (i === characters.length) this.buildEmptySlot(x, y, cardW, cardH, true);
      else this.buildEmptySlot(x, y, cardW, cardH, false);
    }

    const rows = Math.ceil(slots / cols);
    const actionsY = top + rows * (cardH + 12) + 30;
    const selected = findCharacter(this.app.profile, this.app.selectedCharacterId ?? '');
    if (selected) {
      this.root.add(makeButton(this, width / 2, actionsY, 220, 52, `Play — ${selected.name}`, () => this.play(selected.id), 'primary'));
      this.root.add(
        makeButton(this, width / 2 + 170, actionsY, 90, 32, 'Delete', () =>
          confirmDialog(this, `Delete ${selected.name}? This cannot be undone.`, 'Delete', () => {
            deleteCharacter(this.app.profile, selected.id);
            this.app.save();
            this.build();
          }), 'danger'),
      );
    } else {
      this.root.add(label(this, width / 2, actionsY, 'Create a character to start', 18, UI.muted).setOrigin(0.5));
    }

    this.buildRecords(20, Math.min(height - 120, actionsY + 50));
    this.buildLoginHint(width, height);
  }

  private buildAccountWidget(width: number): void {
    const { user, platform } = this.app;
    const name = user?.username ?? 'Guest';
    const x = width - 20;
    this.root.add(makeAvatar(this, x - 20, 34, 36, user ? AVATAR_KEY : undefined, name));
    this.root.add(label(this, x - 48, 20, name, 18).setOrigin(1, 0));
    if (!user && platform.isLoginAvailable()) {
      // Login is offered, never forced and never the main call to action.
      this.root.add(makeButton(this, x - 120, 62, 180, 22, 'Log in with CrazyGames', () => void this.login(), 'link'));
    }
  }

  private buildCharacterCard(character: CharacterRecord, x: number, y: number, w: number, h: number): void {
    const selected = character.id === this.app.selectedCharacterId;
    const look = CLASS_LOOKS.find((l) => l.classId === character.classId);
    const card = makePanel(this, x, y, w, h, selected).setInteractive({ useHandCursor: true });
    card.on('pointerup', () => {
      // Second click on the selected card starts the run.
      if (this.app.selectedCharacterId === character.id) {
        this.play(character.id);
        return;
      }
      this.app.selectedCharacterId = character.id;
      this.build();
    });
    this.root.add(card);
    if (look) {
      const sprite = this.add.sprite(x, y - h * 0.12, textureKey(look.sprite, 'idle'), 0).setScale(h > 180 ? 1.2 : 0.9);
      sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.idleSprites.push({ sprite, set: look.sprite });
      this.root.add(sprite);
    }
    this.root.add(label(this, x, y + h * 0.22, character.name, 18, selected ? UI.goldText : UI.text).setOrigin(0.5));
    this.root.add(label(this, x, y + h * 0.36, `${look?.name ?? character.classId} · lvl ${character.level}`, 13, UI.muted).setOrigin(0.5));
  }

  private buildEmptySlot(x: number, y: number, w: number, h: number, canCreate: boolean): void {
    const panel = this.add.rectangle(x, y, w, h, 0x000000, 0.25).setStrokeStyle(1, UI.panelBorder);
    this.root.add(panel);
    if (!canCreate) return;
    panel.setInteractive({ useHandCursor: true }).on('pointerup', () => this.scene.start('create-character'));
    this.root.add(label(this, x, y - 8, '+', 40, UI.goldText).setOrigin(0.5));
    this.root.add(label(this, x, y + 30, 'New character', 14, UI.muted).setOrigin(0.5));
  }

  private buildRecords(x: number, y: number): void {
    const r = this.app.profile.records;
    const time = r.bestClearTime === null ? '—' : `${Math.floor(r.bestClearTime / 60)}:${String(Math.floor(r.bestClearTime % 60)).padStart(2, '0')}`;
    this.root.add(label(this, x, y, 'Records', 16, UI.goldText));
    this.root.add(
      label(this, x, y + 24, `Best map level ${r.bestMapLevel || '—'}   Bosses ${r.bossKills}   Best clear ${time}   Most kills ${r.mostKillsInRun}`, 14, UI.muted),
    );
  }

  private buildLoginHint(width: number, height: number): void {
    const { app } = this;
    if (app.user || app.loginHint !== 'pending' || !app.platform.isLoginAvailable()) return;
    app.loginHint = 'shown';
    const w = Math.min(560, width - 24);
    const y = height - 40;
    const panel = makePanel(this, width / 2, y, w, 52, true);
    const text = label(this, width / 2 - w / 2 + 16, y, 'Log in to keep your progress on every device.', 15).setOrigin(0, 0.5);
    const login = makeButton(this, width / 2 + w / 2 - 120, y, 90, 32, 'Log in', () => void this.login(), 'primary');
    const close = makeButton(this, width / 2 + w / 2 - 30, y, 32, 32, '×', () => {
      for (const obj of [panel, text, login, close]) obj.destroy();
    });
    this.root.add([panel, text, login, close]);
  }

  /** The platform's auth listener (wired in main.ts) handles the result. */
  private async login(): Promise<void> {
    await this.app.platform.showLogin();
  }

  private play(characterId: string): void {
    this.app.selectedCharacterId = characterId;
    this.scene.start('iso-arena', { characterId });
  }
}

import * as Phaser from 'phaser';
import { deleteCharacter, findCharacter, type CharacterRecord } from '../core/progression/profile';
import { profileRules } from '../data/profile';
import { getApp, type App } from './app';
import { MenuBackdrop, preloadBackdrop } from './menuBackdrop';
import { CLASS_LOOKS, loadSprites, ORIGIN_Y, textureKey } from './sprites';
import { confirmDialog, fadeIn, heading, label, makeAvatar, makeButton, makeCard, makeFrame, UI } from './ui';

const AVATAR_KEY = 'user-avatar';

/** Hub entry: hero by the campfire, character list, account widget, records, play. */
export class MainMenuScene extends Phaser.Scene {
  private app!: App;
  private root!: Phaser.GameObjects.Container;
  private backdrop!: MenuBackdrop;

  constructor() {
    super('main-menu');
  }

  preload(): void {
    this.app = getApp(this);
    this.app.platform.loadingStart();
    loadSprites(this);
    preloadBackdrop(this);
    const avatar = this.app.user?.avatarUrl;
    if (avatar && !this.textures.exists(AVATAR_KEY)) {
      this.load.setCORS('anonymous');
      this.load.image(AVATAR_KEY, avatar);
    }
  }

  create(): void {
    this.app.platform.loadingStop();
    this.cameras.main.setBackgroundColor(UI.bg);
    this.backdrop = new MenuBackdrop(this);
    this.build();
    fadeIn(this);

    const rebuild = (): void => this.build();
    this.scale.on('resize', rebuild);
    const onAuth = (): void => {
      // New identity and possibly cloud-synced data: reload profile and avatar.
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
    this.backdrop.update(dtMs / 1000);
  }

  private build(): void {
    this.root?.destroy();
    this.root = this.add.container(0, 0);
    const { width, height } = this.scale;
    const compact = width < 820 || height < 520;

    const characters = this.app.profile.characters;
    if (!findCharacter(this.app.profile, this.app.selectedCharacterId ?? '')) this.app.selectedCharacterId = characters[0]?.id;
    const selected = findCharacter(this.app.profile, this.app.selectedCharacterId ?? '');

    // Right column: character list. Left area: campfire scene, title, play.
    const listW = compact ? Math.min(250, width * 0.4) : 320;
    const listX = width - listW / 2 - (compact ? 12 : 28);
    const sceneW = width - listW - (compact ? 24 : 56);

    this.backdrop.layout(sceneW * 0.55, height * (compact ? 0.6 : 0.62), width, height);
    this.backdrop.setHero(selected ? CLASS_LOOKS.find((l) => l.classId === selected.classId)?.sprite : undefined);

    this.root.add(heading(this, compact ? 16 : 32, compact ? 10 : 22, 'ARPG Lost', compact ? 30 : UI.size.display));
    this.buildAccountWidget(width, compact);
    this.buildCharacterList(listX, listW, compact ? 72 : 104, height - (compact ? 12 : 28), compact);

    const playY = height - (compact ? 40 : 64);
    if (selected) {
      this.root.add(makeButton(this, sceneW / 2, playY, compact ? 200 : 260, compact ? 48 : 60, 'Enter the dungeon', () => this.play(selected.id), 'primary'));
      const playW = compact ? 200 : 260;
      const invW = compact ? 110 : 150;
      this.root.add(makeButton(this, sceneW / 2 - playW / 2 - 12 - invW / 2, playY, invW, compact ? 40 : 48, 'Inventory', () => this.scene.start('inventory', { characterId: selected.id })));
      this.root.add(label(this, sceneW / 2, playY - (compact ? 38 : 50), selected.name, compact ? UI.size.body : UI.size.heading, UI.goldBrightText, true).setOrigin(0.5));
    } else {
      this.root.add(label(this, sceneW / 2, playY, 'Create a character to begin', UI.size.heading, UI.muted).setOrigin(0.5));
    }
    if (!compact) this.buildRecords(32, 92);
    this.buildLoginHint(sceneW, compact);
    this.root.add(label(this, 12, height - 8, `v${__APP_VERSION__}`, 12, UI.muted).setOrigin(0, 1).setAlpha(0.6));
  }

  private buildAccountWidget(width: number, compact: boolean): void {
    const { user, platform } = this.app;
    const name = user?.username ?? 'Guest';
    const size = compact ? 30 : 38;
    const right = width - (compact ? 12 : 28);
    const y = compact ? 30 : 44;
    this.root.add(makeAvatar(this, right - size / 2, y, size, user ? AVATAR_KEY : undefined, name));
    const nameText = label(this, right - size - 14, y - (user ? 10 : 18), name, compact ? UI.size.small : UI.size.body, UI.text, true).setOrigin(1, 0);
    this.root.add(nameText);
    if (!user && platform.isLoginAvailable()) {
      // Offered, never forced and never the main call to action (CrazyGames rules).
      const link = makeButton(this, 0, 0, 10, 24, 'Log in with CrazyGames', () => void this.login(), 'link');
      const linkText = link.list[1] as Phaser.GameObjects.Text;
      link.setPosition(right - size - 14 - linkText.width / 2, y + 14);
      this.root.add(link);
    }
  }

  private buildCharacterList(x: number, w: number, top: number, bottom: number, compact: boolean): void {
    const characters = this.app.profile.characters;
    const slots = profileRules.maxCharacters;
    const rowH = compact ? 50 : 72;
    const gap = compact ? 6 : 10;
    const rows = Math.min(slots, characters.length + 1);
    const headerH = compact ? 28 : 40;
    const panelH = Math.min(bottom - top, headerH + rows * (rowH + gap) + 16);
    this.root.add(makeFrame(this, x, top + panelH / 2, w, panelH, 'panel'));
    this.root.add(heading(this, x - w / 2 + 18, top + 8, 'Characters', compact ? 18 : 22));
    this.root.add(label(this, x + w / 2 - 18, top + (compact ? 10 : 14), `${characters.length}/${slots}`, UI.size.small, UI.muted).setOrigin(1, 0));

    let y = top + headerH + rowH / 2 + 4;
    for (const character of characters) {
      this.buildCharacterRow(character, x, y, w - 24, rowH, compact);
      y += rowH + gap;
    }
    if (characters.length < slots) {
      const card = makeCard(this, x, y, w - 24, rowH, false, () => this.scene.start('create-character'));
      this.root.add(card);
      this.root.add(heading(this, x - (w - 24) / 2 + 26, y, '+', compact ? 24 : 30).setOrigin(0.5));
      this.root.add(label(this, x - (w - 24) / 2 + 48, y, 'Create new hero', compact ? UI.size.small : UI.size.body, UI.goldText).setOrigin(0, 0.5));
    }
  }

  private buildCharacterRow(character: CharacterRecord, x: number, y: number, w: number, h: number, compact: boolean): void {
    const isSelected = character.id === this.app.selectedCharacterId;
    const look = CLASS_LOOKS.find((l) => l.classId === character.classId);
    this.root.add(
      makeCard(this, x, y, w, h, isSelected, () => {
        if (isSelected) {
          this.play(character.id);
          return;
        }
        this.app.selectedCharacterId = character.id;
        this.build();
      }),
    );
    const left = x - w / 2;
    if (look) {
      // Portrait: front-facing idle frame, cropped by the row height.
      const portrait = this.add
        .sprite(left + h * 0.5, y + h / 2 - 6, textureKey(look.sprite, 'idle'), 6 * 4)
        .setOrigin(0.5, ORIGIN_Y)
        .setScale((h - 10) / 66);
      portrait.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.root.add(portrait);
    }
    const textX = left + h + 6;
    this.root.add(label(this, textX, y - (compact ? 16 : 20), character.name, compact ? UI.size.body : UI.size.heading - 2, isSelected ? UI.goldBrightText : UI.text, true));
    this.root.add(label(this, textX, y + (compact ? 2 : 6), `${look?.name ?? character.classId} · level ${character.level}`, UI.size.small, UI.muted));
    if (isSelected) {
      const del = makeButton(this, x + w / 2 - (compact ? 22 : 28), y, compact ? 32 : 40, compact ? 32 : 40, '✕', () =>
        confirmDialog(this, `Delete ${character.name}?\nThis cannot be undone.`, 'Delete', () => {
          deleteCharacter(this.app.profile, character.id);
          this.app.save();
          this.build();
        }), 'danger');
      this.root.add(del);
    }
  }

  private buildRecords(x: number, y: number): void {
    const r = this.app.profile.records;
    const time = r.bestClearTime === null ? '—' : `${Math.floor(r.bestClearTime / 60)}:${String(Math.floor(r.bestClearTime % 60)).padStart(2, '0')}`;
    const lines = [
      ['Best map level', r.bestMapLevel ? String(r.bestMapLevel) : '—'],
      ['Bosses slain', String(r.bossKills)],
      ['Fastest clear', time],
      ['Most kills in a run', String(r.mostKillsInRun)],
    ];
    lines.forEach(([name, value], i) => {
      this.root.add(label(this, x, y + i * 22, name ?? '', UI.size.small, UI.muted));
      this.root.add(label(this, x + 150, y + i * 22, value ?? '', UI.size.small, UI.text, true));
    });
  }

  private buildLoginHint(sceneW: number, compact: boolean): void {
    const { app } = this;
    if (app.user || app.loginHint !== 'pending' || !app.platform.isLoginAvailable()) return;
    app.loginHint = 'shown';
    const w = Math.min(460, sceneW - 24);
    const h = compact ? 52 : 60;
    const y = compact ? 82 : 110;
    const x = sceneW / 2;
    const panel = makeFrame(this, x, y, w, h, 'panel');
    const text = label(this, x - w / 2 + 18, y, 'Log in to keep your heroes\non every device.', UI.size.small, UI.text).setOrigin(0, 0.5);
    const login = makeButton(this, x + w / 2 - 100, y, 96, 36, 'Log in', () => void this.login(), 'primary');
    const close = makeButton(this, x + w / 2 - 30, y, 36, 36, '✕', () => {
      this.tweens.add({ targets: [panel, text, login, close], alpha: 0, duration: 150, onComplete: () => [panel, text, login, close].forEach((o) => o.destroy()) });
    });
    for (const o of [panel, text, login, close]) o.setAlpha(0);
    this.tweens.add({ targets: [panel, text, login, close], alpha: 1, duration: 300, delay: 400 });
    this.root.add([panel, text, login, close]);
  }

  /** The platform's auth listener (wired in main.ts) handles the result. */
  private async login(): Promise<void> {
    await this.app.platform.showLogin();
  }

  private play(characterId: string): void {
    this.app.selectedCharacterId = characterId;
    this.cameras.main.fadeOut(200, 10, 9, 12);
    this.cameras.main.once('camerafadeoutcomplete', () => this.scene.start('iso-arena', { characterId }));
  }
}

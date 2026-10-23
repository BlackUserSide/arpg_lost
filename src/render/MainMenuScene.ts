import * as Phaser from 'phaser';
import { unspentPoints } from '../core/passives/allocation';
import { deleteCharacter, findCharacter, type CharacterRecord } from '../core/progression/profile';
import { passiveTree } from '../data/passives';
import { profileRules } from '../data/profile';
import { getLocale, LOCALE_NAMES, LOCALES, t, type Locale } from '../i18n';
import { getApp, type App } from './app';
import { className } from './contentText';
import { loadGlyphs } from './fonts';
import { MenuBackdrop, preloadBackdrop } from './menuBackdrop';
import { PointsBanner } from './passiveBanner';
import type { PassiveTreeSceneData } from './PassiveTreeScene';
import type { SupportsSceneData } from './SupportsScene';
import { CLASS_LOOKS, loadSprites, ORIGIN_Y, spriteFrame, textureKey } from './sprites';
import { confirmDialog, fadeIn, fitText, heading, label, makeAvatar, makeButton, makeCard, makeFrame, UI } from './ui';

const AVATAR_KEY = 'user-avatar';

/** Hub entry: hero by the campfire, character list, account widget, records, play. */
export class MainMenuScene extends Phaser.Scene {
  private app!: App;
  private root!: Phaser.GameObjects.Container;
  private backdrop!: MenuBackdrop;
  /** Language list open under the switcher. */
  private languageOpen = false;
  /** A language switch (or the list's fonts) is loading: the switcher ignores taps until it is done. */
  private languageBusy = false;

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
    this.languageOpen = false;
    this.languageBusy = false;
    this.build();
    fadeIn(this);

    const rebuild = (): void => this.build();
    this.scale.on('resize', rebuild);
    const onAuth = (): void => {
      // New identity and possibly cloud-synced data (a saved language too): reload, and restart only once that
      // language's fonts are in, so no fallback glyphs get baked.
      void this.app.reloadProfile().then(() => {
        if (this.scene.isActive()) this.scene.restart();
      });
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

    const title = heading(this, compact ? 16 : 32, compact ? 10 : 22, 'ARPG Lost', compact ? 30 : UI.size.display);
    this.root.add(title);
    this.buildAccountWidget(width, compact);
    this.buildCharacterList(listX, listW, compact ? 72 : 104, height - (compact ? 12 : 28), compact);

    const playY = height - (compact ? 40 : 64);
    if (selected) {
      const playW = compact ? 200 : 260;
      const playH = compact ? 48 : 60;
      const sideW = compact ? 108 : 150;
      const modW = compact ? 120 : 160;
      const sideH = compact ? 40 : 48;
      const gap = compact ? 8 : 12;
      // Room left of the character list (phones in landscape have far less than the one-row layout needs).
      const room = sceneW - (compact ? 16 : 32);
      const rowW = sideW * 2 + modW + playW + gap * 3;
      const openInventory = (): void => {
        this.scene.start('inventory', { characterId: selected.id });
      };
      let playX: number;
      let nameY: number;
      if (rowW <= room) {
        // [Inventory] [Enter] [Talents] [Supports]: the build screens side by side, the row centred as a whole.
        const rowLeft = sceneW / 2 - rowW / 2;
        playX = rowLeft + sideW + gap + playW / 2;
        this.root.add(makeButton(this, playX, playY, playW, playH, t('menu.play'), () => this.play(selected.id), 'primary'));
        this.root.add(makeButton(this, rowLeft + sideW / 2, playY, sideW, sideH, t('menu.inventory'), openInventory));
        const talentsX = playX + playW / 2 + gap + sideW / 2;
        this.root.add(makeButton(this, talentsX, playY, sideW, sideH, t('menu.talents'), () => this.openTree(selected.id)));
        this.root.add(makeButton(this, talentsX + sideW / 2 + gap + modW / 2, playY, modW, sideH, t('menu.supports'), () => this.openSupports(selected.id)));
        nameY = playY - (compact ? 38 : 50);
      } else {
        // Too narrow: the three build screens in a row above the play button.
        const w3 = Math.min(modW, (room - gap * 2) / 3);
        const left = Math.max(8, sceneW / 2 - (w3 * 3 + gap * 2) / 2);
        playX = left + (w3 * 3 + gap * 2) / 2;
        const sideY = playY - playH / 2 - gap - sideH / 2;
        this.root.add(makeButton(this, playX, playY, Math.min(playW + 40, room), playH, t('menu.play'), () => this.play(selected.id), 'primary'));
        this.root.add(makeButton(this, left + w3 / 2, sideY, w3, sideH, t('menu.inventory'), openInventory));
        this.root.add(makeButton(this, left + w3 * 1.5 + gap, sideY, w3, sideH, t('menu.talents'), () => this.openTree(selected.id)));
        this.root.add(makeButton(this, left + w3 * 2.5 + gap * 2, sideY, w3, sideH, t('menu.supports'), () => this.openSupports(selected.id)));
        nameY = sideY - sideH / 2 - 12;
      }
      this.root.add(label(this, playX, nameY, selected.name, compact ? UI.size.body : UI.size.heading, UI.goldBrightText, true).setOrigin(0.5));
      // Unspent passive points: a call to action above the hero's name.
      const { points, specPoints } = unspentPoints(passiveTree, selected);
      const banner = new PointsBanner(this, () => this.openTree(selected.id), { depth: 5, pinned: false, parent: this.root, maxWidth: room });
      banner.setPosition(playX, nameY - (compact ? 38 : 48), compact ? 34 : 40);
      banner.setPoints(points, specPoints);
    } else {
      this.root.add(label(this, sceneW / 2, playY, t('menu.noHero'), UI.size.heading, UI.muted).setOrigin(0.5));
    }
    if (!compact) this.buildRecords(32, 92);
    this.buildLoginHint(sceneW, compact);
    this.root.add(label(this, 12, height - 8, `v${__APP_VERSION__}`, 12, UI.muted).setOrigin(0, 1).setAlpha(0.6));
    // Last, so its list draws over everything else.
    this.buildLanguageSwitcher(title.x + title.width + (compact ? 12 : 20), title.y + title.height / 2, compact);
  }

  /**
   * Language switcher next to the title: the current language's own name; a tap opens the list. A choice is saved
   * (it wins over the browser language from then on) and the menu is rebuilt in the new language at once.
   */
  private buildLanguageSwitcher(left: number, y: number, compact: boolean): void {
    const w = compact ? 112 : 136;
    const h = compact ? 32 : 36;
    const x = left + w / 2;
    const toggle = makeButton(this, x, y, w, h, LOCALE_NAMES[getLocale()], () => void this.toggleLanguageList());
    if (this.languageBusy) toggle.setAlpha(0.6);
    this.root.add(toggle);
    if (!this.languageOpen) return;
    const { width, height } = this.scale;
    // Tapping outside closes the list.
    const shade = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.35).setInteractive();
    shade.on('pointerup', () => {
      this.languageOpen = false;
      this.build();
    });
    const rowH = compact ? 38 : 42;
    const pad = 10;
    const headerH = compact ? 26 : 30;
    const listW = w + 24;
    const listH = headerH + LOCALES.length * (rowH + 6) - 6 + pad * 2;
    const top = y + h / 2 + 6;
    const cx = left + listW / 2 - 12;
    this.root.add([shade, makeFrame(this, cx, top + listH / 2, listW, listH, 'panel')]);
    this.root.add(fitText(label(this, cx, top + pad + 2, t('menu.language'), UI.size.small, UI.muted).setOrigin(0.5, 0), listW - 20));
    LOCALES.forEach((locale, i) => {
      const rowY = top + pad + headerH + rowH / 2 + i * (rowH + 6);
      const current = locale === getLocale();
      this.root.add(makeCard(this, cx, rowY, listW - 20, rowH, current, () => void this.chooseLanguage(locale)));
      this.root.add(label(this, cx, rowY, LOCALE_NAMES[locale], compact ? UI.size.small : UI.size.body, current ? UI.goldBrightText : UI.text, current).setOrigin(0.5));
    });
  }

  /** Opens the list once the glyphs of every language name are loaded (Cyrillic is otherwise only loaded for uk). */
  private async toggleLanguageList(): Promise<void> {
    if (this.languageBusy) return;
    if (this.languageOpen) {
      this.languageOpen = false;
      this.build();
      return;
    }
    this.languageBusy = true;
    await loadGlyphs(LOCALES.map((l) => LOCALE_NAMES[l]).join(''));
    this.languageBusy = false;
    // The scene may have been left while fonts were loading.
    if (!this.scene.isActive()) return;
    this.languageOpen = true;
    this.build();
  }

  /** The list closes at once and the switcher ignores taps until the new language (and its fonts) is applied. */
  private async chooseLanguage(locale: Locale): Promise<void> {
    if (this.languageBusy) return;
    this.languageOpen = false;
    if (locale === getLocale()) {
      this.build();
      return;
    }
    this.languageBusy = true;
    this.build();
    await this.app.setLanguage(locale);
    this.languageBusy = false;
    if (this.scene.isActive()) this.build();
  }

  private buildAccountWidget(width: number, compact: boolean): void {
    const { user, platform } = this.app;
    const name = user?.username ?? t('menu.guest');
    const size = compact ? 30 : 38;
    const right = width - (compact ? 12 : 28);
    const y = compact ? 30 : 44;
    this.root.add(makeAvatar(this, right - size / 2, y, size, user ? AVATAR_KEY : undefined, name));
    const nameText = label(this, right - size - 14, y - (user ? 10 : 18), name, compact ? UI.size.small : UI.size.body, UI.text, true).setOrigin(1, 0);
    this.root.add(nameText);
    if (!user && platform.isLoginAvailable()) {
      // Offered, never forced and never the main call to action (CrazyGames rules).
      const link = makeButton(this, 0, 0, 10, 24, t('menu.loginCrazyGames'), () => void this.login(), 'link');
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
    this.root.add(heading(this, x - w / 2 + 18, top + 8, t('menu.characters'), compact ? 18 : 22));
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
      this.root.add(label(this, x - (w - 24) / 2 + 48, y, t('menu.createHero'), compact ? UI.size.small : UI.size.body, UI.goldText).setOrigin(0, 0.5));
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
        .sprite(left + h * 0.5, y + h / 2 - 6, textureKey(look.sprite, 'idle'), spriteFrame(look.sprite, 'idle', 6, 0))
        .setOrigin(0.5, ORIGIN_Y)
        .setScale((h - 10) / 66);
      portrait.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.root.add(portrait);
    }
    const textX = left + h + 6;
    // Text stops before the delete button of the selected row (long class names in some languages shrink instead).
    const textW = (isSelected ? x + w / 2 - (compact ? 22 : 28) - (compact ? 16 : 20) - 6 : x + w / 2 - 10) - textX;
    this.root.add(fitText(label(this, textX, y - (compact ? 16 : 20), character.name, compact ? UI.size.body : UI.size.heading - 2, isSelected ? UI.goldBrightText : UI.text, true), textW));
    this.root.add(fitText(label(this, textX, y + (compact ? 2 : 6), t('menu.heroLine', { class: className(character.classId), level: character.level }), UI.size.small, UI.muted), textW));
    if (isSelected) {
      const del = makeButton(this, x + w / 2 - (compact ? 22 : 28), y, compact ? 32 : 40, compact ? 32 : 40, '✕', () =>
        confirmDialog(this, t('menu.deleteConfirm', { name: character.name }), t('menu.delete'), () => {
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
    const lines: Array<[string, string]> = [
      [t('records.bestMapLevel'), r.bestMapLevel ? String(r.bestMapLevel) : '—'],
      [t('records.bossKills'), String(r.bossKills)],
      [t('records.fastestClear'), time],
      [t('records.mostKills'), String(r.mostKillsInRun)],
    ];
    // Values line up after the longest label (label lengths differ a lot between languages).
    const names = lines.map(([name], i) => label(this, x, y + i * 22, name, UI.size.small, UI.muted));
    const valueX = x + Math.max(150, ...names.map((n) => n.width + 16));
    names.forEach((n, i) => {
      this.root.add(n);
      this.root.add(label(this, valueX, y + i * 22, lines[i]?.[1] ?? '', UI.size.small, UI.text, true));
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
    const text = label(this, x - w / 2 + 18, y, t('menu.loginHint'), UI.size.small, UI.text).setOrigin(0, 0.5);
    const login = makeButton(this, x + w / 2 - 100, y, 96, 36, t('menu.login'), () => void this.login(), 'primary');
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

  private openTree(characterId: string): void {
    const data: PassiveTreeSceneData = { characterId, returnTo: 'main-menu' };
    this.scene.start('passive-tree', data);
  }

  private openSupports(characterId: string): void {
    const data: SupportsSceneData = { characterId, returnTo: 'main-menu' };
    this.scene.start('supports', data);
  }

  private play(characterId: string): void {
    this.app.selectedCharacterId = characterId;
    this.cameras.main.fadeOut(200, 10, 9, 12);
    this.cameras.main.once('camerafadeoutcomplete', () => this.scene.start('iso-arena', { characterId }));
  }
}

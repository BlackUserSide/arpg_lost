import * as Phaser from 'phaser';
import { unspentPoints } from '../core/passives/allocation';
import { fillStashFromOverflow } from '../core/items/inventory';
import { deleteCharacter, findCharacter, type CharacterRecord } from '../core/progression/profile';
import { availableMaps, unlockedMap } from '../core/run/progress';
import { itemsData } from '../data/items';
import { passiveTree } from '../data/passives';
import { profileRules } from '../data/profile';
import { getLocale, LOCALE_NAMES, LOCALES, t, type Locale } from '../i18n';
import { getApp, type App } from './app';
import { className } from './contentText';
import { loadGlyphs } from './fonts';
import { makeFullscreenButton } from './fullscreen';
import { MenuBackdrop, preloadBackdrop } from './menuBackdrop';
import { PointsBanner } from './passiveBanner';
import { buildQaPanel, QA_UNLOCK_TAPS, QA_UNLOCK_WINDOW_MS, type QaResultLine } from './qaPanel';
import type { PassiveTreeSceneData } from './PassiveTreeScene';
import type { RunSceneData } from './RunScene';
import type { SupportsSceneData } from './SupportsScene';
import { viewportDiagnostics } from './viewport';
import { CLASS_LOOKS, HERO_SETS, loadSprites, ORIGIN_Y, spriteFrame, textureKey, unloadSprites } from './sprites';
import { confirmDialog, densityOf, fadeIn, fitText, heading, label, makeAvatar, makeButton, makeCard, makeFrame, showToast, TOUCH_MIN, UI, type Density } from './ui';

const AVATAR_KEY = 'user-avatar';
/** Portrait phones narrower than this get the stacked menu (px): account line, list top, room kept for the play group. */
const PORTRAIT_MAX_WIDTH = 560;
const PORTRAIT_ACCOUNT_Y = 76;
const PORTRAIT_LIST_TOP = 104;
const PORTRAIT_PLAY_ROOM = 300;

/** Hub sizes per density (render/ui.ts uiMetrics): phones in landscape get the tightest set (px). */
interface MenuSizes {
  /** Screen edge margin. */
  readonly edge: number;
  readonly titleX: number;
  readonly titleY: number;
  readonly title: number;
  /** Character list: width (capped by a share of the screen), top, row height and gap, header strip, heading. */
  readonly listW: number;
  readonly listShare: number;
  readonly listTop: number;
  readonly rowH: number;
  readonly rowGap: number;
  readonly listHeaderH: number;
  readonly listTitle: number;
  /** Text in the list rows: hero name, class line. */
  readonly rowName: number;
  readonly rowLine: number;
  readonly rowDelete: number;
  /** Play group: Enter button, build screen buttons, map selector, gaps; play row centre from the bottom. */
  readonly playW: number;
  readonly playH: number;
  readonly playSub: number;
  readonly sideW: number;
  readonly modW: number;
  readonly sideH: number;
  readonly gap: number;
  readonly mapsW: number;
  readonly playFromBottom: number;
  /** Hero name above the play group, and the points banner above it. */
  readonly nameAbove: number;
  readonly nameSize: number;
  readonly bannerAbove: number;
  readonly bannerH: number;
  /** Title row: language switcher, full screen and QA buttons, gaps; account widget. */
  readonly switcherW: number;
  readonly switcherH: number;
  readonly fullscreen: number;
  readonly qaW: number;
  readonly titleRowGap: number;
  readonly avatar: number;
  readonly accountY: number;
}

const MENU_SIZES: Readonly<Record<Density, MenuSizes>> = {
  phone: {
    edge: 8, titleX: 12, titleY: 6, title: 24,
    listW: 230, listShare: 0.32, listTop: 46, rowH: 44, rowGap: 4, listHeaderH: 26, listTitle: 16, rowName: UI.size.small, rowLine: UI.size.small, rowDelete: 30,
    playW: 176, playH: 42, playSub: 12, sideW: 96, modW: 112, sideH: 34, gap: 6, mapsW: 68, playFromBottom: 29,
    nameAbove: 33, nameSize: UI.size.body, bannerAbove: 32, bannerH: 30,
    switcherW: 100, switcherH: 30, fullscreen: 30, qaW: 44, titleRowGap: 6, avatar: 26, accountY: 22,
  },
  compact: {
    edge: 12, titleX: 16, titleY: 10, title: 30,
    listW: 250, listShare: 0.4, listTop: 72, rowH: 50, rowGap: 6, listHeaderH: 28, listTitle: 18, rowName: UI.size.body, rowLine: UI.size.small, rowDelete: 32,
    playW: 200, playH: 48, playSub: 12, sideW: 108, modW: 120, sideH: 40, gap: 8, mapsW: 84, playFromBottom: 40,
    nameAbove: 38, nameSize: UI.size.body, bannerAbove: 38, bannerH: 34,
    switcherW: 112, switcherH: 32, fullscreen: 32, qaW: 48, titleRowGap: 8, avatar: 30, accountY: 30,
  },
  wide: {
    edge: 28, titleX: 32, titleY: 22, title: UI.size.display,
    listW: 320, listShare: 1, listTop: 104, rowH: 72, rowGap: 10, listHeaderH: 40, listTitle: 22, rowName: UI.size.heading - 2, rowLine: UI.size.small, rowDelete: 40,
    playW: 260, playH: 60, playSub: 14, sideW: 150, modW: 160, sideH: 48, gap: 12, mapsW: 104, playFromBottom: 64,
    nameAbove: 50, nameSize: UI.size.heading, bannerAbove: 48, bannerH: 40,
    switcherW: 136, switcherH: 36, fullscreen: 36, qaW: 56, titleRowGap: 12, avatar: 38, accountY: 44,
  },
};

/** Hub entry: hero by the campfire, character list, account widget, records, play. */
export class MainMenuScene extends Phaser.Scene {
  private app!: App;
  private root!: Phaser.GameObjects.Container;
  /** Sizes for the current screen (set by build). */
  private sizes: MenuSizes = MENU_SIZES.wide;
  private backdrop!: MenuBackdrop;
  /** Language list open under the switcher. */
  private languageOpen = false;
  /** A language switch (or the list's fonts) is loading: the switcher ignores taps until it is done. */
  private languageBusy = false;
  /** The map list (replay a lower map) is open over the menu. */
  private mapsOpen = false;
  /** The QA panel (closed-beta shortcuts, only in QA mode) is open over the menu. */
  private qaOpen = false;
  /** Result of the last QA action, shown in the panel until it closes. */
  private qaLines: QaResultLine[] = [];
  /** Recent presses on the version label (secret QA unlock), scene clock ms. */
  private versionTaps: number[] = [];

  constructor() {
    super('main-menu');
  }

  preload(): void {
    this.app = getApp(this);
    this.app.platform.loadingStart();
    // Mob and boss sheets of a finished run are not drawn in the hub: free their GPU memory (phones).
    unloadSprites(this, HERO_SETS);
    loadSprites(this, HERO_SETS);
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
    this.mapsOpen = false;
    this.qaOpen = false;
    this.qaLines = [];
    this.versionTaps = [];
    // Mail items take any stash room freed since they arrived (oldest first).
    const moved = fillStashFromOverflow(this.app.profile, itemsData);
    if (moved.length > 0) this.app.save();
    this.build();
    fadeIn(this);
    if (moved.length > 0) showToast(this, t('inv.mailMoved', { count: moved.length }));

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
    const density = densityOf(width, height);
    const compact = density !== 'wide';
    const s = MENU_SIZES[density];
    this.sizes = s;

    const characters = this.app.profile.characters;
    if (!findCharacter(this.app.profile, this.app.selectedCharacterId ?? '')) this.app.selectedCharacterId = characters[0]?.id;
    const selected = findCharacter(this.app.profile, this.app.selectedCharacterId ?? '');

    // Right column: character list. Left area: campfire scene, title, play.
    // Narrow portrait phones: the account line moves under the title row and the list spans the width above the scene.
    const portrait = width < PORTRAIT_MAX_WIDTH && height > width;
    const listW = portrait ? width - 24 : Math.min(s.listW, width * s.listShare);
    const listX = portrait ? width / 2 : width - listW / 2 - s.edge;
    const sceneW = portrait ? width : width - listW - s.edge * 2;

    this.backdrop.layout(sceneW * 0.55, height * (portrait ? 0.7 : compact ? 0.6 : 0.62), width, height);
    this.backdrop.setHero(selected ? CLASS_LOOKS.find((l) => l.classId === selected.classId)?.sprite : undefined);

    const title = heading(this, s.titleX, s.titleY, 'ARPG Lost', s.title);
    this.root.add(title);
    this.buildAccountWidget(width, compact, portrait ? PORTRAIT_ACCOUNT_Y : undefined);
    const listTop = portrait ? PORTRAIT_LIST_TOP : s.listTop;
    // Portrait: the play button group keeps the bottom of the screen.
    const listBottom = this.buildCharacterList(listX, listW, listTop, portrait ? height - PORTRAIT_PLAY_ROOM : height - s.edge, compact);

    const playY = height - s.playFromBottom;
    if (selected) {
      const { playW, playH, sideW, modW, sideH, gap } = s;
      // The map selector sits right next to the play button (only when there is a lower map to replay).
      const multiMap = unlockedMap(selected) > 1;
      const mapsW = multiMap ? s.mapsW : 0;
      const mapsGap = multiMap ? 6 : 0;
      // Room left of the character list (phones in landscape have far less than the one-row layout needs).
      const room = sceneW - s.edge * 2;
      const rowW = sideW * 2 + modW + playW + mapsGap + mapsW + gap * 3;
      const openInventory = (): void => {
        this.scene.start('inventory', { characterId: selected.id });
      };
      /** Centre of the play button and the map selector together (name and banner line up with it). */
      let groupX: number;
      let nameY: number;
      if (rowW <= room) {
        // [Inventory] [Enter][Maps] [Talents] [Supports]: the build screens side by side, the row centred as a whole.
        const rowLeft = sceneW / 2 - rowW / 2;
        const playX = rowLeft + sideW + gap + playW / 2;
        this.addPlayButton(selected, playX, playY, playW, playH, compact);
        if (multiMap) this.addMapsButton(playX + playW / 2 + mapsGap + mapsW / 2, playY, mapsW, playH);
        this.root.add(makeButton(this, rowLeft + sideW / 2, playY, sideW, sideH, t('menu.inventory'), openInventory));
        const talentsX = playX + playW / 2 + mapsGap + mapsW + gap + sideW / 2;
        this.root.add(makeButton(this, talentsX, playY, sideW, sideH, t('menu.talents'), () => this.openTree(selected.id)));
        this.root.add(makeButton(this, talentsX + sideW / 2 + gap + modW / 2, playY, modW, sideH, t('menu.supports'), () => this.openSupports(selected.id)));
        nameY = playY - s.nameAbove;
        groupX = playX + (mapsGap + mapsW) / 2;
      } else {
        // Too narrow: the three build screens in a row above the play button and the map selector.
        const w3 = Math.min(modW, (room - gap * 2) / 3);
        const left = Math.max(8, sceneW / 2 - (w3 * 3 + gap * 2) / 2);
        groupX = left + (w3 * 3 + gap * 2) / 2;
        const bigW = Math.min(playW + 40, room - mapsGap - mapsW);
        const playX = groupX - (bigW + mapsGap + mapsW) / 2 + bigW / 2;
        const sideY = playY - playH / 2 - gap - sideH / 2;
        this.addPlayButton(selected, playX, playY, bigW, playH, compact);
        if (multiMap) this.addMapsButton(playX + bigW / 2 + mapsGap + mapsW / 2, playY, mapsW, playH);
        this.root.add(makeButton(this, left + w3 / 2, sideY, w3, sideH, t('menu.inventory'), openInventory));
        this.root.add(makeButton(this, left + w3 * 1.5 + gap, sideY, w3, sideH, t('menu.talents'), () => this.openTree(selected.id)));
        this.root.add(makeButton(this, left + w3 * 2.5 + gap * 2, sideY, w3, sideH, t('menu.supports'), () => this.openSupports(selected.id)));
        nameY = sideY - sideH / 2 - 12;
      }
      this.root.add(label(this, groupX, nameY, selected.name, s.nameSize, UI.goldBrightText, true).setOrigin(0.5));
      // Unspent passive points: a call to action above the hero's name.
      const { points, specPoints } = unspentPoints(passiveTree, selected);
      const banner = new PointsBanner(this, () => this.openTree(selected.id), { depth: 5, pinned: false, parent: this.root, maxWidth: room });
      banner.setPosition(groupX, nameY - s.bannerAbove, s.bannerH);
      banner.setPoints(points, specPoints);
    } else {
      this.mapsOpen = false;
      this.root.add(label(this, sceneW / 2, playY, t('menu.noHero'), UI.size.heading, UI.muted).setOrigin(0.5));
    }
    if (!compact) this.buildRecords(32, 92);
    this.buildLoginHint(sceneW, compact, portrait ? listBottom + 8 : undefined);
    // Phones in landscape: the play row reaches the bottom left corner, so the version goes under the title.
    if (density === 'phone' && !portrait) this.buildVersionLabel(title.x, title.y + title.height, 0);
    else this.buildVersionLabel(12, height - 8, 1);
    const switcherLeft = title.x + title.width + (compact ? 12 : 20);
    const rowY = title.y + title.height / 2;
    const rowGap = s.titleRowGap;
    // Full screen toggle and (QA mode) the QA button right of the language switcher; built before it, so the
    // language list draws over them.
    let rowLeft = switcherLeft + s.switcherW + rowGap;
    const fsSize = s.fullscreen;
    const fullscreen = makeFullscreenButton(this, rowLeft + fsSize / 2, rowY, fsSize);
    if (fullscreen) {
      this.root.add(fullscreen);
      rowLeft += fsSize + rowGap;
    }
    if (this.app.settings.qa === true) {
      // Narrow portrait phones: no room left in the title row, the QA button goes left of the account line below it.
      const fits = rowLeft + s.qaW <= width - (compact ? 8 : 16);
      if (fits) this.buildQaButton(rowLeft, rowY);
      else this.buildQaButton(title.x, portrait ? PORTRAIT_ACCOUNT_Y : rowY + (compact ? 42 : 48));
    }
    // Last, so its list draws over everything else.
    this.buildLanguageSwitcher(switcherLeft, rowY, compact);
    if (selected && this.mapsOpen) this.buildMapList(selected, compact);
    if (this.qaOpen && this.app.settings.qa === true) this.buildQa(selected, compact);
  }

  /**
   * Build version (bottom left; under the title on landscape phones), `originY` 0 = top edge at y, 1 = bottom. Also the secret QA unlock for closed-beta testers (designer decision): seven
   * presses within three seconds toggle QA mode. The hit area is padded so it works by touch.
   */
  private buildVersionLabel(x: number, y: number, originY: number): void {
    const version = label(this, x, y, `v${__APP_VERSION__}`, 12, UI.muted).setOrigin(0, originY).setAlpha(0.6);
    const pad = 12;
    version.setInteractive(new Phaser.Geom.Rectangle(-pad, -pad, version.width + pad * 2, version.height + pad * 2), Phaser.Geom.Rectangle.Contains);
    version.on('pointerdown', () => this.onVersionTap());
    this.root.add(version);
  }

  private onVersionTap(): void {
    const now = this.time.now;
    this.versionTaps = this.versionTaps.filter((at) => now - at <= QA_UNLOCK_WINDOW_MS);
    this.versionTaps.push(now);
    if (this.versionTaps.length < QA_UNLOCK_TAPS) return;
    this.versionTaps = [];
    const on = this.app.settings.qa !== true;
    this.app.setQaMode(on);
    this.qaOpen = false;
    this.qaLines = [];
    this.build();
    showToast(this, t(on ? 'qa.on' : 'qa.off'));
  }

  private buildQaButton(left: number, y: number): void {
    const w = this.sizes.qaW;
    const h = this.sizes.switcherH;
    const button = makeButton(this, left + w / 2, y, w, h, t('qa.button'), () => {
      this.qaOpen = true;
      this.qaLines = [];
      this.build();
    });
    this.root.add(button.setAlpha(0.75));
  }

  private buildQa(hero: CharacterRecord | undefined, compact: boolean): void {
    buildQaPanel(this, this.root, {
      profile: this.app.profile,
      hero,
      compact,
      lines: this.qaLines,
      diagnostics: () => viewportDiagnostics(this.game),
      onApplied: (lines) => {
        this.app.save();
        this.qaLines = lines;
        this.build();
      },
      onClose: () => {
        this.qaOpen = false;
        this.qaLines = [];
        this.build();
      },
    });
  }

  /** "Enter the dungeon" with the map it leads to (the hero's highest unlocked map) on a second line. */
  private addPlayButton(hero: CharacterRecord, x: number, y: number, w: number, h: number, compact: boolean): void {
    const button = makeButton(this, x, y, w, h, t('menu.play'), () => this.play(hero.id), 'primary');
    const caption = button.list[1] as Phaser.GameObjects.Text;
    const subSize = compact ? this.sizes.playSub : 14;
    fitText(caption, w - 24, h - subSize - 14);
    caption.setY(-subSize * 0.5);
    const sub = label(this, 0, caption.y + caption.height / 2 + subSize * 0.55, t('menu.mapN', { map: unlockedMap(hero) }), subSize, UI.goldBrightText, true).setOrigin(0.5);
    sub.setStroke('#120a04', 3);
    button.add(fitText(sub, w - 24));
    this.root.add(button);
  }

  private addMapsButton(x: number, y: number, w: number, h: number): void {
    this.root.add(
      makeButton(this, x, y, w, h, t('menu.maps'), () => {
        this.mapsOpen = true;
        this.build();
      }),
    );
  }

  /**
   * Map choice (docs/design/maps.md): every unlocked map of the hero as a tile, the highest one highlighted; a tap
   * starts that map. Tapping outside or the cross closes the list.
   */
  private buildMapList(hero: CharacterRecord, compact: boolean): void {
    const { width, height } = this.scale;
    const close = (): void => {
      this.mapsOpen = false;
      this.build();
    };
    const shade = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.6).setInteractive();
    shade.on('pointerup', close);
    const maps = availableMaps(hero);
    const highest = maps[maps.length - 1] ?? 1;
    const phone = this.sizes === MENU_SIZES.phone;
    const panelW = Math.min(compact ? (phone ? 560 : 620) : 680, width - 16);
    const pad = phone ? 10 : compact ? 12 : 20;
    const headerH = phone ? 40 : compact ? 50 : 66;
    const hintH = phone ? 24 : compact ? 26 : 32;
    const tileGap = compact ? 6 : 8;
    // Columns: as many as fit at a comfortable touch size (at most 10), but no more than there are maps.
    const minTileW = phone ? 44 : compact ? 52 : 60;
    const cols = Math.max(1, Math.min(maps.length, 10, Math.floor((panelW - pad * 2 + tileGap) / (minTileW + tileGap))));
    const rows = Math.ceil(maps.length / cols);
    const tileW = Math.min(phone ? 52 : compact ? 72 : 84, (panelW - pad * 2 - tileGap * (cols - 1)) / cols);
    const freeH = height - 16 - headerH - hintH - pad;
    const tileH = Math.max(30, Math.min(phone ? 40 : compact ? 44 : 54, (freeH - tileGap * (rows - 1)) / rows));
    const gridW = cols * tileW + (cols - 1) * tileGap;
    const gridH = rows * tileH + (rows - 1) * tileGap;
    const panelH = Math.min(height - 8, headerH + gridH + hintH + pad);
    const top = height / 2 - panelH / 2;
    // The panel swallows taps so only the shade around it closes the list.
    const panel = makeFrame(this, width / 2, height / 2, panelW, panelH, 'panel').setInteractive();
    this.root.add([shade, panel]);
    const closeSize = phone ? 30 : compact ? 34 : 40;
    this.root.add(fitText(heading(this, width / 2, top + (phone ? 20 : compact ? 25 : 33), t('menu.mapsTitle'), phone ? 18 : compact ? 22 : 28).setOrigin(0.5), panelW - closeSize * 2 - 40));
    this.root.add(makeButton(this, width / 2 + panelW / 2 - closeSize / 2 - 10, top + closeSize / 2 + (phone ? 6 : 10), closeSize, closeSize, '✕', close));
    const left = width / 2 - gridW / 2;
    const gridTop = top + headerH;
    maps.forEach((map, i) => {
      const x = left + (i % cols) * (tileW + tileGap) + tileW / 2;
      const y = gridTop + Math.floor(i / cols) * (tileH + tileGap) + tileH / 2;
      const current = map === highest;
      this.root.add(makeCard(this, x, y, tileW, tileH, current, () => this.play(hero.id, map)));
      this.root.add(label(this, x, y, String(map), compact ? UI.size.body : UI.size.heading, current ? UI.goldBrightText : UI.text, true).setOrigin(0.5));
    });
    this.root.add(fitText(label(this, width / 2, gridTop + gridH + hintH / 2 + 2, t('menu.mapsHint'), UI.size.small, UI.muted).setOrigin(0.5), panelW - pad * 2));
  }

  /**
   * Language switcher next to the title: the current language's own name; a tap opens the list. A choice is saved
   * (it wins over the browser language from then on) and the menu is rebuilt in the new language at once.
   */
  private buildLanguageSwitcher(left: number, y: number, compact: boolean): void {
    const w = this.sizes.switcherW;
    const h = this.sizes.switcherH;
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
    const rowH = compact ? TOUCH_MIN : 42;
    const pad = compact ? 8 : 10;
    const headerH = compact ? 24 : 30;
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

  /** Guest / user name, avatar and the login link in the top right; `top`: its centre line when not the default. */
  private buildAccountWidget(width: number, compact: boolean, top?: number): void {
    const { user, platform } = this.app;
    const name = user?.username ?? t('menu.guest');
    const size = this.sizes.avatar;
    const right = width - this.sizes.edge;
    const y = top ?? this.sizes.accountY;
    this.root.add(makeAvatar(this, right - size / 2, y, size, user ? AVATAR_KEY : undefined, name));
    const nameText = label(this, right - size - 14, y - (user ? 10 : compact ? 16 : 18), name, compact ? UI.size.small : UI.size.body, UI.text, true).setOrigin(1, 0);
    this.root.add(nameText);
    if (!user && platform.isLoginAvailable()) {
      // Offered, never forced and never the main call to action (CrazyGames rules).
      const link = makeButton(this, 0, 0, 10, 24, t('menu.loginCrazyGames'), () => void this.login(), 'link');
      const linkText = link.list[1] as Phaser.GameObjects.Text;
      link.setPosition(right - size - 14 - linkText.width / 2, y + (compact ? 12 : 14));
      this.root.add(link);
    }
  }

  /** The character list panel from `top`; returns its bottom edge. */
  private buildCharacterList(x: number, w: number, top: number, bottom: number, compact: boolean): number {
    const characters = this.app.profile.characters;
    const slots = profileRules.maxCharacters;
    const s = this.sizes;
    const rowH = s.rowH;
    const gap = s.rowGap;
    const rows = Math.min(slots, characters.length + 1);
    const headerH = s.listHeaderH;
    const inset = compact ? 16 : 24;
    const panelH = Math.min(bottom - top, headerH + rows * (rowH + gap) + (compact ? 12 : 16));
    this.root.add(makeFrame(this, x, top + panelH / 2, w, panelH, 'panel'));
    this.root.add(heading(this, x - w / 2 + inset - 4, top + (compact ? 5 : 8), t('menu.characters'), s.listTitle));
    this.root.add(label(this, x + w / 2 - inset + 4, top + (compact ? 6 : 14), `${characters.length}/${slots}`, UI.size.small, UI.muted).setOrigin(1, 0));

    let y = top + headerH + rowH / 2 + 4;
    for (const character of characters) {
      this.buildCharacterRow(character, x, y, w - inset, rowH, compact);
      y += rowH + gap;
    }
    if (characters.length < slots) {
      const card = makeCard(this, x, y, w - inset, rowH, false, () => this.scene.start('create-character'));
      this.root.add(card);
      this.root.add(heading(this, x - (w - inset) / 2 + 22, y, '+', compact ? 24 : 30).setOrigin(0.5));
      this.root.add(fitText(label(this, x - (w - inset) / 2 + 42, y, t('menu.createHero'), compact ? UI.size.small : UI.size.body, UI.goldText).setOrigin(0, 0.5), w - inset - 52));
    }
    return top + panelH;
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
    const s = this.sizes;
    const textX = left + h + (compact ? 2 : 6);
    // Text stops before the delete button of the selected row (long class names in some languages shrink instead).
    const delX = x + w / 2 - s.rowDelete / 2 - (compact ? 6 : 8);
    const textW = (isSelected ? delX - s.rowDelete / 2 - 6 : x + w / 2 - 10) - textX;
    // Name above the row's centre line, class and level below it.
    this.root.add(fitText(label(this, textX, y + (compact ? 3 : 2), character.name, s.rowName, isSelected ? UI.goldBrightText : UI.text, true).setOrigin(0, 1), textW));
    this.root.add(fitText(label(this, textX, y + (compact ? 1 : 6), t('menu.heroLine', { class: className(character.classId), level: character.level }), s.rowLine, UI.muted), textW));
    if (isSelected) {
      const del = makeButton(this, delX, y, s.rowDelete, s.rowDelete, '✕', () =>
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

  /** `top`: the hint's top edge when not the default spot. */
  private buildLoginHint(sceneW: number, compact: boolean, top?: number): void {
    const { app } = this;
    if (app.user || app.loginHint !== 'pending' || !app.platform.isLoginAvailable()) return;
    app.loginHint = 'shown';
    const w = Math.min(460, sceneW - 24);
    const h = compact ? 52 : 60;
    // Desktop: below the records block in the top left (four rows from y 92), so it never covers them.
    const y = top !== undefined ? top + h / 2 : compact ? 82 : 92 + 4 * 22 + 46;
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

  /** Starts a map run: `mapLevel` from the map list, else the hero's highest unlocked map (RunScene decides). */
  private play(characterId: string, mapLevel?: number): void {
    this.app.selectedCharacterId = characterId;
    this.mapsOpen = false;
    const data: RunSceneData = { characterId, ...(mapLevel !== undefined ? { mapLevel } : {}) };
    this.cameras.main.fadeOut(200, 10, 9, 12);
    this.cameras.main.once('camerafadeoutcomplete', () => this.scene.start('run', data));
  }
}

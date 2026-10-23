import * as Phaser from 'phaser';
import { applyCraft, ESSENCE_CURRENCY, type CraftData, type CraftOp } from '../core/items/craft';
import { equippedWeapon } from '../core/items/equipment';
import { equipFromStash, salvageFromStash, SALVAGE_CURRENCY, unequipToStash, type InventoryError } from '../core/items/inventory';
import type { EquipSlot, Item } from '../core/items/types';
import { heroMechanics, heroModifiers } from '../core/progression/hero';
import { critStats, leechStats } from '../core/world/passiveEffects';
import { levelModifiers, xpToNextLevel } from '../core/progression/levels';
import { findCharacter, type CharacterRecord } from '../core/progression/profile';
import { createRng } from '../core/rng';
import { computeStat } from '../core/stats/modifiers';
import type { StatId } from '../core/stats/types';
import { deriveStat, getClass, type StatSource } from '../core/world/world';
import { content } from '../data';
import { craftingRules } from '../data/crafting';
import { itemsData } from '../data/items';
import { passiveTree } from '../data/passives';
import { formatNumber, t, upper, type MessageKey } from '../i18n';
import { getApp, type App } from './app';
import { itemIcon } from './itemIcons';
import { className, itemName } from './contentText';
import { buildCraftPanel, CURRENCY_LOOK, type CraftFlash } from './craftPanel';
import { AFFIX_OPS, changedAffixes, currencyAmount } from './craftText';
import { describeItem, rarityLabel } from './itemText';
import { shardsWord } from './passiveText';
import { resourceText } from './resourceText';
import { damageTypeText, num } from './statText';
import type { PassiveTreeSceneData } from './PassiveTreeScene';
import type { SupportsSceneData } from './SupportsScene';
import { CLASS_LOOKS, loadSprites, ORIGIN_Y, spriteFrame, textureKey } from './sprites';
import { confirmDialog, fadeIn, fitText, heading, label, makeButton, makeCard, makeFrame, UI } from './ui';

// Paper doll (8 slots) + shared stash + item details. Select-then-act controls so it works by touch;
// double click / double tap equips or unequips directly. The Craft tab (hub only: this scene is never opened during a
// run) swaps the details for the crafting panel; the doll and the stash then only pick the item to craft.

const CRAFT_DATA: CraftData = { items: itemsData, crafting: craftingRules };

export type InventoryTab = 'items' | 'craft';

type Selection = { where: 'stash'; id: string } | { where: 'equip'; slot: EquipSlot } | undefined;

const DOLL: ReadonlyArray<{ slot: EquipSlot; col: number; row: number; name: MessageKey }> = [
  { slot: 'weapon', col: 0, row: 0, name: 'inv.slot.weapon' },
  { slot: 'helmet', col: 1, row: 0, name: 'inv.slot.helmet' },
  { slot: 'amulet', col: 2, row: 0, name: 'inv.slot.amulet' },
  { slot: 'gloves', col: 0, row: 1, name: 'inv.slot.gloves' },
  { slot: 'armour', col: 1, row: 1, name: 'inv.slot.armour' },
  { slot: 'ring1', col: 2, row: 1, name: 'inv.slot.ring' },
  { slot: 'boots', col: 1, row: 2, name: 'inv.slot.boots' },
  { slot: 'ring2', col: 2, row: 2, name: 'inv.slot.ring' },
];

const ERROR_KEY: Readonly<Record<InventoryError, MessageKey>> = {
  'wrong-slot': 'inv.error.wrongSlot',
  level: 'inv.error.level',
  'weapon-type': 'inv.error.weaponType',
  'unknown-base': 'inv.error.unknownBase',
  'stash-full': 'inv.error.stashFull',
  'no-item': 'inv.error.noItem',
  'no-character': 'inv.error.noCharacter',
};

/** Attribute rows; the resource row (null) is named after the class's own resource. */
const STAT_ROWS: ReadonlyArray<[StatId, MessageKey | null, 'int' | 'pct' | 'dec']> = [
  ['life', 'inv.stat.life', 'int'],
  ['energyShield', 'inv.stat.energyShield', 'int'],
  ['resource', null, 'int'],
  ['armour', 'inv.stat.armour', 'int'],
  ['fireResistance', 'inv.stat.fireResistance', 'pct'],
  ['coldResistance', 'inv.stat.coldResistance', 'pct'],
  ['lightningResistance', 'inv.stat.lightningResistance', 'pct'],
  ['lifeRegen', 'inv.stat.lifeRegen', 'dec'],
];

function levelLine(character: CharacterRecord): string {
  const next = xpToNextLevel(character.level, content.progression);
  return Number.isFinite(next) ? t('inv.levelLine', { level: character.level, xp: Math.floor(character.xp), next }) : t('common.level', { level: character.level });
}

function sameSelection(a: Selection, b: Selection): boolean {
  if (!a || !b || a.where !== b.where) return false;
  return a.where === 'stash' ? a.id === (b as { id: string }).id : a.slot === (b as { slot: EquipSlot }).slot;
}

export class InventoryScene extends Phaser.Scene {
  private app!: App;
  private characterId = '';
  private selection: Selection;
  private hover: Selection;
  private message = '';
  private lastClick = { key: '', time: 0 };
  private root!: Phaser.GameObjects.Container;
  private details!: Phaser.GameObjects.Container;
  private detailsArea = { x: 0, y: 0, w: 0, h: 0, overlay: false };
  private heroSprite: { sprite: Phaser.GameObjects.Sprite; set: string } | undefined;
  private elapsed = 0;
  private tab: InventoryTab = 'items';
  /** Craft tab: the affix picked on the selected item (position in Item.affixes). */
  private craftAffix: number | undefined;
  /** Craft tab: highlight of the last craft, shown once on the next build. */
  private craftFlash: CraftFlash | undefined;

  constructor() {
    super('inventory');
  }

  init(data: { characterId?: string; tab?: InventoryTab }): void {
    if (data.characterId) this.characterId = data.characterId;
    this.tab = data.tab ?? 'items';
    this.selection = undefined;
    this.hover = undefined;
    this.message = '';
    this.craftAffix = undefined;
    this.craftFlash = undefined;
  }

  preload(): void {
    loadSprites(this);
  }

  create(): void {
    this.app = getApp(this);
    this.cameras.main.setBackgroundColor(UI.bg);
    this.build();
    fadeIn(this);
    const rebuild = (): void => this.build();
    this.scale.on('resize', rebuild);
    this.input.keyboard?.on('keydown-ESC', () => this.back());
    this.events.once('shutdown', () => this.scale.off('resize', rebuild));
  }

  override update(_t: number, dtMs: number): void {
    this.elapsed += dtMs / 1000;
    if (this.heroSprite) this.heroSprite.sprite.setFrame(spriteFrame(this.heroSprite.set, 'idle', 6, this.elapsed));
  }

  private get character(): CharacterRecord | undefined {
    return findCharacter(this.app.profile, this.characterId);
  }

  private build(): void {
    this.root?.destroy();
    this.details?.destroy();
    this.heroSprite = undefined;
    this.root = this.add.container(0, 0);
    const character = this.character;
    if (!character) {
      this.back();
      return;
    }
    const { width, height } = this.scale;
    const compact = width < 1100 || height < 600;
    const m = compact ? 10 : 24;
    const titleH = compact ? 40 : 64;
    const look = CLASS_LOOKS.find((l) => l.classId === character.classId);

    const title = heading(this, m + 4, compact ? 4 : 12, compact ? character.name : t('inv.title', { name: character.name, class: className(character.classId) }), compact ? 24 : 34);
    this.root.add(title);
    // The level line sits between the title and the header buttons (Supports is the leftmost, 130 wide at -250): it
    // shrinks into that gap, or hides on screens too narrow for it.
    const levelX = title.x + title.width + 16;
    const levelRoom = width - m - 60 - 250 - 65 - 8 - levelX;
    const level = fitText(label(this, levelX, title.y + title.height - (compact ? 20 : 26), levelLine(character), UI.size.small, UI.goldBrightText), levelRoom);
    this.root.add(level.setVisible(level.width <= levelRoom));
    this.root.add(makeButton(this, width - m - 60, titleH / 2 + (compact ? 0 : 4), 110, compact ? 34 : 42, t('common.back'), () => this.back()));
    this.root.add(
      makeButton(this, width - m - 60 - 120, titleH / 2 + (compact ? 0 : 4), 110, compact ? 34 : 42, t('menu.talents'), () => {
        const data: PassiveTreeSceneData = { characterId: character.id, returnTo: 'inventory' };
        this.scene.start('passive-tree', data);
      }),
    );
    this.root.add(
      makeButton(this, width - m - 60 - 250, titleH / 2 + (compact ? 0 : 4), 130, compact ? 34 : 42, t('menu.supports'), () => {
        const data: SupportsSceneData = { characterId: character.id, returnTo: 'inventory' };
        this.scene.start('supports', data);
      }),
    );

    const top = titleH + (compact ? 0 : 6);
    const avail = height - top - m;

    // Paper doll.
    const cell = Math.floor(Math.min(compact ? 58 : 84, (avail - (compact ? 40 : 230)) / 3 - 14));
    const gap = compact ? 8 : 14;
    const dollW = cell * 3 + gap * 2 + 32;
    const dollX = m + dollW / 2;
    this.root.add(makeFrame(this, dollX, top + avail / 2, dollW, avail, 'panel'));
    const gridTop = top + (compact ? 14 : 22);
    for (const d of DOLL) {
      const x = dollX - (cell + gap) + d.col * (cell + gap);
      const y = gridTop + cell / 2 + d.row * (cell + gap + 14);
      this.buildSlot(character, d.slot, t(d.name), x, y, cell);
    }
    if (look) {
      // Hero stands in the free doll cell (left column, bottom row).
      const sprite = this.add
        .sprite(dollX - (cell + gap), gridTop + cell + 2 * (cell + gap + 14), textureKey(look.sprite, 'idle'), 6 * 10)
        .setOrigin(0.5, ORIGIN_Y)
        .setScale(cell / 56);
      sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.heroSprite = { sprite, set: look.sprite };
      this.root.add(sprite);
    }
    if (!compact) this.buildStats(character, dollX - dollW / 2 + 18, gridTop + 3 * (cell + gap + 14) + 6, dollW - 36);

    // Stash.
    const rules = itemsData.rules;
    const cols = 6;
    const rows = Math.ceil(rules.stashSize / cols);
    const headerH = compact ? 38 : 50;
    const sCell = Math.floor(Math.min(compact ? 48 : 66, (avail - headerH - 24) / rows - (compact ? 4 : 6)));
    const sGap = compact ? 4 : 6;
    const stashW = cols * sCell + (cols - 1) * sGap + 28;
    const stashX = dollX + dollW / 2 + (compact ? 8 : 16) + stashW / 2;
    this.root.add(makeFrame(this, stashX, top + avail / 2, stashW, avail, 'panel'));
    const items = this.app.profile.stash.items;
    // Tabs: Stash (equip / salvage) and Craft; the tab row doubles as the stash header.
    const tabW = compact ? 100 : 124;
    const tabH = compact ? 32 : 36;
    const tabY = top + headerH / 2 + 1;
    const tabsLeft = stashX - stashW / 2 + 12;
    (['items', 'craft'] as const).forEach((tab, i) => {
      const caption = tab === 'items' ? t('inv.stash') : t('inv.tab.craft');
      this.root.add(makeButton(this, tabsLeft + tabW / 2 + i * (tabW + 6), tabY, tabW, tabH, caption, () => this.setTab(tab), this.tab === tab ? 'primary' : 'secondary'));
    });
    const wallet = this.app.profile.currency;
    const headerText =
      this.tab === 'craft'
        ? `${CURRENCY_LOOK[SALVAGE_CURRENCY]!.glyph} ${wallet[SALVAGE_CURRENCY] ?? 0}   ${CURRENCY_LOOK[ESSENCE_CURRENCY]!.glyph} ${currencyAmount(ESSENCE_CURRENCY, wallet[ESSENCE_CURRENCY] ?? 0)}`
        : `${items.length}/${rules.stashSize}   ◆ ${compact ? (wallet[SALVAGE_CURRENCY] ?? 0) : shardsWord(wallet[SALVAGE_CURRENCY] ?? 0)}`;
    const headerRight = stashX + stashW / 2 - 14;
    const headerRoom = headerRight - (tabsLeft + tabW * 2 + 6 + 10);
    const info = fitText(label(this, headerRight, tabY, headerText, UI.size.small, UI.muted).setOrigin(1, 0.5), headerRoom);
    this.root.add(info.setVisible(info.width <= headerRoom));
    for (let i = 0; i < rules.stashSize; i++) {
      const x = stashX - stashW / 2 + 14 + sCell / 2 + (i % cols) * (sCell + sGap);
      const y = top + headerH + sCell / 2 + Math.floor(i / cols) * (sCell + sGap);
      const item = items[i];
      if (item) this.buildStashCell(item, x, y, sCell);
      else this.root.add(this.add.rectangle(x, y, sCell, sCell, 0x000000, 0.35).setStrokeStyle(1, 0x2a2430));
    }

    // Details: own column on wide screens, overlay on narrow ones.
    const detailsLeft = stashX + stashW / 2 + (compact ? 8 : 16);
    const spare = width - m - detailsLeft;
    // The crafting panel needs more room than an item tooltip: on narrow screens it covers the whole content area.
    this.detailsArea =
      spare >= 280
        ? { x: detailsLeft, y: top, w: spare, h: avail, overlay: false }
        : this.tab === 'craft'
          ? { x: m, y: top, w: width - m * 2, h: avail, overlay: true }
          : { x: stashX - stashW / 2 + 6, y: top + headerH - 6, w: stashW - 12, h: avail - headerH, overlay: true };
    this.buildDetails();
  }

  private buildSlot(character: CharacterRecord, slot: EquipSlot, name: string, x: number, y: number, size: number): void {
    const item = character.equipment[slot];
    const selected = this.selection?.where === 'equip' && this.selection.slot === slot;
    const card = makeCard(this, x, y, size, size, selected, () => this.clickEquip(slot));
    card.on('pointerover', () => this.setHover({ where: 'equip', slot })).on('pointerout', () => this.setHover(undefined));
    this.root.add(card);
    const base = item && itemsData.bases[item.baseId];
    if (item && base) this.root.add(this.add.image(x, y, itemIcon(this, base, item.rarity)).setDisplaySize(size - 12, size - 12));
    // Captions of neighbouring cells must not touch: shrink to the cell plus most of the gap.
    this.root.add(fitText(label(this, x, y + size / 2 + 2, name, 12, item ? UI.muted : '#5e574c').setOrigin(0.5, 0), size + 6));
  }

  private buildStashCell(item: Item, x: number, y: number, size: number): void {
    const selected = this.selection?.where === 'stash' && this.selection.id === item.id;
    const card = makeCard(this, x, y, size, size, selected, () => this.clickStash(item.id));
    card.on('pointerover', () => this.setHover({ where: 'stash', id: item.id })).on('pointerout', () => this.setHover(undefined));
    this.root.add(card);
    const base = itemsData.bases[item.baseId];
    // Items above the hero's level are dimmed and show the required level.
    const tooHigh = item.level > (this.character?.level ?? 1);
    if (base) this.root.add(this.add.image(x, y, itemIcon(this, base, item.rarity)).setDisplaySize(size - 10, size - 10).setAlpha(tooHigh ? 0.4 : 1));
    if (tooHigh) this.root.add(label(this, x - size / 2 + 4, y + size / 2 - 16, String(item.level), 11, UI.danger, true).setStroke('#000', 3));
    // Rarity pip in the corner.
    this.root.add(this.add.circle(x + size / 2 - 7, y - size / 2 + 7, 3, Phaser.Display.Color.HexStringToColor(UI.rarity[item.rarity]).color));
  }

  private buildStats(character: CharacterRecord, x: number, y: number, w: number): void {
    const classDef = getClass(content, character.classId);
    const levelMods = levelModifiers(character.level, content.progression);
    const mods = [...heroModifiers(character, itemsData, passiveTree), ...levelMods];
    const mechanics = heroMechanics(character, passiveTree);
    // Keystones (Blood Magic, Crystal Shell, ...) change derived stats; core owns that math.
    const source: StatSource = { baseStats: classDef.baseStats, modifiers: mods, levelModifiers: levelMods, mechanics };
    const weapon = equippedWeapon(character.equipment, itemsData, classDef.weapon);
    this.root.add(heading(this, x, y, t('inv.attributes'), 18));
    const fmt = (v: number, kind: 'int' | 'pct' | 'dec'): string => (kind === 'pct' ? `${Math.round(v * 100)}%` : kind === 'dec' ? formatNumber(v, 1) : String(Math.round(v)));
    const rows: Array<[string, string]> = STAT_ROWS.map(([stat, key, kind]) => [key ? t(key) : resourceText(classDef.resource.id), fmt(deriveStat(source, stat), kind)]);
    const dmg = Object.entries(weapon.damage)
      .map(([type, r]) => `${num(r.min)}–${num(r.max)} ${damageTypeText(type, 'short')}`)
      .join(t('list.separator'));
    rows.push([t('inv.stat.weapon'), dmg]);
    rows.push([t('inv.stat.attacksPerSecond'), formatNumber(computeStat(weapon.attacksPerSecond, mods, 'attackSpeed', ['attack']), 2)]);
    const crit = critStats(mechanics, {
      critChance: computeStat(weapon.critChance, mods, 'critChance', ['attack']),
      critMultiplier: computeStat(content.combat.critMultiplierBase, mods, 'critMultiplier', ['attack']),
    });
    rows.push([t('inv.stat.critChance'), `${formatNumber(crit.critChance * 100, 1)}% ×${formatNumber(crit.critMultiplier, 2)}`]);
    rows.push([t('inv.stat.movementSpeed'), String(Math.round(deriveStat(source, 'movementSpeed')))]);
    // Keystone-only stats: shown only when they differ from the default.
    const leech = leechStats(mechanics);
    if (leech) {
      const cap = Number.isFinite(leech.maxPerSecond) ? t('inv.stat.leechCap', { pct: fmt(leech.maxPerSecond, 'pct') }) : '';
      rows.push([t('inv.stat.lifeLeech'), `${fmt(leech.fraction, 'pct')}${cap}`]);
    }
    const taken = computeStat(1, mods, 'damageTaken');
    if (taken !== 1) rows.push([t('inv.stat.damageTaken'), `×${formatNumber(taken, 2)}`]);
    rows.forEach(([name, value], i) => {
      this.root.add(label(this, x, y + 30 + i * 20, name, UI.size.small, UI.muted));
      this.root.add(label(this, x + w, y + 30 + i * 20, value, UI.size.small, UI.text, true).setOrigin(1, 0));
    });
  }

  private setHover(hover: Selection): void {
    this.hover = hover;
    // On wide screens hovering previews an item; overlays only follow taps. The crafting panel stays on the selection.
    if (!this.detailsArea.overlay && this.tab === 'items') this.buildDetails();
  }

  private setTab(tab: InventoryTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.message = '';
    this.craftAffix = undefined;
    this.craftFlash = undefined;
    this.build();
  }

  private buildCraftDetails(): void {
    const area = this.detailsArea;
    const item = this.itemFor(this.selection);
    if (!item) {
      if (!area.overlay) {
        this.details.add(makeFrame(this, area.x + area.w / 2, area.y + area.h / 2, area.w, area.h, 'panel'));
        this.details.add(
          label(this, area.x + area.w / 2, area.y + area.h / 2, t('craft.pickItem'), UI.size.small, UI.muted)
            .setOrigin(0.5)
            .setAlign('center')
            .setWordWrapWidth(area.w - 32),
        );
      }
      return;
    }
    const owner = this.character;
    const flash = this.craftFlash;
    this.craftFlash = undefined;
    buildCraftPanel(this, this.details, {
      area,
      item,
      profile: this.app.profile,
      data: CRAFT_DATA,
      resourceId: owner ? getClass(content, owner.classId).resource.id : undefined,
      affixIndex: this.craftAffix !== undefined && this.craftAffix < item.affixes.length ? this.craftAffix : undefined,
      flash,
      closable: area.overlay,
      onPickAffix: (index) => {
        this.craftAffix = index;
        this.buildDetails();
      },
      onCraft: (op) => this.craft(item, op),
    });
    if (area.overlay) {
      this.details.add(
        makeButton(this, area.x + area.w - 20, area.y + 20, 30, 30, '✕', () => {
          this.selection = undefined;
          this.craftAffix = undefined;
          this.build();
        }),
      );
    }
  }

  private craft(item: Item, op: CraftOp): void {
    const index = AFFIX_OPS.has(op) ? this.craftAffix : undefined;
    // Same seeding as other client-side rolls (arena rewards): a fresh seed per craft.
    const rng = createRng((Math.random() * 2 ** 32) >>> 0);
    const result = applyCraft(this.app.profile, item.id, op, index === undefined ? {} : { index }, rng, CRAFT_DATA);
    if (!result.ok) {
      // The button is disabled when canCraft fails, so this only happens if the profile changed underneath.
      this.buildDetails();
      return;
    }
    this.app.save();
    const crafted = result.item;
    const lines = op === 'rerollAffix' || op === 'rerollValues' ? (index === undefined ? [] : [index]) : changedAffixes(item.affixes, crafted.affixes);
    this.craftFlash = { lines, title: crafted.rarity !== item.rarity, spent: result.cost };
    // A rerolled affix stays picked (same kind keeps its place); removing or adding affixes shifts the positions.
    if (op !== 'rerollAffix' && op !== 'rerollValues') this.craftAffix = undefined;
    this.build();
  }

  private itemFor(sel: Selection): Item | undefined {
    if (!sel) return undefined;
    if (sel.where === 'stash') return this.app.profile.stash.items.find((i) => i.id === sel.id);
    return this.character?.equipment[sel.slot];
  }

  private buildDetails(): void {
    this.details?.destroy();
    this.details = this.add.container(0, 0).setDepth(50);
    if (this.tab === 'craft') {
      this.buildCraftDetails();
      return;
    }
    const area = this.detailsArea;
    const shown = (!area.overlay && this.hover && this.itemFor(this.hover) ? this.hover : this.selection) as Selection;
    const item = this.itemFor(shown);
    if (!item) {
      if (!area.overlay) {
        this.details.add(makeFrame(this, area.x + area.w / 2, area.y + area.h / 2, area.w, area.h, 'panel'));
        this.details.add(
          label(this, area.x + area.w / 2, area.y + area.h / 2, this.message || t('inv.emptyHint'), UI.size.small, UI.muted)
            .setOrigin(0.5)
            .setAlign('center'),
        );
      }
      return;
    }
    const owner = this.character;
    const tooltip = describeItem(item, itemsData, owner ? getClass(content, owner.classId).resource.id : undefined);
    const pad = 16;
    const x = area.x + pad;
    let y = area.y + pad;
    const w = area.w - pad * 2;
    const parts: Phaser.GameObjects.GameObject[] = [];
    const color = UI.rarity[tooltip.rarity];
    parts.push(label(this, area.x + area.w / 2, y, tooltip.title, UI.size.heading, color, true).setOrigin(0.5, 0));
    y += 26;
    if (tooltip.subtitle) {
      parts.push(label(this, area.x + area.w / 2, y, tooltip.subtitle, UI.size.small, color).setOrigin(0.5, 0));
      y += 20;
    }
    parts.push(label(this, area.x + area.w / 2, y, upper(rarityLabel(tooltip.rarity)), 11, UI.muted).setOrigin(0.5, 0));
    y += 22;
    let lastKind = '';
    for (const line of tooltip.lines) {
      if (lastKind && line.kind !== lastKind) {
        parts.push(this.add.rectangle(area.x + area.w / 2, y + 4, w * 0.8, 1, 0x5a4320));
        y += 10;
      }
      lastKind = line.kind;
      const tooHigh = line.kind === 'meta' && item.level > (this.character?.level ?? 1);
      const tone = tooHigh ? UI.danger : line.kind === 'implicit' ? '#b9d4ff' : line.kind === 'affix' ? '#8fb3ff' : line.kind === 'meta' ? UI.muted : UI.text;
      const text = label(this, x, y, line.text, line.kind === 'meta' ? 12 : UI.size.small, tone, line.kind === 'affix').setWordWrapWidth(w);
      parts.push(text);
      y += text.height + 1;
      if (line.detail) {
        parts.push(label(this, x + 8, y, line.detail, 11, '#7a7262'));
        y += 15;
      }
      y += 3;
    }

    // Actions (only for the selected item, not a hover preview).
    const isSelected = sameSelection(shown, this.selection);
    const buttonsY = area.y + area.h - pad - 22;
    // Long tooltips on short screens (and longer translations): the text block shrinks, kept centred, so it never
    // runs under the buttons.
    const textBottom = buttonsY - 30 - (this.message ? 22 : 0);
    const body = this.add.container(0, 0, parts.splice(0));
    if (y > textBottom && y > area.y) {
      const s = Math.max(0.6, (textBottom - area.y) / (y - area.y));
      body.setScale(s).setPosition((area.x + area.w / 2) * (1 - s), area.y * (1 - s));
    }
    parts.push(body);
    if (this.message) parts.push(label(this, area.x + area.w / 2, buttonsY - 38, this.message, UI.size.small, UI.danger).setOrigin(0.5));
    if (isSelected && this.selection?.where === 'stash') {
      const id = this.selection.id;
      const bw = (w - 10) / 2;
      parts.push(makeButton(this, x + bw / 2, buttonsY, bw, 40, t('inv.equip'), () => this.equip(id), 'primary'));
      parts.push(makeButton(this, x + bw * 1.5 + 10, buttonsY, bw, 40, t('inv.salvage', { value: itemsData.rules.salvage[item.rarity] }), () => this.salvage(item), 'danger'));
    } else if (isSelected && this.selection?.where === 'equip') {
      const slot = this.selection.slot;
      parts.push(makeButton(this, area.x + area.w / 2, buttonsY, Math.min(200, w), 40, t('inv.unequip'), () => this.unequip(slot)));
    } else {
      parts.push(label(this, area.x + area.w / 2, buttonsY, t('inv.clickToSelect'), 12, UI.muted).setOrigin(0.5));
    }

    const panelH = area.overlay ? Math.min(area.h, buttonsY - area.y + 34) : area.h;
    this.details.add(makeFrame(this, area.x + area.w / 2, area.y + panelH / 2, area.w, panelH, 'panel'));
    if (area.overlay) {
      const close = makeButton(this, area.x + area.w - 20, area.y + 20, 30, 30, '✕', () => {
        this.selection = undefined;
        this.message = '';
        this.build();
      });
      parts.push(close);
    }
    this.details.add(parts);
  }

  private isDoubleClick(key: string): boolean {
    const now = this.elapsed;
    const double = this.lastClick.key === key && now - this.lastClick.time < 0.35;
    this.lastClick = { key, time: now };
    return double;
  }

  /** Craft tab: picking an item never equips; a new item drops the picked affix. */
  private pickForCraft(selection: Selection): void {
    if (!sameSelection(selection, this.selection)) this.craftAffix = undefined;
    this.selection = selection;
    this.build();
  }

  private clickStash(id: string): void {
    this.message = '';
    if (this.tab === 'craft') {
      this.pickForCraft({ where: 'stash', id });
      return;
    }
    if (this.isDoubleClick(`s:${id}`)) {
      this.equip(id);
      return;
    }
    this.selection = { where: 'stash', id };
    this.build();
  }

  private clickEquip(slot: EquipSlot): void {
    this.message = '';
    if (!this.character?.equipment[slot]) {
      this.selection = undefined;
      this.build();
      return;
    }
    if (this.tab === 'craft') {
      this.pickForCraft({ where: 'equip', slot });
      return;
    }
    if (this.isDoubleClick(`e:${slot}`)) {
      this.unequip(slot);
      return;
    }
    this.selection = { where: 'equip', slot };
    this.build();
  }

  private equip(itemId: string): void {
    const character = this.character;
    if (!character) return;
    const classDef = getClass(content, character.classId);
    const error = equipFromStash(this.app.profile, character.id, itemId, classDef.weaponType, itemsData);
    this.afterChange(error);
  }

  private unequip(slot: EquipSlot): void {
    const error = unequipToStash(this.app.profile, this.characterId, slot, itemsData);
    this.afterChange(error);
  }

  private salvage(item: Item): void {
    const run = (): void => {
      salvageFromStash(this.app.profile, item.id, itemsData);
      this.afterChange(null);
    };
    // Valuable items ask first.
    if (item.rarity === 'normal' || item.rarity === 'magic') run();
    else confirmDialog(this, t('inv.salvageConfirm', { name: itemName(item) }), t('inv.salvageButton'), run);
  }

  private afterChange(error: InventoryError | null): void {
    if (error) {
      this.message = t(ERROR_KEY[error]);
    } else {
      this.message = '';
      this.selection = undefined;
      this.app.save();
    }
    this.build();
  }

  private back(): void {
    this.scene.start('main-menu');
  }
}

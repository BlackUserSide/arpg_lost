import * as Phaser from 'phaser';
import { equippedWeapon } from '../core/items/equipment';
import { equipFromStash, salvageFromStash, SALVAGE_CURRENCY, unequipToStash, type InventoryError } from '../core/items/inventory';
import type { EquipSlot, Item } from '../core/items/types';
import { heroModifiers } from '../core/progression/hero';
import { levelModifiers, xpToNextLevel } from '../core/progression/levels';
import { findCharacter, type CharacterRecord } from '../core/progression/profile';
import { computeStat } from '../core/stats/modifiers';
import type { StatId } from '../core/stats/types';
import { getClass } from '../core/world/world';
import { content } from '../data';
import { itemsData } from '../data/items';
import { passiveTree } from '../data/passives';
import { getApp, type App } from './app';
import { itemIcon } from './itemIcons';
import { describeItem } from './itemText';
import { CLASS_LOOKS, loadSprites, ORIGIN_Y, spriteFrame, textureKey } from './sprites';
import { confirmDialog, fadeIn, heading, label, makeButton, makeCard, makeFrame, UI } from './ui';

// Paper doll (8 slots) + shared stash + item details. Select-then-act controls so it works by touch;
// double click / double tap equips or unequips directly.

type Selection = { where: 'stash'; id: string } | { where: 'equip'; slot: EquipSlot } | undefined;

const DOLL: ReadonlyArray<{ slot: EquipSlot; col: number; row: number; name: string }> = [
  { slot: 'weapon', col: 0, row: 0, name: 'Weapon' },
  { slot: 'helmet', col: 1, row: 0, name: 'Helmet' },
  { slot: 'amulet', col: 2, row: 0, name: 'Amulet' },
  { slot: 'gloves', col: 0, row: 1, name: 'Gloves' },
  { slot: 'armour', col: 1, row: 1, name: 'Armour' },
  { slot: 'ring1', col: 2, row: 1, name: 'Ring' },
  { slot: 'boots', col: 1, row: 2, name: 'Boots' },
  { slot: 'ring2', col: 2, row: 2, name: 'Ring' },
];

const ERRORS: Record<InventoryError, string> = {
  'wrong-slot': 'That does not go there.',
  level: 'Your level is too low for this item.',
  'weapon-type': 'Your class cannot wield this weapon.',
  'unknown-base': 'Unknown item.',
  'stash-full': 'Your stash is full.',
  'no-item': 'Nothing selected.',
  'no-character': 'No hero selected.',
};

const STAT_ROWS: ReadonlyArray<[StatId, string, 'int' | 'pct' | 'dec']> = [
  ['life', 'Life', 'int'],
  ['energyShield', 'Energy Shield', 'int'],
  ['mana', 'Mana', 'int'],
  ['armour', 'Armour', 'int'],
  ['fireResistance', 'Fire Res', 'pct'],
  ['coldResistance', 'Cold Res', 'pct'],
  ['lightningResistance', 'Lightning Res', 'pct'],
  ['lifeRegen', 'Life Regen', 'dec'],
];

function levelLine(character: CharacterRecord): string {
  const next = xpToNextLevel(character.level, content.progression);
  return Number.isFinite(next) ? `Level ${character.level} · ${Math.floor(character.xp)} / ${next} XP` : `Level ${character.level}`;
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

  constructor() {
    super('inventory');
  }

  init(data: { characterId?: string }): void {
    if (data.characterId) this.characterId = data.characterId;
    this.selection = undefined;
    this.hover = undefined;
    this.message = '';
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

    const title = heading(this, m + 4, compact ? 4 : 12, compact ? character.name : `${character.name} — ${look?.name ?? ''}`, compact ? 24 : 34);
    this.root.add(title);
    this.root.add(label(this, title.x + title.width + 16, title.y + title.height - (compact ? 20 : 26), levelLine(character), UI.size.small, UI.goldBrightText));
    this.root.add(makeButton(this, width - m - 60, titleH / 2 + (compact ? 0 : 4), 110, compact ? 34 : 42, 'Back', () => this.back()));

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
      this.buildSlot(character, d.slot, d.name, x, y, cell);
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
    const headerH = compact ? 30 : 44;
    const sCell = Math.floor(Math.min(compact ? 48 : 66, (avail - headerH - 24) / rows - (compact ? 4 : 6)));
    const sGap = compact ? 4 : 6;
    const stashW = cols * sCell + (cols - 1) * sGap + 28;
    const stashX = dollX + dollW / 2 + (compact ? 8 : 16) + stashW / 2;
    this.root.add(makeFrame(this, stashX, top + avail / 2, stashW, avail, 'panel'));
    const items = this.app.profile.stash.items;
    this.root.add(heading(this, stashX - stashW / 2 + 14, top + 8, 'Stash', compact ? 18 : 22));
    this.root.add(
      label(this, stashX + stashW / 2 - 14, top + (compact ? 10 : 14), `${items.length}/${rules.stashSize}   ◆ ${this.app.profile.currency[SALVAGE_CURRENCY] ?? 0} shards`, UI.size.small, UI.muted).setOrigin(1, 0),
    );
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
    this.detailsArea =
      spare >= 280
        ? { x: detailsLeft, y: top, w: spare, h: avail, overlay: false }
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
    this.root.add(label(this, x, y + size / 2 + 2, name, 12, item ? UI.muted : '#5e574c').setOrigin(0.5, 0));
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
    const mods = [...heroModifiers(character, itemsData, passiveTree), ...levelModifiers(character.level, content.progression)];
    const weapon = equippedWeapon(character.equipment, itemsData, classDef.weapon);
    this.root.add(heading(this, x, y, 'Attributes', 18));
    const fmt = (v: number, kind: 'int' | 'pct' | 'dec'): string => (kind === 'pct' ? `${Math.round(v * 100)}%` : kind === 'dec' ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)));
    const rows: Array<[string, string]> = STAT_ROWS.map(([stat, name, kind]) => [name, fmt(computeStat(classDef.baseStats[stat] ?? 0, mods, stat), kind)]);
    const dmg = Object.entries(weapon.damage).map(([type, r]) => `${r.min}–${r.max} ${type.slice(0, 4)}`).join(', ');
    rows.push(['Weapon', dmg]);
    rows.push(['Attacks/sec', computeStat(weapon.attacksPerSecond, mods, 'attackSpeed', ['attack']).toFixed(2)]);
    rows.push(['Crit chance', `${(computeStat(weapon.critChance, mods, 'critChance', ['attack']) * 100).toFixed(1)}%`]);
    rows.push(['Move speed', String(Math.round(computeStat(classDef.baseStats.movementSpeed ?? 0, mods, 'movementSpeed')))]);
    rows.forEach(([name, value], i) => {
      this.root.add(label(this, x, y + 30 + i * 20, name, UI.size.small, UI.muted));
      this.root.add(label(this, x + w, y + 30 + i * 20, value, UI.size.small, UI.text, true).setOrigin(1, 0));
    });
  }

  private setHover(hover: Selection): void {
    this.hover = hover;
    // On wide screens hovering previews an item; overlays only follow taps.
    if (!this.detailsArea.overlay) this.buildDetails();
  }

  private itemFor(sel: Selection): Item | undefined {
    if (!sel) return undefined;
    if (sel.where === 'stash') return this.app.profile.stash.items.find((i) => i.id === sel.id);
    return this.character?.equipment[sel.slot];
  }

  private buildDetails(): void {
    this.details?.destroy();
    this.details = this.add.container(0, 0).setDepth(50);
    const area = this.detailsArea;
    const shown = (!area.overlay && this.hover && this.itemFor(this.hover) ? this.hover : this.selection) as Selection;
    const item = this.itemFor(shown);
    if (!item) {
      if (!area.overlay) {
        this.details.add(makeFrame(this, area.x + area.w / 2, area.y + area.h / 2, area.w, area.h, 'panel'));
        this.details.add(
          label(this, area.x + area.w / 2, area.y + area.h / 2, this.message || 'Select an item.\nDouble-click to equip or unequip.', UI.size.small, UI.muted)
            .setOrigin(0.5)
            .setAlign('center'),
        );
      }
      return;
    }
    const tooltip = describeItem(item, itemsData);
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
    parts.push(label(this, area.x + area.w / 2, y, tooltip.rarity.toUpperCase(), 11, UI.muted).setOrigin(0.5, 0));
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
    if (this.message) parts.push(label(this, area.x + area.w / 2, buttonsY - 38, this.message, UI.size.small, UI.danger).setOrigin(0.5));
    if (isSelected && this.selection?.where === 'stash') {
      const id = this.selection.id;
      const bw = (w - 10) / 2;
      parts.push(makeButton(this, x + bw / 2, buttonsY, bw, 40, 'Equip', () => this.equip(id), 'primary'));
      parts.push(makeButton(this, x + bw * 1.5 + 10, buttonsY, bw, 40, `Salvage +${itemsData.rules.salvage[item.rarity]}`, () => this.salvage(item), 'danger'));
    } else if (isSelected && this.selection?.where === 'equip') {
      const slot = this.selection.slot;
      parts.push(makeButton(this, area.x + area.w / 2, buttonsY, Math.min(200, w), 40, 'Unequip', () => this.unequip(slot)));
    } else {
      parts.push(label(this, area.x + area.w / 2, buttonsY, 'Click to select', 12, UI.muted).setOrigin(0.5));
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

  private clickStash(id: string): void {
    this.message = '';
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
    else confirmDialog(this, `Salvage ${item.name}?`, 'Salvage', run);
  }

  private afterChange(error: InventoryError | null): void {
    if (error) {
      this.message = ERRORS[error];
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

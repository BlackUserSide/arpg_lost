import * as Phaser from 'phaser';
import { SALVAGE_CURRENCY } from '../core/items/inventory';
import { heroMechanics } from '../core/progression/hero';
import { findCharacter, type CharacterRecord } from '../core/progression/profile';
import {
  salvageSupport,
  socketedSupports,
  socketSupport,
  supportInSlot,
  supportSalvageValue,
  unsocketSupport,
  validateSockets,
  type SupportOwner,
} from '../core/supports/tab';
import type { SupportData, SupportDef, SupportItem } from '../core/supports/types';
import { actionCost, classSkillProgress, deriveFromMechanics, getClass, type ActionSet } from '../core/world/world';
import type { ActionDef, ClassDef } from '../core/world/content';
import { content } from '../data';
import { passiveTree } from '../data/passives';
import { getApp, type App } from './app';
import { skillIcon } from './hudIcons';
import { num, shardsWord } from './passiveText';
import { formatCost, resourceNames } from './resourceText';
import { supportIcon, tierColor } from './supportIcons';
import {
  compatibleSkillNames,
  costMultiplierText,
  describeSupportBonus,
  describeSupportTier,
  GROUP_LABEL,
  SALVAGE_SUPPORT_ERRORS,
  SOCKET_ERRORS,
  supportTitle,
  tierLabel,
} from './supportText';
import { confirmDialog, fadeIn, frameTexture, heading, label, makeButton, makeCard, makeFrame, UI } from './ui';

// Skill modifiers screen (docs/design/skill-modifiers.md): the hero's supports tab and the 3 class skills with their
// slots. Select-then-act so it works by touch: tap a support, then a compatible slot (incompatible slots are
// disabled); tap a skill for its details. Hover only previews (desktop). Every rule is a core call (socketSupport,
// unsocketSupport, salvageSupport); this file only draws, forwards intents and saves.

export interface SupportsSceneData {
  characterId: string;
  /** Hub screen to return to. */
  returnTo?: 'main-menu' | 'inventory';
}

type Selection = { kind: 'support'; id: string } | { kind: 'skill'; id: string } | undefined;

/** Display order of the groups in the tab. */
const GROUP_ORDER: Record<SupportDef['group'], number> = { melee: 0, projectile: 1, spell: 2, general: 3 };
const EMBER = 0xff7a2a;
const AFFIX_TEXT = '#8fb3ff';

/** A support item with its def (unknown defs are dropped by the save loader, but stay safe here). */
interface Owned {
  item: SupportItem;
  def: SupportDef;
}

export class SupportsScene extends Phaser.Scene {
  private app!: App;
  private characterId = '';
  private returnTo: 'main-menu' | 'inventory' = 'main-menu';
  private selection: Selection;
  private hover: Selection;
  private message = '';
  /** Message tone: errors in red, confirmations in gold. */
  private messageTone: 'error' | 'info' = 'error';
  /** Slot that just received a support (pulses once after the rebuild). */
  private justSocketed: string | undefined;
  private root!: Phaser.GameObjects.Container;
  private details!: Phaser.GameObjects.Container;
  private detailsArea = { x: 0, y: 0, w: 0, h: 0, overlay: false };
  private compact = false;

  constructor() {
    super('supports');
  }

  init(data: Partial<SupportsSceneData>): void {
    if (data.characterId) this.characterId = data.characterId;
    this.returnTo = data.returnTo ?? 'main-menu';
    this.selection = undefined;
    this.hover = undefined;
    this.message = '';
    this.justSocketed = undefined;
  }

  create(): void {
    this.app = getApp(this);
    this.cameras.main.setBackgroundColor(UI.bg);
    const character = this.character;
    const data = this.supportData;
    if (character && data && validateSockets(character, getClass(content, character.classId), data).length > 0) this.app.save();
    this.build();
    fadeIn(this);
    const rebuild = (): void => this.build();
    this.scale.on('resize', rebuild);
    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.selection) {
        this.selection = undefined;
        this.message = '';
        this.build();
      } else this.back();
    });
    this.events.once('shutdown', () => this.scale.off('resize', rebuild));
  }

  private get character(): CharacterRecord | undefined {
    return findCharacter(this.app.profile, this.characterId);
  }

  /** Support rules and defs (Content.supports). */
  private get supportData(): SupportData | undefined {
    return content.supports;
  }

  private owned(character: CharacterRecord, data: SupportData): Owned[] {
    const list: Owned[] = [];
    for (const item of character.supports) {
      const def = data.supports[item.defId];
      if (def) list.push({ item, def });
    }
    return list.sort(
      (a, b) => GROUP_ORDER[a.def.group] - GROUP_ORDER[b.def.group] || a.def.name.localeCompare(b.def.name, 'uk') || b.item.tier - a.item.tier || a.item.id.localeCompare(b.item.id),
    );
  }

  /** Effective skills without and with the socketed supports (passives and skill levels in both): for costs. */
  private skillSets(character: CharacterRecord, classDef: ClassDef): { base: ActionSet; current: ActionSet; mechanics: ReturnType<typeof heroMechanics> } {
    const mechanics = heroMechanics(character, passiveTree);
    const skillProgress = content.skillLevels ? classSkillProgress(classDef, character.skills, content.skillLevels.rules) : {};
    const base = deriveFromMechanics(content, classDef, { mechanics, skillProgress, supports: {} }).actions;
    const current = deriveFromMechanics(content, classDef, { mechanics, skillProgress, supports: socketedSupports(character) }).actions;
    return { base, current, mechanics };
  }

  private build(): void {
    // The target slots pulse forever: stop those tweens with the objects they animate.
    this.tweens.killAll();
    this.root?.destroy();
    this.details?.destroy();
    this.root = this.add.container(0, 0);
    const character = this.character;
    const data = this.supportData;
    if (!character || !data) {
      this.back();
      return;
    }
    const classDef = getClass(content, character.classId);
    const { width, height } = this.scale;
    const compact = width < 1100 || height < 600;
    this.compact = compact;
    const m = compact ? 10 : 24;
    const titleH = compact ? 44 : 64;

    const title = heading(this, m + 4, compact ? 6 : 12, 'Модифікатори', compact ? 24 : 34);
    this.root.add(title);
    const shards = this.app.profile.currency[SALVAGE_CURRENCY] ?? 0;
    this.root.add(label(this, title.x + title.width + 14, title.y + title.height - (compact ? 20 : 26), `${character.name}  ·  ◆ ${shardsWord(shards)}`, UI.size.small, UI.goldBrightText));
    this.root.add(makeButton(this, width - m - 55, titleH / 2 + (compact ? 0 : 4), 110, compact ? 36 : 42, 'Назад', () => this.back()));

    const top = titleH + (compact ? 0 : 6);
    const avail = height - top - m;
    const gap = compact ? 8 : 16;

    // Left: the class skills and their slots.
    const skillsW = Math.round(compact ? Phaser.Math.Clamp(width * 0.4, 270, 360) : 430);
    this.buildSkills(character, classDef, data, m, top, skillsW, avail);

    // Right: the tab grid, details under it (or over it when there is no room).
    const rightX = m + skillsW + gap;
    const rightW = width - m - rightX;
    const cols = rightW >= 10 * 44 + 28 ? 10 : 6;
    const cellGap = compact ? 4 : 6;
    const cell = Math.floor(Math.min(compact ? 48 : 60, (rightW - 28 - (cols - 1) * cellGap) / cols));
    const rows = Math.ceil(data.rules.tabSize / cols);
    const headerH = compact ? 30 : 40;
    const gridH = headerH + rows * (cell + cellGap) - cellGap + 18;
    this.buildTab(character, data, rightX, top, rightW, gridH, cols, cell, cellGap, headerH);

    const detailsTop = top + gridH + gap;
    const detailsH = avail - gridH - gap;
    this.detailsArea = detailsH >= 190 ? { x: rightX, y: detailsTop, w: rightW, h: detailsH, overlay: false } : { x: rightX, y: top, w: rightW, h: avail, overlay: true };
    if (this.detailsArea.overlay && !this.selection) {
      // Short screens: the details only open over the tab on a tap; the hint (or the last message) sits under it.
      const hint = character.supports.length === 0 ? 'Модифікатори випадають з ворогів. Якщо герой загине, знахідки забігу втрачаються.' : 'Торкніться модифікатора, потім — слота скіла.';
      const text = this.message || hint;
      const color = this.message ? this.messageColor() : UI.muted;
      this.root.add(label(this, rightX + rightW / 2, top + gridH + 10, text, UI.size.small, color).setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(rightW - 20));
    }
    this.buildDetails();
  }

  // ---- Skills -----------------------------------------------------------------------------------------

  private buildSkills(character: CharacterRecord, classDef: ClassDef, data: SupportData, x: number, y: number, w: number, h: number): void {
    const compact = this.compact;
    this.root.add(makeFrame(this, x + w / 2, y + h / 2, w, h, 'panel'));
    const headerH = compact ? 30 : 42;
    this.root.add(heading(this, x + 14, y + 8, 'Скіли', compact ? 18 : 22));
    const resource = resourceNames(classDef.resource.id);
    const { base, current, mechanics } = this.skillSets(character, classDef);
    const skills = classDef.skills;
    const rowGap = compact ? 6 : 10;
    const rowH = Math.floor((h - headerH - 12 - rowGap * (skills.length - 1)) / Math.max(1, skills.length));
    const slots = data.rules.slotsPerSkill;
    const slotS = Math.floor(Math.min(compact ? 52 : 66, rowH - (compact ? 14 : 22), (w - 24) * 0.2));
    const slotGap = compact ? 6 : 10;
    const selected = this.selectedSupport(character);

    skills.forEach((skill, i) => {
      const rowY = y + headerH + 4 + i * (rowH + rowGap);
      const cy = rowY + rowH / 2;
      const rowW = w - 20;
      const isSkillSelected = this.selection?.kind === 'skill' && this.selection.id === skill.id;
      const card = makeCard(this, x + w / 2, cy, rowW, rowH, isSkillSelected, () => this.clickSkill(skill.id));
      card.on('pointerover', () => this.setHover({ kind: 'skill', id: skill.id })).on('pointerout', () => this.setHover(undefined));
      this.root.add(card);
      const iconS = Math.min(rowH - 16, compact ? 40 : 52);
      const left = x + 10 + 10;
      this.root.add(this.add.image(left + iconS / 2, cy, skillIcon(this, skill.id)).setDisplaySize(iconS, iconS));
      const textX = left + iconS + 10;
      const slotsLeft = x + w - 10 - 10 - slots * slotS - (slots - 1) * slotGap;
      const textW = slotsLeft - textX - 6;
      const name = label(this, textX, cy - (compact ? 18 : 22), skill.name ?? skill.id, compact ? UI.size.body : UI.size.heading - 2, UI.text, true);
      name.setWordWrapWidth(textW);
      if (name.height > 24) name.setFontSize(UI.size.small).setY(cy - 20);
      this.root.add(name);
      const baseAction = base.skills[i] ?? skill;
      const action = current.skills[i] ?? skill;
      const cost = label(this, textX, cy + (compact ? 2 : 4), this.costLine(baseAction, action, mechanics, resource.uk), UI.size.small, UI.muted).setWordWrapWidth(textW);
      this.root.add(cost);
      // Socketed supports by name, when the row has room for a line.
      const names = Array.from({ length: slots }, (_, s) => supportInSlot(character, skill.id, s)).flatMap((item) => (item && data.supports[item.defId] ? [supportTitle(data.supports[item.defId]!, item.tier)] : []));
      if (names.length > 0 && rowH >= 96) {
        this.root.add(label(this, textX, cost.y + cost.height + 4, names.join('  ·  '), UI.size.small, UI.goldText).setWordWrapWidth(textW));
      }

      for (let s = 0; s < slots; s++) {
        const sx = slotsLeft + slotS / 2 + s * (slotS + slotGap);
        this.buildSlot(character, classDef, data, skill, s, sx, cy, slotS, selected);
      }
    });
  }

  /** "Мана: 20 → 29": cost before and after the socketed supports (rounded, see formatCost). */
  private costLine(baseAction: ActionDef, action: ActionDef, mechanics: ReturnType<typeof heroMechanics>, resourceName: string): string {
    const before = actionCost(mechanics, baseAction.resourceCost);
    const after = actionCost(mechanics, action.resourceCost);
    const name = after.pool === 'life' ? 'Життя' : resourceName;
    if (after.amount <= 0) return `${name}: безкоштовно`;
    const a = formatCost(before.amount);
    const b = formatCost(after.amount);
    return a === b && Math.abs(before.amount - after.amount) < 1e-9 ? `${name}: ${b}` : `${name}: ${a} → ${b}`;
  }

  private selectedSupport(character: CharacterRecord): SupportItem | undefined {
    const sel = this.selection;
    return sel?.kind === 'support' ? character.supports.find((s) => s.id === sel.id) : undefined;
  }

  /** Whether socketing `supportId` into the slot would succeed: core decides, on a throwaway copy of the tab. */
  private canSocket(character: CharacterRecord, classDef: ClassDef, data: SupportData, supportId: string, skillId: string, slot: number): boolean {
    const probe: SupportOwner = { supports: character.supports.map((s) => (s.socket ? { ...s, socket: { ...s.socket } } : { id: s.id, defId: s.defId, tier: s.tier })) };
    return socketSupport(probe, supportId, skillId, slot, classDef, data) === null;
  }

  private buildSlot(character: CharacterRecord, classDef: ClassDef, data: SupportData, skill: ActionDef, slot: number, x: number, y: number, size: number, selected: SupportItem | undefined): void {
    const item = supportInSlot(character, skill.id, slot);
    const def = item ? data.supports[item.defId] : undefined;
    const key = `${skill.id}#${slot}`;
    const holdsSelected = selected !== undefined && item?.id === selected.id;
    // With a support picked: compatible slots invite a tap, the rest are disabled.
    const target = selected !== undefined && !holdsSelected && this.canSocket(character, classDef, data, selected.id, skill.id, slot);
    const disabled = selected !== undefined && !holdsSelected && !target;
    const parts: Phaser.GameObjects.GameObject[] = [];
    if (disabled) {
      parts.push(this.add.image(x, y, frameTexture(this, size, size, 'card')).setAlpha(0.35));
    } else {
      const card = makeCard(this, x, y, size, size, holdsSelected || (this.selection?.kind === 'support' && item?.id === this.selection.id), () => this.clickSlot(skill.id, slot));
      if (item) card.on('pointerover', () => this.setHover({ kind: 'support', id: item.id })).on('pointerout', () => this.setHover(undefined));
      parts.push(card);
    }
    if (item && def) {
      parts.push(this.add.image(x, y, supportIcon(this, def, item.tier)).setDisplaySize(size - 10, size - 10).setAlpha(disabled ? 0.35 : 1));
    } else {
      parts.push(heading(this, x, y, '+', Math.round(size * 0.42)).setOrigin(0.5).setAlpha(disabled ? 0.2 : target ? 0.9 : 0.35));
    }
    if (target) {
      // Pulsing ember outline on every slot the picked support can go into.
      const ring = this.add.rectangle(x, y, size + 4, size + 4).setStrokeStyle(2, EMBER, 1).setFillStyle(EMBER, 0.08);
      this.tweens.add({ targets: ring, alpha: 0.35, duration: 520, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      parts.push(ring);
    }
    this.root.add(parts);
    if (this.justSocketed === key) {
      this.justSocketed = undefined;
      const flash = this.add.rectangle(x, y, size, size, 0xfff0c0, 0.6).setBlendMode(Phaser.BlendModes.ADD);
      this.root.add(flash);
      this.tweens.add({ targets: flash, alpha: 0, scale: 1.3, duration: 380, ease: 'Quad.easeOut', onComplete: () => flash.destroy() });
    }
  }

  // ---- Tab --------------------------------------------------------------------------------------------

  private buildTab(character: CharacterRecord, data: SupportData, x: number, y: number, w: number, h: number, cols: number, cell: number, cellGap: number, headerH: number): void {
    this.root.add(makeFrame(this, x + w / 2, y + h / 2, w, h, 'panel'));
    const owned = this.owned(character, data);
    this.root.add(heading(this, x + 14, y + 8, 'Вкладка', this.compact ? 18 : 22));
    this.root.add(label(this, x + w - 14, y + (this.compact ? 10 : 14), `${character.supports.length}/${data.rules.tabSize}`, UI.size.small, UI.muted).setOrigin(1, 0));
    const gridW = cols * cell + (cols - 1) * cellGap;
    const left = x + (w - gridW) / 2;
    for (let i = 0; i < data.rules.tabSize; i++) {
      const cx = left + cell / 2 + (i % cols) * (cell + cellGap);
      const cy = y + headerH + cell / 2 + Math.floor(i / cols) * (cell + cellGap);
      const entry = owned[i];
      if (!entry) {
        this.root.add(this.add.rectangle(cx, cy, cell, cell, 0x000000, 0.35).setStrokeStyle(1, 0x2a2430));
        continue;
      }
      const { item, def } = entry;
      const isSelected = this.selection?.kind === 'support' && this.selection.id === item.id;
      const card = makeCard(this, cx, cy, cell, cell, isSelected, () => this.clickSupport(item.id));
      card.on('pointerover', () => this.setHover({ kind: 'support', id: item.id })).on('pointerout', () => this.setHover(undefined));
      this.root.add(card);
      this.root.add(this.add.image(cx, cy, supportIcon(this, def, item.tier)).setDisplaySize(cell - 8, cell - 8).setAlpha(item.socket ? 0.55 : 1));
      if (item.socket) {
        // Socketed: the skill's icon as a badge in the corner.
        const b = Math.max(14, Math.round(cell * 0.36));
        const bx = cx + cell / 2 - b / 2 - 2;
        const by = cy - cell / 2 + b / 2 + 2;
        this.root.add(this.add.rectangle(bx, by, b + 2, b + 2, 0x000000, 0.9).setStrokeStyle(1, UI.gold));
        this.root.add(this.add.image(bx, by, skillIcon(this, item.socket.skillId)).setDisplaySize(b, b));
      }
    }
  }

  // ---- Details ----------------------------------------------------------------------------------------

  private setHover(hover: Selection): void {
    this.hover = hover;
    // On wide screens hovering previews; overlays only follow taps.
    if (!this.detailsArea.overlay) this.buildDetails();
  }

  private buildDetails(): void {
    this.details?.destroy();
    this.details = this.add.container(0, 0).setDepth(50);
    const character = this.character;
    const data = this.supportData;
    if (!character || !data) return;
    const area = this.detailsArea;
    const shown = !area.overlay && this.hover ? this.hover : this.selection;
    const isSelected = shown !== undefined && this.selection !== undefined && shown.kind === this.selection.kind && shown.id === this.selection.id;
    if (!shown) {
      if (!area.overlay) {
        this.details.add(makeFrame(this, area.x + area.w / 2, area.y + area.h / 2, area.w, area.h, 'panel'));
        const empty = character.supports.length === 0;
        const hint = empty
          ? 'Модифікаторів ще немає.\nВони випадають з ворогів у забігах, частіше з еліт і боса.\nЯкщо герой загине, знайдені за забіг модифікатори втрачаються.'
          : 'Оберіть модифікатор у вкладці, потім — слот скіла ліворуч.\nМодифікатори міняються лише в хабі, вільно й без втрат.';
        const text = label(this, area.x + area.w / 2, area.y + area.h / 2, this.message || hint, UI.size.small, this.message ? this.messageColor() : UI.muted)
          .setOrigin(0.5)
          .setAlign('center')
          .setWordWrapWidth(area.w - 40);
        this.details.add(text);
      }
      return;
    }
    const classDef = getClass(content, character.classId);
    const pad = this.compact ? 12 : 16;
    // Text block in a container at the panel's top-left, so a long one can be scaled down to fit as a whole.
    const body = this.add.container(area.x, area.y);
    const x = pad;
    const w = area.w - pad * 2 - (area.overlay ? 34 : 0);
    let y = pad;
    const add = (text: string, size: number, color: string, bold = false, indent = 0): void => {
      const t = label(this, x + indent, y, text, size, color, bold).setWordWrapWidth(w - indent);
      body.add(t);
      y += t.height + 3;
    };
    const rule = (): void => {
      body.add(this.add.rectangle(area.w / 2, y + 3, area.w * 0.8, 1, 0x5a4320));
      y += 9;
    };
    const header = (iconKey: string, title: string, titleColor: string, subtitle: string): void => {
      const iconS = this.compact ? 40 : 52;
      body.add(this.add.image(x + iconS / 2, y + iconS / 2, iconKey).setDisplaySize(iconS, iconS));
      const tx = x + iconS + 10;
      body.add(label(this, tx, y + 2, title, UI.size.heading, titleColor, true).setWordWrapWidth(w - iconS - 10));
      body.add(label(this, tx, y + 28, subtitle, UI.size.small, UI.muted));
      y += iconS + 8;
    };

    const buttons: Phaser.GameObjects.GameObject[] = [];
    let selectedItem: SupportItem | undefined;
    if (shown.kind === 'support') {
      const item = character.supports.find((s) => s.id === shown.id);
      const def = item ? data.supports[item.defId] : undefined;
      if (!item || !def) return;
      header(supportIcon(this, def, item.tier), supportTitle(def, item.tier), tierColor(item.tier), `${GROUP_LABEL[def.group]}  ·  тир ${tierLabel(item.tier)} з ${tierLabel(def.tiers.length)}`);
      add(def.description, UI.size.small, UI.text);
      rule();
      const tier = def.tiers[Math.min(def.tiers.length, Math.max(1, item.tier)) - 1];
      if (tier) {
        const { lines, variants } = describeSupportTier(tier, classDef.resource.id);
        for (const l of lines) add(l, UI.size.small, AFFIX_TEXT, true);
        for (const v of variants) add(v, UI.size.small, UI.muted);
      }
      add(costMultiplierText(def.resourceCostMultiplier), UI.size.small, UI.goldBrightText, true);
      rule();
      const fits = compatibleSkillNames(def, classDef);
      if (fits.length > 0) add(`Підходить: ${fits.join(', ')}`, UI.size.small, UI.text);
      else add('Не підходить до жодного скіла цього героя', UI.size.small, UI.danger, true);
      if (item.socket) {
        const skill = classDef.skills.find((s) => s.id === item.socket?.skillId);
        add(`Вставлено: ${skill?.name ?? item.socket.skillId}, слот ${item.socket.slot + 1}`, UI.size.small, UI.goldBrightText);
      } else if (isSelected && fits.length > 0 && !this.message) {
        add('Торкніться підсвіченого слота скіла ліворуч', UI.size.small, UI.muted);
      }
      if (isSelected) selectedItem = item;
    } else {
      const index = classDef.skills.findIndex((s) => s.id === shown.id);
      const skill = classDef.skills[index];
      if (!skill) return;
      const { base, current, mechanics } = this.skillSets(character, classDef);
      const action = current.skills[index] ?? skill;
      header(skillIcon(this, skill.id), skill.name ?? skill.id, UI.goldBrightText, `Рівень ${character.skills[skill.id]?.level ?? 1}`);
      add(`Вартість — ${this.costLine(base.skills[index] ?? skill, action, mechanics, resourceNames(classDef.resource.id).uk)}`, UI.size.small, UI.text, true);
      if (action.cooldown > 0) add(`Кулдаун: ${num(action.cooldown)} с`, UI.size.small, UI.text);
      rule();
      const socketed = character.supports.filter((s) => s.socket?.skillId === skill.id).sort((a, b) => (a.socket?.slot ?? 0) - (b.socket?.slot ?? 0));
      if (socketed.length === 0) add('Слоти порожні. Оберіть модифікатор у вкладці, щоб вставити його.', UI.size.small, UI.muted);
      for (const s of socketed) {
        const def = data.supports[s.defId];
        if (!def) continue;
        add(`◆ ${supportTitle(def, s.tier)}  ·  ×${num(def.resourceCostMultiplier)}`, UI.size.small, tierColor(s.tier), true);
        const tier = def.tiers[Math.min(def.tiers.length, Math.max(1, s.tier)) - 1];
        for (const l of tier ? describeSupportBonus(tier.bonus, classDef.resource.id) : []) add(l, UI.size.small, AFFIX_TEXT, false, 12);
      }
    }

    const buttonsY = area.y + area.h - pad - 22;
    let bottom = buttonsY - 30;
    if (this.message) {
      const msg = label(this, area.x + area.w / 2, buttonsY - 30, this.message, UI.size.small, this.messageColor()).setOrigin(0.5, 1).setAlign('center').setWordWrapWidth(area.w - 32);
      buttons.push(msg);
      bottom = buttonsY - 34 - msg.height;
    }
    if (selectedItem) this.supportButtons(buttons, selectedItem, data, area, pad);
    else if (!isSelected && !area.overlay) buttons.push(label(this, area.x + area.w / 2, buttonsY, 'Натисніть, щоб обрати', UI.size.small, UI.muted).setOrigin(0.5));
    if (area.overlay) {
      buttons.push(
        makeButton(this, area.x + area.w - 22, area.y + 22, 34, 34, '✕', () => {
          this.selection = undefined;
          this.message = '';
          this.build();
        }),
      );
    }
    // Long effect lists on short screens: the text block shrinks so it never runs under the buttons.
    const room = bottom - area.y;
    if (y > room) body.setScale(Math.max(0.7, room / y));
    this.details.add(makeFrame(this, area.x + area.w / 2, area.y + area.h / 2, area.w, area.h, 'panel'));
    this.details.add(body);
    this.details.add(buttons);
  }

  private supportButtons(parts: Phaser.GameObjects.GameObject[], item: SupportItem, data: SupportData, area: { x: number; y: number; w: number; h: number }, pad: number): void {
    const buttonsY = area.y + area.h - pad - 22;
    const w = area.w - pad * 2;
    const bw = (w - 10) / 2;
    const bx = area.x + pad;
    const value = supportSalvageValue(item, data);
    if (item.socket) {
      parts.push(makeButton(this, bx + bw / 2, buttonsY, bw, 42, 'Витягти', () => this.unsocket(item.id), 'primary'));
      const salvage = makeButton(this, bx + bw * 1.5 + 10, buttonsY, bw, 42, `Розібрати +${value}`, () => undefined, 'danger');
      disableButton(salvage);
      parts.push(salvage);
    } else {
      parts.push(makeButton(this, bx + bw / 2, buttonsY, bw, 42, 'Скасувати', () => this.clickSupport(item.id)));
      parts.push(makeButton(this, bx + bw * 1.5 + 10, buttonsY, bw, 42, `Розібрати +${value}`, () => this.salvage(item), 'danger'));
    }
  }

  private messageColor(): string {
    return this.messageTone === 'error' ? UI.danger : UI.goldBrightText;
  }

  // ---- Intents ----------------------------------------------------------------------------------------

  private clickSupport(id: string): void {
    this.message = '';
    this.selection = this.selection?.kind === 'support' && this.selection.id === id ? undefined : { kind: 'support', id };
    this.build();
  }

  private clickSkill(id: string): void {
    this.message = '';
    this.selection = this.selection?.kind === 'skill' && this.selection.id === id ? undefined : { kind: 'skill', id };
    this.build();
  }

  /**
   * A slot tap: with a support picked, socket it there (core checks the rules); otherwise pick the support in the
   * slot (to see it or take it out), or show the skill for an empty slot.
   */
  private clickSlot(skillId: string, slot: number): void {
    const character = this.character;
    const data = this.supportData;
    if (!character || !data) return;
    const picked = this.selectedSupport(character);
    const inSlot = supportInSlot(character, skillId, slot);
    if (picked && inSlot?.id !== picked.id) {
      const error = socketSupport(character, picked.id, skillId, slot, getClass(content, character.classId), data);
      if (error) {
        this.message = SOCKET_ERRORS[error];
        this.messageTone = 'error';
      } else {
        this.message = '';
        this.selection = undefined;
        this.justSocketed = `${skillId}#${slot}`;
        this.app.save();
      }
      this.build();
      return;
    }
    if (inSlot) this.clickSupport(inSlot.id);
    else this.clickSkill(skillId);
  }

  private unsocket(id: string): void {
    const character = this.character;
    if (!character) return;
    unsocketSupport(character, id);
    this.app.save();
    this.message = '';
    this.build();
  }

  private salvage(item: SupportItem): void {
    const character = this.character;
    const data = this.supportData;
    if (!character || !data) return;
    const run = (): void => {
      const result = salvageSupport(this.app.profile, character, item.id, data);
      if ('error' in result) {
        this.message = SALVAGE_SUPPORT_ERRORS[result.error];
        this.messageTone = 'error';
      } else {
        this.selection = undefined;
        this.message = `Розібрано: +${shardsWord(result.shards)}`;
        this.messageTone = 'info';
        this.app.save();
      }
      this.build();
    };
    // Higher tiers ask first.
    const def = data.supports[item.defId];
    if (item.tier <= 1 || !def) run();
    else confirmDialog(this, `Розібрати «${supportTitle(def, item.tier)}»?`, 'Розібрати', run, 'Скасувати');
  }

  private back(): void {
    this.scene.start(this.returnTo, { characterId: this.characterId });
  }
}

/** A button that reads as unavailable and ignores input. */
function disableButton(button: Phaser.GameObjects.Container): void {
  button.setAlpha(0.4);
  (button.list[0] as Phaser.GameObjects.Image | undefined)?.disableInteractive();
}

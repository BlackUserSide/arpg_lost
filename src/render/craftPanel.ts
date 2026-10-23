import * as Phaser from 'phaser';
import { canCraft, CRAFT_OPS, craftCost, craftCount, ESSENCE_CURRENCY, type CraftCost, type CraftData, type CraftOp } from '../core/items/craft';
import { SALVAGE_CURRENCY } from '../core/items/inventory';
import type { Item } from '../core/items/types';
import type { Profile } from '../core/progression/profile';
import { t, upper } from '../i18n';
import { AFFIX_OPS, costParts, craftEffect, craftReason, CRAFT_OP_NAME, currencyAmount, currencyWord } from './craftText';
import { describeItem, rarityLabel } from './itemText';
import { fitText, label, makeButton, makeFrame, UI } from './ui';

// Crafting tab of the inventory (docs/design/crafting.md): the chosen item with pickable affix lines, the wallet and
// the five operations with cost and, when unavailable, the reason. Core decides availability and cost (canCraft,
// craftCost); this only lays them out. Wide areas get two columns (item | operations), narrow ones stack them.

/** Currency glyphs and their colours (visual only). */
export const CURRENCY_LOOK: Readonly<Record<string, { glyph: string; color: string }>> = {
  [SALVAGE_CURRENCY]: { glyph: '◆', color: '#d9a94a' },
  [ESSENCE_CURRENCY]: { glyph: '✦', color: '#c79bff' },
};
const lookOf = (currency: string): { glyph: string; color: string } => CURRENCY_LOOK[currency] ?? { glyph: '•', color: UI.text };

/** What changed in the last craft, for a one-shot highlight. */
export interface CraftFlash {
  /** Affix positions (in Item.affixes) that are new or rerolled. */
  readonly lines: readonly number[];
  /** Rarity changed: pop the title in its new colour. */
  readonly title: boolean;
  /** What the craft cost, floated up next to the wallet. */
  readonly spent: CraftCost;
}

export interface CraftPanelOptions {
  readonly area: { x: number; y: number; w: number; h: number };
  readonly item: Item;
  readonly profile: Profile;
  readonly data: CraftData;
  /** ClassDef.resource.id of the viewing hero, to name resource stats. */
  readonly resourceId: string | undefined;
  /** The picked affix (position in Item.affixes), if any. */
  readonly affixIndex: number | undefined;
  readonly flash: CraftFlash | undefined;
  /** Leaves room for a close button in the top-right corner. */
  readonly closable: boolean;
  onPickAffix(index: number | undefined): void;
  onCraft(op: CraftOp): void;
}

const TWO_COLUMNS_MIN_W = 560;

/** Every text here has a one-line slot: shrink the font, never wrap, and squeeze as a last resort. */
function oneLine(text: Phaser.GameObjects.Text, maxW: number): Phaser.GameObjects.Text {
  fitText(text, maxW, 0);
  if (text.width > maxW && maxW > 0) text.setScale(maxW / text.width, 1);
  return text;
}
const WALLET_H = 26;

/** Draws the panel into `parent`. */
export function buildCraftPanel(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, o: CraftPanelOptions): void {
  const { area } = o;
  const pad = 14;
  parent.add(makeFrame(scene, area.x + area.w / 2, area.y + area.h / 2, area.w, area.h, 'panel'));
  const columns = area.w >= TWO_COLUMNS_MIN_W;
  let itemBox: Box;
  let opsBox: Box;
  if (columns) {
    const leftW = Math.floor((area.w - pad * 3) * 0.46);
    itemBox = { x: area.x + pad, y: area.y + pad, w: leftW, h: area.h - pad * 2 };
    opsBox = { x: itemBox.x + leftW + pad, y: area.y + pad - 4, w: area.w - pad * 3 - leftW, h: area.h - pad * 2 + 4 };
    parent.add(scene.add.rectangle(opsBox.x - pad / 2, area.y + area.h / 2, 1, area.h - pad * 4, 0x5a4320));
  } else {
    const opsH = WALLET_H + 5 * 54;
    opsBox = { x: area.x + pad, y: area.y + area.h - pad - opsH, w: area.w - pad * 2, h: opsH };
    itemBox = { x: area.x + pad, y: area.y + pad, w: area.w - pad * 2, h: opsBox.y - 10 - area.y - pad };
    parent.add(scene.add.rectangle(area.x + area.w / 2, opsBox.y - 5, area.w * 0.8, 1, 0x5a4320));
  }
  buildItem(scene, parent, o, itemBox);
  buildOps(scene, parent, o, opsBox);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function buildItem(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, o: CraftPanelOptions, box: Box): void {
  const { item } = o;
  const tooltip = describeItem(item, o.data.items, o.resourceId);
  const color = UI.rarity[tooltip.rarity];
  const cx = box.x + box.w / 2;
  const parts: Phaser.GameObjects.GameObject[] = [];
  let y = box.y;
  const title = oneLine(label(scene, cx, y, tooltip.title, UI.size.heading, color, true).setOrigin(0.5, 0), box.w);
  parts.push(title);
  y += title.height + 2;
  if (tooltip.subtitle) {
    parts.push(oneLine(label(scene, cx, y, tooltip.subtitle, UI.size.small, color).setOrigin(0.5, 0), box.w));
    y += 18;
  }
  const count = craftCount(item);
  parts.push(oneLine(label(scene, cx, y, `${upper(rarityLabel(tooltip.rarity))}  ·  ${t('craft.count', { count })}`, 11, UI.muted).setOrigin(0.5, 0), box.w));
  y += 16;
  parts.push(oneLine(label(scene, cx, y, t('craft.growth'), 11, '#7a7262').setOrigin(0.5, 0), box.w));
  y += 20;

  const affixLines = tooltip.lines.filter((l) => l.kind === 'affix');
  const flashes: Phaser.GameObjects.Rectangle[] = [];
  if (affixLines.length === 0) {
    parts.push(label(scene, cx, y + 4, t('craft.noAffixes'), UI.size.small, UI.muted).setOrigin(0.5, 0));
    y += 28;
  }
  for (const line of affixLines) {
    const index = line.affixIndex ?? -1;
    const selected = index === o.affixIndex;
    const text = label(scene, box.x + 8, y + 3, line.text, UI.size.small, selected ? UI.goldBrightText : '#8fb3ff', true).setWordWrapWidth(box.w - 16);
    const detail = line.detail ? label(scene, box.x + 16, y + 3 + text.height, line.detail, 11, '#7a7262') : undefined;
    const h = text.height + (detail ? detail.height : 0) + 6;
    // The whole line is the touch target (at least 30 px high for fingers).
    const hit = scene.add
      .rectangle(box.x + box.w / 2, y + h / 2, box.w, Math.max(h, 30), selected ? 0xd9a94a : 0x000000, selected ? 0.16 : 0.001)
      .setInteractive({ useHandCursor: true });
    if (selected) hit.setStrokeStyle(1, 0xd9a94a, 0.8);
    // Only a press that started on the line counts (a release left over from a button tap must not pick).
    let pressed = false;
    hit.on('pointerdown', () => (pressed = true)).on('pointerup', () => {
      if (pressed) o.onPickAffix(selected ? undefined : index);
      pressed = false;
    });
    hit.on('pointerout', () => (pressed = false));
    if (!selected) hit.on('pointerover', () => hit.setFillStyle(0xd9a94a, 0.07)).on('pointerout', () => hit.setFillStyle(0x000000, 0.001));
    parts.push(hit, text);
    if (detail) parts.push(detail);
    if (o.flash?.lines.includes(index)) {
      const glow = scene.add.rectangle(box.x + box.w / 2, y + h / 2, box.w, h, UI.ember, 0.45);
      parts.push(glow);
      flashes.push(glow);
    }
    y += Math.max(h, 30) + 2;
  }
  if (affixLines.length > 0 && o.affixIndex === undefined) {
    const hint = oneLine(label(scene, cx, y + 2, t('craft.affixHint'), 11, UI.goldText).setOrigin(0.5, 0), box.w);
    parts.push(hint);
    y += 18;
  }
  const meta = tooltip.lines.find((l) => l.kind === 'meta');
  if (meta) {
    y += 4;
    parts.push(oneLine(label(scene, cx, y, meta.text, 11, UI.muted).setOrigin(0.5, 0), box.w));
    y += 16;
  }

  // Many affixes on a short screen: the block shrinks (anchored top-centre) so it never runs into the operations.
  const body = scene.add.container(0, 0, parts);
  if (y > box.y + box.h) {
    const s = Math.max(0.6, box.h / (y - box.y));
    body.setScale(s).setPosition(cx * (1 - s), box.y * (1 - s));
  }
  parent.add(body);

  if (o.flash?.title) {
    title.setScale(1.25);
    scene.tweens.add({ targets: title, scale: 1, duration: 420, ease: 'Back.easeOut' });
  }
  if (flashes.length > 0) scene.tweens.add({ targets: flashes, alpha: 0, duration: 900, ease: 'Quad.easeOut' });
}

function buildOps(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, o: CraftPanelOptions, box: Box): void {
  const wallet = o.profile.currency;
  // Wallet: shards and essence, always both (essence shows 0 until it has a source).
  let x = box.x;
  const walletY = box.y + 4;
  const walletRight = box.x + box.w - (o.closable ? 40 : 0);
  const walletParts: Phaser.GameObjects.Text[] = [];
  for (const currency of [SALVAGE_CURRENCY, ESSENCE_CURRENCY]) {
    const look = lookOf(currency);
    const icon = label(scene, x, walletY, look.glyph, UI.size.small, look.color, true);
    const amount = label(scene, x + icon.width + 4, walletY, currencyWord(currency, wallet[currency] ?? 0), UI.size.small, UI.text);
    walletParts.push(icon, amount);
    x = amount.x + amount.width + 18;
  }
  // Long words on a narrow column: shrink the whole wallet line.
  const walletLine = scene.add.container(0, 0, walletParts);
  const walletW = x - 18 - box.x;
  if (walletW > walletRight - box.x) {
    const s = Math.max(0.6, (walletRight - box.x) / walletW);
    walletLine.setScale(s).setPosition(box.x * (1 - s), walletY * (1 - s));
  }
  parent.add(walletLine);
  const spentParts = o.flash ? costParts(o.flash.spent) : [];
  if (spentParts.length > 0) {
    // "−6 ◆  −1 ✦" right of the wallet (language-neutral, so it stays short), drifting up and fading.
    const text = spentParts.map((p) => `−${currencyAmount(p.currency, p.amount)} ${lookOf(p.currency).glyph}`).join('  ');
    const spent = label(scene, walletRight, walletY, text, UI.size.small, UI.danger, true).setOrigin(1, 0);
    parent.add(spent);
    scene.tweens.add({ targets: spent, y: walletY - 12, alpha: 0, duration: 1400, delay: 700, ease: 'Quad.easeIn' });
  }

  const top = box.y + WALLET_H;
  const notCraftable = canCraft(o.profile, o.item, 'upgradeRarity', {}, o.data);
  if (notCraftable === 'notCraftable' || notCraftable === 'unknownBase') {
    parent.add(
      label(scene, box.x + box.w / 2, top + (box.h - WALLET_H) / 2, craftReason(notCraftable, 'upgradeRarity', {}, wallet), UI.size.small, UI.muted)
        .setOrigin(0.5)
        .setAlign('center')
        .setWordWrapWidth(box.w - 20),
    );
    return;
  }

  const rowH = Math.min(62, Math.floor((box.h - WALLET_H) / CRAFT_OPS.length));
  const buttonW = Math.min(150, Math.round(box.w * 0.4));
  const buttonH = Math.min(44, rowH - 8);
  const textX = box.x + buttonW + 10;
  const textW = box.x + box.w - textX;
  CRAFT_OPS.forEach((op, i) => {
    const rowY = top + i * rowH;
    if (i > 0) parent.add(scene.add.rectangle(box.x + box.w / 2, rowY, box.w, 1, 0x2a2430));
    const args = AFFIX_OPS.has(op) && o.affixIndex !== undefined ? { index: o.affixIndex } : {};
    const cost = craftCost(o.item, op, o.data.crafting);
    const error = canCraft(o.profile, o.item, op, args, o.data);
    const button = makeButton(scene, box.x + buttonW / 2, rowY + rowH / 2, buttonW, buttonH, t(CRAFT_OP_NAME[op]), () => {
      if (!error) o.onCraft(op);
    }, error ? 'secondary' : 'primary');
    if (error) button.setAlpha(0.5);
    parent.add(button);

    // Effect, cost and (when unavailable) the reason, centred in the row.
    const lines = error ? 3 : 2;
    let y = rowY + rowH / 2 - (lines * 15) / 2;
    parent.add(oneLine(label(scene, textX, y, craftEffect(op, o.item), 12, UI.muted), textW));
    y += 15;
    let cx = textX;
    const costLine: Phaser.GameObjects.Text[] = [];
    for (const part of costParts(cost)) {
      const look = lookOf(part.currency);
      const short = (wallet[part.currency] ?? 0) < part.amount;
      const text = label(scene, cx, y, `${look.glyph} ${currencyAmount(part.currency, part.amount)}`, 13, short ? UI.danger : look.color, true);
      costLine.push(text);
      cx += text.width + 12;
    }
    if (costLine.length === 0) costLine.push(label(scene, cx, y, t('common.free'), 13, UI.text, true));
    parent.add(costLine);
    y += 15;
    if (error) {
      // Affix operations on an item without affixes: say so rather than asking to pick one.
      const reason = error === 'badIndex' && o.item.affixes.length === 0 ? t('craft.noAffixes') : craftReason(error, op, cost, wallet);
      parent.add(oneLine(label(scene, textX, y, reason, 12, UI.danger), textW));
    }
  });
}

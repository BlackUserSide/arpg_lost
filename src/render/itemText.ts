import { tierOf, uniqueDefOf } from '../core/items/generate';
import type { AffixDef, Item, ItemsData, StatLine, ValueRange } from '../core/items/types';
import type { Modifier } from '../core/stats/types';
import { content } from '../data';
import { t } from '../i18n';
import { baseName, itemName } from './contentText';
import { damageTypeText, formatModifier, formatModifiers, num, PERCENT_FLAT } from './statText';
import { uniqueEffectLines } from './uniqueText';

// Human-readable item text for tooltips. Pure functions (tested), no Phaser.
// `resourceId` (ClassDef.resource.id of the viewing hero) names the resource stats ("Rage"); "Resource" without it.


const pctNum = (v: number): string => num(v * 100);

function toModifier(line: StatLine, value: number): Modifier {
  return { stat: line.stat, kind: line.kind, value, ...(line.tags ? { tags: line.tags } : {}), ...(line.damageType ? { damageType: line.damageType } : {}) };
}

export function formatLine(line: StatLine, value: number, resourceId?: string): string {
  return formatModifier(toModifier(line, value), resourceId);
}

export function formatRange(line: StatLine, range: ValueRange): string {
  const show = (v: number): string => (line.kind !== 'flat' || PERCENT_FLAT.has(line.stat) ? `${pctNum(v)}%` : num(v));
  return `${show(range.min)}–${show(range.max)}`;
}

export interface TooltipLine {
  readonly text: string;
  /** unique: a rolled stat line of a unique / legendary; effect: its signature effect; cost: its drawback ("Ціна"). */
  readonly kind: 'base' | 'implicit' | 'affix' | 'unique' | 'effect' | 'cost' | 'meta';
  /** e.g. "P · T2 · 10–15%" for affixes, "T2 · 10–15%" for unique stat lines. */
  readonly detail?: string;
  /** Affix lines: position of the affix in Item.affixes (crafting picks affixes by it). */
  readonly affixIndex?: number;
}

/** Text colour per line kind (visual only; base lines use the default text colour). */
export const LINE_TONE: Readonly<Partial<Record<TooltipLine['kind'], string>>> = {
  implicit: '#b9d4ff',
  affix: '#8fb3ff',
  unique: '#8fb3ff',
  effect: '#f0b46a',
  cost: '#e07a6a',
  meta: '#9b917f',
};

export interface ItemTooltip {
  readonly title: string;
  /** Base type under a rare's random name or a unique's own name. */
  readonly subtitle?: string;
  readonly rarity: Item['rarity'];
  readonly lines: readonly TooltipLine[];
}

export const rarityLabel = (rarity: Item['rarity']): string => t(`rarity.${rarity}`);

export function describeItem(item: Item, data: ItemsData, resourceId?: string): ItemTooltip {
  const base = data.bases[item.baseId];
  const lines: TooltipLine[] = [];
  if (base?.weapon) {
    const w = base.weapon;
    for (const [type, range] of Object.entries(w.damage)) {
      lines.push({ text: t('item.weaponDamage', { type: damageTypeText(type, 'name'), min: num(range.min), max: num(range.max) }), kind: 'base' });
    }
    lines.push({ text: t('item.attacksPerSecond', { value: num(w.attacksPerSecond) }), kind: 'base' });
    lines.push({ text: t('item.critChance', { value: num(w.critChance * 100) }), kind: 'base' });
  }
  if (item.armour) lines.push({ text: t('item.armour', { value: num(item.armour) }), kind: 'base' });
  if (item.energyShield) lines.push({ text: t('item.energyShield', { value: num(item.energyShield) }), kind: 'base' });
  if (base?.implicit && item.implicit !== undefined) lines.push({ text: formatLine(base.implicit, item.implicit, resourceId), kind: 'implicit' });
  item.affixes.forEach((rolled, affixIndex) => {
    const affix: AffixDef | undefined = data.affixes[rolled.affixId];
    if (!affix) return;
    const tier = affix.tiers[affix.tiers.length - rolled.tier];
    const parts = [t(affix.kind === 'prefix' ? 'item.prefixShort' : 'item.suffixShort'), t('item.tierShort', { tier: rolled.tier })];
    if (tier) parts.push(formatRange(affix.line, tier));
    lines.push({ text: formatLine(affix.line, rolled.value, resourceId), kind: 'affix', detail: parts.join(' · '), affixIndex });
  });
  // Uniques: rolled lines with their tier, then the effect and the costs. An unknown unique id: name + base only.
  const unique = uniqueDefOf(item, data);
  if (unique) {
    unique.stats.forEach((line, i) => {
      const roll = item.unique?.rolls[i];
      if (!roll) return;
      const tier = tierOf(line, roll.tier);
      const parts = [t('item.tierShort', { tier: roll.tier })];
      if (tier) parts.push(formatRange(line, tier));
      lines.push({ text: formatLine(line, roll.value, resourceId), kind: 'unique', detail: parts.join(' · ') });
    });
    for (const text of uniqueEffectLines(unique, content, resourceId)) lines.push({ text, kind: 'effect' });
    for (const text of formatModifiers(unique.costs ?? [], resourceId)) lines.push({ text: t('item.cost', { text }), kind: 'cost' });
  }
  lines.push({ text: t('item.levelLine', { level: item.level }), kind: 'meta' });
  const title = itemName(item);
  // Base type under a rare's or a unique's own name (not under a unique id without text, which shows the base).
  const subtitle = base && (item.rarity === 'rare' || item.unique) && title !== baseName(base.id) ? baseName(base.id) : undefined;
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    rarity: item.rarity,
    lines,
  };
}

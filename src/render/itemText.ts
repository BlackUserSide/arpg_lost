import type { AffixDef, Item, ItemsData, StatLine, ValueRange } from '../core/items/types';
import type { Modifier } from '../core/stats/types';
import { t } from '../i18n';
import { baseName, itemName } from './contentText';
import { damageTypeText, formatModifier, num, PERCENT_FLAT } from './statText';

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
  readonly kind: 'base' | 'implicit' | 'affix' | 'meta';
  /** e.g. "P · T2 · 10–15%" for affixes. */
  readonly detail?: string;
}

export interface ItemTooltip {
  readonly title: string;
  /** Base type under a rare's random name. */
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
  for (const rolled of item.affixes) {
    const affix: AffixDef | undefined = data.affixes[rolled.affixId];
    if (!affix) continue;
    const tier = affix.tiers[affix.tiers.length - rolled.tier];
    const parts = [t(affix.kind === 'prefix' ? 'item.prefixShort' : 'item.suffixShort'), t('item.tierShort', { tier: rolled.tier })];
    if (tier) parts.push(formatRange(affix.line, tier));
    lines.push({ text: formatLine(affix.line, rolled.value, resourceId), kind: 'affix', detail: parts.join(' · ') });
  }
  lines.push({ text: t('item.levelLine', { level: item.level }), kind: 'meta' });
  return {
    title: itemName(item),
    ...(item.rarity === 'rare' && base ? { subtitle: baseName(base.id) } : {}),
    rarity: item.rarity,
    lines,
  };
}

import type { AffixDef, Item, ItemsData, StatLine, ValueRange } from '../core/items/types';
import type { StatId } from '../core/stats/types';

// Human-readable item text for tooltips. Pure functions (tested), no Phaser.

const STAT_LABEL: Record<StatId, string> = {
  life: 'Life',
  lifeRegen: 'Life Regeneration per second',
  energyShield: 'Energy Shield',
  energyShieldRegen: 'Energy Shield Regeneration per second',
  mana: 'Mana',
  manaRegen: 'Mana Regeneration per second',
  armour: 'Armour',
  fireResistance: 'Fire Resistance',
  coldResistance: 'Cold Resistance',
  lightningResistance: 'Lightning Resistance',
  damage: 'Damage',
  critChance: 'Critical Strike Chance',
  critMultiplier: 'Critical Strike Multiplier',
  attackSpeed: 'Attack Speed',
  castSpeed: 'Cast Speed',
  cooldownRecovery: 'Cooldown Recovery Speed',
  movementSpeed: 'Movement Speed',
  damageTaken: 'Damage Taken',
};

/** Stats whose flat values are fractions shown as percentages. */
const PERCENT_FLAT: ReadonlySet<StatId> = new Set(['fireResistance', 'coldResistance', 'lightningResistance', 'critMultiplier', 'critChance']);
const MAXIMUM: ReadonlySet<StatId> = new Set(['life', 'mana', 'energyShield']);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (v: number): number => Math.round(v * 100);
const num = (v: number): string => String(Math.round(v * 10) / 10);

function tagWords(line: StatLine): string {
  return (line.tags ?? []).map((t) => `${cap(t)} `).join('');
}

export function formatLine(line: StatLine, value: number): string {
  const label = STAT_LABEL[line.stat];
  if (line.stat === 'damage' && line.kind === 'flat' && line.damageType) return `Adds ${num(value)} ${cap(line.damageType)} Damage`;
  if (line.kind === 'increased') return `${Math.abs(pct(value))}% ${value < 0 ? 'reduced' : 'increased'} ${tagWords(line)}${label}`;
  if (line.kind === 'more') return `${Math.abs(pct(value))}% ${value < 0 ? 'less' : 'more'} ${tagWords(line)}${label}`;
  if (PERCENT_FLAT.has(line.stat)) return `${value < 0 ? '' : '+'}${pct(value)}% to ${label}`;
  if (MAXIMUM.has(line.stat)) return `+${num(value)} to maximum ${label}`;
  return `+${num(value)} ${line.stat === 'armour' ? 'to Armour' : label}`;
}

export function formatRange(line: StatLine, range: ValueRange): string {
  const show = (v: number): string => (line.kind !== 'flat' || PERCENT_FLAT.has(line.stat) ? `${pct(v)}%` : num(v));
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

export function describeItem(item: Item, data: ItemsData): ItemTooltip {
  const base = data.bases[item.baseId];
  const lines: TooltipLine[] = [];
  if (base?.weapon) {
    const w = base.weapon;
    for (const [type, range] of Object.entries(w.damage)) lines.push({ text: `${cap(type)} Damage: ${range.min}–${range.max}`, kind: 'base' });
    lines.push({ text: `Attacks per Second: ${w.attacksPerSecond}`, kind: 'base' });
    lines.push({ text: `Critical Strike Chance: ${num(w.critChance * 100)}%`, kind: 'base' });
  }
  if (item.armour) lines.push({ text: `Armour: ${item.armour}`, kind: 'base' });
  if (item.energyShield) lines.push({ text: `Energy Shield: ${item.energyShield}`, kind: 'base' });
  if (base?.implicit && item.implicit !== undefined) lines.push({ text: formatLine(base.implicit, item.implicit), kind: 'implicit' });
  for (const rolled of item.affixes) {
    const affix: AffixDef | undefined = data.affixes[rolled.affixId];
    if (!affix) continue;
    const tier = affix.tiers[affix.tiers.length - rolled.tier];
    const detail = `${affix.kind === 'prefix' ? 'P' : 'S'} · T${rolled.tier}${tier ? ` · ${formatRange(affix.line, tier)}` : ''}`;
    lines.push({ text: formatLine(affix.line, rolled.value), kind: 'affix', detail });
  }
  lines.push({ text: `Item level ${item.level} · Requires level ${item.level}`, kind: 'meta' });
  return {
    title: item.name,
    ...(item.rarity === 'rare' && base ? { subtitle: base.name } : {}),
    rarity: item.rarity,
    lines,
  };
}

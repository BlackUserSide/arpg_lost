import { ESSENCE_CURRENCY, type CraftCost, type CraftError, type CraftOp } from '../core/items/craft';
import { SALVAGE_CURRENCY } from '../core/items/inventory';
import type { Item, RolledAffix } from '../core/items/types';
import { t, type MessageKey } from '../i18n';
import { rarityLabel } from './itemText';

// Crafting panel text (docs/design/crafting.md). Pure functions (tested), no Phaser. Core decides what is possible
// (canCraft reason codes) and what it costs (craftCost); this only puts it into words.

export const CRAFT_OP_NAME: Readonly<Record<CraftOp, MessageKey>> = {
  upgradeRarity: 'craft.op.upgradeRarity',
  addAffix: 'craft.op.addAffix',
  rerollAffix: 'craft.op.rerollAffix',
  rerollValues: 'craft.op.rerollValues',
  removeAffix: 'craft.op.removeAffix',
};

/** Operations that act on the affix the player picked on the item. */
export const AFFIX_OPS: ReadonlySet<CraftOp> = new Set<CraftOp>(['rerollAffix', 'rerollValues', 'removeAffix']);

/** Display order of currencies in costs and wallets: shards, then essence, then anything newer. */
const CURRENCY_ORDER = [SALVAGE_CURRENCY, ESSENCE_CURRENCY];

export function currencyWord(currency: string, count: number): string {
  if (currency === SALVAGE_CURRENCY) return t('unit.shards', { count });
  if (currency === ESSENCE_CURRENCY) return t('unit.essence', { count });
  return `${count} ${currency}`;
}

/** Non-zero cost entries, shards first. */
export function costParts(cost: CraftCost): Array<{ currency: string; amount: number }> {
  const rank = (c: string): number => (CURRENCY_ORDER.includes(c) ? CURRENCY_ORDER.indexOf(c) : CURRENCY_ORDER.length);
  return Object.entries(cost)
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([currency, amount]) => ({ currency, amount }));
}

/** Rarity the item would reach with upgradeRarity (display only; core decides whether it is allowed). */
function nextRarity(rarity: Item['rarity']): Item['rarity'] {
  return rarity === 'normal' ? 'magic' : 'rare';
}

/** One short line on what the operation does to this item. */
export function craftEffect(op: CraftOp, item: Item): string {
  if (op === 'upgradeRarity') return t('craft.effect.upgradeRarity', { rarity: rarityLabel(nextRarity(item.rarity)) });
  return t(`craft.effect.${op}`);
}

/**
 * Why the operation is unavailable, in words. `wallet` is the profile's currency: for a 'currency' error it names the
 * currency that is short (essence first: it cannot be farmed with shards), with a hint where essence comes from when
 * the player has none at all.
 */
export function craftReason(error: CraftError, op: CraftOp, cost: CraftCost, wallet: Readonly<Record<string, number>>): string {
  switch (error) {
    case 'rarity':
      return t(op === 'upgradeRarity' ? 'craft.reason.rarityMax' : 'craft.reason.rarityNormal');
    case 'currency': {
      const short = costParts(cost).filter((p) => (wallet[p.currency] ?? 0) < p.amount);
      const essence = short.find((p) => p.currency === ESSENCE_CURRENCY);
      if (essence) return t((wallet[ESSENCE_CURRENCY] ?? 0) > 0 ? 'craft.reason.essence' : 'craft.reason.essenceNone');
      if (short.some((p) => p.currency === SALVAGE_CURRENCY)) return t('craft.reason.shards');
      return t('craft.reason.currency');
    }
    default:
      return t(`craft.reason.${error}`);
  }
}

const sameAffix = (a: RolledAffix, b: RolledAffix): boolean => a.affixId === b.affixId && a.tier === b.tier && a.value === b.value;

/** Positions in `after` holding affixes that were not on `before` (each old affix matches at most once). */
export function changedAffixes(before: readonly RolledAffix[], after: readonly RolledAffix[]): number[] {
  const left = [...before];
  const changed: number[] = [];
  after.forEach((affix, index) => {
    const match = left.findIndex((old) => sameAffix(old, affix));
    if (match >= 0) left.splice(match, 1);
    else changed.push(index);
  });
  return changed;
}

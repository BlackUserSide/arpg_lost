// Paid respec actions (docs/design/passives-wheel.md, "Скидання"). Costs come from tree.respec;
// the wallet is the account currency map (profile.currency) and is charged only on success.

import { canDeallocate, removeNode, resetSpec, resetWheel, type DeallocateError } from './allocation';
import type { PassiveHero, PassiveTreeData } from './types';

export type RespecAction = 'node' | 'wheel' | 'spec';

export type RespecError = DeallocateError | 'nothing-to-reset' | 'currency';

/** Guards floor() against binary float error in base + level × perLevel (e.g. 0.7 × 10 = 6.999…). */
const FLOOR_EPSILON = 1e-9;

/**
 * Currency cost of a respec action at this hero level; free below rules.freeBelowLevel.
 * Fractional costs round down, e.g. a spec change at level 21 is floor(31.5) = 31 (designer decision 2026-10-22).
 */
export function respecCost(tree: PassiveTreeData, level: number, action: RespecAction): number {
  const rules = tree.respec;
  if (level < rules.freeBelowLevel) return 0;
  const { base, perLevel } = rules[action];
  return Math.max(0, Math.floor(base + level * perLevel + FLOOR_EPSILON));
}

function charge(tree: PassiveTreeData, wallet: Record<string, number>, amount: number): boolean {
  const currency = tree.respec.currency;
  const balance = wallet[currency] ?? 0;
  if (balance < amount) return false;
  if (amount > 0) wallet[currency] = balance - amount;
  return true;
}

function canAfford(tree: PassiveTreeData, wallet: Readonly<Record<string, number>>, amount: number): boolean {
  return (wallet[tree.respec.currency] ?? 0) >= amount;
}

/**
 * Refunds one node (wheel or spec) if the rest stays connected and the hero can pay.
 * Single spec nodes cost the node price and keep the spec choice (designer decision 2026-10-22).
 */
export function refundNode(tree: PassiveTreeData, hero: PassiveHero, nodeId: string, wallet: Record<string, number>): RespecError | null {
  const error = canDeallocate(tree, hero, nodeId);
  if (error) return error;
  const cost = respecCost(tree, hero.level, 'node');
  if (!canAfford(tree, wallet, cost)) return 'currency';
  charge(tree, wallet, cost);
  removeNode(hero.passives, nodeId);
  return null;
}

/** Refunds every wheel node. Spec nodes are untouched. */
export function refundWheel(tree: PassiveTreeData, hero: PassiveHero, wallet: Record<string, number>): RespecError | null {
  if (hero.passives.nodes.length === 0) return 'nothing-to-reset';
  if (!charge(tree, wallet, respecCost(tree, hero.level, 'wheel'))) return 'currency';
  resetWheel(hero.passives);
  return null;
}

/**
 * Drops the specialization and refunds all spec points; the hero can then pick either branch.
 * Free when no spec nodes are allocated (nothing to clear but the choice itself).
 */
export function changeSpec(tree: PassiveTreeData, hero: PassiveHero, wallet: Record<string, number>): RespecError | null {
  if (hero.passives.spec === null && hero.passives.specNodes.length === 0) return 'nothing-to-reset';
  const cost = hero.passives.specNodes.length === 0 ? 0 : respecCost(tree, hero.level, 'spec');
  if (!charge(tree, wallet, cost)) return 'currency';
  resetSpec(hero.passives);
  return null;
}

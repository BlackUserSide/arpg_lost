// End-of-run rewards (docs/design/maps.md «Нагорода», items.md, crafting.md): no loot during the run; a chest on a
// win, a consolation on a fail. Planning is pure and deterministic; granting rolls the items with a seeded RNG.

import { ESSENCE_CURRENCY } from '../items/craft';
import { addToStash, rollItem, SALVAGE_CURRENCY } from '../items/inventory';
import type { Item, ItemsData } from '../items/types';
import { addCurrency, type Profile } from '../progression/profile';
import type { Rng } from '../rng';
import { timeLeft } from './run';
import type { MapsData, RunRewardRules, RunState, SpeedTier } from './types';

/** What the rewards depend on, taken from a finished run (runOutcome). */
export interface RunOutcome {
  readonly won: boolean;
  readonly mapLevel: number;
  /** Fraction of the time limit left at the end (0..1). */
  readonly timeLeftFraction: number;
  readonly roomsCleared: number;
  readonly reachedBossRoom: boolean;
  readonly elitesKilled: number;
  readonly bossKilled: boolean;
}

export function runOutcome(run: RunState, maps: MapsData): RunOutcome {
  const limit = maps.rules.timeLimit;
  return {
    won: run.status === 'won',
    mapLevel: run.mapLevel,
    timeLeftFraction: limit > 0 ? Math.min(1, Math.max(0, timeLeft(run, maps) / limit)) : 0,
    roomsCleared: run.roomsCleared,
    reachedBossRoom: run.rooms[run.room]?.kind === 'boss',
    elitesKilled: run.elitesKilled,
    bossKilled: run.bossKilled,
  };
}

/** The best speed tier reached with this fraction of the time left (highest minTimeLeft ≤ it), or undefined. */
export function speedTier(timeLeftFraction: number, rules: RunRewardRules): SpeedTier | undefined {
  let best: SpeedTier | undefined;
  for (const tier of rules.chest.speedTiers) {
    if (timeLeftFraction >= tier.minTimeLeft && (!best || tier.minTimeLeft > best.minTimeLeft)) best = tier;
  }
  return best;
}

/** Item level of map loot: map level + bonuses, all bonuses together capped (designer decision: at most map level + 3). */
export function rewardItemLevel(mapLevel: number, bonus: number, rules: RunRewardRules): number {
  return Math.max(1, mapLevel) + Math.max(0, Math.min(rules.chest.maxItemLevelBonus, bonus));
}

/** Essence for the kills: perElite per elite (+ perBoss for the boss), rounded to 4 decimals (no float noise). */
export function essenceFor(elites: number, bossKilled: boolean, rules: RunRewardRules): number {
  const raw = elites * rules.essence.perElite + (bossKilled ? rules.essence.perBoss : 0);
  return Math.round(raw * 10000) / 10000;
}

export interface PlannedItem {
  readonly itemLevel: number;
  /** Rarity luck (rollRarity). */
  readonly luck: number;
}

export interface RewardPlan {
  readonly items: readonly PlannedItem[];
  readonly shards: number;
  /** Fractional essence is kept as is on the profile (addCurrency), so no fraction is ever lost. */
  readonly essence: number;
  /** The speed tier of a won run's chest (render: "fast clear" label), if any. */
  readonly speedTier?: SpeedTier;
}

/**
 * Win (chest): chest.items + the speed tier's extra items, item level = map level + boss bonus + speed bonus
 * (capped, rewardItemLevel), the tier's rarity luck; shards per room cleared; essence for elites and the boss.
 * Fail (consolation): shards per room cleared; if the boss room was reached, bossRoomConsolationItems items of map
 * level (no bonus, no luck); essence for the elites only.
 */
export function planRunRewards(outcome: RunOutcome, rules: RunRewardRules): RewardPlan {
  const shards = Math.max(0, outcome.roomsCleared) * rules.shardsPerRoom;
  if (outcome.won) {
    const tier = speedTier(outcome.timeLeftFraction, rules);
    const count = rules.chest.items + (tier?.extraItems ?? 0);
    const itemLevel = rewardItemLevel(outcome.mapLevel, rules.chest.bossItemLevelBonus + (tier?.itemLevelBonus ?? 0), rules);
    const luck = tier?.luck ?? 0;
    return {
      items: Array.from({ length: Math.max(0, count) }, () => ({ itemLevel, luck })),
      shards,
      essence: essenceFor(outcome.elitesKilled, outcome.bossKilled, rules),
      ...(tier ? { speedTier: tier } : {}),
    };
  }
  const consolation = outcome.reachedBossRoom ? rules.bossRoomConsolationItems : 0;
  const itemLevel = rewardItemLevel(outcome.mapLevel, 0, rules);
  return {
    items: Array.from({ length: Math.max(0, consolation) }, () => ({ itemLevel, luck: 0 })),
    shards,
    essence: essenceFor(outcome.elitesKilled, false, rules),
  };
}

export interface GrantedRewards {
  /** Every rolled item, including the ones salvaged because the stash was full. */
  readonly items: Item[];
  /** Ids of the items that did not fit the stash and were salvaged at once. */
  readonly salvagedIds: string[];
  /** Shards from the plan plus from the salvaged items. */
  readonly shards: number;
  readonly essence: number;
}

/**
 * Rolls the planned items (in plan order, rollItem) into the stash; items that do not fit are salvaged into shards.
 * Adds the shards and essence to the account currency.
 */
export function grantRunRewards(profile: Profile, rng: Rng, plan: RewardPlan, items: ItemsData): GrantedRewards {
  const rolled: Item[] = [];
  const salvagedIds: string[] = [];
  let shards = plan.shards;
  for (const p of plan.items) {
    const item = rollItem(profile, rng, { itemLevel: p.itemLevel, luck: p.luck }, items);
    rolled.push(item);
    if (addToStash(profile, item, items)) {
      salvagedIds.push(item.id);
      shards += items.rules.salvage[item.rarity];
    }
  }
  addCurrency(profile, SALVAGE_CURRENCY, shards);
  addCurrency(profile, ESSENCE_CURRENCY, plan.essence);
  return { items: rolled, salvagedIds, shards, essence: plan.essence };
}

// End-of-run rewards (docs/design/maps.md «Нагорода»), map ladder, and finishRun on the real game data.
import { describe, expect, it } from 'vitest';
import { content } from '../../data/index';
import { itemsData } from '../../data/items';
import { mapsData } from '../../data/maps';
import { supportsData } from '../../data/supports';
import { ESSENCE_CURRENCY } from '../items/craft';
import { SALVAGE_CURRENCY } from '../items/inventory';
import { vec } from '../math';
import { addCurrency, createCharacter, createProfile, type CharacterRecord, type Profile } from '../progression/profile';
import { createRng } from '../rng';
import { finishRun, keepsSupportDrops } from './finish';
import { availableMaps, canEnterMap, unlockedMap, unlockNextMap } from './progress';
import { essenceFor, grantRunRewards, planRunRewards, rewardItemLevel, speedTier, type RewardPlan, type RunOutcome } from './rewards';
import { createRun, currentTemplate, openDoor, stepRun } from './run';
import type { ItemsData, UniqueDef, WeaponType } from '../items/types';
import type { RunInput, RunRewardRules, RunState } from './types';

const rules: RunRewardRules = {
  chest: {
    items: 2,
    bossItemLevelBonus: 1,
    maxItemLevelBonus: 3,
    speedTiers: [
      { minTimeLeft: 0.4, extraItems: 2, itemLevelBonus: 2, luck: 0.3 },
      { minTimeLeft: 0.2, extraItems: 1, itemLevelBonus: 1, luck: 0.15 },
    ],
    bossUniqueWeightMultiplier: 3,
    legendary: { minMapLevel: 30, chance: 0.002 },
  },
  shardsPerRoom: 2,
  bossRoomConsolationItems: 1,
  essence: { perElite: 0.1, perBoss: 0.5 },
};

const won = (timeLeftFraction: number, extra: Partial<RunOutcome> = {}): RunOutcome => ({
  won: true,
  mapLevel: 10,
  timeLeftFraction,
  roomsCleared: 3,
  reachedBossRoom: true,
  elitesKilled: 4,
  bossKilled: true,
  ...extra,
});

describe('reward planning', () => {
  it('speed tiers: the best tier whose threshold is reached', () => {
    expect(speedTier(0.19, rules)).toBeUndefined();
    expect(speedTier(0.2, rules)?.minTimeLeft).toBe(0.2);
    expect(speedTier(0.39, rules)?.minTimeLeft).toBe(0.2);
    expect(speedTier(0.9, rules)?.minTimeLeft).toBe(0.4);
  });

  it('chest: more and better items the more time is left; item level = map + boss + speed, never above map + 3', () => {
    // The boss was killed: the first chest item has the boss unique weight multiplier.
    expect(planRunRewards(won(0.1), rules)).toEqual({
      items: [{ itemLevel: 11, luck: 0, uniqueWeightMultiplier: 3 }, { itemLevel: 11, luck: 0 }],
      shards: 6,
      essence: 0.9,
    });
    const mid = planRunRewards(won(0.25), rules);
    expect(mid.items).toEqual([{ itemLevel: 12, luck: 0.15, uniqueWeightMultiplier: 3 }, ...Array(2).fill({ itemLevel: 12, luck: 0.15 })]);
    expect(mid.speedTier).toBe(rules.chest.speedTiers[1]);
    expect(planRunRewards(won(0.5), rules).items).toEqual([{ itemLevel: 13, luck: 0.3, uniqueWeightMultiplier: 3 }, ...Array(3).fill({ itemLevel: 13, luck: 0.3 })]);
    // Boss +2 and speed +2 would be +4: capped at +3.
    const greedy = { ...rules, chest: { ...rules.chest, bossItemLevelBonus: 2 } };
    expect(planRunRewards(won(0.5), greedy).items[0]!.itemLevel).toBe(13);
    expect(rewardItemLevel(10, 99, rules)).toBe(13);
    expect(rewardItemLevel(0, 0, rules)).toBe(1);
  });

  it('consolation: shards per room cleared, +1 map-level item if the boss room was reached, elite essence only', () => {
    const fail = { won: false, mapLevel: 7, timeLeftFraction: 0.6, roomsCleared: 2, reachedBossRoom: false, elitesKilled: 3, bossKilled: false };
    expect(planRunRewards(fail, rules)).toEqual({ items: [], shards: 4, essence: 0.3 });
    expect(planRunRewards({ ...fail, roomsCleared: 3, reachedBossRoom: true }, rules)).toEqual({ items: [{ itemLevel: 7, luck: 0 }], shards: 6, essence: 0.3 });
    expect(planRunRewards({ ...fail, roomsCleared: 0, elitesKilled: 0 }, rules)).toEqual({ items: [], shards: 0, essence: 0 });
  });

  it('essence: 0.1 per elite + 0.5 per boss, without float noise; fractions accumulate on the profile', () => {
    expect(essenceFor(3, false, rules)).toBe(0.3);
    expect(essenceFor(7, true, rules)).toBe(1.2);
    const profile = createProfile();
    for (let i = 0; i < 10; i++) addCurrency(profile, ESSENCE_CURRENCY, 0.1);
    expect(profile.currency[ESSENCE_CURRENCY]).toBe(1);
    addCurrency(profile, ESSENCE_CURRENCY, 0.3);
    addCurrency(profile, ESSENCE_CURRENCY, -1);
    expect(profile.currency[ESSENCE_CURRENCY]).toBe(0.3);
  });

  it('granting rolls the items into the stash, salvages what does not fit, adds shards and essence', () => {
    const profile = createProfile();
    profile.currency[SALVAGE_CURRENCY] = 5;
    const plan = planRunRewards(won(0.5), rules);
    const got = grantRunRewards(profile, createRng(42), plan, itemsData);
    expect(got.items.map((i) => [i.id, i.level])).toEqual([['i1', 13], ['i2', 13], ['i3', 13], ['i4', 13]]);
    expect(profile.stash.items).toEqual(got.items);
    expect(got).toMatchObject({ salvagedIds: [], shards: 6, essence: 0.9 });
    expect(profile.currency).toEqual({ [SALVAGE_CURRENCY]: 11, [ESSENCE_CURRENCY]: 0.9 });
    // Same seed, same items.
    expect(grantRunRewards(createProfile(), createRng(42), plan, itemsData).items).toEqual(got.items);

    const full = createProfile();
    const small = { ...itemsData, rules: { ...itemsData.rules, stashSize: 1 } };
    const overflow = grantRunRewards(full, createRng(42), plan, small);
    expect(full.stash.items.map((i) => i.id)).toEqual(['i1']);
    expect(overflow.salvagedIds).toEqual(['i2', 'i3', 'i4']);
    const salvage = overflow.items.slice(1).reduce((sum, i) => sum + small.rules.salvage[i.rarity], 0);
    expect(overflow.shards).toBe(6 + salvage);
    expect(full.currency[SALVAGE_CURRENCY]).toBe(6 + salvage);
  });
});

describe('uniques and legendaries in the chest', () => {
  const legend: UniqueDef = {
    id: 'test_legend',
    rarity: 'legendary',
    baseId: 'amber_amulet',
    weight: 1,
    stats: [{ stat: 'life', kind: 'flat', tiers: [{ min: 10, max: 20, step: 1, minLevel: 1 }] }],
  };
  // The fixture is the only legendary here (the real ones are left out so the pick is fixed).
  const realUniques = Object.fromEntries(Object.entries(itemsData.uniques).filter(([, u]) => u.rarity === 'unique'));
  const withLegend: ItemsData = { ...itemsData, uniques: { ...realUniques, test_legend: legend } };

  it('boss loot: only the first chest item gets the ×3 unique weight, and only when the boss was killed', () => {
    expect(planRunRewards(won(0.1), rules).items.map((i) => i.uniqueWeightMultiplier)).toEqual([3, undefined]);
    expect(planRunRewards(won(0.1, { bossKilled: false }), rules).items.map((i) => i.uniqueWeightMultiplier)).toEqual([undefined, undefined]);
  });

  it('the boss multiplier reaches the rarity roll of that item', () => {
    const items: ItemsData = { ...itemsData, rules: { ...itemsData.rules, rarityWeights: { normal: 1, magic: 0, rare: 0, unique: 1e-9 } } };
    const plan = planRunRewards(won(0.1), { ...rules, chest: { ...rules.chest, bossUniqueWeightMultiplier: 1e12 } });
    const got = grantRunRewards(createProfile(), createRng(42), plan, items);
    expect(got.items.map((i) => i.rarity)).toEqual(['unique', 'normal']);
  });

  it('legendary roll: a killed boss on map 30+, at the chest item level; never on a fail or without the boss', () => {
    expect(planRunRewards(won(0.1, { mapLevel: 29 }), rules).legendary).toBeUndefined();
    expect(planRunRewards(won(0.1, { mapLevel: 30 }), rules).legendary).toEqual({ itemLevel: 31, chance: 0.002 });
    expect(planRunRewards(won(0.5, { mapLevel: 40 }), rules).legendary).toEqual({ itemLevel: 43, chance: 0.002 });
    expect(planRunRewards(won(0.1, { mapLevel: 30, bossKilled: false }), rules).legendary).toBeUndefined();
    const fail = { won: false, mapLevel: 35, timeLeftFraction: 0, roomsCleared: 3, reachedBossRoom: true, elitesKilled: 0, bossKilled: false };
    expect(planRunRewards(fail, rules).legendary).toBeUndefined();
  });

  it('a won legendary roll adds one extra legendary item after the chest items, which stay as they were', () => {
    const base = planRunRewards(won(0.1, { mapLevel: 30 }), rules);
    const plan = { ...base, legendary: { itemLevel: 31, chance: 1 } };
    const profile = createProfile();
    const got = grantRunRewards(profile, createRng(42), plan, withLegend);
    expect(got.items.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
    expect(got.items[2]).toMatchObject({ rarity: 'legendary', level: 31, baseId: 'amber_amulet', unique: { id: 'test_legend' } });
    expect(got.legendaryId).toBe('i3');
    const without = grantRunRewards(createProfile(), createRng(42), { ...base, legendary: { itemLevel: 31, chance: 0 } }, withLegend);
    expect(without.items).toEqual(got.items.slice(0, 2));
    expect(without.legendaryId).toBeUndefined();
    // The legendary takes the stash first.
    expect(profile.stash.items.map((i) => i.id)).toEqual(['i3', 'i1', 'i2']);
    const small = { ...withLegend, rules: { ...withLegend.rules, stashSize: 1 } };
    const tight = grantRunRewards(createProfile(), createRng(42), plan, small);
    expect(tight.salvagedIds).toEqual(['i1', 'i2']);
  });

  it('no legendary in the data: a won roll gives nothing extra', () => {
    const plan = { ...planRunRewards(won(0.1, { mapLevel: 30 }), rules), legendary: { itemLevel: 31, chance: 1 } };
    const got = grantRunRewards(createProfile(), createRng(42), plan, { ...itemsData, uniques: realUniques });
    expect(got.items).toHaveLength(2);
    expect(got.legendaryId).toBeUndefined();
  });

  it('real data: a boss kill on map 30 with the legendary roll won drops one of the two legendaries, T1 lines', () => {
    const plan = planRunRewards(won(0.1, { mapLevel: 30 }), mapsData.rewards);
    expect(plan.legendary).toEqual({ itemLevel: 31, chance: 0.002 });
    expect(planRunRewards(won(0.1, { mapLevel: 29 }), mapsData.rewards).legendary).toBeUndefined();
    // A forced rng: every chance draw succeeds (the 1 / 500 legendary roll included); the rest stays seeded.
    const forced = { ...createRng(42), chance: (): boolean => true };
    const got = grantRunRewards(createProfile(), forced, plan, itemsData);
    const legendary = got.items.find((i) => i.id === got.legendaryId)!;
    // Seed 42 picks the Clock (6d); equal weights, so the crown is the other half.
    expect(legendary).toMatchObject({ rarity: 'legendary', level: 31, baseId: 'amber_amulet', unique: { id: 'clock_last_moment' } });
    expect(legendary.unique!.rolls.map((r) => r.tier)).toEqual([1, 1, 1]);
    // With the crown alone in the pool the same roll drops the crown.
    const crownOnly: ItemsData = { ...itemsData, uniques: Object.fromEntries(Object.entries(itemsData.uniques).filter(([id]) => id !== 'clock_last_moment')) };
    const withCrown = grantRunRewards(createProfile(), { ...createRng(42), chance: (): boolean => true }, plan, crownOnly);
    const crown = withCrown.items.find((i) => i.id === withCrown.legendaryId)!;
    expect(crown).toMatchObject({ rarity: 'legendary', level: 31, baseId: 'warded_helm', unique: { id: 'devourer_crown' } });
    expect(crown.unique!.rolls.map((r) => r.tier)).toEqual([1, 1, 1]);
    // The same rolls without the forced chance give no legendary.
    expect(grantRunRewards(createProfile(), createRng(42), plan, itemsData).legendaryId).toBeUndefined();
  });
});

describe('map ladder', () => {
  const hero = (unlocked: number): Pick<CharacterRecord, 'maps'> => ({ maps: { unlocked } });

  it('lists 1..unlocked; only those can be entered', () => {
    expect(availableMaps(hero(3))).toEqual([1, 2, 3]);
    expect(availableMaps(hero(0))).toEqual([1]);
    expect(unlockedMap(hero(0))).toBe(1);
    expect([0, 1, 3, 4, 2.5].map((l) => canEnterMap(hero(3), l))).toEqual([false, true, true, false, false]);
  });

  it('beating the highest map unlocks the next, up to the cap; replays change nothing', () => {
    const h = hero(3);
    expect(unlockNextMap(h, 2, 40)).toBeNull();
    expect(h.maps.unlocked).toBe(3);
    expect(unlockNextMap(h, 3, 40)).toBe(4);
    expect(h.maps.unlocked).toBe(4);
    const top = hero(39);
    expect(unlockNextMap(top, 39, 40)).toBe(40);
    expect(unlockNextMap(top, 40, 40)).toBeNull();
    expect(top.maps.unlocked).toBe(40);
  });
});

// ── finishRun on the real data ──

const DT = 1 / 60;
const idle: RunInput = { move: vec(0, 0), aim: vec(0, 0), basicAttack: false, skills: [] };

function newHero(): { profile: Profile; character: CharacterRecord } {
  const profile = createProfile();
  const r = createCharacter(profile, { name: 'Aria', classId: 'warrior' }, { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 }, ['warrior']);
  if (!r.ok) throw new Error('create failed');
  return { profile, character: r.character };
}

const tick = (run: RunState, input: RunInput = idle): void => void stepRun(run, input, content, mapsData, DT);

/** Plays the run to the boss room: every wave is killed as it appears, the hero walks through each door. */
function toBossRoom(run: RunState): void {
  for (let i = 0; i < 100000 && run.rooms[run.room]!.kind === 'combat'; i++) {
    for (const m of run.world.mobs) m.life = 0;
    const door = openDoor(run, mapsData);
    if (door) run.world.player.pos = vec(door.x, door.y);
    tick(run);
  }
}

function winRun(run: RunState): void {
  toBossRoom(run);
  const t = currentTemplate(run, mapsData);
  if (t.kind !== 'boss') throw new Error('boss room expected');
  run.world.player.pos = vec(t.altar.x, t.altar.y + 40);
  for (let i = 0; i < 1000 && run.bossId === null; i++) tick(run, { ...idle, interact: true });
  run.world.mobs.find((m) => m.id === run.bossId)!.life = 0;
  tick(run);
  expect(run.status).toBe('won');
}

describe('finishRun', () => {
  it('a fast win: chest at map + 3, essence for elites and boss, map unlock, records and supports', () => {
    const { profile, character } = newHero();
    const run = createRun(content, mapsData, 'warrior', 1234, {}, 1);
    winRun(run);
    run.world.supportDrops.push({ defId: Object.keys(supportsData.supports)[0]!, tier: 1 });
    const summary = finishRun(profile, character.id, run, { maps: mapsData, items: itemsData, classes: content.classes, supports: supportsData })!;
    // The whole run took a few seconds: the best speed tier (+2 items, +2 levels), boss +1 → map level + 3.
    expect(summary.plan.speedTier).toBe(mapsData.rewards.chest.speedTiers[1]);
    expect(summary.rewards.items.map((i) => i.level)).toEqual([4, 4, 4, 4]);
    expect(run.elitesKilled).toBeGreaterThanOrEqual(3);
    expect(summary.rewards.essence).toBe(essenceFor(run.elitesKilled, true, mapsData.rewards));
    expect(summary.rewards.shards).toBe(6);
    expect(profile.currency[ESSENCE_CURRENCY]).toBe(summary.rewards.essence);
    expect(summary.unlockedMap).toBe(2);
    expect(character.maps.unlocked).toBe(2);
    expect(summary.supports?.kept).toHaveLength(1);
    expect(summary.bonusXp).toBeCloseTo(run.world.xpGained * 0.07, 10);
    expect(character.stats).toMatchObject({ runs: 1, deaths: 0, kills: run.world.kills });
    expect(profile.records).toMatchObject({ bestMapLevel: 1, bossKills: 1, bestClearTime: run.elapsed });
    expect(character.level).toBe(run.world.player.level);
    // Recorded once.
    expect(finishRun(profile, character.id, run, { maps: mapsData, items: itemsData, classes: content.classes, supports: supportsData })).toBeNull();
    expect(profile.stash.items).toHaveLength(4);
  });

  it('is deterministic from the run seed (same seed and inputs → same chest)', () => {
    const chest = (): unknown => {
      const { profile, character } = newHero();
      const run = createRun(content, mapsData, 'warrior', 99, {}, 5);
      winRun(run);
      return finishRun(profile, character.id, run, { maps: mapsData, items: itemsData, classes: content.classes })!.rewards;
    };
    expect(chest()).toEqual(chest());
  });

  it('death: consolation (shards per room, boss-room item), elite essence only, supports lost, no unlock', () => {
    const { profile, character } = newHero();
    character.maps.unlocked = 3;
    const run = createRun(content, mapsData, 'warrior', 77, {}, 3);
    toBossRoom(run);
    run.world.supportDrops.push({ defId: Object.keys(supportsData.supports)[0]!, tier: 1 });
    run.world.player.life = 0;
    run.world.player.dead = true;
    run.status = 'failed';
    run.failReason = 'death';
    const summary = finishRun(profile, character.id, run, { maps: mapsData, items: itemsData, classes: content.classes, supports: supportsData })!;
    expect(summary.plan).toEqual({ items: [{ itemLevel: 3, luck: 0 }], shards: 6, essence: essenceFor(run.elitesKilled, false, mapsData.rewards) });
    expect(summary.rewards.items.map((i) => i.level)).toEqual([3]);
    expect(summary.supports).toBeUndefined();
    expect(character.supports).toEqual([]);
    expect(summary.unlockedMap).toBeNull();
    expect(character.maps.unlocked).toBe(3);
    expect(character.stats.deaths).toBe(1);
    expect(profile.records.bossKills).toBe(0);
  });

  it('timeout keeps the supports; abandoning an active run fails it and loses them', () => {
    const timeout = createRun(content, mapsData, 'warrior', 5, {}, 1);
    timeout.status = 'failed';
    timeout.failReason = 'timeout';
    expect(keepsSupportDrops(timeout)).toBe(true);

    const { profile, character } = newHero();
    const run = createRun(content, mapsData, 'warrior', 5, {}, 1);
    run.world.supportDrops.push({ defId: Object.keys(supportsData.supports)[0]!, tier: 1 });
    const summary = finishRun(profile, character.id, run, { maps: mapsData, items: itemsData, classes: content.classes, supports: supportsData })!;
    expect(run).toMatchObject({ status: 'failed', failReason: 'abandoned', recorded: true });
    expect(summary.plan).toEqual({ items: [], shards: 0, essence: 0 });
    expect(summary.supports).toBeUndefined();
    expect(character.stats.deaths).toBe(0);
  });
});

describe('unique weapons for the run hero, stash overflow (designer decisions 2026-10-26)', () => {
  const onlyUniques = (d: ItemsData): ItemsData => ({ ...d, rules: { ...d.rules, rarityWeights: { normal: 0, magic: 0, rare: 0, unique: 1 } } });
  // Weapon bases only: every chest item is a weapon, and only weapon uniques can be picked.
  const weaponsOnly = (d: ItemsData): ItemsData => ({ ...d, bases: Object.fromEntries(Object.entries(d.bases).filter(([, b]) => b.slot === 'weapon')) });
  const chest = (count: number, itemLevel = 30): RewardPlan => ({ items: Array.from({ length: count }, () => ({ itemLevel, luck: 0 })), shards: 2, essence: 0 });

  it('a unique weapon in the chest is always of the hero weapon type; without a type any class weapon drops', () => {
    const items = onlyUniques(weaponsOnly(itemsData));
    const ids = (weaponType?: WeaponType): string[] => [...new Set(grantRunRewards(createProfile(), createRng(42), chest(12), items, weaponType).items.map((i) => i.unique?.id ?? 'none'))].sort();
    expect(ids('crossbow')).toEqual(['splitter']);
    expect(ids('sword')).toEqual(['barrow_reaper']);
    expect(ids('wand')).toEqual(['heart_of_winter']);
    expect(ids()).toEqual(['barrow_reaper', 'heart_of_winter', 'splitter']);
  });

  it('full stash: uniques wait in the overflow (not salvaged), normal loot is salvaged; over the overflow cap a unique is salvaged', () => {
    const tiny = (d: ItemsData, overflow: number): ItemsData => ({ ...d, rules: { ...d.rules, stashSize: 1, overflow: { ...d.rules.overflow, size: overflow } } });
    const profile = createProfile();
    const got = grantRunRewards(profile, createRng(42), chest(4), tiny(onlyUniques(itemsData), 20));
    expect(got.items.map((i) => i.rarity)).toEqual(['unique', 'unique', 'unique', 'unique']);
    expect(profile.stash.items.map((i) => i.id)).toEqual(['i1']);
    expect(profile.stash.overflow.map((i) => i.id)).toEqual(['i2', 'i3', 'i4']);
    expect(got).toMatchObject({ salvagedIds: [], overflowIds: ['i2', 'i3', 'i4'], shards: 2 });
    expect(profile.currency[SALVAGE_CURRENCY]).toBe(2);

    const capped = createProfile();
    const over = grantRunRewards(capped, createRng(42), chest(4), tiny(onlyUniques(itemsData), 2));
    expect(over).toMatchObject({ salvagedIds: ['i4'], overflowIds: ['i2', 'i3'], shards: 2 + itemsData.rules.salvage.unique });

    // Normal loot keeps the old behaviour: the stash takes one, the rest is salvaged, the overflow stays empty.
    const plain = createProfile();
    const normal: ItemsData = { ...tiny(itemsData, 20), rules: { ...tiny(itemsData, 20).rules, rarityWeights: { normal: 1, magic: 0, rare: 0, unique: 0 } } };
    expect(grantRunRewards(plain, createRng(42), chest(3), normal)).toMatchObject({ salvagedIds: ['i2', 'i3'], overflowIds: [], shards: 2 + 2 * itemsData.rules.salvage.normal });
    expect(plain.stash.overflow).toEqual([]);
  });

  it('a legendary on a full stash waits in the overflow', () => {
    const legend: UniqueDef = { id: 'test_legend', rarity: 'legendary', baseId: 'amber_amulet', weight: 1, stats: [] };
    const items: ItemsData = { ...itemsData, uniques: { test_legend: legend }, rules: { ...itemsData.rules, stashSize: 0, rarityWeights: { normal: 1, magic: 0, rare: 0, unique: 0 } } };
    const profile = createProfile();
    const got = grantRunRewards(profile, createRng(42), { ...chest(1), legendary: { itemLevel: 31, chance: 1 } }, items);
    expect(got).toMatchObject({ legendaryId: 'i2', overflowIds: ['i2'], salvagedIds: ['i1'] });
    expect(profile.stash.overflow.map((i) => i.rarity)).toEqual(['legendary']);
  });

  it('finishRun: waiting overflow items take freed stash space before the chest; the chest weapon uniques fit the hero', () => {
    const { profile, character } = newHero();
    const waiting = { id: 'w1', baseId: 'iron_ring', level: 5, rarity: 'unique' as const, name: '', affixes: [] };
    profile.stash.overflow.push(waiting);
    const run = createRun(content, mapsData, 'warrior', 1234, {}, 1);
    winRun(run);
    const items = onlyUniques(weaponsOnly(itemsData));
    const summary = finishRun(profile, character.id, run, { maps: mapsData, items: { ...items, rules: { ...items.rules, stashSize: 3 } }, classes: content.classes })!;
    expect(summary.claimedFromOverflow).toEqual(['w1']);
    expect(summary.rewards.items.map((i) => i.unique?.id)).toEqual(['barrow_reaper', 'barrow_reaper', 'barrow_reaper', 'barrow_reaper']);
    expect(profile.stash.items.map((i) => i.id)).toEqual(['w1', ...summary.rewards.items.slice(0, 2).map((i) => i.id)]);
    expect(profile.stash.overflow.map((i) => i.id)).toEqual(summary.rewards.items.slice(2).map((i) => i.id));
    expect(summary.rewards.overflowIds).toEqual(summary.rewards.items.slice(2).map((i) => i.id));
  });
});

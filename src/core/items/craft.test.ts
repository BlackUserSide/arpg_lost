import { describe, expect, it } from 'vitest';
import { craftingRules } from '../../data/crafting';
import { itemsData } from '../../data/items';
import { createCharacter, createProfile, type Profile } from '../progression/profile';
import { createRng } from '../rng';
import { computeStat } from '../stats/modifiers';
import { applyCraft, canCraft, craftCost, craftCount, ESSENCE_CURRENCY, findItem, type CraftData, type CraftingRules } from './craft';
import { equipmentModifiers } from './equipment';
import { SALVAGE_CURRENCY } from './inventory';
import type { AffixDef, BaseDef, Item, ItemsData, RolledAffix } from './types';

const tiers = (values: Array<[number, number]>, levels = [1, 10, 20]): AffixDef['tiers'] =>
  values.map(([min, max], i) => ({ min, max, step: 1, minLevel: levels[i] ?? 1 }));

const affixes: Record<string, AffixDef> = {
  life: { id: 'life', group: 'life', kind: 'prefix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'life', kind: 'flat' }, tiers: tiers([[1, 2], [10, 12], [50, 60]]) },
  armour: { id: 'armour', group: 'armour', kind: 'prefix', slots: ['helmet'], weight: 100, line: { stat: 'armour', kind: 'flat' }, tiers: tiers([[1, 2], [10, 12], [50, 60]]) },
  fire: { id: 'fire', group: 'fire', kind: 'prefix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'damage', kind: 'flat', damageType: 'fire' }, tiers: tiers([[1, 2]]) },
  res: { id: 'res', group: 'res', kind: 'suffix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'fireResistance', kind: 'flat' }, tiers: tiers([[1, 2], [10, 12]]) },
  regen: { id: 'regen', group: 'regen', kind: 'suffix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'lifeRegen', kind: 'flat' }, tiers: tiers([[1, 2]]) },
  speed: { id: 'speed', group: 'speed', kind: 'suffix', slots: ['helmet'], weight: 100, line: { stat: 'movementSpeed', kind: 'increased' }, tiers: [{ min: 0.05, max: 0.1, step: 0.01, minLevel: 1 }] },
  late: { id: 'late', group: 'late', kind: 'suffix', slots: ['helmet'], weight: 100, line: { stat: 'resource', kind: 'flat' }, tiers: tiers([[5, 5]], [25]) },
};

const bases: Record<string, BaseDef> = {
  cap: { id: 'cap', slot: 'helmet', level: 1, armour: { min: 10, max: 10, step: 1 } },
  ring: { id: 'ring', slot: 'ring', level: 1 },
};

const items: ItemsData = {
  bases,
  affixes,
  rules: {
    rarityWeights: { normal: 55, magic: 33, rare: 11 },
    affixCount: { magic: { min: 1, max: 2 }, rare: { min: 3, max: 6 } },
    maxPrefixes: { magic: 1, rare: 3 },
    maxSuffixes: { magic: 1, rare: 3 },
    tierWeights: [10, 25, 50, 80, 100],
    salvage: { normal: 1, magic: 3, rare: 8, unique: 25, legendary: 100 },
    stashSize: 10,
    enforceLevelRequirement: true,
    arenaRewards: { killsPerItem: 10, maxItems: 2, wavesPerItemLevel: 2, maxBonusLevels: 3 },
    rareNameWords: { first: ['Grim'], second: ['Bane'] },
  },
};

const crafting: CraftingRules = {
  ops: {
    upgradeRarity: { cost: { shards: 10 }, costByRarity: { magic: { shards: 20 } }, counted: true },
    addAffix: { cost: { shards: 10 }, counted: true },
    rerollAffix: { cost: { shards: 10, essence: 1 }, counted: true },
    rerollValues: { cost: { shards: 5 }, counted: false },
    removeAffix: { cost: { shards: 10, essence: 2 }, counted: true },
  },
  growth: { kind: 'linear', perCraft: 0.5 },
};

const data: CraftData = { items, crafting };

const a = (affixId: string, tier = 1, value = 1): RolledAffix => ({ affixId, tier, value });

function item(rarity: Item['rarity'], list: RolledAffix[], extra: Partial<Item> = {}): Item {
  return { id: 'i1', baseId: 'cap', level: 30, rarity, name: rarity === 'rare' ? 'Grim Bane' : '', armour: 10, affixes: list, ...extra };
}

/** A profile with one hero, the item in the stash and plenty of currency. */
function setup(it: Item, currency: Record<string, number> = { shards: 1000, essence: 100 }): Profile {
  const profile = createProfile();
  createCharacter(profile, { name: 'Hero', classId: 'warrior' }, { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 }, ['warrior']);
  profile.stash.items.push(it);
  profile.currency = { ...currency };
  return profile;
}

const kinds = (it: Item): string[] => it.affixes.map((r) => affixes[r.affixId]!.kind);
const ids = (it: Item): string[] => it.affixes.map((r) => r.affixId);

describe('craft cost', () => {
  it('grows linearly with the craft counter for counted operations', () => {
    expect(craftCost(item('rare', []), 'addAffix', crafting)).toEqual({ shards: 10 });
    expect(craftCost(item('rare', [], { crafts: 1 }), 'addAffix', crafting)).toEqual({ shards: 15 });
    expect(craftCost(item('rare', [], { crafts: 3 }), 'removeAffix', crafting)).toEqual({ shards: 25, essence: 5 });
  });

  it('grows geometrically when the data says so', () => {
    const geo: CraftingRules = { ...crafting, growth: { kind: 'geometric', factor: 2 } };
    expect([0, 1, 3].map((crafts) => craftCost(item('rare', [], { crafts }), 'addAffix', geo).shards)).toEqual([10, 20, 80]);
  });

  it('prices the rarity upgrade by the current rarity, falling back to the base cost', () => {
    expect(craftCost(item('normal', []), 'upgradeRarity', crafting)).toEqual({ shards: 10 });
    expect(craftCost(item('magic', [a('life')]), 'upgradeRarity', crafting)).toEqual({ shards: 20 });
    expect(craftCost(item('magic', [a('life')], { crafts: 2 }), 'upgradeRarity', crafting)).toEqual({ shards: 40 });
  });

  it('value rerolls never get dearer', () => {
    expect(craftCost(item('rare', [], { crafts: 7 }), 'rerollValues', crafting)).toEqual({ shards: 5 });
  });

  it('reads a malformed counter as 0 and floors fractions', () => {
    expect(craftCount(item('rare', []))).toBe(0);
    expect(craftCount(item('rare', [], { crafts: -3 }))).toBe(0);
    expect(craftCount(item('rare', [], { crafts: Number.NaN }))).toBe(0);
    expect(craftCount(item('rare', [], { crafts: 2.7 }))).toBe(2);
  });
});

describe('craft rules (canCraft)', () => {
  const check = (it: Item, op: Parameters<typeof canCraft>[2], index?: number, currency?: Record<string, number>): ReturnType<typeof canCraft> =>
    canCraft(setup(it, currency), it, op, index === undefined ? {} : { index }, data);

  it('never crafts unique or legendary items', () => {
    for (const rarity of ['unique', 'legendary'] as const) {
      for (const op of ['upgradeRarity', 'addAffix', 'rerollAffix', 'rerollValues', 'removeAffix'] as const) {
        expect(check(item(rarity, [a('life')]), op, 0)).toBe('notCraftable');
      }
    }
  });

  it('refuses to upgrade a rare item and to add affixes to a normal one', () => {
    expect(check(item('rare', [a('life'), a('res'), a('regen')]), 'upgradeRarity')).toBe('rarity');
    expect(check(item('normal', []), 'addAffix')).toBe('rarity');
    expect(check(item('normal', []), 'upgradeRarity')).toBeNull();
    expect(check(item('magic', [a('life')]), 'upgradeRarity')).toBeNull();
  });

  it('needs a free slot to add an affix: rarity max and prefix / suffix caps', () => {
    expect(check(item('magic', [a('life'), a('res')]), 'addAffix')).toBe('noSlot');
    expect(check(item('magic', [a('life')]), 'addAffix')).toBeNull();
    const six = [a('life'), a('armour'), a('fire'), a('res'), a('regen'), a('speed')];
    expect(check(item('rare', six), 'addAffix')).toBe('noSlot');
    expect(check(item('rare', six.slice(0, 5)), 'addAffix')).toBeNull();
    // Every prefix and suffix that fits a ring is already there: slots are free but nothing can roll.
    expect(check(item('rare', [a('life'), a('fire'), a('res'), a('regen')], { baseId: 'ring' }), 'addAffix')).toBe('noAffix');
  });

  it('never removes below the rarity minimum', () => {
    expect(check(item('magic', [a('life')]), 'removeAffix', 0)).toBe('minAffixes');
    expect(check(item('magic', [a('life'), a('res')]), 'removeAffix', 1)).toBeNull();
    expect(check(item('rare', [a('life'), a('res'), a('regen')]), 'removeAffix', 0)).toBe('minAffixes');
    expect(check(item('rare', [a('life'), a('armour'), a('res'), a('regen')]), 'removeAffix', 0)).toBeNull();
  });

  it('validates the chosen affix index', () => {
    const it = item('rare', [a('life'), a('res'), a('regen')]);
    for (const index of [undefined, -1, 3, 1.5]) {
      for (const op of ['rerollAffix', 'rerollValues', 'removeAffix'] as const) expect(check(it, op, index)).toBe('badIndex');
    }
    expect(check(item('normal', []), 'rerollValues', 0)).toBe('badIndex');
    expect(check(item('rare', [a('gone'), a('res'), a('regen')]), 'rerollValues', 0)).toBe('unknownAffix');
    expect(check(item('rare', [a('life', 9), a('res'), a('regen')]), 'rerollValues', 0)).toBe('unknownAffix');
  });

  it('treats zero-weight affixes as unavailable (never charged for an item left below the minimum)', () => {
    const zero: CraftData = { ...data, items: { ...items, affixes: { ...affixes, fire: { ...affixes.fire!, weight: 0 }, regen: { ...affixes.regen!, weight: 0 } } } };
    const ring = (rarity: Item['rarity'], list: RolledAffix[]): Item => item(rarity, list, { baseId: 'ring' });
    const check = (it: Item, op: Parameters<typeof canCraft>[2], index?: number): ReturnType<typeof canCraft> =>
      canCraft(setup(it), it, op, index === undefined ? {} : { index }, zero);
    // Magic → rare needs two more affixes; only `life` can roll on a ring.
    expect(check(ring('magic', [a('res')]), 'upgradeRarity')).toBe('noAffix');
    expect(check(ring('rare', [a('life'), a('res'), a('speed')]), 'addAffix')).toBe('noAffix');
    expect(check(ring('rare', [a('life'), a('res'), a('speed')]), 'rerollAffix', 0)).toBe('noAffix');
    const profile = setup(ring('magic', [a('res')]));
    expect(applyCraft(profile, 'i1', 'upgradeRarity', {}, createRng(1), zero)).toEqual({ ok: false, error: 'noAffix' });
    expect(profile.currency).toEqual({ shards: 1000, essence: 100 });
  });

  it('refuses an affix reroll when no other affix of that kind can roll', () => {
    expect(check(item('rare', [a('life'), a('fire'), a('res')], { baseId: 'ring' }), 'rerollAffix', 0)).toBe('noAffix');
    expect(check(item('rare', [a('life'), a('fire'), a('res')], { baseId: 'ring' }), 'rerollAffix', 2)).toBeNull();
  });

  it('checks every currency of the cost, structural reasons first', () => {
    const it = item('rare', [a('life'), a('armour'), a('res'), a('regen')]);
    expect(check(it, 'addAffix', undefined, { shards: 9 })).toBe('currency');
    expect(check(it, 'addAffix', undefined, { shards: 10 })).toBeNull();
    // Essence operations are refused at 0 essence however many shards there are.
    expect(check(it, 'rerollAffix', 0, { shards: 1000 })).toBe('currency');
    expect(check(it, 'removeAffix', 0, { shards: 1000, essence: 1 })).toBe('currency');
    expect(check(it, 'removeAffix', 0, { shards: 1000, essence: 2 })).toBeNull();
    expect(check(item('rare', [a('life'), a('res'), a('regen')]), 'removeAffix', 0, {})).toBe('minAffixes');
    // The counter raises the price.
    expect(check({ ...it, crafts: 2 }, 'addAffix', undefined, { shards: 19 })).toBe('currency');
  });
});

describe('craft operations (applyCraft)', () => {
  it('upgrades normal → magic with one affix and magic → rare up to three, naming the rare', () => {
    const profile = setup(item('normal', []));
    const magic = applyCraft(profile, 'i1', 'upgradeRarity', {}, createRng(1), data);
    if (!magic.ok) throw new Error(magic.error);
    expect(magic.item.rarity).toBe('magic');
    expect(magic.item.affixes).toHaveLength(1);
    expect(magic.item.name).toBe('');
    expect(magic.item.crafts).toBe(1);
    expect(magic.cost).toEqual({ shards: 10 });

    const rare = applyCraft(profile, 'i1', 'upgradeRarity', {}, createRng(2), data);
    if (!rare.ok) throw new Error(rare.error);
    expect(rare.item.rarity).toBe('rare');
    expect(rare.item.affixes).toHaveLength(3);
    expect(rare.item.affixes).toContainEqual(magic.item.affixes[0]);
    expect(rare.item.name).toBe('Grim Bane');
    expect(rare.item.crafts).toBe(2);
    expect(rare.cost).toEqual({ shards: 30 });
    expect(profile.currency).toEqual({ shards: 960, essence: 100 });
    expect(profile.stash.items[0]).toBe(rare.item);
    expect(applyCraft(profile, 'i1', 'upgradeRarity', {}, createRng(3), data)).toEqual({ ok: false, error: 'rarity' });
  });

  it('gives exact results for a fixed seed and is deterministic', () => {
    const run = (): Profile => {
      const profile = setup(item('normal', []));
      const rng = createRng(42);
      applyCraft(profile, 'i1', 'upgradeRarity', {}, rng, data);
      applyCraft(profile, 'i1', 'upgradeRarity', {}, rng, data);
      applyCraft(profile, 'i1', 'addAffix', {}, rng, data);
      applyCraft(profile, 'i1', 'rerollAffix', { index: 0 }, rng, data);
      applyCraft(profile, 'i1', 'rerollValues', { index: 1 }, rng, data);
      return profile;
    };
    const profile = run();
    expect(profile).toEqual(run());
    expect(profile.stash.items[0]).toEqual(EXPECTED_SEED_42);
    // Shards 10 + 30 (magic → rare: 20 × 1.5) + 20 + 25 + 5 (value reroll, uncounted); essence 1 × 2.5 rounds to 3.
    expect(profile.currency).toEqual({ shards: 910, essence: 97 });
  });

  it('adds one affix of a kind that still has room, never a duplicate group', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const profile = setup(item('magic', [a('life')]));
      const result = applyCraft(profile, 'i1', 'addAffix', {}, createRng(seed), data);
      if (!result.ok) throw new Error(result.error);
      expect(kinds(result.item)).toEqual(['prefix', 'suffix']);

      const rareProfile = setup(item('rare', [a('life'), a('armour'), a('res')]));
      const rare = applyCraft(rareProfile, 'i1', 'addAffix', {}, createRng(seed), data);
      if (!rare.ok) throw new Error(rare.error);
      expect(rare.item.affixes).toHaveLength(4);
      expect(new Set(ids(rare.item)).size).toBe(4);
      expect(kinds(rare.item)).toEqual([...kinds(rare.item)].sort((x, y) => (x === 'prefix' ? 0 : 1) - (y === 'prefix' ? 0 : 1)));
    }
  });

  it('rerolls the chosen affix into a different one of the same kind, keeping the others', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const before = item('rare', [a('life'), a('armour'), a('res'), a('regen')]);
      const profile = setup(before);
      const result = applyCraft(profile, 'i1', 'rerollAffix', { index: 2 }, createRng(seed), data);
      if (!result.ok) throw new Error(result.error);
      const rolled = result.item.affixes[2]!;
      expect(affixes[rolled.affixId]!.kind).toBe('suffix');
      expect(['res', 'regen']).not.toContain(rolled.affixId);
      seen.add(rolled.affixId);
      expect([0, 1, 3].map((i) => result.item.affixes[i])).toEqual([0, 1, 3].map((i) => before.affixes[i]));
      expect(result.cost).toEqual({ shards: 10, essence: 1 });
      expect(profile.currency.essence).toBe(99);
    }
    expect([...seen].sort()).toEqual(['late', 'speed']);
  });

  it('rerolls values inside the same tier without counting', () => {
    const values = new Set<number>();
    for (let seed = 1; seed <= 100; seed++) {
      const profile = setup(item('rare', [a('life', 1, 50), a('res', 2, 1), a('regen')], { crafts: 4 }));
      const result = applyCraft(profile, 'i1', 'rerollValues', { index: 0 }, createRng(seed), data);
      if (!result.ok) throw new Error(result.error);
      const rolled = result.item.affixes[0]!;
      expect(rolled.affixId).toBe('life');
      expect(rolled.tier).toBe(1);
      expect(rolled.value).toBeGreaterThanOrEqual(50);
      expect(rolled.value).toBeLessThanOrEqual(60);
      values.add(rolled.value);
      expect(result.item.crafts).toBe(4);
      expect(result.cost).toEqual({ shards: 5 });
    }
    expect(values.size).toBe(11);
  });

  it('removes the chosen affix and frees its slot', () => {
    const profile = setup(item('rare', [a('life'), a('armour'), a('res'), a('regen')]));
    const result = applyCraft(profile, 'i1', 'removeAffix', { index: 1 }, createRng(1), data);
    if (!result.ok) throw new Error(result.error);
    expect(ids(result.item)).toEqual(['life', 'res', 'regen']);
    expect(result.item.crafts).toBe(1);
    expect(profile.currency).toEqual({ shards: 990, essence: 98 });
    expect(applyCraft(profile, 'i1', 'removeAffix', { index: 0 }, createRng(1), data)).toEqual({ ok: false, error: 'minAffixes' });
  });

  it('respects item level for new affixes and tiers', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const low = item('rare', [a('life', 3), a('res', 2)], { level: 5 });
      const profile = setup(low);
      const added = applyCraft(profile, 'i1', 'addAffix', {}, createRng(seed), data);
      if (!added.ok) throw new Error(added.error);
      const rerolled = applyCraft(profile, 'i1', 'rerollAffix', { index: 0 }, createRng(seed + 1000), data);
      if (!rerolled.ok) throw new Error(rerolled.error);
      for (const r of [...added.item.affixes.slice(2), rerolled.item.affixes[0]!]) {
        expect(r.affixId).not.toBe('late');
        expect(r.tier).toBe(affixes[r.affixId]!.tiers.length); // only the lowest tier unlocks at level 5
      }
    }
  });

  it('changes nothing when refused (currency, missing item)', () => {
    const before = item('rare', [a('life'), a('armour'), a('res'), a('regen')]);
    const profile = setup(before, { shards: 1000 });
    expect(applyCraft(profile, 'i1', 'rerollAffix', { index: 0 }, createRng(1), data)).toEqual({ ok: false, error: 'currency' });
    expect(applyCraft(profile, 'nope', 'addAffix', {}, createRng(1), data)).toEqual({ ok: false, error: 'noItem' });
    expect(profile.stash.items[0]).toBe(before);
    expect(profile.currency).toEqual({ shards: 1000 });
  });

  it('crafts equipped items in place so equipment stats follow', () => {
    const profile = setup(item('magic', [a('life', 1, 50)]));
    const helmet = profile.stash.items.pop()!;
    profile.characters[0]!.equipment.helmet = helmet;
    expect(findItem(profile, 'i1')?.location).toEqual({ where: 'equipped', characterId: 'c1', slot: 'helmet' });
    const result = applyCraft(profile, 'i1', 'rerollValues', { index: 0 }, createRng(5), data);
    if (!result.ok) throw new Error(result.error);
    const equipped = profile.characters[0]!.equipment.helmet!;
    expect(equipped).toBe(result.item);
    expect(computeStat(0, equipmentModifiers(profile.characters[0]!.equipment, items), 'life')).toBe(equipped.affixes[0]!.value);
    expect(profile.stash.items).toHaveLength(0);
  });
});

describe('crafting data', () => {
  it('prices every operation in shards; affix reroll and removal also need essence', () => {
    for (const op of Object.values(craftingRules.ops)) expect(op.cost[SALVAGE_CURRENCY]).toBeGreaterThan(0);
    expect(craftingRules.ops.rerollAffix.cost[ESSENCE_CURRENCY]).toBeGreaterThan(0);
    expect(craftingRules.ops.removeAffix.cost[ESSENCE_CURRENCY]).toBeGreaterThan(0);
    expect(craftingRules.ops.rerollValues.counted).toBe(false);
    // Designer decision 2026-10-23: magic → rare costs more than normal → magic.
    const step = (rarity: Item['rarity']): number => craftCost({ id: 'x', baseId: 'x', level: 1, rarity, name: '', affixes: [] }, 'upgradeRarity', craftingRules)[SALVAGE_CURRENCY]!;
    expect(step('magic')).toBeGreaterThan(step('normal'));
  });

  it('works on generated items with the real tables', () => {
    const real: CraftData = { items: itemsData, crafting: craftingRules };
    const it: Item = { id: 'i1', baseId: Object.keys(itemsData.bases)[0]!, level: 20, rarity: 'normal', name: '', affixes: [] };
    const profile = setup(it, { [SALVAGE_CURRENCY]: 100 });
    const rng = createRng(7);
    expect(applyCraft(profile, 'i1', 'upgradeRarity', {}, rng, real).ok).toBe(true);
    expect(applyCraft(profile, 'i1', 'upgradeRarity', {}, rng, real).ok).toBe(true);
    expect(profile.stash.items[0]!.affixes.length).toBeGreaterThanOrEqual(3);
    // No essence source before maps: essence operations stay unaffordable.
    expect(canCraft(profile, profile.stash.items[0]!, 'rerollAffix', { index: 0 }, real)).toBe('currency');
  });
});

const EXPECTED_SEED_42: Item = { id: 'i1', baseId: 'cap', level: 30, rarity: 'rare', name: 'Grim Bane', armour: 10, crafts: 4, affixes: [a('life', 3, 2), a('regen', 1, 2), a('speed', 1, 0.08), a('late', 1, 5)] };

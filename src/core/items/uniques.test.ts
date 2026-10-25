// Uniques and legendaries (docs/design/items.md, decisions 2026-10-21 / 2026-10-25): generation with tiered stat
// lines, drop pool, rarity roll, modifiers and mechanics, the duplicate rule, crafting and salvage.
import { describe, expect, it } from 'vitest';
import { craftingRules } from '../../data/crafting';
import { itemsData } from '../../data/items';
import { passiveTree } from '../../data/passives';
import { createAllocation } from '../passives/allocation';
import { heroMechanics } from '../progression/hero';
import { createCharacter, createProfile } from '../progression/profile';
import { createRng } from '../rng';
import { canCraft, CRAFT_OPS } from './craft';
import { canEquip, equipmentMechanics, equipSlotsFor } from './equipment';
import { generateItem, generateUnique, itemMechanics, itemModifiers, rollRarity, tierOf, uniqueDefOf, uniquePool, uniqueTierAt } from './generate';
import { equipFromStash, salvageFromStash } from './inventory';
import type { Item, ItemsData, UniqueDef } from './types';

const TIERS = [1, 8, 15, 23, 30].map((minLevel, i) => ({ min: i * 10, max: i * 10 + 5, step: 1, minLevel }));

const testRing: UniqueDef = { id: 'test_ring', rarity: 'unique', baseId: 'iron_ring', weight: 1, stats: [{ stat: 'life', kind: 'flat', tiers: TIERS }] };
const lateRing: UniqueDef = { ...testRing, id: 'late_ring', level: 20 };
const offRing: UniqueDef = { ...testRing, id: 'off_ring', weight: 0 };
const lostBase: UniqueDef = { ...testRing, id: 'lost_base', baseId: 'no_such_base' };
const legend: UniqueDef = {
  id: 'test_legend',
  rarity: 'legendary',
  baseId: 'amber_amulet',
  weight: 1,
  stats: [{ stat: 'life', kind: 'increased', tiers: TIERS.map((t) => ({ ...t, min: t.min / 100, max: t.max / 100, step: 0.01 })) }],
  mechanics: [{ kind: 'lifeLeech', fraction: 0.1 }],
};

const data: ItemsData = { ...itemsData, uniques: { ...itemsData.uniques, test_ring: testRing, late_ring: lateRing, off_ring: offRing, lost_base: lostBase, test_legend: legend } };

describe('unique generation', () => {
  it('a stat line rolls in the best tier unlocked at the item level (no draw); below every tier: the worst', () => {
    const at = (level: number): number | undefined => uniqueTierAt({ tiers: TIERS }, level)?.number;
    expect([0, 1, 7, 8, 14, 15, 22, 23, 29, 30, 99].map(at)).toEqual([5, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
    expect(uniqueTierAt({ tiers: [] }, 10)).toBeUndefined();
  });

  it('rolls base defences, implicit and one value per stat line inside its tier; no affixes, no name', () => {
    const def = itemsData.uniques.glass_cannon_crown!;
    const low = generateUnique(createRng(1), 'u1', def, 1, itemsData);
    expect(low).toMatchObject({ id: 'u1', baseId: 'leather_helm', level: 1, rarity: 'unique', name: '', affixes: [] });
    expect(low.unique!.id).toBe('glass_cannon_crown');
    expect(low.unique!.rolls.map((r) => r.tier)).toEqual([5, 5, 5]);
    const high = generateUnique(createRng(1), 'u2', def, 30, itemsData);
    expect(high.unique!.rolls.map((r) => r.tier)).toEqual([1, 1, 1]);
    expect(high).toEqual(generateUnique(createRng(1), 'u2', def, 30, itemsData));
    for (const item of [low, high]) {
      expect(item.armour).toBeGreaterThanOrEqual(4);
      expect(item.energyShield).toBeGreaterThanOrEqual(3);
      expect(item.implicit).toBeGreaterThanOrEqual(5);
    }
    // Every roll of every unique sits inside its tier, at every tier level.
    for (const u of Object.values(itemsData.uniques)) {
      for (const level of [1, 8, 15, 23, 30]) {
        for (let seed = 0; seed < 20; seed++) {
          const item = generateUnique(createRng(seed), 'x', u, level, itemsData);
          item.unique!.rolls.forEach((roll, i) => {
            const tier = tierOf(u.stats[i]!, roll.tier)!;
            expect(roll.value).toBeGreaterThanOrEqual(tier.min);
            expect(roll.value).toBeLessThanOrEqual(tier.max);
          });
        }
      }
    }
  });

  it('exact rolls for a fixed seed', () => {
    expect(generateUnique(createRng(7), 'r', testRing, 16, data)).toEqual({
      id: 'r',
      baseId: 'iron_ring',
      level: 16,
      rarity: 'unique',
      name: '',
      affixes: [],
      implicit: expect.any(Number),
      unique: { id: 'test_ring', rolls: [{ tier: 3, value: 20 }] },
    });
  });

  it('drop pool: by rarity, positive weight, known base, level reached, optional slot', () => {
    const ids = (rarity: 'unique' | 'legendary', level: number, slot?: Parameters<typeof uniquePool>[3]): string[] => uniquePool(data, rarity, level, slot).map((u) => u.id);
    expect(ids('unique', 1, 'ring')).toEqual(['bloody_pupil', 'rift_ring', 'test_ring']);
    expect(ids('unique', 20, 'ring')).toEqual(['bloody_pupil', 'rift_ring', 'test_ring', 'late_ring']);
    expect(ids('legendary', 1)).toEqual(['test_legend']);
    const realUniques = Object.values(itemsData.uniques).filter((u) => u.rarity === 'unique').map((u) => u.id);
    expect(ids('unique', 1)).toEqual([...realUniques, 'test_ring']);
    // The real legendaries (6c: Devourer's Crown on a level-15 helmet base; 6d: the Clock on an amulet, gated at 15
    // too) never enter the unique pool.
    expect(uniquePool(itemsData, 'legendary', 99).map((u) => u.id)).toEqual(['devourer_crown', 'clock_last_moment']);
    expect(uniquePool(itemsData, 'legendary', 15).map((u) => u.id)).toEqual(['devourer_crown', 'clock_last_moment']);
    expect(uniquePool(itemsData, 'legendary', 14)).toEqual([]);
  });
});

describe('unique drops', () => {
  const onlyUniques = (d: ItemsData): ItemsData => ({ ...d, rules: { ...d.rules, rarityWeights: { normal: 0, magic: 0, rare: 0, unique: 1 } } });

  it('a unique rarity roll picks a unique for the slot and level; with none available the item is rare', () => {
    // Fixture uniques only: the real data has a unique for every slot.
    const fixtures: ItemsData = { ...data, uniques: { test_ring: testRing, late_ring: lateRing, off_ring: offRing, lost_base: lostBase, test_legend: legend } };
    const ring = generateItem(createRng(3), 'a', { itemLevel: 5, slot: 'ring' }, onlyUniques(fixtures));
    expect(ring).toMatchObject({ rarity: 'unique', baseId: 'iron_ring', unique: { id: 'test_ring' } });
    const boots = generateItem(createRng(3), 'b', { itemLevel: 5, slot: 'boots' }, onlyUniques(fixtures));
    expect(boots.rarity).toBe('rare');
    expect(boots.unique).toBeUndefined();
    expect(boots.affixes.length).toBeGreaterThanOrEqual(3);
    expect(boots.name).not.toBe('');
  });

  it('rarity weights: unique ≈ 1 in 100, ×3 with the boss multiplier, untouched by speed luck', () => {
    const count = (luck: number, multiplier: number): number => {
      const rng = createRng(11);
      let n = 0;
      for (let i = 0; i < 100000; i++) if (rollRarity(rng, itemsData, luck, multiplier) === 'unique') n++;
      return n;
    };
    expect(count(0, 1)).toBe(1011);
    // ×3: weight 3 of 102 (≈ 2.94%).
    expect(count(0, 3)).toBe(2928);
    // Luck moves weight from normal to magic / rare only; the unique weight and the total stay the same.
    expect(count(0.3, 1)).toBe(count(0, 1));
    expect(count(0.3, 3)).toBe(count(0, 3));
  });
});

describe('unique modifiers and mechanics', () => {
  const crown = (rolls: Item['unique']): Item => ({ id: 'c', baseId: 'leather_helm', level: 30, rarity: 'unique', name: '', affixes: [], armour: 5, energyShield: 4, implicit: 6, ...(rolls ? { unique: rolls } : {}) });

  it('base defences and implicit, then the rolled lines, the effect modifiers and the costs', () => {
    const item = crown({ id: 'glass_cannon_crown', rolls: [{ tier: 1, value: 0.33 }, { tier: 1, value: 0.55 }, { tier: 1, value: 35 }] });
    expect(itemModifiers(item, itemsData)).toEqual([
      { stat: 'armour', kind: 'flat', value: 5 },
      { stat: 'energyShield', kind: 'flat', value: 4 },
      { stat: 'resource', kind: 'flat', value: 6 },
      { stat: 'damage', kind: 'increased', value: 0.33 },
      { stat: 'critChance', kind: 'increased', value: 0.55 },
      { stat: 'resource', kind: 'flat', value: 35 },
      { stat: 'damage', kind: 'more', value: 0.5 },
      { stat: 'damageTaken', kind: 'more', value: 0.4 },
    ]);
    // A line without a roll gives nothing; the fixed parts stay.
    expect(itemModifiers(crown({ id: 'glass_cannon_crown', rolls: [{ tier: 1, value: 0.33 }] }), itemsData).slice(3)).toEqual([
      { stat: 'damage', kind: 'increased', value: 0.33 },
      { stat: 'damage', kind: 'more', value: 0.5 },
      { stat: 'damageTaken', kind: 'more', value: 0.4 },
    ]);
  });

  it('an unknown unique id keeps only the base (removed unique: no stats, no mechanics)', () => {
    const item = crown({ id: 'gone', rolls: [{ tier: 1, value: 99 }] });
    expect(uniqueDefOf(item, itemsData)).toBeUndefined();
    expect(itemModifiers(item, itemsData)).toEqual([
      { stat: 'armour', kind: 'flat', value: 5 },
      { stat: 'energyShield', kind: 'flat', value: 4 },
      { stat: 'resource', kind: 'flat', value: 6 },
    ]);
    expect(itemMechanics(item, itemsData)).toEqual([]);
  });

  it('equipped uniques bring their mechanics; heroMechanics puts them after the passive ones', () => {
    const amulet = generateUnique(createRng(1), 'l', legend, 30, data);
    const sword = generateUnique(createRng(1), 's', itemsData.uniques.barrow_reaper!, 1, data);
    const ring = generateUnique(createRng(1), 'r', testRing, 1, data);
    expect(itemMechanics(ring, data)).toEqual([]);
    const equipment = { amulet, weapon: sword, ring1: ring };
    expect(equipmentMechanics(equipment, data)).toEqual([
      { kind: 'skillParams', skillIds: ['cleave'], resourcePerHit: 2 },
      { kind: 'lifeLeech', fraction: 0.1 },
    ]);
    const passives = createAllocation();
    expect(heroMechanics({ equipment, passives }, passiveTree, data)).toEqual(equipmentMechanics(equipment, data));
  });
});

describe('unique rules: duplicates, crafting, salvage', () => {
  const hero = (): { profile: ReturnType<typeof createProfile>; id: string } => {
    const profile = createProfile();
    const r = createCharacter(profile, { name: 'Aria', classId: 'warrior' }, { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 }, ['warrior']);
    if (!r.ok) throw new Error('create failed');
    return { profile, id: r.character.id };
  };

  it('the same unique cannot be worn twice (two identical rings); replacing the worn copy is fine', () => {
    const a = generateUnique(createRng(1), 'a', testRing, 1, data);
    const b = generateUnique(createRng(2), 'b', testRing, 1, data);
    const other = generateItem(createRng(3), 'c', { itemLevel: 1, slot: 'ring', rarity: 'magic' }, data);
    const who = { level: 1, weaponType: 'sword' as const, equipment: { ring1: a } };
    expect(canEquip(b, 'ring2', who, data)).toBe('unique-duplicate');
    expect(canEquip(b, 'ring1', who, data)).toBeNull();
    expect(canEquip(other, 'ring2', who, data)).toBeNull();
    // Without the equipment the rule cannot be checked (old callers).
    expect(canEquip(b, 'ring2', { level: 1, weaponType: 'sword' }, data)).toBeNull();

    const { profile, id } = hero();
    profile.stash.items.push(a, b);
    expect(equipFromStash(profile, id, 'a', 'sword', data)).toBeNull();
    // An explicit other ring place is refused.
    expect(equipFromStash(profile, id, 'b', 'sword', data, 'ring2')).toBe('unique-duplicate');
    expect(profile.stash.items.map((i) => i.id)).toEqual(['b']);
    expect(equipFromStash(profile, id, 'b', 'sword', data, 'ring1')).toBeNull();
    expect(profile.stash.items.map((i) => i.id)).toEqual(['a']);
  });

  it('auto-targeting swaps a unique ring with its worn copy instead of refusing (ring1 full / ring2 empty, both full)', () => {
    const a = generateUnique(createRng(1), 'a', testRing, 1, data);
    const b = generateUnique(createRng(2), 'b', testRing, 1, data);
    const other = generateItem(createRng(3), 'c', { itemLevel: 1, slot: 'ring', rarity: 'magic' }, data);
    expect(equipSlotsFor('ring', { ring1: a }, b)).toEqual(['ring1', 'ring2']);
    expect(equipSlotsFor('ring', { ring1: other, ring2: a }, b)).toEqual(['ring2', 'ring1']);
    // Not a unique / no copy worn: the usual order (first empty ring).
    expect(equipSlotsFor('ring', { ring1: a }, other)).toEqual(['ring2', 'ring1']);
    expect(equipSlotsFor('ring', { ring1: other })).toEqual(['ring2', 'ring1']);

    // ring1 holds the copy, ring2 is empty: the new copy replaces ring1, ring2 stays empty.
    const first = hero();
    first.profile.stash.items.push(a, b);
    expect(equipFromStash(first.profile, first.id, 'a', 'sword', data)).toBeNull();
    expect(equipFromStash(first.profile, first.id, 'b', 'sword', data)).toBeNull();
    const eq1 = first.profile.characters[0]!.equipment;
    expect([eq1.ring1?.id, eq1.ring2?.id]).toEqual(['b', undefined]);
    expect(first.profile.stash.items.map((i) => i.id)).toEqual(['a']);

    // Both rings full, the copy in ring2: the new copy replaces ring2, ring1 keeps the other ring.
    const second = hero();
    second.profile.stash.items.push(other, a, b);
    expect(equipFromStash(second.profile, second.id, 'c', 'sword', data)).toBeNull();
    expect(equipFromStash(second.profile, second.id, 'a', 'sword', data)).toBeNull();
    expect(equipFromStash(second.profile, second.id, 'b', 'sword', data)).toBeNull();
    const eq2 = second.profile.characters[0]!.equipment;
    expect([eq2.ring1?.id, eq2.ring2?.id]).toEqual(['c', 'b']);
    expect(second.profile.stash.items.map((i) => i.id)).toEqual(['a']);
  });

  it('crafting refuses uniques and legendaries; salvage gives 25 / 100 shards', () => {
    const { profile } = hero();
    const u = generateUnique(createRng(1), 'u', testRing, 1, data);
    const l = generateUnique(createRng(1), 'l', legend, 1, data);
    profile.stash.items.push(u, l);
    for (const item of [u, l]) {
      for (const op of CRAFT_OPS) expect(canCraft(profile, item, op, { index: 0 }, { items: data, crafting: craftingRules })).toBe('notCraftable');
    }
    expect(salvageFromStash(profile, 'u', data)).toBe(25);
    expect(salvageFromStash(profile, 'l', data)).toBe(100);
    expect(profile.currency.shards).toBe(125);
  });
});

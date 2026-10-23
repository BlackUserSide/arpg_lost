import { describe, expect, it } from 'vitest';
import { createCharacter, createProfile } from '../progression/profile';
import { createRng } from '../rng';
import { computeStat } from '../stats/modifiers';
import { canEquip, equippedWeapon, equipmentModifiers, equipSlotsFor } from './equipment';
import { generateItem, itemModifiers, rollRarity, rollValue } from './generate';
import { addToStash, equipFromStash, rollItem, salvageFromStash, SALVAGE_CURRENCY, unequipToStash } from './inventory';
import type { AffixDef, BaseDef, Item, ItemsData } from './types';
import { itemsData } from '../../data/items';

const tiers = (values: Array<[number, number]>, levels = [1, 10, 20]): AffixDef['tiers'] =>
  values.map(([min, max], i) => ({ min, max, step: 1, minLevel: levels[i] ?? 1 }));

const affixes: Record<string, AffixDef> = {
  life: { id: 'life', group: 'life', kind: 'prefix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'life', kind: 'flat' }, tiers: tiers([[1, 2], [10, 12], [50, 60]]) },
  armour: { id: 'armour', group: 'armour', kind: 'prefix', slots: ['helmet'], weight: 100, line: { stat: 'armour', kind: 'flat' }, tiers: tiers([[1, 2], [10, 12], [50, 60]]) },
  fire: { id: 'fire', group: 'fire', kind: 'prefix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'damage', kind: 'flat', damageType: 'fire' }, tiers: tiers([[1, 2]]) },
  res: { id: 'res', group: 'res', kind: 'suffix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'fireResistance', kind: 'flat' }, tiers: tiers([[1, 2]]) },
  regen: { id: 'regen', group: 'regen', kind: 'suffix', slots: ['helmet', 'ring'], weight: 100, line: { stat: 'lifeRegen', kind: 'flat' }, tiers: tiers([[1, 2]]) },
  speed: { id: 'speed', group: 'speed', kind: 'suffix', slots: ['helmet'], weight: 100, line: { stat: 'movementSpeed', kind: 'increased' }, tiers: [{ min: 0.05, max: 0.1, step: 0.01, minLevel: 1 }] },
  late: { id: 'late', group: 'late', kind: 'suffix', slots: ['helmet'], weight: 100, line: { stat: 'resource', kind: 'flat' }, tiers: tiers([[5, 5]], [25]) },
};

const bases: Record<string, BaseDef> = {
  cap: { id: 'cap', slot: 'helmet', level: 1, armour: { min: 10, max: 10, step: 1 }, implicit: { stat: 'resource', kind: 'flat', range: { min: 5, max: 5, step: 1 } } },
  crown: { id: 'crown', slot: 'helmet', level: 15, armour: { min: 40, max: 40, step: 1 } },
  ring: { id: 'ring', slot: 'ring', level: 1 },
  sword: { id: 'sword', slot: 'weapon', level: 1, weapon: { type: 'sword', damage: { physical: { min: 5, max: 9 } }, attacksPerSecond: 1.2, critChance: 0.05 } },
  wand: { id: 'wand', slot: 'weapon', level: 1, weapon: { type: 'wand', damage: { lightning: { min: 3, max: 7 } }, attacksPerSecond: 1.5, critChance: 0.07 } },
};

const data: ItemsData = {
  bases,
  affixes,
  rules: {
    rarityWeights: { normal: 55, magic: 33, rare: 11 },
    affixCount: { magic: { min: 1, max: 2 }, rare: { min: 3, max: 6 } },
    maxPrefixes: { magic: 1, rare: 3 },
    maxSuffixes: { magic: 1, rare: 3 },
    tierWeights: [10, 25, 50, 80, 100],
    salvage: { normal: 1, magic: 3, rare: 8, unique: 25, legendary: 100 },
    stashSize: 3,
    enforceLevelRequirement: true,
    arenaRewards: { killsPerItem: 10, maxItems: 2, wavesPerItemLevel: 2, maxBonusLevels: 3 },
    rareNameWords: { first: ['Grim'], second: ['Bane'] },
  },
};

const make = (seed: number, opts: Parameters<typeof generateItem>[2]): Item => generateItem(createRng(seed), 'x', opts, data);

describe('item generation', () => {
  it('is deterministic for a seed', () => {
    expect(make(5, { itemLevel: 20, rarity: 'rare' })).toEqual(make(5, { itemLevel: 20, rarity: 'rare' }));
  });

  // Golden drops on the real tables: a refactor that changes seeded drop output must fail here. Update only when
  // data/items.ts or the generation rules change on purpose.
  it('pins seeded drops on the real item data', () => {
    const real = (seed: number, opts: Parameters<typeof generateItem>[2]): Item => generateItem(createRng(seed), 'x', opts, itemsData);
    expect(real(7, { itemLevel: 20, rarity: 'rare' })).toEqual({
      id: 'x', baseId: 'rusty_sword', level: 20, rarity: 'rare', name: 'Dusk Crown', implicit: 0.13,
      affixes: [
        { affixId: 'added_lightning', tier: 4, value: 4 },
        { affixId: 'spell_damage_inc', tier: 5, value: 0.11 },
        { affixId: 'crit_multiplier', tier: 5, value: 0.12 },
      ],
    });
    expect(real(5, { itemLevel: 20 })).toEqual({
      id: 'x', baseId: 'iron_greaves', level: 20, rarity: 'magic', name: '', implicit: 0.05, armour: 6,
      affixes: [{ affixId: 'cold_res', tier: 3, value: 0.21 }],
    });
    expect(real(11, { itemLevel: 20 })).toEqual({
      id: 'x', baseId: 'scale_robe', level: 20, rarity: 'normal', name: '', implicit: 22, armour: 36, energyShield: 29, affixes: [],
    });
    expect(real(9, { itemLevel: 12, luck: 0.5 })).toEqual({
      id: 'x', baseId: 'driftwood_wand', level: 12, rarity: 'rare', name: 'Blood Whisper', implicit: 0.07,
      affixes: [
        { affixId: 'added_cold', tier: 5, value: 2 },
        { affixId: 'spell_damage_inc', tier: 5, value: 0.13 },
        { affixId: 'crit_chance', tier: 5, value: 0.16 },
      ],
    });
  });

  it('respects rarity affix counts, prefix/suffix caps and unique groups', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const rarity of ['normal', 'magic', 'rare'] as const) {
        const item = make(seed, { itemLevel: 30, rarity, slot: 'helmet' });
        const kinds = item.affixes.map((a) => affixes[a.affixId]!.kind);
        const prefixes = kinds.filter((k) => k === 'prefix').length;
        const suffixes = kinds.length - prefixes;
        if (rarity === 'normal') expect(item.affixes).toHaveLength(0);
        if (rarity === 'magic') {
          expect(item.affixes.length).toBeGreaterThanOrEqual(1);
          expect(prefixes).toBeLessThanOrEqual(1);
          expect(suffixes).toBeLessThanOrEqual(1);
        }
        if (rarity === 'rare') {
          expect(item.affixes.length).toBeGreaterThanOrEqual(3);
          expect(prefixes).toBeLessThanOrEqual(3);
          expect(suffixes).toBeLessThanOrEqual(3);
          expect(item.name).toBe('Grim Bane');
        } else {
          // Display names are not core's job: normal / magic items are named by their base in render.
          expect(item.name).toBe('');
        }
        expect(new Set(item.affixes.map((a) => a.affixId)).size).toBe(item.affixes.length);
        // Prefixes listed first.
        expect(kinds).toEqual([...kinds].sort((a, b) => (a === 'prefix' ? 0 : 1) - (b === 'prefix' ? 0 : 1)));
      }
    }
  });

  it('only rolls bases, affixes and tiers allowed by item level', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const item = make(seed, { itemLevel: 5, rarity: 'rare', slot: 'helmet' });
      expect(item.baseId).toBe('cap');
      for (const a of item.affixes) {
        expect(a.affixId).not.toBe('late');
        expect(a.tier).toBe(affixes[a.affixId]!.tiers.length); // only the lowest tier at level 5
      }
    }
  });

  it('rolls values inside the tier range on the step grid', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const item = make(seed, { itemLevel: 25, rarity: 'rare', slot: 'helmet' });
      for (const a of item.affixes) {
        const def = affixes[a.affixId]!;
        const tier = def.tiers[def.tiers.length - a.tier]!;
        expect(a.value).toBeGreaterThanOrEqual(tier.min);
        expect(a.value).toBeLessThanOrEqual(tier.max);
        expect(Math.abs(a.value / tier.step - Math.round(a.value / tier.step))).toBeLessThan(1e-6);
      }
    }
  });

  it('higher tiers are rarer than lower ones', () => {
    const counts = [0, 0, 0, 0];
    for (let seed = 1; seed <= 2000; seed++) {
      for (const a of make(seed, { itemLevel: 25, rarity: 'magic', slot: 'ring' }).affixes) if (a.affixId === 'life') counts[a.tier]!++;
    }
    expect(counts[1]).toBeLessThan(counts[2]!);
    expect(counts[2]).toBeLessThan(counts[3]!);
  });

  it('rollValue avoids float noise', () => {
    const rng = createRng(1);
    for (let i = 0; i < 100; i++) {
      const v = rollValue(rng, { min: 0.1, max: 0.3, step: 0.01 });
      expect(String(v).length).toBeLessThanOrEqual(4);
    }
  });

  it('rarity luck shifts weight away from normal items', () => {
    const count = (luck: number): number => {
      const rng = createRng(9);
      let normal = 0;
      for (let i = 0; i < 5000; i++) if (rollRarity(rng, data, luck) === 'normal') normal++;
      return normal;
    };
    expect(count(0.5)).toBeLessThan(count(0) * 0.7);
  });
});

describe('item modifiers and equipment', () => {
  const item: Item = {
    id: 'a',
    baseId: 'cap',
    level: 1,
    rarity: 'magic',
    name: 'Cap',
    implicit: 5,
    armour: 10,
    affixes: [
      { affixId: 'life', tier: 3, value: 2 },
      { affixId: 'speed', tier: 1, value: 0.07 },
    ],
  };

  it('turns defences, implicit and affixes into stat modifiers', () => {
    const mods = itemModifiers(item, data);
    expect(computeStat(0, mods, 'armour')).toBe(10);
    expect(computeStat(0, mods, 'resource')).toBe(5);
    expect(computeStat(100, mods, 'life')).toBe(102);
    expect(computeStat(100, mods, 'movementSpeed')).toBeCloseTo(107, 9);
  });

  it('sums modifiers over all equipped items', () => {
    const mods = equipmentModifiers({ helmet: item, ring1: { ...item, id: 'b', baseId: 'ring', implicit: undefined as never, armour: undefined as never } }, data);
    expect(computeStat(0, mods, 'life')).toBe(4);
  });

  it('validates slot, level and weapon type', () => {
    const hero = { level: 1, weaponType: 'sword' as const };
    expect(canEquip(item, 'helmet', hero, data)).toBeNull();
    expect(canEquip(item, 'boots', hero, data)).toBe('wrong-slot');
    expect(canEquip({ ...item, level: 5 }, 'helmet', hero, data)).toBe('level');
    const wand: Item = { id: 'w', baseId: 'wand', level: 1, rarity: 'normal', name: 'Wand', affixes: [] };
    expect(canEquip(wand, 'weapon', hero, data)).toBe('weapon-type');
  });

  it('fills the first free ring slot', () => {
    expect(equipSlotsFor('ring', {})[0]).toBe('ring1');
    expect(equipSlotsFor('ring', { ring1: item })[0]).toBe('ring2');
  });

  it('uses the equipped weapon or the class fallback', () => {
    const fallback = { damage: { physical: { min: 1, max: 2 } }, attacksPerSecond: 1, critChance: 0 };
    expect(equippedWeapon({}, data, fallback)).toBe(fallback);
    const sword: Item = { id: 's', baseId: 'sword', level: 1, rarity: 'normal', name: 'Sword', affixes: [] };
    expect(equippedWeapon({ weapon: sword }, data, fallback).attacksPerSecond).toBe(1.2);
  });
});

describe('inventory', () => {
  const rules = { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 };

  function setup(): ReturnType<typeof createProfile> {
    const profile = createProfile();
    createCharacter(profile, { name: 'Hero', classId: 'warrior' }, rules, ['warrior']);
    return profile;
  }

  it('assigns increasing item ids and caps the stash', () => {
    const profile = setup();
    const rng = createRng(1);
    const ids = [1, 2, 3, 4].map(() => rollItem(profile, rng, { itemLevel: 1, slot: 'helmet' }, data));
    expect(ids.map((i) => i.id)).toEqual(['i1', 'i2', 'i3', 'i4']);
    expect(ids.slice(0, 3).map((i) => addToStash(profile, i, data))).toEqual([null, null, null]);
    expect(addToStash(profile, ids[3]!, data)).toBe('stash-full');
  });

  it('equips from stash and swaps the old item back', () => {
    const profile = setup();
    const rng = createRng(2);
    const a = rollItem(profile, rng, { itemLevel: 1, slot: 'helmet' }, data);
    const b = rollItem(profile, rng, { itemLevel: 1, slot: 'helmet' }, data);
    addToStash(profile, a, data);
    addToStash(profile, b, data);
    expect(equipFromStash(profile, 'c1', a.id, 'sword', data)).toBeNull();
    expect(profile.characters[0]!.equipment.helmet?.id).toBe(a.id);
    expect(equipFromStash(profile, 'c1', b.id, 'sword', data)).toBeNull();
    expect(profile.characters[0]!.equipment.helmet?.id).toBe(b.id);
    expect(profile.stash.items.map((i) => i.id)).toEqual([a.id]);
  });

  it('refuses invalid equips without touching the stash', () => {
    const profile = setup();
    const wand = rollItem(profile, createRng(3), { itemLevel: 1, slot: 'weapon' }, { ...data, bases: { wand: bases.wand! } });
    addToStash(profile, wand, data);
    expect(equipFromStash(profile, 'c1', wand.id, 'sword', data)).toBe('weapon-type');
    expect(profile.stash.items).toHaveLength(1);
  });

  it('unequips into the stash and salvages for currency', () => {
    const profile = setup();
    const item = rollItem(profile, createRng(4), { itemLevel: 1, slot: 'helmet', rarity: 'rare' }, data);
    addToStash(profile, item, data);
    equipFromStash(profile, 'c1', item.id, 'sword', data);
    expect(unequipToStash(profile, 'c1', 'helmet', data)).toBeNull();
    expect(salvageFromStash(profile, item.id, data)).toBe(8);
    expect(profile.currency[SALVAGE_CURRENCY]).toBe(8);
    expect(profile.stash.items).toHaveLength(0);
  });
});

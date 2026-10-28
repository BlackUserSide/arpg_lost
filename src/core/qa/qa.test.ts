import { describe, expect, it } from 'vitest';
import { classes } from '../../data/classes';
import { itemsData } from '../../data/items';
import { mapsData } from '../../data/maps';
import { passiveTree } from '../../data/passives';
import { progression } from '../../data/progression';
import { qaPreset } from '../../data/qa';
import { skillLevels } from '../../data/skillLevels';
import type { Item } from '../items/types';
import { allocatePath, spentPoints, unspentPoints } from '../passives/allocation';
import { createCharacter, createProfile, type Profile } from '../progression/profile';
import { createRng } from '../rng';
import { qaApplyPreset, qaGrantUniques, qaMaxSkills, qaSetLevel, qaUniqueDefs, qaUnlockMaps, type QaData } from './qa';

const data: QaData = { progression, tree: passiveTree, maps: mapsData.rules, items: itemsData, classes, skillRules: skillLevels.rules };
const rules = { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 };

function setup(classId = 'warrior'): { profile: Profile; id: string } {
  const profile = createProfile();
  const result = createCharacter(profile, { name: 'Tester', classId }, rules, Object.keys(classes));
  if (!result.ok) throw new Error(result.error);
  return { profile, id: result.character.id };
}

const NON_WEAPON_UNIQUES = ['glass_cannon_crown', 'iron_heart_oath', 'bloody_pupil', 'ancestral_horn', 'madman_gloves', 'shadow_boots', 'rift_ring'];
const LEGENDARIES = ['devourer_crown', 'clock_last_moment', 'abyss_eye'];

describe('qaSetLevel', () => {
  it('sets the level with 0 XP; points follow the level; skills are untouched', () => {
    const { profile, id } = setup();
    const hero = profile.characters[0]!;
    hero.xp = 50;
    hero.skills = { cleave: { level: 2, xp: 7 } };
    expect(qaSetLevel(profile, id, 25, data)).toEqual({ level: 25, passivesReset: false });
    expect(hero.level).toBe(25);
    expect(hero.xp).toBe(0);
    expect(unspentPoints(passiveTree, hero)).toEqual({ points: 24, specPoints: 3 });
    expect(hero.skills).toEqual({ cleave: { level: 2, xp: 7 } });
  });

  it('clamps to 1..maxLevel and floors fractions', () => {
    const { profile, id } = setup();
    expect(qaSetLevel(profile, id, 99, data).level).toBe(40);
    expect(qaSetLevel(profile, id, 0, data).level).toBe(1);
    expect(qaSetLevel(profile, id, 12.7, data).level).toBe(12);
    expect(qaSetLevel(profile, id, Number.NaN, data).level).toBe(1);
  });

  it('keeps an allocation that still fits and resets one that does not', () => {
    const { profile, id } = setup();
    const hero = profile.characters[0]!;
    qaSetLevel(profile, id, 10, data);
    expect(allocatePath(passiveTree, hero, 'w_n1')).toBeNull();
    const nodes = [...hero.passives.nodes];
    const spent = spentPoints(passiveTree, hero.passives);
    expect(spent).toBeGreaterThan(nodes.length);

    expect(qaSetLevel(profile, id, 1 + spent, data)).toEqual({ level: 1 + spent, passivesReset: false });
    expect(hero.passives.nodes).toEqual(nodes);

    expect(qaSetLevel(profile, id, spent, data)).toEqual({ level: spent, passivesReset: true });
    expect(hero.passives).toEqual({ nodes: [], spec: null, specNodes: [] });
  });

  it('throws for an unknown character', () => {
    expect(() => qaSetLevel(createProfile(), 'c9', 5, data)).toThrow('Unknown character: c9');
  });
});

describe('qaUnlockMaps', () => {
  it('unlocks maps 1..upTo, clamped to the linear ladder', () => {
    const { profile, id } = setup();
    const hero = profile.characters[0]!;
    expect(qaUnlockMaps(profile, id, 12, data)).toBe(12);
    expect(hero.maps.unlocked).toBe(12);
    expect(qaUnlockMaps(profile, id, 500, data)).toBe(40);
    expect(qaUnlockMaps(profile, id, 3, data)).toBe(3);
    expect(qaUnlockMaps(profile, id, -2, data)).toBe(1);
  });
});

describe('qaGrantUniques', () => {
  it('lists only the weapon uniques of the class weapon type', () => {
    expect(qaUniqueDefs(itemsData, 'sword').map((u) => u.id)).toEqual([
      'glass_cannon_crown',
      'barrow_reaper',
      ...NON_WEAPON_UNIQUES.slice(1),
      ...LEGENDARIES,
    ]);
    expect(qaUniqueDefs(itemsData, 'wand').map((u) => u.id)).toEqual([
      'glass_cannon_crown',
      'heart_of_winter',
      ...NON_WEAPON_UNIQUES.slice(1),
      ...LEGENDARIES,
    ]);
  });

  it('puts one of each into the stash at the item level (unique level as the floor), deterministically', () => {
    const { profile, id } = setup('ranger');
    const result = qaGrantUniques(profile, id, createRng(7), 5, data);
    expect(result).toEqual({ stash: 11, overflow: 0, lost: 0 });
    const items = profile.stash.items;
    expect(items.map((i) => i.unique?.id)).toEqual(['glass_cannon_crown', 'splitter', ...NON_WEAPON_UNIQUES.slice(1), ...LEGENDARIES]);
    expect(items.map((i) => i.id)).toEqual(Array.from({ length: 11 }, (_, i) => `i${i + 1}`));
    expect(profile.nextItemId).toBe(12);
    // devourer_crown sits on a level-15 base, clock / abyss have level 15: they roll at 15, the rest at 5.
    expect(items.map((i) => i.level)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 15, 15, 15]);
    expect(items.map((i) => i.rarity)).toEqual([...Array<string>(8).fill('unique'), 'legendary', 'legendary', 'legendary']);

    const again = setup('ranger');
    qaGrantUniques(again.profile, again.id, createRng(7), 5, data);
    expect(again.profile.stash.items).toEqual(items);
  });

  it('sends what does not fit to the overflow, then loses the rest', () => {
    const { profile, id } = setup('mage');
    const filler = (n: number): Item => ({ id: `x${n}`, baseId: 'iron_ring', level: 1, rarity: 'normal', name: '', affixes: [] });
    profile.stash.items = Array.from({ length: itemsData.rules.stashSize - 3 }, (_, i) => filler(i));
    profile.stash.overflow = Array.from({ length: itemsData.rules.overflow.size - 5 }, (_, i) => filler(100 + i));
    expect(qaGrantUniques(profile, id, createRng(1), 30, data)).toEqual({ stash: 3, overflow: 5, lost: 3 });
    expect(profile.stash.items.slice(-3).map((i) => i.unique?.id)).toEqual(['glass_cannon_crown', 'heart_of_winter', 'iron_heart_oath']);
    expect(profile.stash.overflow.slice(-5).map((i) => i.unique?.id)).toEqual(['bloody_pupil', 'ancestral_horn', 'madman_gloves', 'shadow_boots', 'rift_ring']);
  });
});

describe('qaMaxSkills', () => {
  it('sets every class skill to max level with 0 XP, keeping other fields and foreign records', () => {
    const { profile, id } = setup('warrior');
    const hero = profile.characters[0]!;
    hero.skills = { cleave: { level: 2, xp: 40, note: 'kept' } as never, fireball: { level: 2, xp: 5 } };
    expect(qaMaxSkills(profile, id, data)).toEqual(['cleave', 'shield_charge', 'battle_cry']);
    expect(hero.skills).toEqual({
      cleave: { level: 3, xp: 0, note: 'kept' },
      shield_charge: { level: 3, xp: 0 },
      battle_cry: { level: 3, xp: 0 },
      fireball: { level: 2, xp: 5 },
    });
  });

  it('does nothing for a class without data', () => {
    const { profile, id } = setup();
    expect(qaMaxSkills(profile, id, { ...data, classes: {} })).toEqual([]);
    expect(profile.characters[0]!.skills).toEqual({});
  });
});

describe('qaApplyPreset', () => {
  it('sets level, maps and grants the uniques from the preset data', () => {
    const { profile, id } = setup();
    const result = qaApplyPreset(profile, id, createRng(3), qaPreset, data);
    expect(result).toEqual({
      level: { level: 30, passivesReset: false },
      mapsUnlocked: 30,
      items: { stash: 11, overflow: 0, lost: 0 },
      maxedSkills: ['cleave', 'shield_charge', 'battle_cry'],
    });
    const hero = profile.characters[0]!;
    expect(hero.level).toBe(30);
    expect(hero.maps.unlocked).toBe(30);
    expect(profile.stash.items.every((i) => i.level === 30)).toBe(true);
    expect(Object.values(hero.skills)).toEqual(Array(3).fill({ level: 3, xp: 0 }));
  });

  it('leaves skills alone when the preset does not ask for it', () => {
    const { profile, id } = setup();
    expect(qaApplyPreset(profile, id, createRng(3), { ...qaPreset, maxSkills: false }, data).maxedSkills).toEqual([]);
    expect(profile.characters[0]!.skills).toEqual({});
  });
});

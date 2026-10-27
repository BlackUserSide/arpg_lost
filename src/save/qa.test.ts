import { describe, expect, it } from 'vitest';
import { equipFromStash } from '../core/items/inventory';
import { allocatePath } from '../core/passives/allocation';
import { createCharacter, createProfile } from '../core/progression/profile';
import { qaApplyPreset, qaGrantUniques, qaSetLevel, type QaData } from '../core/qa/qa';
import { createRng } from '../core/rng';
import { classes } from '../data/classes';
import { itemsData } from '../data/items';
import { mapsData } from '../data/maps';
import { passiveTree } from '../data/passives';
import { progression } from '../data/progression';
import { qaPreset } from '../data/qa';
import { skillLevels } from '../data/skillLevels';
import type { KeyValueStorage } from '../platform/platform';
import { loadProfile, saveProfile } from './profileStore';
import { defaultValidation, validateProfile } from './validate';

// QA mode results (src/core/qa) must survive save + load unchanged: validation must not reset or clamp anything.

const data: QaData = { progression, tree: passiveTree, maps: mapsData.rules, items: itemsData, classes, skillRules: skillLevels.rules };
const rules = { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 };

function memoryStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
}

const firstNode: Record<string, string> = { warrior: 'w_n1', ranger: 'r_a3', mage: 'm_a1' };

describe('QA mode save round-trip', () => {
  it('a preset hero of every class (max skills, equipped uniques, passives, overflow) loads back unchanged', () => {
    const profile = createProfile();
    const rng = createRng(11);
    for (const classId of Object.keys(classes)) {
      const created = createCharacter(profile, { name: `QA ${classId}`, classId }, rules, Object.keys(classes));
      if (!created.ok) throw new Error(created.error);
      const hero = created.character;
      expect(qaApplyPreset(profile, hero.id, rng, qaPreset, data).maxedSkills).toHaveLength(3);
      expect(Object.values(hero.skills).every((p) => p.level === skillLevels.rules.maxLevel && p.xp === 0)).toBe(true);
      expect(allocatePath(passiveTree, hero, firstNode[classId]!)).toBeNull();
      // Wear every unique this class got that fits a free slot.
      for (const item of [...profile.stash.items]) {
        equipFromStash(profile, hero.id, item.id, classes[classId]!.weaponType, itemsData);
      }
      expect(hero.equipment.weapon?.rarity).toBe('unique');
    }
    // More copies than the stash holds: the rest waits in the overflow.
    qaGrantUniques(profile, profile.characters[0]!.id, rng, qaPreset.itemLevel, data);
    qaGrantUniques(profile, profile.characters[0]!.id, rng, qaPreset.itemLevel, data);
    expect(profile.stash.items).toHaveLength(itemsData.rules.stashSize);
    expect(profile.stash.overflow.length).toBeGreaterThan(0);

    const snapshot = JSON.parse(JSON.stringify(profile)) as unknown;
    expect(validateProfile(snapshot, defaultValidation)).toEqual(profile);

    const storage = memoryStorage();
    saveProfile(storage, profile);
    const loaded = loadProfile(storage);
    expect(loaded.integrity).toBe('ok');
    expect(loaded.profile).toEqual(profile);
  });

  it('a lowered level with a reset tree and level-40 items also loads back unchanged', () => {
    const profile = createProfile();
    const created = createCharacter(profile, { name: 'QA', classId: 'mage' }, rules, ['mage']);
    if (!created.ok) throw new Error(created.error);
    const hero = created.character;
    qaSetLevel(profile, hero.id, 40, data);
    expect(allocatePath(passiveTree, hero, firstNode.mage!)).toBeNull();
    qaGrantUniques(profile, hero.id, createRng(5), 40, data);
    expect(qaSetLevel(profile, hero.id, 1, data).passivesReset).toBe(true);

    const storage = memoryStorage();
    saveProfile(storage, profile);
    expect(loadProfile(storage).profile).toEqual(profile);
  });
});

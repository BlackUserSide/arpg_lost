import { describe, expect, it } from 'vitest';
import { createCharacter, createProfile } from '../core/progression/profile';
import type { KeyValueStorage } from '../platform/platform';
import { loadProfile, SAVE_KEY, saveProfile } from './profileStore';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const rules = { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 };

describe('profile store', () => {
  it('returns a fresh profile when nothing is saved', () => {
    expect(loadProfile(memoryStorage()).profile).toEqual(createProfile());
  });

  it('round-trips a profile', () => {
    const storage = memoryStorage();
    const profile = createProfile();
    createCharacter(profile, { name: 'Aria', classId: 'mage' }, rules, ['mage']);
    profile.currency.chaos = 3;
    saveProfile(storage, profile);
    expect(loadProfile(storage).profile).toEqual(profile);
  });

  it('keeps a backup and starts fresh when the save is corrupt', () => {
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, '{not json');
    const result = loadProfile(storage);
    expect(result.profile).toEqual(createProfile());
    expect(result.backupKey).toBeDefined();
    expect(storage.getItem(result.backupKey!)).toBe('{not json');
  });

  it('refuses saves from a newer game version instead of corrupting them', () => {
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, JSON.stringify({ version: 999, profile: {} }));
    expect(loadProfile(storage).backupKey).toBeDefined();
  });

  it('fills missing fields from defaults', () => {
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, JSON.stringify({ version: 1, profile: { characters: [], records: { bossKills: 2 } } }));
    const { profile } = loadProfile(storage);
    expect(profile.records.bossKills).toBe(2);
    expect(profile.records.bestClearTime).toBeNull();
    expect(profile.stash).toEqual({ items: [] });
  });
});

describe('profile store migrations', () => {
  it('upgrades v1 saves: characters get equipment, stash is reset, item ids start at 1', () => {
    const storage = memoryStorage();
    const v1 = {
      version: 1,
      profile: {
        characters: [{ id: 'c1', name: 'Aria', classId: 'mage', level: 1, xp: 0, stats: { runs: 2, deaths: 1, kills: 9, longestRun: 30 } }],
        stash: { items: ['legacy'] },
        currency: {},
        records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 9 },
        nextCharacterId: 2,
      },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(v1));
    const { profile, backupKey } = loadProfile(storage);
    expect(backupKey).toBeUndefined();
    expect(profile.characters[0]!.equipment).toEqual({});
    expect(profile.characters[0]!.stats.kills).toBe(9);
    expect(profile.stash.items).toEqual([]);
    expect(profile.nextItemId).toBe(1);
  });
});

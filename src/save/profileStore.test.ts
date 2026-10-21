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

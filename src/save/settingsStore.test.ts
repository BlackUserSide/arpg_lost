import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../platform/platform';
import { SAVE_KEY } from './profileStore';
import { loadSettings, saveSettings, SETTINGS_KEY } from './settingsStore';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('settings store', () => {
  it('is empty when nothing is stored', () => {
    expect(loadSettings(memoryStorage())).toEqual({});
  });

  it('round-trips the language under its own key, apart from the profile', () => {
    const storage = memoryStorage();
    saveSettings(storage, { language: 'uk' });
    expect(loadSettings(storage)).toEqual({ language: 'uk' });
    expect(storage.data.has(SETTINGS_KEY)).toBe(true);
    expect(storage.data.has(SAVE_KEY)).toBe(false);
  });

  it('ignores unreadable data and malformed fields', () => {
    const storage = memoryStorage();
    storage.setItem(SETTINGS_KEY, '{oops');
    expect(loadSettings(storage)).toEqual({});
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, settings: { language: 42 } }));
    expect(loadSettings(storage)).toEqual({});
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, settings: { language: 'uk', qa: 'yes' } }));
    expect(loadSettings(storage)).toEqual({ language: 'uk' });
    storage.setItem(SETTINGS_KEY, 'null');
    expect(loadSettings(storage)).toEqual({});
  });

  it('round-trips the QA mode flag', () => {
    const storage = memoryStorage();
    saveSettings(storage, { qa: true });
    expect(loadSettings(storage)).toEqual({ qa: true });
  });

  it('keeps settings it does not know (written by a newer build)', () => {
    const storage = memoryStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 2, settings: { language: 'de', volume: 0.5 } }));
    expect(loadSettings(storage)).toEqual({ language: 'de', volume: 0.5 });
  });
});

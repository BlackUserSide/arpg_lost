import { createProfile, type Profile } from '../core/progression/profile';
import type { KeyValueStorage } from '../platform/platform';

// Versioned profile persistence. Bump SAVE_VERSION and add a migration whenever the Profile shape changes.

export const SAVE_KEY = 'arpg.profile';
export const SAVE_VERSION = 2;

interface SaveFile {
  version: number;
  profile: unknown;
}

/** migrations[n] upgrades a version-n profile to version n+1. */
const migrations: Record<number, (profile: unknown) => unknown> = {
  // v2: items. Characters get equipment, profile gets an item id counter; old stash had no real items.
  1: (data) => {
    const p = data as { characters?: Array<Record<string, unknown>>; stash?: unknown };
    return {
      ...p,
      characters: (p.characters ?? []).map((c) => ({ equipment: {}, ...c })),
      stash: { items: [] },
      nextItemId: 1,
    };
  },
};

export interface LoadResult {
  profile: Profile;
  /** Set when stored data could not be read; the broken copy is kept under this key. */
  backupKey?: string;
}

export function loadProfile(storage: KeyValueStorage): LoadResult {
  const raw = storage.getItem(SAVE_KEY);
  if (!raw) return { profile: createProfile() };
  try {
    const file = JSON.parse(raw) as SaveFile;
    if (typeof file.version !== 'number' || file.version > SAVE_VERSION) throw new Error(`Unsupported save version: ${String(file.version)}`);
    let data = file.profile;
    for (let v = file.version; v < SAVE_VERSION; v++) {
      const migrate = migrations[v];
      if (!migrate) throw new Error(`No migration from version ${v}`);
      data = migrate(data);
    }
    return { profile: normalize(data) };
  } catch {
    const backupKey = `${SAVE_KEY}.broken`;
    storage.setItem(backupKey, raw);
    return { profile: createProfile(), backupKey };
  }
}

export function saveProfile(storage: KeyValueStorage, profile: Profile): void {
  const file: SaveFile = { version: SAVE_VERSION, profile };
  storage.setItem(SAVE_KEY, JSON.stringify(file));
}

/** Fills fields missing from older or partial saves with defaults. */
function normalize(data: unknown): Profile {
  if (typeof data !== 'object' || data === null) throw new Error('Profile is not an object');
  const base = createProfile();
  const p = data as Partial<Profile>;
  if (!Array.isArray(p.characters)) throw new Error('Profile has no characters array');
  return {
    characters: p.characters.map((c) => ({ ...c, equipment: c.equipment ?? {} })),
    stash: p.stash ?? base.stash,
    currency: p.currency ?? base.currency,
    records: { ...base.records, ...p.records },
    nextCharacterId: p.nextCharacterId ?? p.characters.length + 1,
    nextItemId: p.nextItemId ?? 1,
  };
}

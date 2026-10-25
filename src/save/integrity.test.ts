import { describe, expect, it } from 'vitest';
import { createCharacter, createProfile, type Profile } from '../core/progression/profile';
import type { KeyValueStorage } from '../platform/platform';
import { canonicalJson, hashString, readSigned, signData, writeSigned } from './integrity';
import { BACKUP_KEY, BROKEN_KEY, loadProfile, SAVE_KEY, SAVE_VERSION, saveProfile } from './profileStore';

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

function sampleProfile(shards = 40): Profile {
  const profile = createProfile();
  createCharacter(profile, { name: 'Aria', classId: 'mage' }, rules, ['mage']);
  profile.currency.shards = shards;
  return profile;
}

/** Edits the stored save's data in place without re-signing it (what a casual cheater does in devtools). */
function tamper(storage: KeyValueStorage, key: string, edit: (profile: Profile) => void): void {
  const envelope = JSON.parse(storage.getItem(key)!) as { data: { profile: Profile }; sig: string };
  edit(envelope.data.profile);
  storage.setItem(key, JSON.stringify(envelope));
}

describe('save hash', () => {
  it('is deterministic and changes with any edit', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).toMatch(/^[0-9a-f]{14}$/);
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('')).not.toBe(hashString(' '));
  });

  it('canonical JSON does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(signData({ a: 1, b: 2 })).toBe(signData({ b: 2, a: 1 }));
    // Arrays match JSON.stringify, holes of sparse arrays included.
    const sparse = [1, , 3];
    expect(canonicalJson(sparse)).toBe(JSON.stringify(sparse));
    expect(canonicalJson([undefined, () => 1])).toBe(JSON.stringify([undefined, () => 1]));
    // Same rules as JSON: undefined fields are skipped, so a live object signs like its parsed copy.
    expect(signData({ a: 1, b: undefined })).toBe(signData(JSON.parse(JSON.stringify({ a: 1, b: undefined }))));
  });

  it('readSigned tells signed, edited, unsigned, corrupt and missing apart', () => {
    const storage = memoryStorage();
    expect(readSigned(storage, 'k').kind).toBe('missing');
    writeSigned(storage, ['k'], { n: 1 });
    expect(readSigned(storage, 'k')).toMatchObject({ kind: 'signed', data: { n: 1 } });
    storage.setItem('k', JSON.stringify({ data: { n: 2 }, sig: signData({ n: 1 }) }));
    expect(readSigned(storage, 'k').kind).toBe('tampered');
    storage.setItem('k', JSON.stringify({ data: { n: 2 } }));
    expect(readSigned(storage, 'k').kind).toBe('tampered');
    storage.setItem('k', JSON.stringify({ version: 8, profile: {} }));
    expect(readSigned(storage, 'k')).toMatchObject({ kind: 'unsigned', data: { version: 8, profile: {} } });
    storage.setItem('k', '{oops');
    expect(readSigned(storage, 'k').kind).toBe('corrupt');
    storage.setItem('k', '[1]');
    expect(readSigned(storage, 'k').kind).toBe('corrupt');
  });
});

describe('signed saves', () => {
  it('a save is written signed, to the save and to the backup, and loads as ok', () => {
    const storage = memoryStorage();
    const profile = sampleProfile();
    saveProfile(storage, profile);
    const envelope = JSON.parse(storage.getItem(SAVE_KEY)!) as { data: unknown; sig: string };
    expect(envelope.data).toEqual(JSON.parse(JSON.stringify({ version: SAVE_VERSION, profile })));
    expect(envelope.sig).toBe(signData(envelope.data));
    expect(storage.getItem(BACKUP_KEY)).toBe(storage.getItem(SAVE_KEY));
    expect(loadProfile(storage)).toEqual({ profile, integrity: 'ok' });
  });

  it('an edited save rolls back to the backup; the edited copy is kept aside and the save is re-signed', () => {
    const storage = memoryStorage();
    const profile = sampleProfile(40);
    saveProfile(storage, profile);
    tamper(storage, SAVE_KEY, (p) => (p.currency.shards = 99999));
    const edited = storage.getItem(SAVE_KEY);
    const result = loadProfile(storage);
    expect(result.integrity).toBe('restored');
    expect(result.profile.currency.shards).toBe(40);
    expect(result.backupKey).toBe(BROKEN_KEY);
    expect(storage.getItem(BROKEN_KEY)).toBe(edited);
    expect(loadProfile(storage)).toEqual({ profile, integrity: 'ok' });
  });

  it('the backup is validated too: an edited backup is never loaded', () => {
    const storage = memoryStorage();
    saveProfile(storage, sampleProfile(40));
    tamper(storage, SAVE_KEY, (p) => (p.currency.shards = 500));
    tamper(storage, BACKUP_KEY, (p) => (p.currency.shards = 999));
    const result = loadProfile(storage);
    // No honest copy left: the save's own data is loaded (validated) and re-signed.
    expect(result.integrity).toBe('unverified');
    expect(result.profile.currency.shards).toBe(500);
    expect(result.backupKey).toBe(BROKEN_KEY);
    expect(loadProfile(storage).integrity).toBe('ok');
  });

  it('an edited save without a valid backup still goes through validation', () => {
    const storage = memoryStorage();
    saveProfile(storage, sampleProfile());
    storage.removeItem(BACKUP_KEY);
    tamper(storage, SAVE_KEY, (p) => {
      p.currency.shards = -50;
      p.characters[0]!.level = 999;
    });
    const result = loadProfile(storage);
    expect(result.integrity).toBe('unverified');
    expect(result.profile.currency.shards).toBe(0);
    expect(result.profile.characters[0]!.level).toBe(40);
  });

  it('a save with its signature stripped is an edited save', () => {
    const storage = memoryStorage();
    saveProfile(storage, sampleProfile(40));
    const envelope = JSON.parse(storage.getItem(SAVE_KEY)!) as { data: { profile: Profile } };
    envelope.data.profile.currency.shards = 777;
    storage.setItem(SAVE_KEY, JSON.stringify({ data: envelope.data }));
    const result = loadProfile(storage);
    expect(result.integrity).toBe('restored');
    expect(result.profile.currency.shards).toBe(40);
  });

  it('an unsigned save from before signatures is accepted once and signed at once (and the backup is written)', () => {
    const storage = memoryStorage();
    const profile = sampleProfile(12);
    storage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, profile }));
    const result = loadProfile(storage);
    expect(result).toEqual({ profile, integrity: 'unsigned' });
    expect(readSigned(storage, SAVE_KEY).kind).toBe('signed');
    expect(readSigned(storage, BACKUP_KEY).kind).toBe('signed');
    expect(storage.getItem(BROKEN_KEY)).toBeNull();
    expect(loadProfile(storage)).toEqual({ profile, integrity: 'ok' });
  });

  it('old unsigned saves are migrated, then validated, then signed', () => {
    const storage = memoryStorage();
    const v1 = { version: 1, profile: { characters: [], currency: { shards: -3, essence: 2 }, records: { bossKills: 2 } } };
    storage.setItem(SAVE_KEY, JSON.stringify(v1));
    const result = loadProfile(storage);
    expect(result.integrity).toBe('unsigned');
    expect(result.profile.currency).toEqual({ shards: 0, essence: 2 });
    expect(result.profile.stash).toEqual({ items: [], overflow: [] });
    const stored = readSigned(storage, SAVE_KEY);
    expect(stored.kind).toBe('signed');
    expect((stored as { data: { version: number } }).data.version).toBe(SAVE_VERSION);
  });

  it('an unsigned save next to a signed backup is not accepted: the signature was stripped, the backup wins', () => {
    const storage = memoryStorage();
    const profile = sampleProfile(40);
    saveProfile(storage, profile);
    storage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, profile: { ...profile, currency: { shards: 5000 } } }));
    const result = loadProfile(storage);
    expect(result.integrity).toBe('restored');
    expect(result.profile).toEqual(profile);
  });

  it('a broken or missing save loads the backup', () => {
    for (const broken of ['{not json', null]) {
      const storage = memoryStorage();
      const profile = sampleProfile(7);
      saveProfile(storage, profile);
      if (broken === null) storage.removeItem(SAVE_KEY);
      else storage.setItem(SAVE_KEY, broken);
      const result = loadProfile(storage);
      expect(result.integrity).toBe('restored');
      expect(result.profile).toEqual(profile);
      expect(readSigned(storage, SAVE_KEY).kind).toBe('signed');
    }
  });

  it('with neither a readable save nor a valid backup the game starts fresh and keeps the broken data aside', () => {
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, '{not json');
    storage.setItem(BACKUP_KEY, '{also not json');
    const result = loadProfile(storage);
    expect(result).toEqual({ profile: createProfile(), integrity: 'broken', backupKey: BROKEN_KEY });
    expect(storage.getItem(BROKEN_KEY)).toBe('{not json');
  });

  it('a signed save from a newer game version is never loaded or overwritten on load', () => {
    const storage = memoryStorage();
    writeSigned(storage, [SAVE_KEY, BACKUP_KEY], { version: SAVE_VERSION + 1, profile: {} });
    const raw = storage.getItem(SAVE_KEY);
    const result = loadProfile(storage);
    expect(result).toMatchObject({ integrity: 'broken', readOnly: true, preservedKey: `${BROKEN_KEY}.v${SAVE_VERSION + 1}` });
    expect(storage.getItem(BROKEN_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
    // The app skips saving while read-only (render/app.ts), so the newer save stays loadable by the newer build.
    const app = { save: () => void (result.readOnly ? undefined : saveProfile(storage, result.profile)) };
    app.save();
    expect(storage.getItem(SAVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
    // Even a save written anyway and a later rejection cannot destroy the preserved copy.
    saveProfile(storage, result.profile);
    storage.setItem(SAVE_KEY, '{garbage');
    loadProfile(storage);
    expect(storage.getItem(result.preservedKey!)).toBe(raw);
  });

  it('an unsigned save of a newer version, or a lone newer backup, is read-only too; garbage is not', () => {
    const unsigned = memoryStorage();
    unsigned.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION + 3, profile: {} }));
    expect(loadProfile(unsigned)).toMatchObject({ integrity: 'broken', readOnly: true, preservedKey: `${BROKEN_KEY}.v${SAVE_VERSION + 3}` });
    const lone = memoryStorage();
    writeSigned(lone, [BACKUP_KEY], { version: SAVE_VERSION + 1, profile: {} });
    expect(loadProfile(lone)).toMatchObject({ integrity: 'broken', readOnly: true });
    const garbage = memoryStorage();
    garbage.setItem(SAVE_KEY, '{nope');
    expect(loadProfile(garbage).readOnly).toBeUndefined();
  });

  it('nothing stored: a fresh profile, nothing written', () => {
    const storage = memoryStorage();
    expect(loadProfile(storage)).toEqual({ profile: createProfile(), integrity: 'new' });
    expect(storage.data.size).toBe(0);
  });
});

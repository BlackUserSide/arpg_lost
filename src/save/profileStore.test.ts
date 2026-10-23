import { describe, expect, it } from 'vitest';
import { createCharacter, createProfile } from '../core/progression/profile';
import type { KeyValueStorage } from '../platform/platform';
import { itemsData } from '../data/items';
import { loadProfile, SAVE_KEY, SAVE_VERSION, saveProfile } from './profileStore';
import { classSkillProgress } from '../core/skills/levels';
import { content } from '../data/index';
import { skillLevels } from '../data/skillLevels';

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
    expect(profile.characters[0]!.passives).toEqual({ nodes: [], spec: null, specNodes: [] });
  });

  it('upgrades v2 saves: characters get an empty passive allocation, other fields kept', () => {
    const storage = memoryStorage();
    const v2 = {
      version: 2,
      profile: {
        characters: [{ id: 'c1', name: 'Aria', classId: 'mage', level: 7, xp: 40, stats: { runs: 2, deaths: 1, kills: 9, longestRun: 30 }, equipment: {} }],
        stash: { items: [] },
        currency: { shards: 12 },
        records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 9 },
        nextCharacterId: 2,
        nextItemId: 5,
      },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(v2));
    const { profile, backupKey } = loadProfile(storage);
    expect(backupKey).toBeUndefined();
    expect(profile.characters[0]!.passives).toEqual({ nodes: [], spec: null, specNodes: [] });
    expect(profile.characters[0]!.level).toBe(7);
    expect(profile.currency).toEqual({ shards: 12 });
    expect(profile.nextItemId).toBe(5);
  });

  it('upgrades v3 saves: mana affixes become resource affixes in stash and equipment, other affixes kept', () => {
    const storage = memoryStorage();
    const helmet = {
      id: 'i1',
      baseId: 'iron_cap',
      level: 10,
      rarity: 'magic',
      name: 'Cap',
      implicit: 6,
      armour: 10,
      affixes: [
        { affixId: 'mana_flat', tier: 3, value: 18 },
        { affixId: 'life_flat', tier: 4, value: 20 },
      ],
    };
    const ring = (id: string, tier: number, value: number) => ({ id, baseId: 'iron_ring', level: 30, rarity: 'magic', name: 'Ring', affixes: [{ affixId: 'mana_regen', tier, value }] });
    const v3 = {
      version: 3,
      profile: {
        characters: [
          { id: 'c1', name: 'Aria', classId: 'mage', level: 7, xp: 40, stats: { runs: 0, deaths: 0, kills: 0, longestRun: 0 }, equipment: { helmet }, passives: { nodes: [], spec: null, specNodes: [] } },
        ],
        stash: { items: [ring('i2', 5, 0.7), ring('i3', 4, 1.1), ring('i4', 1, 4.6), ring('i5', 1, 6)] },
        currency: {},
        records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 0 },
        nextCharacterId: 2,
        nextItemId: 3,
      },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(v3));
    const { profile, backupKey } = loadProfile(storage);
    expect(backupKey).toBeUndefined();
    expect(profile.characters[0]!.equipment.helmet!.affixes).toEqual([
      { affixId: 'resource_flat', tier: 3, value: 18 },
      { affixId: 'life_flat', tier: 4, value: 20 },
    ]);
    expect(profile.characters[0]!.equipment.helmet!.implicit).toBe(6);
    // Resource regen rescaled ×0.6 and snapped to the 0.1 roll step: 0.7 → 0.4, 1.1 → 0.7, 4.6 → 2.8, 6 → 3.6.
    expect(profile.stash.items.map((i) => i.affixes[0])).toEqual([
      { affixId: 'resource_regen', tier: 5, value: 0.4 },
      { affixId: 'resource_regen', tier: 4, value: 0.7 },
      { affixId: 'resource_regen', tier: 1, value: 2.8 },
      { affixId: 'resource_regen', tier: 1, value: 3.6 },
    ]);
    expect(profile.nextItemId).toBe(3);
  });

  it('v3 → v4 puts every old resource regen roll inside its new tier', () => {
    // Old mana_regen tiers T5..T1 (step 0.1) before the ×0.6 cut.
    const oldTiers: Array<[number, number]> = [[0.5, 1], [1.1, 2], [2.1, 3], [3.1, 4.5], [4.6, 6]];
    const items: unknown[] = [];
    oldTiers.forEach(([min, max], i) => {
      for (let k = 0; min + k * 0.1 <= max + 1e-9; k++) {
        const value = Math.round((min + k * 0.1) * 10) / 10;
        items.push({ id: `i${items.length}`, baseId: 'iron_ring', level: 30, rarity: 'magic', name: 'Ring', affixes: [{ affixId: 'mana_regen', tier: 5 - i, value }] });
      }
    });
    const storage = memoryStorage();
    const profile = { characters: [], stash: { items }, currency: {}, records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 0 }, nextCharacterId: 1, nextItemId: 1 };
    storage.setItem(SAVE_KEY, JSON.stringify({ version: 3, profile }));
    const tiers = itemsData.affixes.resource_regen!.tiers;
    const migrated = loadProfile(storage).profile.stash.items;
    expect(migrated).toHaveLength(items.length);
    for (const item of migrated) {
      const affix = item.affixes[0]!;
      const tier = tiers[tiers.length - affix.tier]!;
      expect(affix.value).toBeGreaterThanOrEqual(tier.min);
      expect(affix.value).toBeLessThanOrEqual(tier.max);
      expect(Math.round(affix.value * 10) / 10).toBe(affix.value);
    }
  });

  it('upgrades v4 saves: characters get an empty skill record (every skill level 1, 0 XP), other fields kept', () => {
    const storage = memoryStorage();
    const character = {
      id: 'c1',
      name: 'Aria',
      classId: 'mage',
      level: 7,
      xp: 40,
      stats: { runs: 2, deaths: 1, kills: 9, longestRun: 30 },
      equipment: {},
      passives: { nodes: [], spec: null, specNodes: [] },
    };
    const v4 = {
      version: 4,
      profile: {
        characters: [character],
        stash: { items: [] },
        currency: { shards: 12 },
        records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 9 },
        nextCharacterId: 2,
        nextItemId: 5,
      },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(v4));
    const { profile, backupKey } = loadProfile(storage);
    expect(backupKey).toBeUndefined();
    // Level 7 hero from before maps: maps 1..7 unlocked (v7 migration).
    expect(profile.characters[0]).toEqual({ ...character, skills: {}, supports: [], maps: { unlocked: 7 } });
    expect(classSkillProgress(content.classes.mage!, profile.characters[0]!.skills, skillLevels.rules)).toEqual({
      fireball: { level: 1, xp: 0 },
      frost_nova: { level: 1, xp: 0 },
      teleport: { level: 1, xp: 0 },
    });
  });

  it('round-trips skill progress and sanitizes malformed skill records, keeping extra per-skill fields', () => {
    const storage = memoryStorage();
    const profile = createProfile();
    createCharacter(profile, { name: 'Aria', classId: 'mage' }, rules, ['mage']);
    profile.characters[0]!.skills = { fireball: { level: 2, xp: 120 }, teleport: { level: 3, xp: 0 } };
    saveProfile(storage, profile);
    expect(loadProfile(storage).profile).toEqual(profile);

    const raw = JSON.parse(storage.getItem(SAVE_KEY)!) as { profile: { characters: Array<Record<string, unknown>> } };
    raw.profile.characters[0]!.skills = {
      fireball: { level: 9, xp: 50 },
      frost_nova: { level: 2.7, xp: -4, supports: ['pierce'] },
      teleport: 'broken',
      volley: { xp: 30 },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(raw));
    expect(loadProfile(storage).profile.characters[0]!.skills).toEqual({
      fireball: { level: 3, xp: 0 },
      frost_nova: { level: 2, xp: 0, supports: ['pierce'] },
      volley: { level: 1, xp: 30 },
    });
  });

  it('upgrades v5 saves: characters get an empty supports tab, other fields kept', () => {
    const storage = memoryStorage();
    const character = {
      id: 'c1',
      name: 'Aria',
      classId: 'mage',
      level: 7,
      xp: 40,
      stats: { runs: 2, deaths: 1, kills: 9, longestRun: 30 },
      equipment: {},
      passives: { nodes: [], spec: null, specNodes: [] },
      skills: { fireball: { level: 2, xp: 10 } },
    };
    const v5 = {
      version: 5,
      profile: {
        characters: [character],
        stash: { items: [] },
        currency: { shards: 12 },
        records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 9 },
        nextCharacterId: 2,
        nextItemId: 5,
      },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(v5));
    const { profile, backupKey } = loadProfile(storage);
    expect(backupKey).toBeUndefined();
    expect(profile.characters[0]).toEqual({ ...character, supports: [], maps: { unlocked: 7 } });
    expect(profile.nextItemId).toBe(5);
  });

  it('round-trips the supports tab and sanitizes it on load (unknown defs, tiers, invalid sockets back to the tab)', () => {
    const storage = memoryStorage();
    const profile = createProfile();
    createCharacter(profile, { name: 'Aria', classId: 'mage' }, rules, ['mage']);
    profile.characters[0]!.supports = [
      { id: 's1', defId: 'chain_lightning', tier: 2, socket: { skillId: 'fireball', slot: 0 } },
      { id: 's2', defId: 'echo', tier: 1 },
    ];
    saveProfile(storage, profile);
    expect(loadProfile(storage).profile).toEqual(profile);

    const raw = JSON.parse(storage.getItem(SAVE_KEY)!) as { profile: { characters: Array<Record<string, unknown>> } };
    raw.profile.characters[0]!.supports = [
      { id: 's1', defId: 'chain_lightning', tier: 7, socket: { skillId: 'fireball', slot: 0 } },
      { id: 's2', defId: 'echo', tier: 1, socket: { skillId: 'teleport', slot: 0 } },
      { id: 's3', defId: 'removed_support', tier: 1 },
      { id: 's1', defId: 'echo', tier: 1 },
      { id: 's4', defId: 'pierce', tier: 0.5, socket: { skillId: 'fireball', slot: 1 } },
      { id: 's5', defId: 'pure_power', tier: 3, socket: 'broken' },
      'garbage',
    ];
    storage.setItem(SAVE_KEY, JSON.stringify(raw));
    expect(loadProfile(storage).profile.characters[0]!.supports).toEqual([
      { id: 's1', defId: 'chain_lightning', tier: 3, socket: { skillId: 'fireball', slot: 0 } },
      // Echo does not fit movement skills; Pierce does not fit an exploding projectile: both back to the tab.
      { id: 's2', defId: 'echo', tier: 1 },
      { id: 's4', defId: 'pierce', tier: 1 },
      { id: 's5', defId: 'pure_power', tier: 3 },
    ]);
  });

  it('fills partial passives and resets invalid allocations for free, keeping valid ones', () => {
    const storage = memoryStorage();
    const character = (id: string, passives: unknown): Record<string, unknown> => ({
      id,
      name: id,
      classId: 'warrior',
      level: 20,
      xp: 0,
      stats: { runs: 0, deaths: 0, kills: 0, longestRun: 0 },
      equipment: {},
      passives,
    });
    const v3 = {
      version: 3,
      profile: {
        characters: [
          character('valid', { nodes: ['w_a1', 'w_a2'], spec: 'berserker', specNodes: ['bz_entry'] }),
          character('partial', { nodes: ['w_a1'] }),
          character('disconnected', { nodes: ['w_a2'], spec: null, specNodes: [] }),
          character('foreign', { nodes: ['w_a1'], spec: 'sniper', specNodes: ['sn_entry'] }),
          character('garbage', 'nope'),
        ],
        stash: { items: [] },
        currency: { shards: 3 },
        records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 0 },
        nextCharacterId: 6,
        nextItemId: 1,
      },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(v3));
    const { profile, backupKey } = loadProfile(storage);
    expect(backupKey).toBeUndefined();
    expect(profile.characters.map((c) => c.passives)).toEqual([
      { nodes: ['w_a1', 'w_a2'], spec: 'berserker', specNodes: ['bz_entry'] },
      { nodes: ['w_a1'], spec: null, specNodes: [] },
      { nodes: [], spec: null, specNodes: [] },
      { nodes: [], spec: null, specNodes: [] },
      { nodes: [], spec: null, specNodes: [] },
    ]);
    expect(profile.currency).toEqual({ shards: 3 });
  });

  it('loads items without a craft counter as is (no migration, reads as 0) and sanitizes present counters', () => {
    const storage = memoryStorage();
    const profile = createProfile();
    createCharacter(profile, { name: 'Aria', classId: 'mage' }, rules, ['mage']);
    const base = { baseId: 'iron_ring', level: 1, rarity: 'magic' as const, name: '', affixes: [{ affixId: 'life_flat', tier: 5, value: 10 }] };
    profile.stash.items.push({ id: 'i1', ...base }, { id: 'i2', ...base, crafts: 3 }, { id: 'i3', ...base, crafts: -2 }, { id: 'i4', ...base, crafts: 2.6 });
    profile.characters[0]!.equipment.ring1 = { id: 'i5', ...base, crafts: Number.NaN };
    profile.characters[0]!.equipment.ring2 = { id: 'i6', ...base, crafts: 4 };
    saveProfile(storage, profile);
    const loaded = loadProfile(storage).profile;
    expect(loaded.stash.items.map((i) => i.crafts)).toEqual([undefined, 3, 0, 2]);
    expect(loaded.stash.items[0]).not.toHaveProperty('crafts');
    // NaN is stored as null by JSON.
    expect(loaded.characters[0]!.equipment.ring1!.crafts).toBe(0);
    expect(loaded.characters[0]!.equipment.ring2!.crafts).toBe(4);
  });

  it('falls back to an empty stash when the stored stash has no item array', () => {
    for (const stash of [{}, { items: 'oops' }, { items: null }]) {
      const storage = memoryStorage();
      storage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, profile: { ...createProfile(), stash } }));
      const result = loadProfile(storage);
      expect(result.backupKey).toBeUndefined();
      expect(result.profile.stash).toEqual({ items: [] });
    }
  });

  it('round-trips a passive allocation', () => {
    const storage = memoryStorage();
    const profile = createProfile();
    const result = createCharacter(profile, { name: 'Aria', classId: 'mage' }, rules, ['mage']);
    if (!result.ok) throw new Error('create failed');
    result.character.level = 6;
    result.character.passives = { nodes: ['m_a1', 'm_a2'], spec: 'pyromancer', specNodes: ['py_entry'] };
    saveProfile(storage, profile);
    expect(loadProfile(storage).profile.characters[0]!.passives).toEqual({ nodes: ['m_a1', 'm_a2'], spec: 'pyromancer', specNodes: ['py_entry'] });
  });
});

describe('profile store: map ladder (v7)', () => {
  const v6Character = (level: unknown): Record<string, unknown> => ({
    id: 'c1',
    name: 'Aria',
    classId: 'mage',
    level,
    xp: 0,
    stats: { runs: 0, deaths: 0, kills: 0, longestRun: 0 },
    equipment: {},
    passives: { nodes: [], spec: null, specNodes: [] },
    skills: {},
    supports: [],
  });
  const v6 = (characters: unknown[]): string =>
    JSON.stringify({
      version: 6,
      profile: { characters, stash: { items: [] }, currency: {}, records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 0 }, nextCharacterId: 9, nextItemId: 1 },
    });

  it('is save version 7', () => {
    expect(SAVE_VERSION).toBe(7);
  });

  it('upgrades v6 heroes: maps up to their level are unlocked (at least 1, at most 40), other fields kept', () => {
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, v6([v6Character(1), { ...v6Character(12), id: 'c2' }, { ...v6Character(40), id: 'c3' }, { ...v6Character(55), id: 'c4' }, { ...v6Character('x'), id: 'c5' }]));
    const { profile, backupKey } = loadProfile(storage);
    expect(backupKey).toBeUndefined();
    expect(profile.characters.map((c) => c.maps)).toEqual([{ unlocked: 1 }, { unlocked: 12 }, { unlocked: 40 }, { unlocked: 40 }, { unlocked: 1 }]);
    expect(profile.characters[1]).toEqual({ ...v6Character(12), id: 'c2', maps: { unlocked: 12 } });
  });

  it('new heroes start at map 1 and the ladder round-trips', () => {
    const storage = memoryStorage();
    const profile = createProfile();
    createCharacter(profile, { name: 'Aria', classId: 'mage' }, rules, ['mage']);
    expect(profile.characters[0]!.maps).toEqual({ unlocked: 1 });
    profile.characters[0]!.maps.unlocked = 6;
    saveProfile(storage, profile);
    expect(loadProfile(storage).profile).toEqual(profile);
  });

  it('sanitizes stored ladders: whole number in 1..maxLinearMap, malformed → 1, extra fields kept', () => {
    const storage = memoryStorage();
    const profile = createProfile();
    for (const name of ['Aa', 'Bb', 'Cc', 'Dd', 'Ee']) createCharacter(profile, { name, classId: 'mage' }, rules, ['mage']);
    saveProfile(storage, profile);
    const raw = JSON.parse(storage.getItem(SAVE_KEY)!) as { profile: { characters: Array<Record<string, unknown>> } };
    const stored: unknown[] = [{ unlocked: 7.8 }, { unlocked: 999 }, { unlocked: -3 }, 'broken', { unlocked: 3, key: 2 }];
    raw.profile.characters.forEach((c, i) => (c.maps = stored[i]));
    delete raw.profile.characters[2]!.maps;
    storage.setItem(SAVE_KEY, JSON.stringify(raw));
    const loaded = loadProfile(storage, undefined, undefined, undefined, { maxLinearMap: 40 }).profile;
    expect(loaded.characters.map((c) => c.maps)).toEqual([{ unlocked: 7 }, { unlocked: 40 }, { unlocked: 1 }, { unlocked: 1 }, { unlocked: 3, key: 2 }]);
  });
});

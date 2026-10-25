import { describe, expect, it } from 'vitest';
import { applyCraft, CRAFT_OPS } from '../core/items/craft';
import { equipFromStash } from '../core/items/inventory';
import { generateItem, generateUnique } from '../core/items/generate';
import type { Item } from '../core/items/types';
import { grantXp, xpToNextLevel } from '../core/progression/levels';
import { createCharacter, createProfile, type Profile } from '../core/progression/profile';
import { createRng } from '../core/rng';
import { grantSkillXp, skillXpToNext } from '../core/skills/levels';
import { addSupport, socketSupport } from '../core/supports/tab';
import type { KeyValueStorage } from '../platform/platform';
import { classes } from '../data/classes';
import { craftingRules } from '../data/crafting';
import { itemsData } from '../data/items';
import { progression } from '../data/progression';
import { skillLevels } from '../data/skillLevels';
import { supportsData } from '../data/supports';
import { loadProfile, SAVE_KEY, SAVE_VERSION, saveProfile } from './profileStore';
import { defaultValidation, normalizeHeroProgress, normalizeItem, validateProfile } from './validate';

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const rules = { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 };
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const validate = (profile: unknown): Profile => validateProfile(plain(profile), defaultValidation);

/** A stored profile with one hero of `classId` and the given overrides on the hero. */
function withHero(classId: string, hero: Record<string, unknown> = {}, profile: Partial<Profile> = {}): Record<string, unknown> {
  const p = createProfile();
  createCharacter(p, { name: 'Aria', classId }, rules, [classId]);
  return { ...p, ...profile, characters: [{ ...p.characters[0]!, ...hero }] };
}

const item = (fields: Partial<Item> & Record<string, unknown>): Item => ({ id: 'i1', baseId: 'iron_ring', level: 30, rarity: 'magic', name: '', affixes: [], ...fields }) as Item;
const fix = (fields: Partial<Item> & Record<string, unknown>): Item => normalizeItem(plain(item(fields)), itemsData);

describe('save validation: legit data is never changed', () => {
  /** A profile the game itself could produce: every class, levels, skills, supports, crafted and unique items. */
  function legitProfile(seed: number): Profile {
    const rng = createRng(seed);
    const profile = createProfile();
    profile.currency = { shards: 100000, essence: 1000 };
    for (const classId of ['warrior', 'ranger', 'mage']) {
      const result = createCharacter(profile, { name: `Hero ${classId}`, classId }, rules, [classId]);
      if (!result.ok) throw new Error('create failed');
      const hero = result.character;
      const classDef = classes[classId]!;
      grantXp(hero, rng.range(0, 400000), progression);
      hero.maps.unlocked = rng.int(1, 40);
      hero.stats = { runs: 12, deaths: 3, kills: 2345, longestRun: 291.4 };
      for (const skill of classDef.skills) {
        hero.skills[skill.id] = { level: 1, xp: 0 };
        grantSkillXp(hero.skills[skill.id]!, rng.range(0, 9000), skillLevels.rules);
      }
      for (const def of Object.values(supportsData.supports)) {
        addSupport(profile, hero, { defId: def.id, tier: rng.int(1, def.tiers.length) }, supportsData);
      }
      for (const skill of classDef.skills) {
        for (let slot = 0; slot < supportsData.rules.slotsPerSkill; slot++) {
          for (const s of hero.supports) if (!s.socket && socketSupport(hero, s.id, skill.id, slot, classDef, supportsData) === null) break;
        }
      }
      // A weapon of the class's type and a ring, equipped from the stash.
      for (const slot of ['weapon', 'ring', 'amulet', 'boots'] as const) {
        for (let tries = 0; tries < 50; tries++) {
          const it = generateItem(rng, `i${profile.nextItemId++}`, { itemLevel: rng.int(1, hero.level), slot, rarity: 'rare' }, itemsData);
          if (slot === 'weapon' && itemsData.bases[it.baseId]!.weapon!.type !== classDef.weaponType) continue;
          profile.stash.items.push(it);
          expect(equipFromStash(profile, hero.id, it.id, classDef.weaponType, itemsData)).toBeNull();
          break;
        }
      }
    }
    // Loot of every level, crafted at random.
    for (let i = 0; i < 25; i++) profile.stash.items.push(generateItem(rng, `i${profile.nextItemId++}`, { itemLevel: rng.int(1, 45) }, itemsData));
    for (let n = 0; n < 200; n++) {
      const target = profile.stash.items[rng.int(0, profile.stash.items.length - 1)]!;
      applyCraft(profile, target.id, CRAFT_OPS[rng.int(0, CRAFT_OPS.length - 1)]!, { index: rng.int(0, 5) }, rng, { items: itemsData, crafting: craftingRules });
    }
    // Every unique and legendary at a few levels, in the overflow and the stash.
    for (const def of Object.values(itemsData.uniques)) {
      for (const level of [1, 9, 16, 27, 40]) profile.stash.overflow.push(generateUnique(rng, `i${profile.nextItemId++}`, def, level, itemsData));
    }
    profile.stash.overflow = profile.stash.overflow.slice(0, itemsData.rules.overflow.size);
    profile.records = { bestMapLevel: 17, bossKills: 9, bestClearTime: 187.25, mostKillsInRun: 311 };
    return plain(profile);
  }

  it('a generated profile loads exactly as saved (signed and unsigned)', () => {
    for (const seed of [1, 2, 3, 42]) {
      const profile = legitProfile(seed);
      // The fixture covers what validation checks: crafted rares, uniques, socketed supports, worn gear, levels.
      expect(profile.stash.items.some((i) => (i.crafts ?? 0) > 0 && i.rarity === 'rare')).toBe(true);
      expect(profile.stash.overflow.length).toBeGreaterThan(0);
      expect(profile.characters.every((c) => c.supports.some((s) => s.socket) && c.equipment.weapon && c.level > 1)).toBe(true);
      expect(validate(profile)).toEqual(profile);
      const storage = memoryStorage();
      saveProfile(storage, profile);
      expect(loadProfile(storage)).toEqual({ profile, integrity: 'ok' });
      const legacy = memoryStorage();
      legacy.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, profile }));
      expect(loadProfile(legacy)).toEqual({ profile, integrity: 'unsigned' });
    }
  });

  it('a hand-shaped v8 save like the designer\'s loads unchanged', () => {
    const save = {
      version: 8,
      profile: {
        characters: [
          {
            id: 'c1',
            name: 'Тест',
            classId: 'warrior',
            level: 20,
            xp: 1234.5678,
            stats: { runs: 41, deaths: 6, kills: 9120, longestRun: 302.7 },
            equipment: {
              weapon: { id: 'i31', baseId: 'rusty_sword', level: 12, rarity: 'unique', name: '', affixes: [], implicit: 0.12, unique: { id: 'barrow_reaper', rolls: [{ tier: 4, value: 5 }, { tier: 4, value: 0.2 }, { tier: 4, value: 20 }] } },
              helmet: { id: 'i40', baseId: 'iron_cap', level: 18, rarity: 'rare', name: 'Grim Ward', implicit: 7, armour: 11, crafts: 3, affixes: [{ affixId: 'life_flat', tier: 3, value: 30 }, { affixId: 'fire_res', tier: 3, value: 0.2 }, { affixId: 'resource_flat', tier: 4, value: 12 }] },
              ring1: { id: 'i44', baseId: 'iron_ring', level: 20, rarity: 'magic', name: '', implicit: 10, affixes: [{ affixId: 'resource_regen', tier: 3, value: 1.5 }] },
            },
            passives: { nodes: ['w_a1', 'w_a2'], spec: 'berserker', specNodes: ['bz_entry'] },
            skills: { cleave: { level: 3, xp: 0 }, shield_charge: { level: 2, xp: 812.25 } },
            supports: [
              { id: 's12', defId: 'stun', tier: 2, socket: { skillId: 'cleave', slot: 0 } },
              { id: 's13', defId: 'pierce', tier: 1 },
            ],
            maps: { unlocked: 14 },
          },
        ],
        stash: { items: [{ id: 'i50', baseId: 'chainmail', level: 9, rarity: 'normal', name: '', implicit: 12, armour: 25, affixes: [] }], overflow: [] },
        currency: { shards: 152.5, essence: 1.7 },
        records: { bestMapLevel: 13, bossKills: 7, bestClearTime: 201.4, mostKillsInRun: 288 },
        nextCharacterId: 2,
        nextItemId: 51,
      },
    };
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, JSON.stringify(save));
    const result = loadProfile(storage);
    expect(result.integrity).toBe('unsigned');
    expect(result.profile).toEqual(save.profile);
    expect(loadProfile(storage)).toEqual({ profile: save.profile, integrity: 'ok' });
  });

  it('unknown fields are kept (forward compatibility)', () => {
    const stored = withHero('mage', { future: { a: 1 }, stats: { runs: 1, deaths: 0, kills: 0, longestRun: 0, bestStreak: 4 } }, { stash: { items: [item({ affixes: [], glow: 'red' })], overflow: [], tabs: 2 } as never });
    const profile = validate({ ...stored, season: 3 }) as unknown as Record<string, unknown> & Profile;
    expect(profile.season).toBe(3);
    expect((profile.characters[0] as unknown as Record<string, unknown>).future).toEqual({ a: 1 });
    expect(profile.characters[0]!.stats).toMatchObject({ bestStreak: 4 });
    expect(profile.stash).toMatchObject({ tabs: 2 });
    expect(profile.stash.items[0]).toMatchObject({ glow: 'red' });
  });
});

describe('save validation: heroes', () => {
  it('hero level is whole, within 1..maxLevel; XP finite, ≥ 0, below the next level, 0 at max', () => {
    const max = progression.maxLevel;
    expect(normalizeHeroProgress(0, 10, progression)).toEqual({ level: 1, xp: 10 });
    expect(normalizeHeroProgress(7.9, 5, progression)).toEqual({ level: 7, xp: 5 });
    expect(normalizeHeroProgress('x', 5, progression)).toEqual({ level: 1, xp: 5 });
    expect(normalizeHeroProgress(999, 5000, progression)).toEqual({ level: max, xp: 0 });
    expect(normalizeHeroProgress(5, -3, progression)).toEqual({ level: 5, xp: 0 });
    expect(normalizeHeroProgress(5, null, progression)).toEqual({ level: 5, xp: 0 });
    expect(normalizeHeroProgress(5, 12.5, progression)).toEqual({ level: 5, xp: 12.5 });
  });

  it('XP past the next level goes through the level-up path (a cheaper curve turns it into levels)', () => {
    const next = xpToNextLevel(5, progression);
    expect(normalizeHeroProgress(5, next + 3, progression)).toEqual({ level: 6, xp: 3 });
    expect(normalizeHeroProgress(5, 1e12, progression)).toEqual({ level: progression.maxLevel, xp: 0 });
    // The same stored XP under a curve half as steep: more levels, nothing lost.
    const cheaper = { ...progression, xpCurve: { ...progression.xpCurve, base: progression.xpCurve.base / 2 } };
    const stored = xpToNextLevel(5, progression) - 1;
    const hero = { level: 5, xp: 0 };
    grantXp(hero, stored, cheaper);
    expect(hero.level).toBeGreaterThan(5);
    expect(normalizeHeroProgress(5, stored, cheaper)).toEqual(hero);
  });

  it('a hero clamped down loses a passive allocation it can no longer pay for (free reset)', () => {
    const profile = validate(withHero('warrior', { level: 999, passives: { nodes: ['w_a1', 'w_a2'], spec: 'berserker', specNodes: ['bz_entry'] } }));
    expect(profile.characters[0]!.level).toBe(progression.maxLevel);
    expect(profile.characters[0]!.passives.nodes).toEqual(['w_a1', 'w_a2']);
    const low = validate(withHero('warrior', { level: -4, passives: { nodes: ['w_a1', 'w_a2'], spec: null, specNodes: [] } }));
    expect(low.characters[0]!.level).toBe(1);
    expect(low.characters[0]!.passives).toEqual({ nodes: [], spec: null, specNodes: [] });
  });

  it('skill XP past the next skill level levels the skill up', () => {
    const next = skillXpToNext(1, skillLevels.rules);
    const profile = validate(
      withHero('mage', { skills: { fireball: { level: 1, xp: next + 7 }, frost_nova: { level: 2, xp: 10 }, teleport: { level: 1, xp: 99999999 } } }),
    );
    expect(profile.characters[0]!.skills).toEqual({
      fireball: { level: 2, xp: 7 },
      frost_nova: { level: 2, xp: 10 },
      teleport: { level: skillLevels.rules.maxLevel, xp: 0 },
    });
  });

  it('stats are whole and ≥ 0, names are strings cut to the length rule, malformed heroes are dropped', () => {
    const p = withHero('mage', { name: '  ' + 'A'.repeat(40), stats: { runs: -2, deaths: 1.7, kills: 'many', longestRun: -1 } });
    (p.characters as unknown[]).push('garbage', { id: 'c9', name: 'X' }, { id: 7, classId: 'mage' });
    const profile = validate(p);
    expect(profile.characters).toHaveLength(1);
    expect(profile.characters[0]!.name).toBe('A'.repeat(rules.nameMaxLength));
    expect(profile.characters[0]!.stats).toEqual({ runs: 0, deaths: 1, kills: 0, longestRun: 0 });
    expect(validate(withHero('mage', { name: 42 })).characters[0]!.name).toBe('Hero');
  });

  it('maps.unlocked stays within 1..maxLinearMap', () => {
    expect(validate(withHero('mage', { maps: { unlocked: 500 } })).characters[0]!.maps).toEqual({ unlocked: 40 });
    expect(validate(withHero('mage', { maps: { unlocked: 0 } })).characters[0]!.maps).toEqual({ unlocked: 1 });
  });
});

describe('save validation: account', () => {
  it('currency is finite and ≥ 0; non-numbers removed; unknown currencies kept', () => {
    const profile = validate({ ...createProfile(), currency: { shards: -40, essence: 'lots', chaos: 3.123456789, gold: null } });
    expect(profile.currency).toEqual({ shards: 0, chaos: 3.1235 });
    expect(validate({ ...createProfile(), currency: 'rich' }).currency).toEqual({});
  });

  it('records are whole and ≥ 0, the best clear time null or positive', () => {
    const profile = validate({ ...createProfile(), records: { bestMapLevel: -1, bossKills: 2.5, bestClearTime: -3, mostKillsInRun: 'x' } });
    expect(profile.records).toEqual({ bestMapLevel: 0, bossKills: 2, bestClearTime: null, mostKillsInRun: 0 });
  });

  it('id counters move past every id in use, so no id is handed out twice', () => {
    const p = withHero('mage', { supports: [{ id: 's40', defId: 'pierce', tier: 1 }] }, { nextItemId: 2, nextCharacterId: 1 });
    (p as { stash: unknown }).stash = { items: [item({ id: 'i17' })], overflow: [] };
    const profile = validate(p);
    expect(profile.nextItemId).toBe(41);
    expect(profile.nextCharacterId).toBe(2);
    expect(validate({ ...createProfile(), nextItemId: 'x', nextCharacterId: -5 })).toMatchObject({ nextItemId: 1, nextCharacterId: 1 });
  });
});

describe('save validation: items', () => {
  it('unknown affixes, affixes that do not fit the base and malformed entries are removed', () => {
    const fixed = fix({
      baseId: 'iron_greaves',
      rarity: 'rare',
      affixes: [
        { affixId: 'gone_affix', tier: 1, value: 5 },
        { affixId: 'crit_chance', tier: 1, value: 0.5 }, // rings / amulets / weapons only
        { affixId: 'move_speed', tier: 'x', value: 0.1 } as never,
        { affixId: 'life_flat', tier: 3, value: 30 },
      ],
    });
    expect(fixed.affixes).toEqual([{ affixId: 'life_flat', tier: 3, value: 30 }]);
  });

  it('an affix that breaks only the defence requirement is kept (older items legitimately have them)', () => {
    // es_flat requires energy shield; iron_greaves have armour only. Items from before that rule keep it.
    const fixed = fix({ baseId: 'iron_greaves', rarity: 'rare', affixes: [{ affixId: 'es_flat', tier: 1, value: 40 }] });
    expect(fixed.affixes).toEqual([{ affixId: 'es_flat', tier: 1, value: 40 }]);
  });

  it('tiers: garbage removed, past the worst → worst, above the item level → best unlocked; values clamped', () => {
    const fixed = fix({
      level: 10,
      rarity: 'rare',
      affixes: [
        { affixId: 'life_flat', tier: 0, value: 10 },
        { affixId: 'fire_res', tier: 2.5, value: 0.1 },
        { affixId: 'cold_res', tier: 9, value: 0.5 },
        { affixId: 'life_flat', tier: 1, value: 55 },
      ],
    });
    // life_flat T1 needs item level 30: at level 10 the best is T4 (8+), value clamped to its 15..24.
    expect(fixed.affixes).toEqual([
      { affixId: 'cold_res', tier: 5, value: 0.11 },
      { affixId: 'life_flat', tier: 4, value: 24 },
    ]);
    expect(fix({ level: 30, affixes: [{ affixId: 'life_flat', tier: 2, value: 1 }] }).affixes).toEqual([{ affixId: 'life_flat', tier: 2, value: 35 }]);
  });

  it('one affix per group, prefix / suffix / count caps of the rarity; normal and unique items carry none', () => {
    const magic = fix({
      affixes: [
        { affixId: 'life_flat', tier: 5, value: 10 },
        { affixId: 'life_flat', tier: 4, value: 20 },
        { affixId: 'added_fire', tier: 5, value: 3 },
        { affixId: 'fire_res', tier: 5, value: 0.1 },
        { affixId: 'cold_res', tier: 5, value: 0.1 },
      ],
    });
    expect(magic.affixes.map((a) => a.affixId)).toEqual(['life_flat', 'fire_res']);
    expect(fix({ rarity: 'normal', affixes: [{ affixId: 'life_flat', tier: 5, value: 10 }] }).affixes).toEqual([]);
    expect(fix({ rarity: 'unique', affixes: [{ affixId: 'life_flat', tier: 5, value: 10 }], unique: { id: 'bloody_pupil', rolls: [] } }).affixes).toEqual([]);
  });

  it('implicit, armour and energy shield are clamped to the base; non-finite ones removed', () => {
    const fixed = fix({ baseId: 'iron_cap', rarity: 'normal', implicit: 99, armour: -5, energyShield: null } as never);
    expect(fixed.implicit).toBe(8);
    expect(fixed.armour).toBe(8);
    expect(fixed).not.toHaveProperty('energyShield');
  });

  it('level whole and ≥ 1, unknown rarity inferred, name a string; unknown bases keep their data', () => {
    expect(fix({ level: -3, rarity: 'godly' as never, name: 5 as never, affixes: [{ affixId: 'life_flat', tier: 5, value: 10 }] })).toMatchObject({ level: 1, rarity: 'magic', name: '' });
    const gone = fix({ baseId: 'removed_base', rarity: 'rare', implicit: 1e9, affixes: [{ affixId: 'gone', tier: 1, value: 3 }] });
    expect(gone).toMatchObject({ baseId: 'removed_base', implicit: 1e9, affixes: [{ affixId: 'gone', tier: 1, value: 3 }] });
  });

  it('unique rolls never lose their position: a line without tiers keeps its roll, so later rolls stay on their lines', () => {
    const pupil = itemsData.uniques.bloody_pupil!;
    const data = { ...itemsData, uniques: { ...itemsData.uniques, bloody_pupil: { ...pupil, stats: [{ ...pupil.stats[0]!, tiers: [] }, ...pupil.stats.slice(1)] } } };
    const stored = item({ level: 5, rarity: 'unique', unique: { id: 'bloody_pupil', rolls: [{ tier: 3, value: 0.33 }, { tier: 5, value: 0.12 }, { tier: 5, value: 11 }] } });
    expect(normalizeItem(plain(stored), data).unique).toEqual({ id: 'bloody_pupil', rolls: [{ tier: 3, value: 0.33 }, { tier: 5, value: 0.12 }, { tier: 5, value: 11 }] });
  });

  it('unique rolls: clamped to their tier, a tier above the item level → the tier the level gives, extra rolls dropped', () => {
    const fixed = fix({
      level: 5,
      rarity: 'unique',
      unique: { id: 'bloody_pupil', rolls: [{ tier: 1, value: 0.6 }, { tier: 5, value: 9 }, { tier: 5, value: 10 }, { tier: 5, value: 1 }] },
    });
    // Level 5: every line rolls T5 (CRIT_INC 0.1..0.19, CRIT_MULTI 0.1..0.14, LIFE 8..14).
    expect(fixed.unique).toEqual({ id: 'bloody_pupil', rolls: [{ tier: 5, value: 0.19 }, { tier: 5, value: 0.14 }, { tier: 5, value: 10 }] });
    // Below every tier's level a unique still rolls its worst tier (generateUnique).
    expect(fix({ level: 30, rarity: 'legendary', unique: { id: 'abyss_eye', rolls: [] } }).unique).toEqual({ id: 'abyss_eye', rolls: [] });
  });

  it('malformed stash entries are dropped', () => {
    const profile = validate({ ...createProfile(), stash: { items: ['legacy', null, { id: 'i1' }, item({ id: 'i2' })], overflow: [] } });
    expect(profile.stash.items.map((i) => i.id)).toEqual(['i2']);
  });
});

describe('save validation: equipment', () => {
  const sword = item({ id: 'i2', baseId: 'rusty_sword', rarity: 'normal', implicit: 0.12 });
  const ring = item({ id: 'i3', affixes: [{ affixId: 'life_flat', tier: 5, value: 10 }] });

  it('items worn where they cannot be go to the stash: wrong slot, unknown slot, other class weapon, a second copy of a unique', () => {
    const pupil = (id: string): Item => item({ id, rarity: 'unique', unique: { id: 'bloody_pupil', rolls: [{ tier: 1, value: 0.5 }] } });
    const profile = validate(withHero('mage', { equipment: { weapon: sword, ring3: ring, amulet: item({ id: 'i4' }), ring1: pupil('i5'), ring2: pupil('i6') } }));
    expect(Object.keys(profile.characters[0]!.equipment)).toEqual(['ring1']);
    expect(profile.stash.items.map((i) => i.id)).toEqual(['i2', 'i3', 'i4', 'i6']);
    const warrior = validate(withHero('warrior', { equipment: { weapon: sword } }));
    expect(warrior.characters[0]!.equipment.weapon?.id).toBe('i2');
  });

  it('with a full stash a displaced unique waits in the overflow, other items are salvaged into shards', () => {
    const full = Array.from({ length: itemsData.rules.stashSize }, (_, i) => item({ id: `i${100 + i}` }));
    const unique = item({ id: 'i7', baseId: 'amber_amulet', rarity: 'unique', implicit: 12, unique: { id: 'ancestral_horn', rolls: [] } });
    const profile = validate(withHero('mage', { equipment: { weapon: sword, ring1: unique } }, { stash: { items: full, overflow: [] }, currency: { shards: 1 } }));
    expect(profile.stash.items).toHaveLength(itemsData.rules.stashSize);
    expect(profile.stash.overflow.map((i) => i.id)).toEqual(['i7']);
    expect(profile.currency.shards).toBe(1 + itemsData.rules.salvage.normal);
  });
});

describe('save validation: supports', () => {
  it('a support whose def is gone is salvaged into shards at its tier value (from data)', () => {
    const salvage = supportsData.rules.salvage;
    const profile = validate(
      withHero(
        'mage',
        {
          supports: [
            { id: 's1', defId: 'removed_a', tier: 2 },
            { id: 's2', defId: 'removed_b', tier: 9 },
            { id: 's3', defId: 'pierce', tier: 1 },
            { id: 's1', defId: 'removed_a', tier: 3 }, // a duplicated id is a copy, not a support: no shards
          ],
        },
        { currency: { shards: 4 } },
      ),
    );
    expect(profile.characters[0]!.supports).toEqual([{ id: 's3', defId: 'pierce', tier: 1 }]);
    expect(profile.currency.shards).toBe(4 + salvage[1]! + salvage[salvage.length - 1]!);
  });

  it('a tab over its size salvages its newest unsocketed supports', () => {
    const size = supportsData.rules.tabSize;
    const supports = Array.from({ length: size + 3 }, (_, i) => ({ id: `s${i + 1}`, defId: 'pierce', tier: 1 }));
    (supports[size + 2] as { socket?: unknown }).socket = { skillId: 'volley', slot: 0 };
    const profile = validate(withHero('ranger', { supports }));
    const tab = profile.characters[0]!.supports;
    expect(tab).toHaveLength(size);
    expect(tab[size - 1]).toEqual({ id: `s${size + 3}`, defId: 'pierce', tier: 1, socket: { skillId: 'volley', slot: 0 } });
    expect(profile.currency.shards).toBe(3 * supportsData.rules.salvage[0]!);
  });
});

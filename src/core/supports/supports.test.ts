// Skill modifiers: compatibility, change sets, the supports tab and drops (docs/design/skill-modifiers.md).
import { describe, expect, it } from 'vitest';
import { classes } from '../../data/classes';
import { supportsData } from '../../data/supports';
import { createCharacter, createProfile, type CharacterRecord, type Profile } from '../progression/profile';
import { createRng } from '../rng';
import { resolveAction } from '../skills/params';
import type { ActionDef, ClassDef } from '../world/content';
import { availableSupportTiers, rollSupport, rollSupportDrop } from './drops';
import { supportChangeSet, supportChangeSets, supportFits, supportTier } from './rules';
import {
  addSupport,
  grantSupportDrops,
  salvageSupport,
  socketCandidates,
  socketedSupports,
  socketSupport,
  supportInSlot,
  unsocketSupport,
  validateSockets,
} from './tab';
import type { SupportData, SupportDef } from './types';

const def = (id: string, compatibility: SupportDef['compatibility'], resourceCostMultiplier: number, tiers: SupportDef['tiers'], weight = 100): SupportDef => ({
  id,
  group: 'general',
  compatibility,
  resourceCostMultiplier,
  weight,
  tiers,
});

const testData: SupportData = {
  rules: { slotsPerSkill: 2, tabSize: 3, tierMinLevel: [1, 5, 10], tierWeights: [100, 40, 15], dropChance: { normal: 0.5, elite: 0.8, boss: 1 }, salvage: [2, 4, 8] },
  supports: {
    power: def('power', { damaging: true }, 1.4, [
      { bonus: { modifiers: [{ stat: 'damage', kind: 'more', value: 0.3 }] } },
      { bonus: { modifiers: [{ stat: 'damage', kind: 'more', value: 0.4 }] } },
    ]),
    melee: def('melee', { tags: [['melee']] }, 1.3, [{ bonus: { changes: [{ param: 'radius', increased: 0.5 }] } }]),
    stun: def('stun', { tags: [['melee']], damaging: true }, 1, [
      { bonus: { addOnHit: [{ status: 'stun', duration: 1, chance: 0.5 }] }, variants: [{ mechanic: 'stunBar', bonus: { stunBarFillIncreased: 0.4 } }] },
    ]),
    rare: def('rare', {}, 1, [{ bonus: {} }, { bonus: {} }, { bonus: {} }], 0),
  },
};

const warrior = classes.warrior!;
const ranger = classes.ranger!;
const mage = classes.mage!;
const skill = (cls: ClassDef, id: string): ActionDef => cls.skills.find((s) => s.id === id)!;

function hero(classId = 'warrior'): { profile: Profile; character: CharacterRecord } {
  const profile = createProfile();
  const result = createCharacter(profile, { name: 'Aria', classId }, { maxCharacters: 5, nameMinLength: 2, nameMaxLength: 16 }, [classId]);
  if (!result.ok) throw new Error('create failed');
  return { profile, character: result.character };
}

describe('support data (src/data/supports.ts)', () => {
  it('has the 14 designed supports with 3 tiers each, 2 slots and a tab of 30', () => {
    expect(Object.keys(supportsData.supports)).toEqual([
      'wider_swing',
      'stun',
      'bleed',
      'knockback',
      'extra_projectiles',
      'pierce',
      'fast_projectiles',
      'increased_area',
      'ignite_on_hit',
      'chain_lightning',
      'cast_speed',
      'pure_power',
      'vampirism',
      'echo',
    ]);
    for (const s of Object.values(supportsData.supports)) {
      expect(s.tiers).toHaveLength(3);
      expect(s.resourceCostMultiplier).toBeGreaterThan(1);
    }
    expect(supportsData.rules.slotsPerSkill).toBe(2);
    expect(supportsData.rules.tabSize).toBe(30);
    expect(supportsData.rules.tierMinLevel).toHaveLength(3);
  });

  it('compatibility follows the design for every class skill', () => {
    const all = [...warrior.skills, ...ranger.skills, ...mage.skills];
    const fits = (id: string): string[] => all.filter((s) => supportFits(supportsData.supports[id]!, s)).map((s) => s.id);
    expect(fits('wider_swing')).toEqual(['cleave', 'shield_charge']);
    expect(fits('stun')).toEqual(['cleave', 'shield_charge']);
    expect(fits('bleed')).toEqual(['cleave', 'shield_charge']);
    expect(fits('knockback')).toEqual(['cleave', 'shield_charge']);
    expect(fits('extra_projectiles')).toEqual(['volley', 'fireball']);
    // Fireball explodes on its first hit: nothing to pierce.
    expect(fits('pierce')).toEqual(['volley']);
    expect(fits('fast_projectiles')).toEqual(['volley', 'fireball']);
    expect(fits('increased_area')).toEqual(['cleave', 'explosive_trap', 'fireball', 'frost_nova']);
    // Any skill that hits (designer decision 2026-10-23).
    expect(fits('ignite_on_hit')).toEqual(['cleave', 'shield_charge', 'volley', 'explosive_trap', 'fireball', 'frost_nova']);
    expect(fits('chain_lightning')).toEqual(['fireball', 'frost_nova']);
    // Spells and attacks (designer decision 2026-10-23); Battle Cry and Roll are neither. Not on cooldown-gated
    // skills, where it does nothing (Shield Charge, Frost Nova, Teleport; designer decision 2026-10-23).
    expect(fits('cast_speed')).toEqual(['cleave', 'volley', 'fireball']);
    expect(fits('pure_power')).toEqual(['cleave', 'shield_charge', 'volley', 'explosive_trap', 'fireball', 'frost_nova']);
    expect(fits('vampirism')).toEqual(['cleave', 'shield_charge', 'volley', 'explosive_trap', 'fireball', 'frost_nova']);
    // No movement skills or buffs (designer decision 2026-10-23).
    expect(fits('echo')).toEqual(['cleave', 'volley', 'explosive_trap', 'fireball', 'frost_nova']);
  });

  it('Extra Projectiles gives Volley +2 and Fireball +1 at every tier (designer decision 2026-10-23)', () => {
    for (let tier = 1; tier <= 3; tier++) {
      const count = (cls: ClassDef, id: string): number => {
        const set = supportChangeSet(id, { defId: 'extra_projectiles', tier }, supportsData, []);
        const d = resolveAction(skill(cls, id), set ? [set] : []).delivery;
        return d.kind === 'projectile' ? d.count : NaN;
      };
      expect(count(ranger, 'volley')).toBe(7);
      expect(count(mage, 'fireball')).toBe(2);
    }
  });

  it('every support fits at least one skill and every damaging class skill takes some support', () => {
    const all = [...warrior.skills, ...ranger.skills, ...mage.skills];
    for (const s of Object.values(supportsData.supports)) expect(all.some((a) => supportFits(s, a))).toBe(true);
    for (const a of all.filter((x) => x.damage)) expect(Object.values(supportsData.supports).some((s) => supportFits(s, a))).toBe(true);
  });
});

describe('support rules', () => {
  it('compatibility: OR of tag sets, deliveries, excluded deliveries, damaging, non-exploding, no cooldown', () => {
    const cleave = skill(warrior, 'cleave');
    const cry = skill(warrior, 'battle_cry');
    const fireball = skill(mage, 'fireball');
    expect(supportFits(def('a', { tags: [['spell'], ['melee', 'area']] }, 1, []), cleave)).toBe(true);
    expect(supportFits(def('a', { tags: [['spell'], ['melee', 'projectile']] }, 1, []), cleave)).toBe(false);
    expect(supportFits(def('a', { deliveries: ['projectile'] }, 1, []), cleave)).toBe(false);
    expect(supportFits(def('a', { excludeDeliveries: ['self'] }, 1, []), cry)).toBe(false);
    expect(supportFits(def('a', { damaging: true }, 1, []), cry)).toBe(false);
    expect(supportFits(def('a', { nonExploding: true }, 1, []), fireball)).toBe(false);
    expect(supportFits(def('a', { nonExploding: true }, 1, []), cleave)).toBe(true);
    expect(supportFits(def('a', { noCooldown: true }, 1, []), skill(warrior, 'shield_charge'))).toBe(false);
    expect(supportFits(def('a', { noCooldown: true }, 1, []), cleave)).toBe(true);
  });

  it('tiers clamp to the def; unknown defs resolve to nothing', () => {
    expect(supportTier({ defId: 'power', tier: 9 }, testData)?.tier).toBe(testData.supports.power!.tiers[1]);
    expect(supportTier({ defId: 'power', tier: 0 }, testData)?.tier).toBe(testData.supports.power!.tiers[0]);
    expect(supportTier({ defId: 'nope', tier: 1 }, testData)).toBeUndefined();
  });

  it('a support targets only its skill and carries its cost multiplier', () => {
    expect(supportChangeSet('cleave', { defId: 'power', tier: 2 }, testData, [])).toEqual({
      modifiers: [{ stat: 'damage', kind: 'more', value: 0.4 }],
      skillIds: ['cleave'],
      resourceCostMultiplier: 1.4,
    });
  });

  it('two supports multiply the resource cost (×1.3 × 1.4 = ×1.82, designer decision 2026-10-23)', () => {
    const cleave = skill(warrior, 'cleave');
    const sets = supportChangeSets(warrior, { cleave: [{ defId: 'melee', tier: 1 }, { defId: 'power', tier: 1 }] }, testData, []);
    const resolved = resolveAction(cleave, sets);
    expect(resolved.resourceCost).toBeCloseTo(cleave.resourceCost * 1.82, 10);
    expect(resolved.delivery).toEqual({ kind: 'arc', radius: 95 * 1.5, angleDeg: 150 });
    expect(resolved.modifiers).toEqual([{ stat: 'damage', kind: 'more', value: 0.3 }]);
  });

  it('the Stun support uses its stunBar variant when the hero has the stun bar mechanic (Guardian)', () => {
    const bar = { kind: 'stunBar', baseFill: 0.1, damageFill: 1, stunDuration: 1, bossFillFactor: 0.5, bossStunDuration: 1, decayDelay: 1, decayPerSecond: 0.5 } as const;
    expect(supportChangeSet('cleave', { defId: 'stun', tier: 1 }, testData, [])).toEqual({
      addOnHit: [{ status: 'stun', duration: 1, chance: 0.5 }],
      skillIds: ['cleave'],
      resourceCostMultiplier: 1,
    });
    expect(supportChangeSet('cleave', { defId: 'stun', tier: 1 }, testData, [bar])).toEqual({ stunBarFillIncreased: 0.4, skillIds: ['cleave'], resourceCostMultiplier: 1 });
  });

  it('ignores invalid sockets: basic attack, unknown skill or def, incompatible, duplicates, past the slot count', () => {
    const sets = supportChangeSets(
      warrior,
      {
        warrior_strike: [{ defId: 'power', tier: 1 }],
        volley: [{ defId: 'power', tier: 1 }],
        battle_cry: [{ defId: 'power', tier: 1 }],
        cleave: [{ defId: 'power', tier: 1 }, { defId: 'power', tier: 2 }, { defId: 'melee', tier: 1 }],
        shield_charge: [{ defId: 'nope', tier: 1 }, { defId: 'melee', tier: 1 }, { defId: 'power', tier: 1 }],
      },
      testData,
      [],
    );
    expect(sets.map((s) => [s.skillIds, s.resourceCostMultiplier])).toEqual([
      [['cleave'], 1.4],
      [['shield_charge'], 1.3],
    ]);
    expect(supportChangeSets(warrior, { cleave: [{ defId: 'power', tier: 1 }] }, undefined, [])).toEqual([]);
  });
});

describe('supports tab', () => {
  it('a new hero has no supports (designer decision 2026-10-23)', () => {
    expect(hero().character.supports).toEqual([]);
  });

  it('adds supports with profile item ids; past the tab size they are salvaged into shards', () => {
    const { profile, character } = hero();
    profile.nextItemId = 7;
    const rewards = grantSupportDrops(
      profile,
      character,
      [
        { defId: 'power', tier: 1 },
        { defId: 'melee', tier: 1 },
        { defId: 'stun', tier: 1 },
        { defId: 'power', tier: 2 },
        { defId: 'rare', tier: 3 },
      ],
      testData,
    );
    expect(rewards.kept.map((s) => s.id)).toEqual(['s7', 's8', 's9']);
    expect(rewards).toMatchObject({ salvagedCount: 2, shards: 4 + 8 });
    expect(character.supports).toEqual([
      { id: 's7', defId: 'power', tier: 1 },
      { id: 's8', defId: 'melee', tier: 1 },
      { id: 's9', defId: 'stun', tier: 1 },
    ]);
    expect(profile.currency.shards).toBe(12);
    expect(profile.nextItemId).toBe(10);
    expect(addSupport(profile, character, { defId: 'power', tier: 1 }, testData)).toEqual({ kept: false, shards: 2 });
  });

  it('socketing: checks, swap, move and duplicates', () => {
    const { profile, character } = hero();
    grantSupportDrops(profile, character, [{ defId: 'power', tier: 1 }, { defId: 'melee', tier: 1 }, { defId: 'power', tier: 2 }], testData);
    const [p1, m1, p2] = character.supports.map((s) => s.id) as [string, string, string];
    expect(socketSupport(character, 'x', 'cleave', 0, warrior, testData)).toBe('no-support');
    expect(socketSupport(character, p1, 'warrior_strike', 0, warrior, testData)).toBe('no-skill');
    expect(socketSupport(character, p1, 'cleave', 2, warrior, testData)).toBe('bad-slot');
    expect(socketSupport(character, p1, 'battle_cry', 0, warrior, testData)).toBe('incompatible');
    expect(socketSupport(character, p1, 'cleave', 0, warrior, testData)).toBeNull();
    // Same def into the other slot of the same skill: not allowed.
    expect(socketSupport(character, p2, 'cleave', 1, warrior, testData)).toBe('duplicate');
    expect(socketSupport(character, m1, 'cleave', 1, warrior, testData)).toBeNull();
    expect(socketedSupports(character)).toEqual({ cleave: [{ defId: 'power', tier: 1 }, { defId: 'melee', tier: 1 }] });
    // Same def replacing itself in its own slot is fine; the occupant returns to the tab.
    expect(socketSupport(character, p2, 'cleave', 0, warrior, testData)).toBeNull();
    expect(supportInSlot(character, 'cleave', 0)?.id).toBe(p2);
    expect(character.supports.find((s) => s.id === p1)?.socket).toBeUndefined();
    // Moving a socketed support to another skill frees its old slot.
    expect(socketSupport(character, m1, 'shield_charge', 0, warrior, testData)).toBeNull();
    expect(socketedSupports(character)).toEqual({ cleave: [{ defId: 'power', tier: 2 }], shield_charge: [{ defId: 'melee', tier: 1 }] });
    expect(socketCandidates(character, skill(warrior, 'cleave'), testData).map((s) => s.id)).toEqual([p1, m1]);
    expect(unsocketSupport(character, p2)).toBeNull();
    expect(unsocketSupport(character, 'x')).toBe('no-support');
    expect(socketedSupports(character)).toEqual({ shield_charge: [{ defId: 'melee', tier: 1 }] });
  });

  it('a socketed support cannot be salvaged; an unsocketed one gives shards by tier', () => {
    const { profile, character } = hero();
    grantSupportDrops(profile, character, [{ defId: 'power', tier: 2 }], testData);
    const id = character.supports[0]!.id;
    socketSupport(character, id, 'cleave', 0, warrior, testData);
    expect(salvageSupport(profile, character, id, testData)).toEqual({ error: 'socketed' });
    unsocketSupport(character, id);
    expect(salvageSupport(profile, character, id, testData)).toEqual({ shards: 4 });
    expect(character.supports).toEqual([]);
    expect(profile.currency.shards).toBe(4);
    expect(salvageSupport(profile, character, id, testData)).toEqual({ error: 'no-support' });
  });

  it('validateSockets returns invalid supports to the tab (lost compatibility, unknown, duplicates, taken slots)', () => {
    const owner = {
      supports: [
        { id: 's1', defId: 'power', tier: 1, socket: { skillId: 'cleave', slot: 0 } },
        { id: 's2', defId: 'power', tier: 2, socket: { skillId: 'cleave', slot: 1 } },
        { id: 's3', defId: 'melee', tier: 1, socket: { skillId: 'cleave', slot: 0 } },
        { id: 's4', defId: 'power', tier: 1, socket: { skillId: 'battle_cry', slot: 0 } },
        { id: 's5', defId: 'gone', tier: 1, socket: { skillId: 'shield_charge', slot: 0 } },
        { id: 's6', defId: 'melee', tier: 1, socket: { skillId: 'volley', slot: 0 } },
        { id: 's7', defId: 'melee', tier: 1, socket: { skillId: 'shield_charge', slot: 5 } },
        { id: 's8', defId: 'melee', tier: 1, socket: { skillId: 'shield_charge', slot: 1 } },
      ],
    };
    expect(validateSockets(owner, warrior, testData)).toEqual(['s2', 's3', 's4', 's5', 's6', 's7']);
    expect(socketedSupports(owner)).toEqual({ cleave: [{ defId: 'power', tier: 1 }], shield_charge: [{ defId: 'melee', tier: 1 }] });
  });
});

describe('support drops', () => {
  it('tiers unlock by area level', () => {
    expect(availableSupportTiers(testData, 1)).toEqual([1]);
    expect(availableSupportTiers(testData, 5)).toEqual([1, 2]);
    expect(availableSupportTiers(testData, 30)).toEqual([1, 2, 3]);
    expect(availableSupportTiers({ ...testData, rules: { ...testData.rules, tierMinLevel: [3] } }, 1)).toEqual([]);
  });

  it('rolls a def by weight and a tier by tier weight (capped by the def), deterministically', () => {
    const rng = createRng(42);
    const rolls = Array.from({ length: 6 }, () => rollSupport(rng, testData, 30));
    expect(rolls).toEqual([
      { defId: 'melee', tier: 1 },
      { defId: 'stun', tier: 1 },
      { defId: 'power', tier: 1 },
      { defId: 'power', tier: 1 },
      { defId: 'stun', tier: 1 },
      { defId: 'power', tier: 2 },
    ]);
    // Zero-weight defs never drop; single-tier defs drop at tier 1 even where tier 3 is available.
    for (const r of rolls) {
      expect(r?.defId).not.toBe('rare');
      if (r?.defId !== 'power') expect(r?.tier).toBe(1);
    }
    // Area level 1: tier 1 only.
    const low = createRng(7);
    for (let i = 0; i < 20; i++) expect(rollSupport(low, testData, 1)?.tier).toBe(1);
  });

  it('a kill drops by rank: one chance draw, then the support', () => {
    const never = { ...testData, rules: { ...testData.rules, dropChance: { normal: 0, elite: 0, boss: 1 } } };
    const rng = createRng(3);
    expect(rollSupportDrop(rng, never, 'normal', 1)).toBeUndefined();
    expect(rng.getState()).toBe(advance(createRng(3)).getState());
    expect(rollSupportDrop(createRng(3), never, 'boss', 1)).toEqual(rollSupport(advance(createRng(3)), never, 1));
  });
});

/** The rng after one draw (a chance roll). */
function advance(rng: ReturnType<typeof createRng>): ReturnType<typeof createRng> {
  rng.next();
  return rng;
}

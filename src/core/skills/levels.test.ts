import { describe, expect, it } from 'vitest';
import { classes } from '../../data/classes';
import { skillLevels } from '../../data/skillLevels';
import type { ActionDef, ClassDef } from '../world/content';
import {
  classSkillProgress,
  grantSkillXp,
  isLevelEffectPending,
  readSkillProgress,
  skillKillXp,
  skillLevelChangeSet,
  skillLevelChangeSets,
  skillLevelInfo,
  skillXpToNext,
  type SkillLevelData,
} from './levels';
import { resolveAction, resolveActions } from './params';

const rules = { maxLevel: 3, xpToNext: [100, 250], killXpMultiplier: 2 };

const data: SkillLevelData = {
  rules,
  skills: {
    zap: {
      perLevel: [{ modifiers: [{ stat: 'damage', kind: 'more', value: 0.2 }] }, { changes: [{ param: 'cooldown', increased: -0.1 }] }],
      effect: { level: 3, grants: { charges: 2 }, buffModifiers: [{ stat: 'attackSpeed', kind: 'increased', value: 0.2 }] },
    },
    later: { perLevel: [{ changes: [{ param: 'range', add: 10 }] }, {}], effect: { level: 3, pending: true } },
  },
};

const skillOf = (classId: string, id: string): ActionDef => {
  const skill = classes[classId]!.skills.find((s) => s.id === id);
  if (!skill) throw new Error(id);
  return skill;
};

const atLevel = (classDef: ClassDef, levels: Record<string, number>): ReturnType<typeof resolveActions> =>
  resolveActions(
    classDef,
    skillLevelChangeSets(classDef, Object.fromEntries(Object.entries(levels).map(([id, level]) => [id, { level, xp: 0 }])), skillLevels),
  );

describe('skill levels: XP', () => {
  it('thresholds come from the table and stop at max level', () => {
    expect(skillXpToNext(1, rules)).toBe(100);
    expect(skillXpToNext(2, rules)).toBe(250);
    expect(skillXpToNext(3, rules)).toBe(Infinity);
    expect(skillKillXp(3, rules)).toBe(6);
  });

  it('grants XP across several levels at once and drops XP at max level', () => {
    const p = { level: 1, xp: 40 };
    expect(grantSkillXp(p, 80, rules)).toBe(1);
    expect(p).toEqual({ level: 2, xp: 20 });
    expect(grantSkillXp(p, 229, rules)).toBe(0);
    expect(p).toEqual({ level: 2, xp: 249 });
    expect(grantSkillXp(p, 500, rules)).toBe(1);
    expect(p).toEqual({ level: 3, xp: 0 });
    expect(grantSkillXp(p, 500, rules)).toBe(0);
    expect(p).toEqual({ level: 3, xp: 0 });
    const fresh = { level: 1, xp: 0 };
    expect(grantSkillXp(fresh, 1000, rules)).toBe(2);
    expect(fresh).toEqual({ level: 3, xp: 0 });
  });

  it('reads stored progress defensively', () => {
    expect(readSkillProgress(undefined, rules)).toEqual({ level: 1, xp: 0 });
    expect(readSkillProgress({ level: 2, xp: 30 }, rules)).toEqual({ level: 2, xp: 30 });
    expect(readSkillProgress({ level: 7, xp: 30 }, rules)).toEqual({ level: 3, xp: 0 });
    expect(readSkillProgress({ level: 0, xp: -5 }, rules)).toEqual({ level: 1, xp: 0 });
    expect(readSkillProgress({ level: '2', xp: Number.NaN }, rules)).toEqual({ level: 1, xp: 0 });
    expect(classSkillProgress(classes.ranger!, { volley: { level: 2, xp: 5 }, cleave: { level: 3, xp: 0 } }, skillLevels.rules)).toEqual({
      volley: { level: 2, xp: 5 },
      explosive_trap: { level: 1, xp: 0 },
      roll: { level: 1, xp: 0 },
    });
  });

  it('display info: level, threshold and pending effect', () => {
    expect(skillLevelInfo('later', { level: 2, xp: 7 }, data)).toEqual({
      skillId: 'later',
      level: 2,
      maxLevel: 3,
      xp: 7,
      xpToNext: 250,
      effectPending: true,
      effectLevel: 3,
    });
    expect(skillLevelInfo('zap', undefined, data)).toMatchObject({ level: 1, xp: 0, xpToNext: 100, effectPending: false, effectLevel: 3 });
    expect(skillLevelInfo('none', { level: 3, xp: 0 }, data)).toMatchObject({ xpToNext: Infinity, effectPending: false, effectLevel: undefined });
  });
});

describe('skill levels: change sets', () => {
  it('per-level bonuses accumulate and the effect joins at its level', () => {
    expect(skillLevelChangeSet('zap', 1, data)).toBeUndefined();
    expect(skillLevelChangeSet('zap', 2, data)).toEqual({ skillIds: ['zap'], modifiers: [{ stat: 'damage', kind: 'more', value: 0.2 }] });
    expect(skillLevelChangeSet('zap', 3, data)).toEqual({
      skillIds: ['zap'],
      grants: { charges: 2 },
      changes: [{ param: 'cooldown', increased: -0.1 }],
      modifiers: [{ stat: 'damage', kind: 'more', value: 0.2 }],
      buffModifiers: [{ stat: 'attackSpeed', kind: 'increased', value: 0.2 }],
    });
    expect(skillLevelChangeSet('unknown', 3, data)).toBeUndefined();
  });

  it('a pending effect adds nothing, but the per-level bonuses still apply', () => {
    expect(isLevelEffectPending(data, 'later')).toBe(true);
    expect(isLevelEffectPending(data, 'zap')).toBe(false);
    expect(isLevelEffectPending(data, 'unknown')).toBe(false);
    expect(skillLevelChangeSet('later', 3, data)).toEqual({ skillIds: ['later'], changes: [{ param: 'range', add: 10 }] });
  });

  it('data: every class skill has a live level-3 effect (none pending)', () => {
    const skills = Object.values(classes).flatMap((c) => c.skills);
    expect(skills.filter((s) => isLevelEffectPending(skillLevels, s.id))).toEqual([]);
    for (const s of skills) expect(skillLevels.skills[s.id]?.effect).toBeDefined();
  });

  it('every bonus field of a level reaches its change set', () => {
    const full: SkillLevelData = {
      rules,
      skills: {
        all: {
          perLevel: [
            {
              grants: { charges: 2 },
              changes: [{ param: 'radius', add: 1 }],
              modifiers: [{ stat: 'damage', kind: 'more', value: 0.1 }],
              buffModifiers: [{ stat: 'armour', kind: 'flat', value: 1 }],
              addSelfEffects: [{ kind: 'invulnerable', duration: 0.1 }],
              addOnHit: [{ status: 'slow', duration: 1, magnitude: 0.1 }],
              statusDurations: [{ status: 'slow', add: 1 }],
            },
            {},
          ],
        },
      },
    };
    expect(skillLevelChangeSet('all', 2, full)).toEqual({ skillIds: ['all'], ...full.skills.all!.perLevel[0] });
  });

  it('level 1 leaves the class actions untouched', () => {
    const warrior = classes.warrior!;
    const resolved = atLevel(warrior, { cleave: 1, shield_charge: 1, battle_cry: 1 });
    expect(resolved.skills).toEqual(warrior.skills);
    expect(resolved.basicAttack).toBe(warrior.basicAttack);
  });

  it('damaging skills get +20% more damage per level as their own modifiers', () => {
    const fireball = atLevel(classes.mage!, { fireball: 3 }).skills[0]!;
    expect(fireball.modifiers).toEqual([
      { stat: 'damage', kind: 'more', value: 0.2 },
      { stat: 'damage', kind: 'more', value: 0.2 },
    ]);
    expect(fireball.delivery).toEqual({ ...skillOf('mage', 'fireball').delivery, split: skillLevels.skills.fireball!.effect!.grants!.projectileSplit });
    expect(atLevel(classes.mage!, { fireball: 2 }).skills[0]!.delivery).toEqual(skillOf('mage', 'fireball').delivery);
  });

  it('Cleave level 3: every 3rd swing is a 360° circle', () => {
    expect(atLevel(classes.warrior!, { cleave: 2 }).skills[0]!.delivery).toEqual({ kind: 'arc', radius: 95, angleDeg: 150 });
    expect(atLevel(classes.warrior!, { cleave: 3 }).skills[0]!.delivery).toEqual({ kind: 'arc', radius: 95, angleDeg: 150, everyNth: { every: 3, angleDeg: 360 } });
  });

  it('Shield Charge level 3: a landing hit (radius follows radius changes)', () => {
    const charge = skillOf('warrior', 'shield_charge');
    const levelSet = skillLevelChangeSet('shield_charge', 3, skillLevels)!;
    expect(resolveAction(charge, [levelSet]).delivery).toEqual({ kind: 'dash', distance: 230, speed: 950, hitRadius: 30, landing: { radius: 90, effectiveness: 0.6 } });
    const bigger = { changes: [{ param: 'radius' as const, increased: 0.5 }] };
    expect(resolveAction(charge, [bigger, levelSet]).delivery).toMatchObject({ hitRadius: 30, landing: { radius: 135, effectiveness: 0.6 } });
  });

  it('Explosive Trap and Frost Nova level 3: ground zones', () => {
    expect(atLevel(classes.ranger!, { explosive_trap: 3 }).skills[1]!.zone).toEqual({
      id: 'fire_puddle',
      duration: 3,
      radius: 70,
      tick: { interval: 0.5, damage: { fire: { min: 4, max: 6 } } },
    });
    expect(atLevel(classes.ranger!, { explosive_trap: 2 }).skills[1]!.zone).toBeUndefined();
    expect(atLevel(classes.mage!, { frost_nova: 3 }).skills[1]!.zone).toEqual({ id: 'ice_field', duration: 3, radius: 150, slow: 0.3 });
  });

  it('Battle Cry: +10% damage on the buff per level, level 3 adds attack speed', () => {
    const buffOf = (level: number): unknown => atLevel(classes.warrior!, { battle_cry: level }).skills[2]!.selfEffects;
    expect(buffOf(2)).toEqual([
      {
        kind: 'buff',
        id: 'battle_cry',
        duration: 6,
        modifiers: [
          { stat: 'damage', kind: 'increased', value: 0.4 },
          { stat: 'damage', kind: 'increased', value: 0.1 },
        ],
      },
    ]);
    expect(buffOf(3)).toEqual([
      {
        kind: 'buff',
        id: 'battle_cry',
        duration: 6,
        modifiers: [
          { stat: 'damage', kind: 'increased', value: 0.4 },
          { stat: 'damage', kind: 'increased', value: 0.1 },
          { stat: 'damage', kind: 'increased', value: 0.1 },
          { stat: 'attackSpeed', kind: 'increased', value: 0.2 },
        ],
      },
    ]);
  });

  it('Volley: level 3 bolts pierce 1 enemy, adding up with other pierce sources', () => {
    const volley = skillOf('ranger', 'volley');
    const levelSet = skillLevelChangeSet('volley', 3, skillLevels)!;
    expect(resolveAction(volley, [skillLevelChangeSet('volley', 2, skillLevels)!]).delivery).toMatchObject({ pierce: 0 });
    expect(resolveAction(volley, [levelSet]).delivery).toMatchObject({ pierce: 1, count: 5 });
    // A passive / support "+1 pierce on projectiles" comes first in the list; the sum is 2.
    const pierceSource = { tags: ['projectile' as const], changes: [{ param: 'pierce' as const, add: 1 }] };
    expect(resolveAction(volley, [pierceSource, levelSet]).delivery).toMatchObject({ pierce: 2 });
  });

  it('Teleport: −10% cooldown and +10% range per level, level 3 gives 2 charges', () => {
    const teleport = (level: number): ActionDef => atLevel(classes.mage!, { teleport: level }).skills[2]!;
    expect(teleport(1)).toBe(skillOf('mage', 'teleport'));
    const range = (a: ActionDef): number => (a.delivery.kind === 'teleport' ? a.delivery.range : NaN);
    expect(teleport(2).cooldown).toBeCloseTo(3.6, 10);
    expect(range(teleport(2))).toBeCloseTo(385, 10);
    expect(teleport(2).charges).toBeUndefined();
    expect(teleport(3).cooldown).toBeCloseTo(3.2, 10);
    expect(range(teleport(3))).toBeCloseTo(420, 10);
    expect(teleport(3).charges).toBe(2);
  });

  it('Roll: cooldown and haste grow per level; level 3 leaves a decoy', () => {
    const roll = atLevel(classes.ranger!, { roll: 3 }).skills[2]!;
    expect(roll.cooldown).toBeCloseTo(2.4, 10);
    expect(roll.selfEffects).toEqual([
      { kind: 'invulnerable', duration: 0.25 },
      {
        kind: 'buff',
        id: 'roll_haste',
        duration: 2,
        modifiers: [
          { stat: 'movementSpeed', kind: 'increased', value: 0.3 },
          { stat: 'movementSpeed', kind: 'increased', value: 0.1 },
          { stat: 'movementSpeed', kind: 'increased', value: 0.1 },
        ],
      },
      { kind: 'decoy', id: 'roll_decoy', duration: 2, tauntRadius: 300, bossTauntDuration: 1 },
    ]);
    expect(atLevel(classes.ranger!, { roll: 2 }).skills[2]!.selfEffects).toHaveLength(2);
  });

  it('change sets are plain JSON', () => {
    const sets = skillLevelChangeSets(classes.mage!, { fireball: { level: 2, xp: 0 }, teleport: { level: 3, xp: 0 } }, skillLevels);
    expect(JSON.parse(JSON.stringify(sets))).toEqual(sets);
    expect(sets.map((s) => s.skillIds)).toEqual([['fireball'], ['teleport']]);
  });
});

import { describe, expect, it } from 'vitest';
import type { ActionDef, ClassDef } from '../world/content';
import { resolveAction, resolveActions, skillMatches } from './params';
import type { SkillChangeSet } from './types';

const nova: ActionDef = {
  id: 'nova',
  tags: ['spell', 'area'],
  manaCost: 10,
  cooldown: 3,
  castTime: 0.4,
  damage: { source: 'skill', base: { cold: { min: 10, max: 10 } }, critChance: 0 },
  delivery: { kind: 'arc', radius: 150, angleDeg: 360 },
  onHit: [{ status: 'slow', duration: 2.5, magnitude: 0.4 }],
};
const bolt: ActionDef = {
  id: 'bolt',
  tags: ['attack', 'projectile'],
  manaCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 750, range: 620, radius: 6, pierce: 0 },
};
const fireball: ActionDef = {
  id: 'fireball',
  tags: ['spell', 'projectile', 'area'],
  manaCost: 9,
  cooldown: 0,
  delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 520, range: 600, radius: 9, pierce: 0, explodeRadius: 80 },
};
const trap: ActionDef = {
  id: 'trap',
  tags: ['area'],
  manaCost: 12,
  cooldown: 5,
  delivery: { kind: 'trap', throwRange: 300, armTime: 0.5, triggerRadius: 40, explodeRadius: 110, lifetime: 8 },
};
const cry: ActionDef = {
  id: 'cry',
  tags: [],
  manaCost: 15,
  cooldown: 12,
  delivery: { kind: 'self' },
  selfEffects: [
    { kind: 'invulnerable', duration: 0.5 },
    { kind: 'buff', id: 'cry', duration: 6, modifiers: [{ stat: 'damage', kind: 'increased', value: 0.4 }] },
  ],
};
const blink: ActionDef = { id: 'blink', tags: ['spell'], manaCost: 0, cooldown: 4, delivery: { kind: 'teleport', range: 350 } };
const charge: ActionDef = {
  id: 'charge',
  tags: ['attack', 'melee'],
  manaCost: 10,
  cooldown: 4,
  delivery: { kind: 'dash', distance: 230, speed: 950, hitRadius: 30 },
  onHit: [{ status: 'stun', duration: 1.2 }],
};

describe('skillMatches', () => {
  it('matches by id, by all tags, by both; an empty matcher matches everything', () => {
    expect(skillMatches(nova, {})).toBe(true);
    expect(skillMatches(nova, { skillIds: ['nova'] })).toBe(true);
    expect(skillMatches(nova, { skillIds: ['bolt'] })).toBe(false);
    expect(skillMatches(fireball, { tags: ['projectile'] })).toBe(true);
    expect(skillMatches(fireball, { tags: ['projectile', 'attack'] })).toBe(false);
    expect(skillMatches(bolt, { tags: ['projectile', 'attack'] })).toBe(true);
    expect(skillMatches(bolt, { skillIds: ['bolt'], tags: ['spell'] })).toBe(false);
  });
});

describe('resolveAction', () => {
  it('returns the base action itself when nothing matches', () => {
    expect(resolveAction(nova, [{ skillIds: ['bolt'], changes: [{ param: 'cooldown', add: -1 }] }])).toBe(nova);
    expect(resolveAction(nova, [])).toBe(nova);
  });

  it('combines like stats: (base + Σadd) × (1 + Σincreased) across all matching sets', () => {
    const sets: SkillChangeSet[] = [
      { skillIds: ['nova'], changes: [{ param: 'radius', increased: 0.2 }, { param: 'cooldown', add: -0.5 }] },
      { tags: ['area'], changes: [{ param: 'radius', add: 10, increased: 0.1 }] },
    ];
    const r = resolveAction(nova, sets);
    expect(r.cooldown).toBe(2.5);
    expect(r.delivery).toEqual({ kind: 'arc', radius: (150 + 10) * 1.3, angleDeg: 360 });
  });

  it('never goes below 0', () => {
    const r = resolveAction(trap, [{ changes: [{ param: 'cooldown', add: -10 }, { param: 'armTime', increased: -2 }] }]);
    expect(r.cooldown).toBe(0);
    expect(r.delivery).toMatchObject({ armTime: 0 });
  });

  it('projectile params: range, speed, pierce (whole targets), explode radius when the skill has one', () => {
    const sets: SkillChangeSet[] = [
      {
        tags: ['projectile'],
        changes: [
          { param: 'range', increased: 0.25 },
          { param: 'projectileSpeed', increased: 0.2 },
          { param: 'pierce', add: 1 },
          { param: 'explodeRadius', increased: 0.2 },
        ],
      },
      { skillIds: ['bolt'], changes: [{ param: 'pierce', increased: 0.9 }] },
    ];
    expect(resolveAction(bolt, sets).delivery).toEqual({ kind: 'projectile', count: 1, spreadDeg: 0, speed: 900, range: 775, radius: 6, pierce: 1 });
    expect(resolveAction(fireball, sets).delivery).toEqual({
      kind: 'projectile',
      count: 1,
      spreadDeg: 0,
      speed: 624,
      range: 750,
      radius: 9,
      pierce: 1,
      explodeRadius: 96,
    });
  });

  it('trap params: arm time, trigger radius, explode radius, throw range', () => {
    const r = resolveAction(trap, [
      {
        changes: [
          { param: 'armTime', add: -0.25 },
          { param: 'triggerRadius', increased: 0.25 },
          { param: 'explodeRadius', increased: 0.25 },
          { param: 'range', add: 50 },
        ],
      },
    ]);
    expect(r.delivery).toEqual({ kind: 'trap', throwRange: 350, armTime: 0.25, triggerRadius: 50, explodeRadius: 137.5, lifetime: 8 });
  });

  it('range changes teleport range; params a delivery does not have are ignored', () => {
    expect(resolveAction(blink, [{ changes: [{ param: 'range', increased: 0.5 }] }]).delivery).toEqual({ kind: 'teleport', range: 525 });
    const r = resolveAction(charge, [{ changes: [{ param: 'pierce', add: 1 }, { param: 'radius', add: 50 }, { param: 'buffDuration', add: 3 }] }]);
    expect(r.delivery).toEqual(charge.delivery);
    expect(r.cooldown).toBe(4);
  });

  it('buffDuration and buffModifiers change buffs only, not invulnerability', () => {
    const attackSpeed = { stat: 'attackSpeed', kind: 'increased', value: 0.2 } as const;
    const r = resolveAction(cry, [{ skillIds: ['cry'], changes: [{ param: 'buffDuration', add: 3 }], buffModifiers: [attackSpeed] }]);
    expect(r.selfEffects).toEqual([
      { kind: 'invulnerable', duration: 0.5 },
      { kind: 'buff', id: 'cry', duration: 9, modifiers: [{ stat: 'damage', kind: 'increased', value: 0.4 }, attackSpeed] },
    ]);
  });

  it('addOnHit appends statuses; statusDuration scales every on-hit status; unknown statuses are skipped', () => {
    const r = resolveAction(bolt, [
      { skillIds: ['bolt'], addOnHit: [{ status: 'slow', duration: 2, magnitude: 0.2 }, { status: 'poison', duration: 1 }] },
    ]);
    expect(r.onHit).toEqual([{ status: 'slow', duration: 2, magnitude: 0.2 }]);
    const n = resolveAction(nova, [{ skillIds: ['nova'], changes: [{ param: 'statusDuration', increased: 0.4 }], addOnHit: [{ status: 'stun', duration: 1, chance: 0.5 }] }]);
    expect(n.onHit).toEqual([
      { status: 'slow', duration: 3.5, magnitude: 0.4 },
      { status: 'stun', duration: 1.4, chance: 0.5 },
    ]);
  });

  it('addOnHit keeps ignite / freeze requirements; duration changes also scale a freeze bossDuration', () => {
    const r = resolveAction(nova, [
      { addOnHit: [{ status: 'ignite', duration: 3, magnitude: 0.5, chance: 0.3, requiresDamageType: 'fire' }] },
      { skillIds: ['nova'], addOnHit: [{ status: 'freeze', duration: 1, bossDuration: 0.3, requiresStatus: 'slow' }] },
      { skillIds: ['nova'], statusDurations: [{ status: 'freeze', increased: 0.5 }] },
    ]);
    expect(r.onHit).toEqual([
      { status: 'slow', duration: 2.5, magnitude: 0.4 },
      { status: 'ignite', duration: 3, magnitude: 0.5, chance: 0.3, requiresDamageType: 'fire' },
      { status: 'freeze', duration: 1.5, bossDuration: 0.3 * 1.5, requiresStatus: 'slow' },
    ]);
  });

  it('statusDurations change one status only and add to statusDuration in one sum', () => {
    const stunAndSlow: ActionDef = { ...charge, onHit: [{ status: 'stun', duration: 1 }, { status: 'slow', duration: 2, magnitude: 0.3 }] };
    const r = resolveAction(stunAndSlow, [
      { statusDurations: [{ status: 'stun', increased: 0.3 }] },
      { skillIds: ['charge'], changes: [{ param: 'statusDuration', increased: 0.5 }] },
      { statusDurations: [{ status: 'stun', add: 1 }] },
    ]);
    expect(r.onHit).toEqual([
      { status: 'stun', duration: (1 + 1) * (1 + 0.5 + 0.3) },
      { status: 'slow', duration: 3, magnitude: 0.3 },
    ]);
  });

  it('does not mutate the base action', () => {
    const before = JSON.stringify([nova, cry, trap]);
    resolveAction(nova, [{ changes: [{ param: 'radius', increased: 1 }, { param: 'statusDuration', add: 1 }] }]);
    resolveAction(cry, [{ changes: [{ param: 'buffDuration', add: 1 }], buffModifiers: [{ stat: 'damage', kind: 'more', value: 1 }] }]);
    resolveAction(trap, [{ changes: [{ param: 'armTime', add: 1 }] }]);
    expect(JSON.stringify([nova, cry, trap])).toBe(before);
  });
});

describe('resolveActions', () => {
  it('resolves the basic attack and every skill in class order', () => {
    const hero: ClassDef = {
      id: 'hero',
      radius: 10,
      weaponType: 'wand',
      baseStats: {},
      weapon: { damage: { physical: { min: 1, max: 1 } }, attacksPerSecond: 1, critChance: 0 },
      basicAttack: bolt,
      skills: [fireball, nova, blink],
    };
    const set = resolveActions(hero, [{ tags: ['projectile'], changes: [{ param: 'pierce', add: 2 }] }]);
    expect(set.basicAttack.delivery).toMatchObject({ pierce: 2 });
    expect(set.skills.map((s) => s.id)).toEqual(['fireball', 'nova', 'blink']);
    expect(set.skills[0]!.delivery).toMatchObject({ pierce: 2 });
    expect(set.skills[1]).toBe(nova);
    expect(set.skills[2]).toBe(blink);
  });
});

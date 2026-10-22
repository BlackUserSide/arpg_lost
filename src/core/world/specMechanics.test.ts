// Spec-branch mechanics in the running world: skillParams (effective skills), moreDamagePerMissingLife, stunBonus.
import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import type { Modifier } from '../stats/types';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { createWorld, setLoadoutModifiers, step, type Loadout, type MobState, type PlayerInput, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 1000,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};

const bolt: ActionDef = {
  id: 'bolt',
  tags: ['attack', 'projectile'],
  manaCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 400, radius: 2, pierce: 0 },
};
const nova: ActionDef = {
  id: 'nova',
  tags: ['spell', 'area'],
  manaCost: 0,
  cooldown: 3,
  castTime: 0.4,
  damage: { source: 'skill', base: { cold: { min: 10, max: 10 } }, critChance: 0 },
  delivery: { kind: 'arc', radius: 100, angleDeg: 360 },
  onHit: [{ status: 'slow', duration: 2.5, magnitude: 0.4 }],
};
const charge: ActionDef = {
  id: 'charge',
  tags: ['attack', 'melee'],
  manaCost: 0,
  cooldown: 4,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'dash', distance: 200, speed: 1000, hitRadius: 20 },
  onHit: [{ status: 'stun', duration: 1.2 }],
};
const cry: ActionDef = {
  id: 'cry',
  tags: [],
  manaCost: 8,
  cooldown: 12,
  castTime: 0,
  delivery: { kind: 'self' },
  selfEffects: [{ kind: 'buff', id: 'cry', duration: 6, modifiers: [{ stat: 'damage', kind: 'increased', value: 0.4 }] }],
};
const mine: ActionDef = {
  id: 'mine',
  tags: ['area'],
  manaCost: 0,
  cooldown: 5,
  castTime: 0,
  damage: { source: 'skill', base: { fire: { min: 20, max: 20 } }, critChance: 0 },
  delivery: { kind: 'trap', throwRange: 300, armTime: 0.5, triggerRadius: 40, explodeRadius: 110, lifetime: 8 },
};
const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  manaCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};

/** Slots: 0 nova, 1 charge, 2 cry, 3 mine. */
function makeContent(basicAttack: ActionDef = bolt): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'wand',
    baseStats: { life: 50, mana: 50, manaRegen: 0, movementSpeed: 100 },
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack,
    skills: [nova, charge, cry, mine],
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9 },
    classes: { hero },
    mobs: { dummy },
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
    progression: {
      maxLevel: 5,
      xpCurve: { base: 15, exponent: 1 },
      mobXpGrowth: 0,
      lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
      mapClearBonus: 0.1,
      perLevel: { life: 10 },
    },
  };
}

function setup(mechanics: readonly PassiveMechanic[], loadout: Loadout = {}, basicAttack?: ActionDef): { content: Content; world: WorldState } {
  const content = makeContent(basicAttack);
  return { content, world: createWorld(content, 'hero', 1, { ...loadout, mechanics }) };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };
const skill = (slot: number): PlayerInput => ({ ...idle, skills: [0, 1, 2, 3].map((i) => i === slot) });

function addMob(world: WorldState, x: number, y: number, life = 1000): MobState {
  const mob: MobState = { id: world.nextId++, defId: 'dummy', pos: vec(x, y), facing: vec(0, 1), life, attackTimer: 10, stun: 0, slow: 0, slowMagnitude: 0 };
  world.mobs.push(mob);
  return mob;
}

function run(world: WorldState, content: Content, input: PlayerInput, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) step(world, input, content, DT);
}

/** Spec node data as in src/data/passives.ts. */
const SHIELD_READY: PassiveMechanic = { kind: 'skillParams', skillIds: ['charge'], changes: [{ param: 'cooldown', add: -1 }] };
const BLOODY_CRY: PassiveMechanic = {
  kind: 'skillParams',
  skillIds: ['cry'],
  changes: [{ param: 'buffDuration', add: 3 }],
  buffModifiers: [{ stat: 'attackSpeed', kind: 'increased', value: 0.2 }],
};
const PIERCING: PassiveMechanic = { kind: 'skillParams', tags: ['projectile'], changes: [{ param: 'pierce', add: 1 }] };
const LONG_RANGE: PassiveMechanic = {
  kind: 'skillParams',
  tags: ['projectile'],
  changes: [
    { param: 'range', increased: 0.25 },
    { param: 'projectileSpeed', increased: 0.2 },
  ],
};
const QUICK_TRAP: PassiveMechanic = {
  kind: 'skillParams',
  skillIds: ['mine'],
  changes: [
    { param: 'armTime', add: -0.25 },
    { param: 'triggerRadius', increased: 0.25 },
  ],
};
const SHRAPNEL: PassiveMechanic = { kind: 'skillParams', skillIds: ['mine'], changes: [{ param: 'explodeRadius', increased: 0.25 }] };
const BLIZZARD: PassiveMechanic = {
  kind: 'skillParams',
  skillIds: ['nova'],
  changes: [
    { param: 'radius', increased: 0.2 },
    { param: 'cooldown', add: -0.5 },
  ],
};
const ICY_GRIP_SLOW: PassiveMechanic = { kind: 'skillParams', skillIds: ['nova'], changes: [{ param: 'statusDuration', increased: 0.4 }] };
const COLD_BLOOD: PassiveMechanic = { kind: 'skillParams', skillIds: ['bolt'], addOnHit: [{ status: 'slow', duration: 2, magnitude: 0.2 }] };
const HEAVY_HAND: PassiveMechanic = { kind: 'stunBonus', fillIncreased: 0.3, durationIncreased: 0.3 };
const FURY: PassiveMechanic = { kind: 'moreDamagePerMissingLife', perMissingLife: 0.6, max: 0.45 };
const BLOOD: PassiveMechanic = { kind: 'bloodMagic', lifePerMana: 1 };
const CRYSTAL: PassiveMechanic = { kind: 'lifeToEnergyShield', maxLife: 1, lifeRegenToShield: true };
/** Fast attacks so tests are not gated by the action timer. */
const FAST: Modifier = { stat: 'attackSpeed', kind: 'increased', value: 9 };

describe('skillParams: effective skills in the world', () => {
  it('without skill changes the actions are the class data', () => {
    const { content, world: w } = setup([FURY]);
    const hero = content.classes.hero!;
    expect(w.player.actions.basicAttack).toBe(hero.basicAttack);
    expect(w.player.actions.skills).toEqual(hero.skills);
    expect(w.player.actions.skills[0]).toBe(nova);
  });

  it('cooldown: Shield Ready 4 → 3 s; Blizzard nova 3 → 2.5 s and radius 100 → 120', () => {
    const { content, world: w } = setup([SHIELD_READY, BLIZZARD]);
    step(w, skill(1), content, DT);
    expect(w.player.cooldowns.charge).toBe(3);
    run(w, content, idle, 0.5);
    const near = addMob(w, 615, 500); // 115 away: inside 120 + 10, outside 100 + 10
    const events = step(w, skill(0), content, DT);
    expect(w.player.cooldowns.nova).toBe(2.5);
    expect(events).toContainEqual(expect.objectContaining({ type: 'area', actionId: 'nova', radius: 120 }));
    expect(near.life).toBe(990);
  });

  it('the base nova radius misses a mob 115 away', () => {
    const { content, world: w } = setup([]);
    const far = addMob(w, 615, 500);
    step(w, skill(0), content, DT);
    expect(far.life).toBe(1000);
  });

  it('Bloody Cry: buff lasts 9 s instead of 6 and also grants +20% attack speed', () => {
    const { content, world: w } = setup([BLOODY_CRY]);
    step(w, skill(2), content, DT);
    expect(w.player.buffs).toEqual([
      {
        id: 'cry',
        remaining: 9,
        modifiers: [
          { stat: 'damage', kind: 'increased', value: 0.4 },
          { stat: 'attackSpeed', kind: 'increased', value: 0.2 },
        ],
      },
    ]);
    run(w, content, idle, 8.9);
    expect(w.player.buffs).toHaveLength(1);
    run(w, content, idle, 0.2);
    expect(w.player.buffs).toHaveLength(0);
  });

  it('pierce: a bolt passes through the first mob and hits the second', () => {
    const plain = setup([]);
    const a1 = addMob(plain.world, 600, 500);
    const b1 = addMob(plain.world, 650, 500);
    step(plain.world, attack, plain.content, DT);
    run(plain.world, plain.content, idle, 0.5);
    expect([a1.life, b1.life]).toEqual([990, 1000]);

    const pierced = setup([PIERCING]);
    const a2 = addMob(pierced.world, 600, 500);
    const b2 = addMob(pierced.world, 650, 500);
    step(pierced.world, attack, pierced.content, DT);
    expect(pierced.world.projectiles[0]?.pierceLeft).toBe(1);
    run(pierced.world, pierced.content, idle, 0.5);
    expect([a2.life, b2.life]).toEqual([990, 990]);
  });

  it('range and projectile speed: +25% / +20% on the projectile, so a mob 450 away is reached', () => {
    const { content, world: w } = setup([LONG_RANGE]);
    const mob = addMob(w, 960, 500);
    step(w, attack, content, DT);
    const p = w.projectiles[0]!;
    expect(p.speed).toBe(720);
    expect(p.remaining).toBeCloseTo(500 - 720 * DT, 9);
    run(w, content, idle, 1);
    expect(mob.life).toBe(990);

    const base = setup([]);
    const missed = addMob(base.world, 960, 500);
    step(base.world, attack, base.content, DT);
    run(base.world, base.content, idle, 1);
    expect(missed.life).toBe(1000);
  });

  it('trap: arm 0.5 → 0.25 s, trigger 40 → 50, explosion 110 → 137.5', () => {
    const { content, world: w } = setup([QUICK_TRAP, SHRAPNEL]);
    step(w, { ...skill(3), aim: vec(700, 500) }, content, DT);
    expect(w.traps).toHaveLength(1);
    expect(w.traps[0]).toMatchObject({ triggerRadius: 50, explodeRadius: 137.5 });
    expect(w.traps[0]?.armTimer).toBeCloseTo(0.25 - DT, 9); // the trap update ran once this tick
    // A mob 55 from the trap (inside 50 + 10) triggers it after arming; one 135 from the trap is caught by 137.5.
    const trigger = addMob(w, 755, 500);
    const edge = addMob(w, 700, 635);
    run(w, content, idle, 0.2);
    expect(w.traps).toHaveLength(1);
    run(w, content, idle, 0.1);
    expect(w.traps).toHaveLength(0);
    expect([trigger.life, edge.life]).toEqual([980, 980]);
  });

  it('Cold Blood: the basic attack slows 20% for 2 s', () => {
    const { content, world: w } = setup([COLD_BLOOD]);
    const mob = addMob(w, 560, 500);
    step(w, attack, content, DT);
    run(w, content, idle, 0.1);
    expect(mob.life).toBe(990);
    expect(mob.slowMagnitude).toBe(0.2);
    // Applied on the hit tick, then ticks down with the mob update of every step.
    expect(mob.slow).toBeGreaterThan(1.85);
    expect(mob.slow).toBeLessThan(2);
  });

  it("Icy Grip's slow extension: nova slow 2.5 → 3.5 s", () => {
    const { content, world: w } = setup([ICY_GRIP_SLOW]);
    const mob = addMob(w, 550, 500);
    step(w, skill(0), content, DT);
    expect(mob.slow).toBeCloseTo(3.5 - DT, 9);
    expect(mob.slowMagnitude).toBe(0.4);
  });

  it('mid-run swap: actions follow the mechanics; a running cooldown keeps its time, the next use gets the new one', () => {
    const { content, world: w } = setup([]);
    step(w, skill(1), content, DT);
    expect(w.player.cooldowns.charge).toBe(4);
    setLoadoutModifiers(w, content, [], [SHIELD_READY]);
    expect(w.player.actions.skills[1]?.cooldown).toBe(3);
    expect(w.player.cooldowns.charge).toBe(4);
    run(w, content, idle, 4);
    step(w, skill(1), content, DT);
    expect(w.player.cooldowns.charge).toBe(3);
    // Removing the node restores the class data; omitting mechanics keeps the actions.
    setLoadoutModifiers(w, content, [FAST]);
    expect(w.player.actions.skills[1]?.cooldown).toBe(3);
    setLoadoutModifiers(w, content, [], []);
    expect(w.player.actions.skills[1]).toBe(charge);
  });

  it('mid-run swap: a thrown trap and a flying bolt keep the params they were created with', () => {
    const { content, world: w } = setup([QUICK_TRAP, SHRAPNEL, PIERCING]);
    step(w, { ...skill(3), aim: vec(700, 500) }, content, DT);
    run(w, content, idle, 0.5);
    step(w, { ...attack, aim: vec(500, 1000) }, content, DT);
    setLoadoutModifiers(w, content, [], []);
    expect(w.traps[0]).toMatchObject({ triggerRadius: 50, explodeRadius: 137.5 });
    expect(w.projectiles[0]?.pierceLeft).toBe(1);
    // A new trap uses the base params.
    run(w, content, idle, 5);
    step(w, { ...skill(3), aim: vec(300, 500) }, content, DT);
    expect(w.traps[1]).toMatchObject({ triggerRadius: 40, explodeRadius: 110 });
    expect(w.traps[1]?.armTimer).toBeCloseTo(0.5 - DT, 9);
  });

  it('mid-run swap: a bolt fired with an added slow still slows after the node is removed mid-flight', () => {
    const { content, world: w } = setup([COLD_BLOOD]);
    const mob = addMob(w, 800, 500);
    step(w, attack, content, DT);
    expect(w.projectiles[0]?.action?.onHit).toEqual([{ status: 'slow', duration: 2, magnitude: 0.2 }]);
    setLoadoutModifiers(w, content, [], []);
    expect(w.player.actions.basicAttack.onHit).toBeUndefined();
    run(w, content, idle, 0.6);
    expect(mob.life).toBe(990);
    expect(mob.slowMagnitude).toBe(0.2);
    expect(mob.slow).toBeGreaterThan(1.8); // 2 s from the hit, ~0.1 s ago
  });

  it('mid-run swap: a bolt fired without the slow does not slow when the node is taken mid-flight; the next one does', () => {
    const { content, world: w } = setup([]);
    const mob = addMob(w, 800, 500);
    step(w, attack, content, DT);
    setLoadoutModifiers(w, content, [], [COLD_BLOOD]);
    run(w, content, idle, 0.6);
    expect(mob.life).toBe(990);
    expect(mob.slow).toBe(0);
    step(w, attack, content, DT);
    run(w, content, idle, 0.6);
    expect(mob.life).toBe(980);
    expect(mob.slowMagnitude).toBe(0.2);
  });

  it('mid-run swap: a running dash keeps the stun bonus it started with', () => {
    const { content, world: w } = setup([HEAVY_HAND]);
    const mob = addMob(w, 650, 500);
    step(w, skill(1), content, DT);
    expect(w.player.motion?.action.onHit).toEqual([{ status: 'stun', duration: 1.56 }]);
    setLoadoutModifiers(w, content, [], []);
    let max = 0;
    for (let i = 0; i < 30; i++) {
      step(w, idle, content, DT);
      max = Math.max(max, mob.stun);
    }
    expect(max).toBeCloseTo(1.56 - DT, 9);
  });
});

describe('stunBonus: increased duration of every stun the hero applies', () => {
  const maxStun = (mechanics: readonly PassiveMechanic[]): number => {
    const { content, world: w } = setup(mechanics);
    const mob = addMob(w, 600, 500);
    let max = 0;
    step(w, skill(1), content, DT);
    for (let i = 0; i < 30; i++) {
      step(w, idle, content, DT);
      max = Math.max(max, mob.stun);
    }
    return max;
  };

  it('charge stun 1.2 → 1.56 s with +30%', () => {
    expect(maxStun([])).toBeCloseTo(1.2 - DT, 9);
    expect(maxStun([HEAVY_HAND])).toBeCloseTo(1.56 - DT, 9);
  });

  it('adds to a skill statusDuration change like increased (designer decision): 1.2 × (1 + 0.5 + 0.3)', () => {
    const longer: PassiveMechanic = { kind: 'skillParams', skillIds: ['charge'], changes: [{ param: 'statusDuration', increased: 0.5 }] };
    expect(maxStun([HEAVY_HAND, longer])).toBeCloseTo(1.2 * (1 + 0.5 + 0.3) - DT, 9);
  });

  it('does not touch slows', () => {
    const { content, world: w } = setup([HEAVY_HAND]);
    const mob = addMob(w, 550, 500);
    step(w, skill(0), content, DT);
    expect(mob.slow).toBeCloseTo(2.5 - DT, 9);
  });
});

describe('moreDamagePerMissingLife (Berserker Fury)', () => {
  /** Damage of one basic strike at the given life (max life 50). */
  const strikeAt = (life: number, mechanics: readonly PassiveMechanic[] = [FURY]): number => {
    const { content, world: w } = setup(mechanics, { modifiers: [FAST] }, strike);
    const mob = addMob(w, 530, 500);
    w.player.life = life;
    step(w, attack, content, DT);
    return 1000 - mob.life;
  };

  it('0.6% more per 1% missing: full 0%, 50% life +30%, 25% life +45%, capped below', () => {
    expect(strikeAt(50)).toBe(10);
    expect(strikeAt(25)).toBeCloseTo(13, 9);
    expect(strikeAt(12.5)).toBeCloseTo(14.5, 9);
    expect(strikeAt(5)).toBeCloseTo(14.5, 9);
    expect(strikeAt(40)).toBeCloseTo(10 * 1.12, 9);
  });

  it('without the mechanic missing life changes nothing', () => {
    expect(strikeAt(5, [])).toBe(10);
  });

  /** Damage of one strike with the given pools. */
  const strikeWith = (mechanics: readonly PassiveMechanic[], gear: readonly Modifier[], life: number, es: number): number => {
    const { content, world: w } = setup(mechanics, { modifiers: [FAST, ...gear] }, strike);
    const mob = addMob(w, 530, 500);
    w.player.life = life;
    w.player.energyShield = es;
    step(w, attack, content, DT);
    return 1000 - mob.life;
  };

  it('life and ES count as one pool: 1 − (life + ES) / (maxLife + maxES)', () => {
    const es50: Modifier[] = [{ stat: 'energyShield', kind: 'flat', value: 50 }];
    expect(strikeWith([FURY], es50, 50, 50)).toBe(10);
    // 50 of 100 missing → +30%, however it splits between life and ES.
    expect(strikeWith([FURY], es50, 50, 0)).toBeCloseTo(13, 9);
    expect(strikeWith([FURY], es50, 25, 25)).toBeCloseTo(13, 9);
    // 20 of 100 missing → +12%.
    expect(strikeWith([FURY], es50, 40, 40)).toBeCloseTo(11.2, 9);
  });

  it('Crystal Shell: works off ES (life fixed at 1, base life 50 becomes ES: pool 51)', () => {
    expect(strikeWith([FURY, CRYSTAL], [], 1, 50)).toBe(10);
    // (1 + 24.5) / 51 = 50% left → +30%.
    expect(strikeWith([FURY, CRYSTAL], [], 1, 24.5)).toBeCloseTo(13, 9);
    // ES drained: 50 / 51 missing → capped at +45%.
    expect(strikeWith([FURY, CRYSTAL], [], 1, 0)).toBeCloseTo(14.5, 9);
  });

  it('Blood Magic: paying a skill with life raises the bonus for that very hit', () => {
    const { content, world: w } = setup([FURY, BLOOD], { modifiers: [FAST] }, strike);
    const mob = addMob(w, 530, 500);
    // Cry costs 8 life: 42 / 50 left, 16% missing → 9.6% more. Cry itself deals no damage.
    step(w, skill(2), content, DT);
    expect(w.player.life).toBe(42);
    run(w, content, idle, 0.1);
    step(w, attack, content, DT);
    // Cry buff +40% increased damage too.
    expect(1000 - mob.life).toBeCloseTo(10 * 1.4 * 1.096, 9);
  });

  it('delayed hits lock the bonus at cast time', () => {
    const { content, world: w } = setup([FURY]);
    const mob = addMob(w, 700, 500);
    w.player.life = 25;
    step(w, attack, content, DT);
    expect(w.projectiles[0]?.castModifiers).toEqual([{ stat: 'damage', kind: 'more', value: 0.3 }]);
    w.player.life = 50;
    run(w, content, idle, 0.5);
    expect(1000 - mob.life).toBeCloseTo(13, 9);
  });
});

describe('spec mechanics: determinism', () => {
  it('runs with skill changes, Fury and stun bonus stay deterministic and JSON-serializable', () => {
    const play = (): WorldState => {
      const { content, world: w } = setup([FURY, HEAVY_HAND, SHIELD_READY, BLOODY_CRY, PIERCING, QUICK_TRAP, ICY_GRIP_SLOW, COLD_BLOOD], { modifiers: [FAST] });
      addMob(w, 560, 500);
      addMob(w, 620, 520);
      for (let i = 0; i < 400; i++) {
        if (i === 200) setLoadoutModifiers(w, content, [FAST], [FURY, BLIZZARD, SHRAPNEL]);
        step(w, { ...idle, move: vec(i % 40 < 20 ? 1 : -1, 0), basicAttack: true, skills: [i % 50 === 0, i % 70 === 0, i % 90 === 0, i % 110 === 0] }, content, DT);
      }
      return w;
    };
    const a = play();
    expect(a).toEqual(play());
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

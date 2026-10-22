import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import type { Modifier } from '../stats/types';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import {
  activeConditionalModifiers,
  actionCost,
  baseLife,
  canPay,
  conditionHolds,
  critStats,
  deriveStat,
  leechStats,
  lifePotionMultiplier,
  lifeRecoveryPool,
  type ConditionState,
} from './passiveEffects';
import { applyDamageTaken } from '../combat/damage';
import {
  canAfford,
  createWorld,
  playerStat,
  recoverLife,
  recoverMana,
  setLoadoutModifiers,
  step,
  type Loadout,
  type MobState,
  type PlayerInput,
  type WorldEvent,
  type WorldState,
} from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 100,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  manaCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};
const sweep: ActionDef = {
  id: 'sweep',
  tags: ['attack', 'melee', 'area'],
  manaCost: 8,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 180 },
};
const blink: ActionDef = { id: 'blink', tags: ['spell'], manaCost: 0, cooldown: 0, castTime: 0.1, delivery: { kind: 'teleport', range: 300 } };
const charge: ActionDef = {
  id: 'charge',
  tags: ['attack', 'melee'],
  manaCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'dash', distance: 200, speed: 1000, hitRadius: 20 },
};

function makeContent(baseStats: ClassDef['baseStats'] = {}): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'sword',
    baseStats: { life: 50, mana: 20, manaRegen: 0, movementSpeed: 100, ...baseStats },
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack: strike,
    skills: [sweep, blink, charge],
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5 },
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

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };

function addMob(world: WorldState, x: number, y: number, life = 1000): MobState {
  const mob: MobState = { id: world.nextId++, defId: 'dummy', pos: vec(x, y), facing: vec(0, 1), life, maxLife: life, attackTimer: 10, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0 };
  world.mobs.push(mob);
  return mob;
}

function run(world: WorldState, content: Content, input: PlayerInput, seconds: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) events.push(...step(world, input, content, DT));
  return events;
}

/** Damage the mob took from one step with `input`. */
function hitOnce(world: WorldState, content: Content, mob: MobState, input: PlayerInput = attack): number {
  const before = mob.life;
  step(world, input, content, DT);
  return before - mob.life;
}

const BLOOD: PassiveMechanic = { kind: 'bloodMagic', lifePerMana: 1 };
const PRECISE: PassiveMechanic = { kind: 'alwaysCrit', critMultiplier: 1.3 };
const CRYSTAL: PassiveMechanic = { kind: 'lifeToEnergyShield', maxLife: 1, lifeRegenToShield: true };
const SWIFT: PassiveMechanic[] = [
  { kind: 'conditionalModifiers', condition: { kind: 'movedWithin', seconds: 0.5 }, modifiers: [{ stat: 'damage', kind: 'more', value: 0.3 }] },
  { kind: 'conditionalModifiers', condition: { kind: 'stationaryFor', seconds: 0.5 }, modifiers: [{ stat: 'damage', kind: 'more', value: -0.3 }] },
];
/** Fast attacks so tests are not gated by the action timer (2 aps × 10 = 20 aps). */
const FAST: Modifier = { stat: 'attackSpeed', kind: 'increased', value: 9 };

function world(mechanics: readonly PassiveMechanic[], loadout: Loadout = {}, baseStats: ClassDef['baseStats'] = {}): { content: Content; world: WorldState } {
  const content = makeContent(baseStats);
  return { content, world: createWorld(content, 'hero', 1, { ...loadout, mechanics }) };
}

describe('passiveEffects: pure rules', () => {
  it('action cost goes to life under blood magic, scaled by lifePerMana', () => {
    expect(actionCost([], 8)).toEqual({ pool: 'mana', amount: 8 });
    expect(actionCost([BLOOD], 8)).toEqual({ pool: 'life', amount: 8 });
    expect(actionCost([{ kind: 'bloodMagic', lifePerMana: 2 }], 8)).toEqual({ pool: 'life', amount: 16 });
  });

  it('mana costs need enough mana, life costs need strictly more life', () => {
    expect(canPay({ life: 0, mana: 8 }, { pool: 'mana', amount: 8 })).toBe(true);
    expect(canPay({ life: 0, mana: 7 }, { pool: 'mana', amount: 8 })).toBe(false);
    expect(canPay({ life: 8, mana: 0 }, { pool: 'life', amount: 8 })).toBe(false);
    expect(canPay({ life: 8.5, mana: 0 }, { pool: 'life', amount: 8 })).toBe(true);
  });

  it('alwaysCrit forces chance 1 and the fixed multiplier', () => {
    expect(critStats([], { critChance: 0.2, critMultiplier: 2.5 })).toEqual({ critChance: 0.2, critMultiplier: 2.5 });
    expect(critStats([PRECISE], { critChance: 0.2, critMultiplier: 2.5 })).toEqual({ critChance: 1, critMultiplier: 1.3 });
  });

  it('crystal shell: base life (class + levels) becomes flat ES; gear life and % life are lost', () => {
    const levelModifiers: Modifier[] = [{ stat: 'life', kind: 'flat', value: 20 }];
    const modifiers: Modifier[] = [
      ...levelModifiers,
      { stat: 'life', kind: 'flat', value: 30 },
      { stat: 'life', kind: 'increased', value: 0.5 },
      { stat: 'energyShield', kind: 'flat', value: 40 },
      { stat: 'energyShield', kind: 'increased', value: 0.5 },
      { stat: 'lifeRegen', kind: 'flat', value: 3 },
      { stat: 'energyShieldRegen', kind: 'flat', value: 2 },
    ];
    const source = { baseStats: { life: 50, energyShield: 10 }, modifiers, levelModifiers, mechanics: [CRYSTAL] };
    expect(baseLife(source)).toBe(70);
    expect(deriveStat(source, 'life')).toBe(1);
    expect(deriveStat(source, 'energyShield')).toBe((10 + 70 + 40) * 1.5);
    expect(deriveStat(source, 'lifeRegen')).toBe(0);
    expect(deriveStat(source, 'energyShieldRegen')).toBe(5);
    const plain = { ...source, mechanics: [] };
    expect(deriveStat(plain, 'life')).toBe((50 + 20 + 30) * 1.5);
    expect(deriveStat(plain, 'energyShield')).toBe((10 + 40) * 1.5);
    expect(deriveStat(plain, 'energyShieldRegen')).toBe(2);
  });

  it('crystal shell without lifeRegenToShield keeps life regen on life', () => {
    const source = {
      baseStats: { life: 50 },
      modifiers: [{ stat: 'lifeRegen', kind: 'flat', value: 3 } as const],
      levelModifiers: [],
      mechanics: [{ kind: 'lifeToEnergyShield', maxLife: 1, lifeRegenToShield: false } as const],
    };
    expect(deriveStat(source, 'lifeRegen')).toBe(3);
    expect(deriveStat(source, 'energyShieldRegen')).toBe(0);
  });

  it('blood magic: max mana and mana regen are 0', () => {
    const source = { baseStats: { mana: 20, manaRegen: 2 }, modifiers: [{ stat: 'mana', kind: 'flat', value: 30 } as const], levelModifiers: [], mechanics: [BLOOD] };
    expect(deriveStat(source, 'mana')).toBe(0);
    expect(deriveStat(source, 'manaRegen')).toBe(0);
    expect(deriveStat({ ...source, mechanics: [] }, 'mana')).toBe(50);
  });

  it('life recovery goes to ES under crystal shell', () => {
    expect(lifeRecoveryPool([])).toBe('life');
    expect(lifeRecoveryPool([CRYSTAL])).toBe('energyShield');
  });

  it('conditions: moving / standing are complementary; life and target status', () => {
    const state = (stillTime: number, life = 100): ConditionState => ({ stillTime, life, maxLife: 100, energyShield: 0, maxEnergyShield: 0 });
    const moved = { kind: 'movedWithin', seconds: 0.5 } as const;
    const still = { kind: 'stationaryFor', seconds: 0.5 } as const;
    expect([conditionHolds(moved, state(0)), conditionHolds(still, state(0))]).toEqual([true, false]);
    expect([conditionHolds(moved, state(0.49)), conditionHolds(still, state(0.49))]).toEqual([true, false]);
    expect([conditionHolds(moved, state(0.5)), conditionHolds(still, state(0.5))]).toEqual([false, true]);
    expect(conditionHolds({ kind: 'lifeBelow', fraction: 0.5 }, state(0, 49))).toBe(true);
    expect(conditionHolds({ kind: 'lifeBelow', fraction: 0.5 }, state(0, 50))).toBe(false);
    const stun = { kind: 'targetHasStatus', status: 'stun' } as const;
    expect(conditionHolds(stun, state(0))).toBe(false);
    expect(conditionHolds(stun, state(0), { stun: 1, slow: 0, ignite: 0, freeze: 0 })).toBe(true);
    expect(conditionHolds({ kind: 'targetHasStatus', status: 'slow' }, state(0), { stun: 0, slow: 1, ignite: 0, freeze: 0 })).toBe(true);
    expect(conditionHolds({ kind: 'targetHasStatus', status: 'freeze' }, state(0), { stun: 1, slow: 1, ignite: 0, freeze: 0 })).toBe(false);
  });

  it('hero conditions apply without a target, target conditions only with one', () => {
    const more = (value: number): Modifier[] => [{ stat: 'damage', kind: 'more', value }];
    const mechanics: PassiveMechanic[] = [
      { kind: 'conditionalModifiers', condition: { kind: 'movedWithin', seconds: 0.5 }, modifiers: more(0.3) },
      { kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'stun' }, modifiers: more(0.25) },
    ];
    const state: ConditionState = { stillTime: 0, life: 1, maxLife: 1, energyShield: 0, maxEnergyShield: 0 };
    expect(activeConditionalModifiers(mechanics, state)).toEqual(more(0.3));
    expect(activeConditionalModifiers(mechanics, state, { stun: 1, slow: 0, ignite: 0, freeze: 0 })).toEqual(more(0.25));
    expect(activeConditionalModifiers(mechanics, state, { stun: 0, slow: 0, ignite: 0, freeze: 0 })).toEqual([]);
  });
});

describe('keystone: blood magic', () => {
  it('max mana is 0 and skills spend life 1:1', () => {
    const { content, world: w } = world([BLOOD]);
    expect(playerStat(content.classes.hero!, w.player, 'mana')).toBe(0);
    expect(w.player.mana).toBe(0);
    expect(w.player.life).toBe(50);
    const mob = addMob(w, 530, 500);
    step(w, { ...idle, skills: [true] }, content, DT);
    expect(mob.life).toBe(990);
    expect(w.player.life).toBe(42);
    expect(w.player.mana).toBe(0);
  });

  it('cannot cast when life <= cost; falls back to the basic attack', () => {
    const { content, world: w } = world([BLOOD]);
    const mob = addMob(w, 530, 500);
    w.player.life = 8;
    expect(canAfford(w.player, sweep)).toBe(false);
    const events = step(w, { ...attack, skills: [true] }, content, DT);
    expect(events.find((e) => e.type === 'action')).toMatchObject({ actionId: 'strike' });
    expect(w.player.life).toBe(8);
    expect(mob.life).toBe(990);
    expect(w.player.dead).toBe(false);
  });

  it('casting at just above the cost leaves the hero alive', () => {
    const { content, world: w } = world([BLOOD]);
    w.player.life = 8.5;
    expect(canAfford(w.player, sweep)).toBe(true);
    const events = step(w, { ...idle, skills: [true] }, content, DT);
    expect(events.find((e) => e.type === 'action')).toMatchObject({ actionId: 'sweep' });
    expect(w.player.life).toBe(0.5);
    expect(w.player.dead).toBe(false);
  });

  it('lifePerMana scales the life cost', () => {
    const { content, world: w } = world([{ kind: 'bloodMagic', lifePerMana: 2 }]);
    step(w, { ...idle, skills: [true] }, content, DT);
    expect(w.player.life).toBe(34);
  });

  it('mana regen and mana recovery do nothing', () => {
    const { content, world: w } = world([BLOOD], {}, { manaRegen: 5 });
    run(w, content, idle, 1);
    expect(w.player.mana).toBe(0);
    expect(recoverMana(content.classes.hero!, w.player, 50)).toBe(0);
    expect(w.player.mana).toBe(0);
  });

  it('without blood magic skills still spend mana', () => {
    const { content, world: w } = world([]);
    step(w, { ...idle, skills: [true] }, content, DT);
    expect(w.player.mana).toBe(12);
    expect(w.player.life).toBe(50);
  });
});

describe('keystone: precise hand (always crit)', () => {
  it('every hit crits with the fixed multiplier, ignoring crit multiplier modifiers', () => {
    const { content, world: w } = world([PRECISE], { modifiers: [{ stat: 'critMultiplier', kind: 'flat', value: 1 }, FAST] });
    const mob = addMob(w, 530, 500);
    for (let i = 0; i < 5; i++) {
      const events = step(w, attack, content, DT);
      run(w, content, idle, 0.1);
      expect(events.find((e) => e.type === 'hit')).toMatchObject({ amount: 13, isCrit: true });
    }
    expect(mob.life).toBe(1000 - 5 * 13);
  });

  it('without the keystone a 0% crit chance never crits', () => {
    const { content, world: w } = world([], { modifiers: [{ stat: 'critMultiplier', kind: 'flat', value: 1 }] });
    addMob(w, 530, 500);
    const events = step(w, attack, content, DT);
    expect(events.find((e) => e.type === 'hit')).toMatchObject({ amount: 10, isCrit: false });
  });
});

describe('keystone: crystal shell', () => {
  const gear: Modifier[] = [
    { stat: 'life', kind: 'flat', value: 30 },
    { stat: 'life', kind: 'increased', value: 0.5 },
    { stat: 'energyShield', kind: 'increased', value: 0.5 },
  ];

  it('base life (class + levels) becomes ES before % bonuses; life from gear is lost; max life 1', () => {
    const { content, world: w } = world([CRYSTAL], { level: 3, modifiers: gear }, { energyShield: 10 });
    const hero = content.classes.hero!;
    expect(playerStat(hero, w.player, 'life')).toBe(1);
    expect(w.player.life).toBe(1);
    expect(playerStat(hero, w.player, 'energyShield')).toBe((10 + 50 + 20) * 1.5);
    expect(w.player.energyShield).toBe(120);
  });

  it('ES absorbs hits; with ES gone the 1 life dies to the next hit', () => {
    const { content, world: w } = world([CRYSTAL], { level: 3, modifiers: gear }, { energyShield: 10 });
    const mob = addMob(w, 521, 500);
    mob.attackTimer = 0;
    run(w, content, idle, 0.1);
    expect(w.player.energyShield).toBe(110);
    expect(w.player.life).toBe(1);
    w.player.energyShield = 5;
    mob.attackTimer = 0;
    const events = run(w, content, idle, 0.1);
    expect(events.some((e) => e.type === 'playerDeath')).toBe(true);
    expect(w.player.energyShield).toBe(0);
    expect(w.player.life).toBe(0);
  });

  it('life regen feeds ES regen; life stays at 1', () => {
    const regen: Modifier[] = [
      { stat: 'lifeRegen', kind: 'flat', value: 3 },
      { stat: 'energyShieldRegen', kind: 'flat', value: 2 },
    ];
    const { content, world: w } = world([CRYSTAL], { modifiers: regen });
    const hero = content.classes.hero!;
    expect(playerStat(hero, w.player, 'energyShieldRegen')).toBe(5);
    expect(playerStat(hero, w.player, 'lifeRegen')).toBe(0);
    w.player.energyShield = 10;
    run(w, content, idle, 1);
    expect(w.player.energyShield).toBeCloseTo(15, 9);
    expect(w.player.life).toBe(1);
  });

  it('life potions restore ES instead of life, capped at max ES', () => {
    const { content, world: w } = world([CRYSTAL]);
    const hero = content.classes.hero!;
    w.player.energyShield = 10;
    expect(recoverLife(hero, w.player, 25)).toBe(25);
    expect(w.player.energyShield).toBe(35);
    expect(w.player.life).toBe(1);
    expect(recoverLife(hero, w.player, 100)).toBe(15);
    expect(w.player.energyShield).toBe(50);
  });

  it('without the keystone life potions restore life', () => {
    const { content, world: w } = world([]);
    w.player.life = 10;
    expect(recoverLife(content.classes.hero!, w.player, 25)).toBe(25);
    expect(w.player.life).toBe(35);
    expect(w.player.energyShield).toBe(0);
  });
});

describe('keystone: swift feet (moving / standing)', () => {
  it('standing still >= 0.5 s: 30% less damage; moving this tick: 30% more', () => {
    const { content, world: w } = world(SWIFT, { modifiers: [FAST] });
    const mob = addMob(w, 530, 500);
    run(w, content, idle, 1);
    expect(hitOnce(w, content, mob)).toBeCloseTo(7, 9);
    run(w, content, idle, 0.1);
    expect(hitOnce(w, content, mob, { ...attack, move: vec(0, 1) })).toBeCloseTo(13, 9);
  });

  it('the bonus lasts 0.5 s after stopping, then turns into the penalty', () => {
    const { content, world: w } = world(SWIFT, { modifiers: [FAST] });
    const mob = addMob(w, 530, 500);
    run(w, content, { ...idle, move: vec(0, 1) }, 0.1);
    run(w, content, idle, 0.3);
    expect(w.player.stillTime).toBeCloseTo(0.3, 9);
    expect(hitOnce(w, content, mob)).toBeCloseTo(13, 9);
    run(w, content, idle, 0.3);
    expect(hitOnce(w, content, mob)).toBeCloseTo(7, 9);
  });

  it('a fresh hero counts as just moved (stillTime starts at 0)', () => {
    const { content, world: w } = world(SWIFT);
    expect(w.player.stillTime).toBe(0);
    const mob = addMob(w, 530, 500);
    expect(hitOnce(w, content, mob)).toBeCloseTo(13, 9);
  });

  it('teleport counts as movement', () => {
    const { content, world: w } = world(SWIFT, { modifiers: [FAST] });
    run(w, content, idle, 1);
    step(w, { ...idle, aim: vec(500, 400), skills: [false, true] }, content, DT);
    expect(w.player.pos).toEqual(vec(500, 400));
    expect(w.player.stillTime).toBe(0);
    const mob = addMob(w, 530, 400);
    run(w, content, idle, 0.15);
    expect(hitOnce(w, content, mob)).toBeCloseTo(13, 9);
  });

  it('a dash (roll / charge) counts as movement for its own hits', () => {
    const { content, world: w } = world(SWIFT);
    run(w, content, idle, 1);
    const mob = addMob(w, 600, 500);
    step(w, { ...idle, skills: [false, false, true] }, content, DT);
    run(w, content, idle, 0.3);
    expect(1000 - mob.life).toBeCloseTo(13, 9);
  });

  it('pushing into a wall without moving does not count as movement', () => {
    const { content, world: w } = world(SWIFT);
    run(w, content, { ...idle, move: vec(1, 0) }, 6);
    expect(w.player.pos.x).toBe(990);
    run(w, content, { ...idle, move: vec(1, 0) }, 1);
    expect(w.player.stillTime).toBeGreaterThan(0.9);
  });
});

describe('conditional modifiers on delayed hits are locked at cast time', () => {
  const arrow: ActionDef = {
    id: 'arrow',
    tags: ['attack', 'projectile'],
    manaCost: 0,
    cooldown: 0,
    damage: { source: 'skill', base: { physical: { min: 10, max: 10 } }, critChance: 0 },
    delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 300, range: 1000, radius: 2, pierce: 0 },
  };
  const mine: ActionDef = {
    id: 'mine',
    tags: ['attack', 'area'],
    manaCost: 0,
    cooldown: 0,
    damage: { source: 'skill', base: { physical: { min: 10, max: 10 } }, critChance: 0 },
    delivery: { kind: 'trap', throwRange: 100, armTime: 0.8, triggerRadius: 20, explodeRadius: 30, lifetime: 5 },
  };
  const STUNNED: PassiveMechanic = { kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'stun' }, modifiers: [{ stat: 'damage', kind: 'more', value: 0.25 }] };
  const ranged = (mechanics: readonly PassiveMechanic[]): { content: Content; world: WorldState } => {
    const base = makeContent();
    const content: Content = { ...base, classes: { hero: { ...base.classes.hero!, skills: [arrow, mine] } } };
    return { content, world: createWorld(content, 'hero', 1, { mechanics }) };
  };
  const moving: PlayerInput = { ...idle, move: vec(0, 1) };

  it('a projectile fired while moving keeps the bonus after the hero stood still past 0.5 s', () => {
    const { content, world: w } = ranged(SWIFT);
    const mob = addMob(w, 700, 500);
    run(w, content, idle, 1);
    step(w, { ...moving, skills: [true] }, content, DT);
    expect(w.player.stillTime).toBe(0);
    expect(w.projectiles[0]?.castModifiers).toEqual([{ stat: 'damage', kind: 'more', value: 0.3 }]);
    run(w, content, idle, 0.55);
    expect(w.projectiles).toHaveLength(1);
    expect(w.player.stillTime).toBeGreaterThanOrEqual(0.5);
    run(w, content, idle, 0.45);
    expect(w.projectiles).toHaveLength(0);
    expect(1000 - mob.life).toBeCloseTo(13, 9);
  });

  it('a projectile fired standing keeps the penalty even if the hero moves before impact', () => {
    const { content, world: w } = ranged(SWIFT);
    const mob = addMob(w, 700, 500);
    run(w, content, idle, 1);
    step(w, { ...idle, skills: [true] }, content, DT);
    expect(w.projectiles[0]?.castModifiers).toEqual([{ stat: 'damage', kind: 'more', value: -0.3 }]);
    run(w, content, moving, 1);
    expect(w.projectiles).toHaveLength(0);
    expect(1000 - mob.life).toBeCloseTo(7, 9);
  });

  it('a trap thrown while moving keeps the bonus when it explodes later', () => {
    const { content, world: w } = ranged(SWIFT);
    const mob = addMob(w, 600, 500);
    step(w, { ...moving, skills: [false, true] }, content, DT);
    expect(w.traps).toHaveLength(1);
    run(w, content, idle, 1);
    expect(w.traps).toHaveLength(0);
    expect(1000 - mob.life).toBeCloseTo(13, 9);
  });

  it('target conditions are still evaluated at impact', () => {
    const { content, world: w } = ranged([...SWIFT, STUNNED]);
    const mob = addMob(w, 700, 500);
    step(w, { ...moving, skills: [true] }, content, DT);
    expect(w.projectiles[0]?.castModifiers).toEqual([{ stat: 'damage', kind: 'more', value: 0.3 }]);
    mob.stun = 5;
    run(w, content, idle, 1);
    expect(1000 - mob.life).toBeCloseTo(10 * 1.3 * 1.25, 9);
  });

  it('without conditional mechanics the snapshot is empty', () => {
    const { content, world: w } = ranged([]);
    addMob(w, 700, 500);
    step(w, { ...idle, skills: [true] }, content, DT);
    expect(w.projectiles[0]?.castModifiers).toEqual([]);
  });
});

describe('conditional modifiers: life and target status', () => {
  it('lifeBelow applies only under the life fraction', () => {
    const mechanics: PassiveMechanic[] = [{ kind: 'conditionalModifiers', condition: { kind: 'lifeBelow', fraction: 0.5 }, modifiers: [{ stat: 'damage', kind: 'more', value: 1 }] }];
    const { content, world: w } = world(mechanics, { modifiers: [FAST] });
    const mob = addMob(w, 530, 500);
    w.player.life = 30;
    expect(hitOnce(w, content, mob)).toBe(10);
    run(w, content, idle, 0.1);
    w.player.life = 20;
    expect(hitOnce(w, content, mob)).toBe(20);
  });

  it('targetHasStatus applies per hit to stunned targets only', () => {
    const mechanics: PassiveMechanic[] = [{ kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'stun' }, modifiers: [{ stat: 'damage', kind: 'more', value: 0.25 }] }];
    const { content, world: w } = world(mechanics, { modifiers: [FAST] });
    const mob = addMob(w, 530, 500);
    expect(hitOnce(w, content, mob)).toBe(10);
    run(w, content, idle, 0.1);
    mob.stun = 1;
    expect(hitOnce(w, content, mob)).toBe(12.5);
  });
});

/** Bloodsucker as in src/data/passives.ts (k_leech). */
const LEECH: PassiveMechanic = { kind: 'lifeLeech', fraction: 0.05, maxPerSecond: 0.2 };
const NO_LIFE_REGEN: Modifier = { stat: 'lifeRegen', kind: 'more', value: -1 };
/** Glass Cannon as in src/data/passives.ts (k_glass). */
const GLASS: Modifier[] = [
  { stat: 'damage', kind: 'more', value: 0.4 },
  { stat: 'damageTaken', kind: 'more', value: 0.4 },
];

describe('keystone: bloodsucker (life leech)', () => {
  it('leechStats adds fractions and caps; lifePotionMultiplier multiplies', () => {
    expect(leechStats([])).toBeUndefined();
    expect(leechStats([LEECH])).toEqual({ fraction: 0.05, maxPerSecond: 0.2 });
    expect(leechStats([LEECH, { kind: 'lifeLeech', fraction: 0.03, maxPerSecond: 0.1 }])).toEqual({ fraction: 0.08, maxPerSecond: 0.2 + 0.1 });
    expect(leechStats([{ kind: 'lifeLeech', fraction: 0.1 }])).toEqual({ fraction: 0.1, maxPerSecond: Infinity });
    expect(lifePotionMultiplier([])).toBe(1);
    expect(lifePotionMultiplier([{ kind: 'lifePotionEffectiveness', multiplier: 0.5 }])).toBe(0.5);
    expect(lifePotionMultiplier([{ kind: 'lifePotionEffectiveness', multiplier: 0.5 }, { kind: 'lifePotionEffectiveness', multiplier: 0.5 }])).toBe(0.25);
  });

  it('a hit restores 5% of its damage as life', () => {
    const { content, world: w } = world([LEECH]);
    const mob = addMob(w, 530, 500);
    w.player.life = 20;
    expect(hitOnce(w, content, mob)).toBe(10);
    expect(w.player.life).toBe(20.5);
    expect(w.player.leechRecent).toBe(0.5);
  });

  it('overkill does not leech: only the life actually removed counts', () => {
    const { content, world: w } = world([LEECH], { modifiers: [{ stat: 'damage', kind: 'more', value: 29 }] });
    const mob = addMob(w, 530, 500, 20);
    w.player.life = 10;
    expect(hitOnce(w, content, mob)).toBe(300);
    // 5% of 20 (the mob's remaining life), not of 300.
    expect(w.player.life).toBe(11);
    expect(w.player.leechRecent).toBe(1);
  });

  it('a "more" below −100% zeroes regen instead of draining life', () => {
    const { content, world: w } = world([LEECH], { modifiers: [{ stat: 'lifeRegen', kind: 'flat', value: 3 }, { stat: 'lifeRegen', kind: 'more', value: -1.5 }] });
    expect(playerStat(content.classes.hero!, w.player, 'lifeRegen')).toBe(0);
    w.player.life = 20;
    run(w, content, idle, 1);
    expect(w.player.life).toBe(20);
  });

  it('no leech without the mechanic', () => {
    const { content, world: w } = world([]);
    const mob = addMob(w, 530, 500);
    w.player.life = 20;
    hitOnce(w, content, mob);
    expect(w.player.life).toBe(20);
  });

  it('a big hit restores at most 20% of max life; the cap refills at 20% per second', () => {
    // 400 damage × 5% = 20, capped at 20% of 50 max life = 10.
    const big: Modifier = { stat: 'damage', kind: 'more', value: 39 };
    const { content, world: w } = world([LEECH], { modifiers: [FAST, big] });
    const mob = addMob(w, 530, 500, 1e6);
    w.player.life = 10;
    expect(hitOnce(w, content, mob)).toBe(400);
    expect(w.player.life).toBe(20);
    expect(w.player.leechRecent).toBe(10);
    // 30 idle ticks drain 5; the next hit's tick drains 1/6 more before it lands.
    run(w, content, idle, 0.5);
    expect(w.player.leechRecent).toBeCloseTo(5, 9);
    hitOnce(w, content, mob);
    expect(w.player.life).toBeCloseTo(25 + 1 / 6, 9);
    expect(w.player.leechRecent).toBeCloseTo(10, 9);
    // A second without leeching empties the window: the full cap is available again.
    run(w, content, idle, 1.1);
    expect(w.player.leechRecent).toBe(0);
    w.player.life = 10;
    hitOnce(w, content, mob);
    expect(w.player.life).toBe(20);
  });

  it('leech at full life is wasted and does not use the cap', () => {
    const { content, world: w } = world([LEECH]);
    const mob = addMob(w, 530, 500);
    hitOnce(w, content, mob);
    expect(w.player.life).toBe(50);
    expect(w.player.leechRecent).toBe(0);
  });

  it('projectile hits leech too', () => {
    const arrow: ActionDef = {
      id: 'arrow',
      tags: ['attack', 'projectile'],
      manaCost: 0,
      cooldown: 0,
      damage: { source: 'skill', base: { physical: { min: 20, max: 20 } }, critChance: 0 },
      delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 300, range: 1000, radius: 2, pierce: 0 },
    };
    const base = makeContent();
    const content: Content = { ...base, classes: { hero: { ...base.classes.hero!, skills: [arrow] } } };
    const w = createWorld(content, 'hero', 1, { mechanics: [LEECH] });
    const mob = addMob(w, 700, 500);
    w.player.life = 20;
    step(w, { ...idle, skills: [true] }, content, DT);
    run(w, content, idle, 1);
    expect(mob.life).toBe(980);
    expect(w.player.life).toBe(21);
  });

  it('under Crystal Shell leech restores ES (cap from max ES); life stays 1', () => {
    const { content, world: w } = world([CRYSTAL, LEECH], { modifiers: [{ stat: 'damage', kind: 'more', value: 9 }] });
    const hero = content.classes.hero!;
    expect(playerStat(hero, w.player, 'energyShield')).toBe(50);
    const mob = addMob(w, 530, 500);
    w.player.energyShield = 10;
    hitOnce(w, content, mob);
    expect(w.player.energyShield).toBe(15);
    expect(w.player.life).toBe(1);
  });

  it('no life regen under Bloodsucker, also not as ES regen under Crystal Shell', () => {
    const regen: Modifier[] = [
      { stat: 'lifeRegen', kind: 'flat', value: 3 },
      { stat: 'energyShieldRegen', kind: 'flat', value: 2 },
      NO_LIFE_REGEN,
    ];
    const { content, world: w } = world([LEECH], { modifiers: regen });
    const hero = content.classes.hero!;
    expect(playerStat(hero, w.player, 'lifeRegen')).toBe(0);
    w.player.life = 20;
    run(w, content, idle, 1);
    expect(w.player.life).toBe(20);
    const crystal = world([CRYSTAL, LEECH], { modifiers: regen });
    expect(playerStat(hero, crystal.world.player, 'energyShieldRegen')).toBe(2);
  });
});

describe('keystone: glass cannon', () => {
  it('applyDamageTaken scales each damage portion by its own damageTaken modifiers', () => {
    const mods: Modifier[] = [...GLASS, { stat: 'damageTaken', kind: 'increased', value: 0.5, tags: ['fire'] }];
    const taken = applyDamageTaken({ physical: 10, fire: 10 }, mods);
    expect(Object.keys(taken).sort()).toEqual(['fire', 'physical']);
    expect(taken.physical).toBeCloseTo(14, 9);
    expect(taken.fire).toBeCloseTo(21, 9);
    expect(applyDamageTaken({ cold: 10 }, [])).toEqual({ cold: 10 });
  });

  it('damage taken never goes negative: below-zero multipliers give 0 per portion', () => {
    const mods: Modifier[] = [
      { stat: 'damageTaken', kind: 'more', value: -1.5, tags: ['fire'] },
      { stat: 'damageTaken', kind: 'flat', value: -2, tags: ['cold'] },
      { stat: 'damageTaken', kind: 'increased', value: -3, tags: ['lightning'] },
    ];
    expect(applyDamageTaken({ physical: 10, fire: 10, cold: 10, lightning: 10 }, mods)).toEqual({ physical: 10, fire: 0, cold: 0, lightning: 0 });
  });

  it('deals 40% more damage', () => {
    const { content, world: w } = world([], { modifiers: GLASS });
    const mob = addMob(w, 530, 500);
    expect(hitOnce(w, content, mob)).toBeCloseTo(14, 9);
  });

  it('takes 40% more damage, applied before the ES / life split', () => {
    const { content, world: w } = world([], { modifiers: [...GLASS, { stat: 'energyShield', kind: 'flat', value: 10 }] });
    expect(w.player.energyShield).toBe(10);
    const mob = addMob(w, 521, 500);
    mob.attackTimer = 0;
    const events = run(w, content, idle, 0.1);
    expect(events.find((e) => e.type === 'hit' && e.targetId === 0)).toMatchObject({ amount: 14 });
    expect(w.player.energyShield).toBe(0);
    expect(w.player.life).toBeCloseTo(46, 9);
  });

  it('without the keystone the same hit deals 10', () => {
    const { content, world: w } = world([]);
    const mob = addMob(w, 521, 500);
    mob.attackTimer = 0;
    run(w, content, idle, 0.1);
    expect(w.player.life).toBe(40);
  });
});

describe('mechanics in the loadout', () => {
  it('Bloodsucker and Glass Cannon swap mid-run keeping pool fractions; leech follows the main pool', () => {
    const { content, world: w } = world([]);
    const hero = content.classes.hero!;
    w.player.life = 25;
    setLoadoutModifiers(w, content, [NO_LIFE_REGEN], [LEECH]);
    expect(w.player.life).toBe(25);
    setLoadoutModifiers(w, content, [NO_LIFE_REGEN, ...GLASS], [LEECH]);
    expect(w.player.life).toBe(25);
    const mob = addMob(w, 530, 500);
    expect(hitOnce(w, content, mob)).toBeCloseTo(14, 9);
    expect(w.player.life).toBeCloseTo(25.7, 9);
    // Taking Crystal Shell: ES gets the life fraction, leech now restores ES.
    run(w, content, idle, 1);
    setLoadoutModifiers(w, content, [NO_LIFE_REGEN, ...GLASS], [CRYSTAL, LEECH]);
    expect(w.player.life).toBe(1);
    expect(playerStat(hero, w.player, 'energyShield')).toBe(50);
    expect(w.player.energyShield).toBeCloseTo(25.7, 9);
    hitOnce(w, content, mob);
    expect(w.player.energyShield).toBeCloseTo(26.4, 9);
    expect(w.player.life).toBe(1);
  });

  it('max life dropping below leechRecent blocks leech until the window drains under the new cap', () => {
    // Cap 20% × 50 = 10; fill the window, then halve max life (cap 5): no leech until leechRecent < 5.
    const { content, world: w } = world([LEECH], { modifiers: [FAST, { stat: 'damage', kind: 'more', value: 39 }] });
    const mob = addMob(w, 530, 500, 1e6);
    w.player.life = 10;
    hitOnce(w, content, mob);
    expect(w.player.leechRecent).toBe(10);
    setLoadoutModifiers(w, content, [FAST, { stat: 'damage', kind: 'more', value: 39 }, { stat: 'life', kind: 'more', value: -0.5 }]);
    expect(playerStat(content.classes.hero!, w.player, 'life')).toBe(25);
    // 20 / 50 life before the swap -> 10 / 25 after.
    expect(w.player.life).toBe(10);
    // Drains at the new cap (5/s): 0.5 s idle + the hit's tick leaves 10 − 31 × 5/60 > 5, so nothing is restored.
    run(w, content, idle, 0.5);
    hitOnce(w, content, mob);
    expect(w.player.life).toBe(10);
    expect(w.player.leechRecent).toBeCloseTo(10 - 31 * (5 / 60), 9);
    // After the window drains below the new cap, leech is allowed up to the room left (5 per burst at most).
    run(w, content, idle, 2.1);
    expect(w.player.leechRecent).toBe(0);
    hitOnce(w, content, mob);
    expect(w.player.life).toBe(15);
  });

  it('setLoadoutModifiers swaps mechanics mid-run, keeping the main pool fill fraction', () => {
    const { content, world: w } = world([]);
    const hero = content.classes.hero!;
    expect(w.player.life).toBe(50);
    expect(w.player.mana).toBe(20);
    setLoadoutModifiers(w, content, [], [BLOOD]);
    expect(w.player.mechanics).toEqual([BLOOD]);
    expect(w.player.mana).toBe(0);
    expect(w.player.life).toBe(50);
    // Taking Crystal Shell at 50% life: 50% ES, life at its fixed max.
    w.player.life = 25;
    setLoadoutModifiers(w, content, [], [CRYSTAL]);
    expect(w.player.life).toBe(1);
    expect(playerStat(hero, w.player, 'energyShield')).toBe(50);
    expect(w.player.energyShield).toBe(25);
    // Mana max was 0 under blood magic: it starts at 0 and regenerates, it is not refilled.
    expect(playerStat(hero, w.player, 'mana')).toBe(20);
    expect(w.player.mana).toBe(0);
    // Mechanics are kept when the argument is omitted; ES keeps its fraction of the new max.
    setLoadoutModifiers(w, content, [{ stat: 'energyShield', kind: 'flat', value: 10 }]);
    expect(w.player.mechanics).toEqual([CRYSTAL]);
    expect(playerStat(hero, w.player, 'energyShield')).toBe(60);
    expect(w.player.energyShield).toBe(30);
    // Leaving Crystal Shell: the fixed life counts with ES, (30 + 1) / (60 + 1) of the new max life.
    setLoadoutModifiers(w, content, [], []);
    expect(playerStat(hero, w.player, 'life')).toBe(50);
    expect(w.player.life).toBeCloseTo((31 / 61) * 50, 9);
    expect(w.player.energyShield).toBe(0);
  });

  it('leaving Crystal Shell at 0 ES leaves the hero alive', () => {
    const { content, world: w } = world([CRYSTAL]);
    w.player.energyShield = 0;
    setLoadoutModifiers(w, content, [], []);
    expect(w.player.life).toBeCloseTo((1 / 51) * 50, 9);
    expect(w.player.life).toBeGreaterThan(0);
  });

  it('secondary ES and mana keep their fill fractions; a pool that had max 0 starts empty', () => {
    const { content, world: w } = world([], { modifiers: [{ stat: 'energyShield', kind: 'flat', value: 20 }] });
    w.player.life = 40;
    w.player.energyShield = 5;
    w.player.mana = 10;
    setLoadoutModifiers(w, content, [
      { stat: 'energyShield', kind: 'flat', value: 40 },
      { stat: 'mana', kind: 'flat', value: 20 },
      { stat: 'life', kind: 'flat', value: 50 },
    ]);
    expect(w.player.life).toBe(80);
    expect(w.player.energyShield).toBe(10);
    expect(w.player.mana).toBe(20);
    // No ES before: gaining ES mid-run does not grant a full shield.
    const fresh = world([]);
    setLoadoutModifiers(fresh.world, fresh.content, [{ stat: 'energyShield', kind: 'flat', value: 30 }]);
    expect(fresh.world.player.energyShield).toBe(0);
  });

  it('runs with mechanics stay deterministic and JSON-serializable', () => {
    const play = (): WorldState => {
      const { content, world: w } = world([BLOOD, PRECISE, ...SWIFT, LEECH], { modifiers: [FAST, ...GLASS] });
      addMob(w, 530, 500);
      for (let i = 0; i < 300; i++) step(w, { ...idle, move: vec(i % 40 < 20 ? 1 : 0, 0), basicAttack: true, skills: [i % 7 === 0] }, content, DT);
      return w;
    };
    const a = play();
    expect(a).toEqual(play());
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

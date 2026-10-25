import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import type { ActionDef, ClassDef, Content, MobDef, ResourceDef } from './content';
import { tickResource } from './resource';
import { createWorld, inCombat, maxResource, playerStat, recoverResource, setLoadoutModifiers, step, type MobState, type PlayerInput, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 1000,
  xp: 20,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};

/** Basic attack: a full circle around the hero, no target cap (so one swing can hit many mobs). */
const swing: ActionDef = {
  id: 'swing',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 360 },
};
const slam: ActionDef = {
  id: 'slam',
  tags: ['attack', 'melee', 'area'],
  resourceCost: 10,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 360 },
};

const RAGE: ResourceDef = {
  id: 'rage',
  startFraction: 0,
  refillOnLevelUp: false,
  onHit: { amount: 5, source: 'basicAttack', maxHitsPerUse: 3 },
  onDamageTaken: { perPoolFraction: 50 },
  decay: { delay: 2.5, perSecond: 10 },
};
const MANA: ResourceDef = { id: 'mana', startFraction: 1, refillOnLevelUp: true };

function makeContent(resource: ResourceDef, baseStats: ClassDef['baseStats'] = {}): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'sword',
    baseStats: { life: 50, resource: 100, resourceRegen: 0, movementSpeed: 100, ...baseStats },
    resource,
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack: swing,
    skills: [slam],
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5, maxLifeCostFraction: 0.9 },
    classes: { hero },
    mobs: { dummy },
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
    progression: {
      maxLevel: 5,
      xpCurve: { base: 15, exponent: 1 },
      mobXpGrowth: 0,
      lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
      mapClearBonus: 0.1,
      perLevel: { life: 10, resource: 2 },
    },
  };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };
const useSlam: PlayerInput = { ...idle, skills: [true] };

/** A mob next to the hero (hero at 500, 500). `attackTimer` 10 keeps it from attacking during a test. */
function addMob(world: WorldState, x = 520, y = 500, life = 1000, attackTimer = 10): MobState {
  const mob: MobState = { id: world.nextId++, defId: 'dummy', pos: vec(x, y), facing: vec(0, 1), life, maxLife: life, attackTimer, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: 10 };
  world.mobs.push(mob);
  return mob;
}

function run(world: WorldState, content: Content, input: PlayerInput, steps: number): void {
  for (let i = 0; i < steps; i++) step(world, input, content, DT);
}

function setup(resource: ResourceDef = RAGE, mechanics: PassiveMechanic[] = [], baseStats: ClassDef['baseStats'] = {}) {
  const content = makeContent(resource, baseStats);
  const world = createWorld(content, 'hero', 1, { mechanics });
  return { content, world, hero: content.classes.hero! };
}

describe('class resource: spawn and regeneration', () => {
  it('rage starts empty, mana starts full, a fractional start gives that share of max', () => {
    expect(setup(RAGE).world.player.resource).toBe(0);
    expect(setup(MANA).world.player.resource).toBe(100);
    expect(setup({ ...MANA, startFraction: 0.25 }).world.player.resource).toBe(25);
  });

  it('the hero spawns out of combat (combatIdle = decay delay); without decay always in combat', () => {
    const rage = setup();
    expect(rage.world.player.combatIdle).toBe(2.5);
    expect(inCombat(rage.hero, rage.world.player)).toBe(false);
    expect(rage.world.player.resourceHits).toBe(0);
    const mana = setup(MANA);
    expect(mana.world.player.combatIdle).toBe(0);
    mana.world.player.combatIdle = 100;
    expect(inCombat(mana.hero, mana.world.player)).toBe(true);
  });

  it('regenerates resourceRegen per second up to max', () => {
    const { content, world } = setup({ ...MANA, startFraction: 0 }, [], { resourceRegen: 6 });
    run(world, content, idle, 30);
    expect(world.player.resource).toBeCloseTo(3, 10);
    run(world, content, idle, 3000);
    expect(world.player.resource).toBe(100);
  });

  it('maxResource is the resource stat; recoverResource caps at max', () => {
    const { world, hero } = setup(MANA, [], { resource: 60 });
    expect(maxResource(hero, world.player)).toBe(60);
    expect(playerStat(hero, world.player, 'resource')).toBe(60);
    world.player.resource = 50;
    expect(recoverResource(hero, world.player, 30)).toBe(10);
    expect(world.player.resource).toBe(60);
  });
});

describe('class resource: gain on hit (Rage)', () => {
  it('a basic attack hit grants onHit.amount', () => {
    const { content, world } = setup();
    addMob(world);
    step(world, attack, content, DT);
    expect(world.player.resource).toBe(5);
  });

  it('one swing grants at most maxHitsPerUse hits', () => {
    const { content, world } = setup();
    for (let i = 0; i < 5; i++) addMob(world, 520, 490 + i * 5);
    step(world, attack, content, DT);
    expect(world.mobs.every((m) => m.life === 990)).toBe(true);
    expect(world.player.resource).toBe(15);
  });

  it('the cap restarts on the next swing', () => {
    const { content, world } = setup();
    for (let i = 0; i < 5; i++) addMob(world, 520, 490 + i * 5);
    // attacksPerSecond 2: the second swing comes 0.5 s after the first, the third not before step 61.
    run(world, content, attack, 40);
    expect(world.player.resource).toBe(30);
  });

  it('skill hits do not grant resource when only the basic attack counts', () => {
    const { content, world } = setup(RAGE, [], {});
    world.player.resource = 20;
    world.player.combatIdle = 0;
    addMob(world);
    step(world, useSlam, content, DT);
    expect(world.mobs[0]!.life).toBe(990);
    expect(world.player.resource).toBe(10);
  });

  it("source 'anyAction' counts skill hits too", () => {
    const { content, world } = setup({ ...RAGE, onHit: { amount: 4, source: 'anyAction', maxHitsPerUse: 2 } });
    world.player.resource = 20;
    world.player.combatIdle = 0;
    for (let i = 0; i < 3; i++) addMob(world, 520, 495 + i * 5);
    step(world, useSlam, content, DT);
    expect(world.player.resource).toBe(18);
  });

  it('gains stop at max', () => {
    const { content, world } = setup();
    world.player.resource = 98;
    addMob(world);
    step(world, attack, content, DT);
    expect(world.player.resource).toBe(100);
  });

  it('a counter-attack (basic attack) grants hit resource on top of damage taken', () => {
    const { content, world } = setup(RAGE, [{ kind: 'counterAttack', effectiveness: 1, cooldown: 1 }]);
    const mob = addMob(world, 520, 500, 1000, 0);
    step(world, idle, content, DT);
    expect(world.player.life).toBe(40);
    expect(mob.life).toBe(990);
    // 10 / 50 life lost × 50 = 10, plus 5 for the counter hit.
    expect(world.player.resource).toBe(15);
  });
});

describe('class resource: gain from damage taken (Rage)', () => {
  it('grants perPoolFraction × share of life lost', () => {
    const { content, world } = setup();
    addMob(world, 520, 500, 1000, 0);
    step(world, idle, content, DT);
    expect(world.player.life).toBe(40);
    expect(world.player.resource).toBe(10);
  });

  it('life and energy shield count as one pool', () => {
    const { content, world } = setup(RAGE, [], { energyShield: 50 });
    addMob(world, 520, 500, 1000, 0);
    step(world, idle, content, DT);
    expect(world.player.energyShield).toBe(40);
    // 10 / (50 + 50) × 50 = 5.
    expect(world.player.resource).toBe(5);
  });

  it('a class without onDamageTaken gains nothing from hits taken', () => {
    const { content, world } = setup({ ...MANA, startFraction: 0 });
    addMob(world, 520, 500, 1000, 0);
    step(world, idle, content, DT);
    expect(world.player.life).toBe(40);
    expect(world.player.resource).toBe(0);
  });

  it('Crystal Shell: a hit that only drains ES grants Rage by the share of (max life + max ES) lost', () => {
    const { content, world, hero } = setup(RAGE, [{ kind: 'lifeToEnergyShield', maxLife: 1, lifeRegenToShield: true }]);
    expect(playerStat(hero, world.player, 'life')).toBe(1);
    expect(playerStat(hero, world.player, 'energyShield')).toBe(50);
    addMob(world, 520, 500, 1000, 0);
    step(world, idle, content, DT);
    expect(world.player.life).toBe(1);
    expect(world.player.energyShield).toBe(40);
    // 10 / (1 + 50) × 50.
    expect(world.player.resource).toBe((10 / 51) * 50);
  });

  it('a fatal hit grants no Rage', () => {
    const { content, world } = setup();
    world.player.life = 5;
    addMob(world, 520, 500, 1000, 0);
    step(world, idle, content, DT);
    expect(world.player.dead).toBe(true);
    expect(world.player.resource).toBe(0);
  });
});

describe('class resource: decay out of combat (Rage)', () => {
  it('drains perSecond only once combatIdle reaches the delay', () => {
    const { content, world } = setup();
    world.player.resource = 50;
    world.player.combatIdle = 0;
    run(world, content, idle, 149);
    expect(world.player.resource).toBe(50);
    // Step 150: combatIdle = 2.5 s, draining starts (10 / 60 per step).
    step(world, idle, content, DT);
    expect(world.player.resource).toBeCloseTo(50 - 10 / 60, 10);
    run(world, content, idle, 60);
    expect(world.player.resource).toBeCloseTo(50 - (61 * 10) / 60, 10);
    run(world, content, idle, 600);
    expect(world.player.resource).toBe(0);
  });

  it('dealing a hit resets the delay', () => {
    const { content, world } = setup();
    world.player.resource = 50;
    world.player.combatIdle = 0;
    // 148 idle steps + the hit step = 149 steps: still below the delay when the hit lands (regen / decay run before actions).
    run(world, content, idle, 148);
    addMob(world);
    step(world, attack, content, DT);
    expect(world.player.combatIdle).toBe(0);
    expect(world.player.resource).toBe(55);
    run(world, content, idle, 149);
    expect(world.player.resource).toBe(55);
    step(world, idle, content, DT);
    expect(world.player.resource).toBeCloseTo(55 - 10 / 60, 10);
  });

  it('taking a hit resets the delay', () => {
    const { content, world } = setup();
    world.player.resource = 50;
    world.player.combatIdle = 0;
    run(world, content, idle, 148);
    addMob(world, 520, 500, 1000, 0);
    step(world, idle, content, DT);
    expect(world.player.combatIdle).toBe(0);
    expect(world.player.resource).toBe(60);
  });

  it('regeneration still applies while draining', () => {
    const { world, hero } = setup(RAGE, [], { resourceRegen: 4 });
    world.player.resource = 50;
    world.player.combatIdle = 3;
    tickResource(hero, world.player, 0.5);
    // +4 × 0.5 − 10 × 0.5.
    expect(world.player.resource).toBe(47);
  });

  it('regenOnlyInCombat: regen in combat, only decay out of combat', () => {
    const { world, hero } = setup({ ...RAGE, regenOnlyInCombat: true }, [], { resourceRegen: 4 });
    world.player.resource = 50;
    world.player.combatIdle = 1;
    tickResource(hero, world.player, 0.5);
    expect(world.player.resource).toBe(52);
    world.player.combatIdle = 2.5;
    tickResource(hero, world.player, 0.5);
    // Out of combat: −10 × 0.5, no regen.
    expect(world.player.resource).toBe(47);
  });

  it('regenOnlyInCombat over steps: regen stops when the decay delay is reached, then Rage drains', () => {
    const { content, world } = setup({ ...RAGE, regenOnlyInCombat: true }, [], { resourceRegen: 6 });
    // Spawned out of combat: no regen, nothing to decay.
    run(world, content, idle, 60);
    expect(world.player.resource).toBe(0);
    addMob(world);
    step(world, attack, content, DT);
    // Regen ran before the hit (still out of combat): just the +5 of the hit.
    expect(world.player.resource).toBe(5);
    world.mobs = [];
    // 149 in-combat steps of +6/60 = +14.9; step 150 reaches the delay: −10/60 instead.
    run(world, content, idle, 149);
    expect(world.player.resource).toBeCloseTo(5 + (149 * 6) / 60, 10);
    step(world, idle, content, DT);
    expect(world.player.resource).toBeCloseTo(5 + (149 * 6) / 60 - 10 / 60, 10);
  });

  it('the game warrior regenerates Rage only in combat', () => {
    expect(gameContent.classes.warrior!.resource.regenOnlyInCombat).toBe(true);
  });


  it('combatIdle stops growing at the decay delay (0 without decay)', () => {
    const rage = setup();
    rage.world.player.combatIdle = 0;
    run(rage.world, rage.content, idle, 600);
    expect(rage.world.player.combatIdle).toBe(2.5);
    const mana = setup(MANA);
    run(mana.world, mana.content, idle, 60);
    expect(mana.world.player.combatIdle).toBe(0);
  });
  it('a resource without decay never drains', () => {
    const { content, world } = setup({ ...MANA, startFraction: 0.5 });
    run(world, content, idle, 600);
    expect(world.player.resource).toBe(50);
  });
});

describe('class resource: blood magic, level-up and loadout changes', () => {
  it('under blood magic the warrior gains no Rage from hits dealt or taken', () => {
    const { content, world, hero } = setup(RAGE, [{ kind: 'bloodMagic', lifePerResource: 1 }]);
    expect(maxResource(hero, world.player)).toBe(0);
    addMob(world, 520, 500, 1000, 0);
    step(world, attack, content, DT);
    expect(world.player.life).toBe(40);
    expect(world.mobs[0]!.life).toBe(990);
    expect(world.player.resource).toBe(0);
  });

  it('under blood magic skills spend life; Rage stays 0', () => {
    const { content, world } = setup(RAGE, [{ kind: 'bloodMagic', lifePerResource: 1 }]);
    addMob(world);
    step(world, useSlam, content, DT);
    expect(world.player.life).toBe(40);
    expect(world.player.resource).toBe(0);
  });

  it('Rage is kept on level-up (refillOnLevelUp false)', () => {
    const { content, world, hero } = setup();
    addMob(world, 520, 500, 5);
    step(world, attack, content, DT);
    expect(world.player.level).toBe(2);
    // Max grew by perLevel (100 → 102); the 5 Rage from the killing hit is kept.
    expect(maxResource(hero, world.player)).toBe(102);
    expect(world.player.resource).toBe(5);
  });

  it('mana is refilled on level-up (refillOnLevelUp true)', () => {
    const { content, world } = setup(MANA);
    world.player.resource = 3;
    addMob(world, 520, 500, 5);
    step(world, attack, content, DT);
    expect(world.player.level).toBe(2);
    expect(world.player.resource).toBe(102);
  });

  it('a loadout change keeps the Rage fill fraction', () => {
    const { content, world } = setup();
    world.player.resource = 40;
    setLoadoutModifiers(world, content, [{ stat: 'resource', kind: 'flat', value: 100 }]);
    expect(world.player.resource).toBe(80);
  });
});

describe('class resource: game data', () => {
  it('warrior uses Rage starting empty, ranger Energy and mage Mana starting full', () => {
    const ids = Object.fromEntries(Object.values(gameContent.classes).map((c) => [c.id, c.resource.id]));
    expect(ids).toEqual({ warrior: 'rage', ranger: 'energy', mage: 'mana' });
    for (const id of ['warrior', 'ranger', 'mage']) {
      const world = createWorld(gameContent, id, 1);
      const cls = gameContent.classes[id]!;
      expect(world.player.resource).toBe(cls.resource.startFraction * playerStat(cls, world.player, 'resource'));
    }
    expect(createWorld(gameContent, 'warrior', 1).player.resource).toBe(0);
  });

  it('every class can afford its skills from a full pool', () => {
    for (const cls of Object.values(gameContent.classes)) {
      for (const skill of cls.skills) expect(skill.resourceCost).toBeLessThanOrEqual(cls.baseStats.resource ?? 0);
    }
  });
});

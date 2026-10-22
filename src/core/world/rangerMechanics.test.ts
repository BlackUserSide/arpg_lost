// Ranger spec mechanics in the running world: distanceDamage (Sniper «Далекий постріл»), skill charges + active-trap
// cap + chain detonation (Trapper «Мінне поле»), trap slow aura (Trapper «Приманка»).
// Numbers mirror src/data/passives.ts but are local to the test.
import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import { isMechanicPending } from '../passives/mechanics';
import type { PassiveMechanic } from '../passives/types';
import { resolveAction } from '../skills/params';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { createRng } from '../rng';
import { placeTrap } from './actions';
import { slowFraction } from './mobs';
import { distanceDamageMore, skillChangeSets } from './passiveEffects';
import { conditionTarget } from './statuses';
import { chargeInfo, createWorld, setLoadoutModifiers, step, type Ctx, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

function mobDef(id: string, extra: Partial<MobDef> = {}): MobDef {
  return {
    id,
    radius: 10,
    life: 1000,
    xp: 0,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 0,
    attack: { damage: { physical: { min: 0, max: 0 } }, range: 5, interval: 1, critChance: 0 },
    ...extra,
  };
}

const MOBS: Record<string, MobDef> = { dummy: mobDef('dummy'), walker: mobDef('walker', { moveSpeed: 60 }) };

/** 600 u/s at 1/60 s steps: 10 units per step. */
const bolt: ActionDef = {
  id: 'bolt',
  tags: ['attack', 'projectile'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 1000, radius: 2, pierce: 0 },
};
const spellBolt: ActionDef = {
  id: 'spell_bolt',
  tags: ['spell', 'projectile'],
  resourceCost: 0,
  cooldown: 0,
  castTime: 0,
  damage: { source: 'skill', base: { cold: { min: 10, max: 10 } }, critChance: 0 },
  delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 1000, radius: 2, pierce: 0 },
};
const mine: ActionDef = {
  id: 'mine',
  tags: ['area'],
  resourceCost: 0,
  cooldown: 5,
  castTime: 0,
  damage: { source: 'skill', base: { fire: { min: 20, max: 20 } }, critChance: 0 },
  delivery: { kind: 'trap', throwRange: 300, armTime: 0.5, triggerRadius: 40, explodeRadius: 110, lifetime: 8 },
};
/** A second trap source (stands in for e.g. a fan of traps from an item): shares the active-trap cap. */
const mine2: ActionDef = { ...mine, id: 'mine2' };

/** Slots: 0 mine, 1 mine2, 2 spell bolt. */
function makeContent(): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'crossbow',
    baseStats: { life: 50, resource: 50, resourceRegen: 0, movementSpeed: 100 },
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack: bolt,
    skills: [mine, mine2, spellBolt],
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5 },
    classes: { hero },
    mobs: MOBS,
    arena: { width: 2000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
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

/** Ranger node data as in src/data/passives.ts. */
const FAR_SHOT: PassiveMechanic = { kind: 'distanceDamage', tags: ['attack', 'projectile'], minDistance: 150, maxDistance: 450, maxMore: 0.5 };
const PIERCING: PassiveMechanic = { kind: 'skillParams', tags: ['projectile'], changes: [{ param: 'pierce', add: 1 }] };
const MINEFIELD: PassiveMechanic = { kind: 'trapCharges', charges: 3, maxActive: 3, chainDelay: 0.15, chainRadius: 250 };
const LURE: PassiveMechanic = { kind: 'trapAura', radius: 150, slow: 0.3 };

function setup(mechanics: readonly PassiveMechanic[]): { content: Content; world: WorldState } {
  const content = makeContent();
  const world = createWorld(content, 'hero', 1, { mechanics });
  world.player.pos = vec(500, 500);
  return { content, world };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };
const skill = (slot: number, aim = idle.aim): PlayerInput => ({ ...idle, aim, skills: [0, 1, 2].map((i) => i === slot) });

function addMob(world: WorldState, x: number, y: number, defId = 'dummy'): MobState {
  const life = MOBS[defId]!.life;
  const mob: MobState = {
    id: world.nextId++,
    defId,
    pos: vec(x, y),
    facing: vec(0, 1),
    life,
    maxLife: life,
    attackTimer: 10,
    stun: 0,
    slow: 0,
    slowMagnitude: 0,
    ignite: 0,
    igniteDps: 0,
    freeze: 0,
    freezeSlow: 0,
    stunSlow: 0,
    stunBar: 0,
    stunBarIdle: 0,
    auraSlow: 0,
  };
  world.mobs.push(mob);
  return mob;
}

function run(world: WorldState, content: Content, input: PlayerInput, steps: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, content, DT));
  return events;
}

/** Throws a trap from `slot` landing exactly at (x, y): the hero stands 50 to the left and aims at the point. */
function throwAt(world: WorldState, content: Content, x: number, y: number, slot = 0): WorldEvent[] {
  world.player.pos = vec(x - 50, y);
  world.player.actionTimer = 0;
  return step(world, skill(slot, vec(x, y)), content, DT);
}

/** Moves the hero out of the way (far from traps and mobs). */
function park(world: WorldState): void {
  world.player.pos = vec(100, 100);
}

function hits(events: readonly WorldEvent[], id: number): number[] {
  return events.flatMap((e) => (e.type === 'hit' && e.targetId === id ? [e.amount] : []));
}

describe('Ranger mechanics are live', () => {
  it('distanceDamage, trapCharges and trapAura are no longer pending', () => {
    expect([FAR_SHOT, MINEFIELD, LURE].filter(isMechanicPending)).toEqual([]);
  });
});

describe('distanceDamage («Далекий постріл»)', () => {
  it('more = clamp((d − 150) / 300, 0, 1) × 0.5 for attack projectiles', () => {
    const tags = ['attack', 'projectile'] as const;
    expect(distanceDamageMore([FAR_SHOT], tags, 0)).toBe(0);
    expect(distanceDamageMore([FAR_SHOT], tags, 150)).toBe(0);
    expect(distanceDamageMore([FAR_SHOT], tags, 280)).toBe(0.21666666666666667); // archer range: +22%
    expect(distanceDamageMore([FAR_SHOT], tags, 300)).toBe(0.25);
    expect(distanceDamageMore([FAR_SHOT], tags, 450)).toBe(0.5);
    expect(distanceDamageMore([FAR_SHOT], tags, 620)).toBe(0.5);
  });

  it('needs every mechanic tag: spell projectiles and traps get nothing; two sources add up', () => {
    expect(distanceDamageMore([FAR_SHOT], ['spell', 'projectile'], 450)).toBe(0);
    expect(distanceDamageMore([FAR_SHOT], ['area'], 450)).toBe(0);
    expect(distanceDamageMore([], ['attack', 'projectile'], 450)).toBe(0);
    expect(distanceDamageMore([FAR_SHOT, FAR_SHOT], ['attack', 'projectile'], 300)).toBe(0.5);
  });

  it('a bolt hitting after 280 units deals 10 × 1.2167', () => {
    const { content, world } = setup([FAR_SHOT]);
    // Fired from x = 510, 10 units per step; touches the mob at x = 800 (2 + 10 reach) after 28 steps = 280 units.
    const mob = addMob(world, 800, 500);
    const events = step(world, attack, content, DT);
    events.push(...run(world, content, idle, 27));
    expect(hits(events, mob.id)).toEqual([12.166666666666668]);
    expect(world.projectiles).toEqual([]);
  });

  it('within 150 units there is no bonus', () => {
    const { content, world } = setup([FAR_SHOT]);
    const mob = addMob(world, 600, 500); // hit at 90 travelled
    const events = run(world, content, attack, 1).concat(run(world, content, idle, 10));
    expect(hits(events, mob.id)).toEqual([10]);
  });

  it('pierce: distance keeps accumulating, the second target gets more', () => {
    const { content, world } = setup([FAR_SHOT, PIERCING]);
    const near = addMob(world, 700, 500); // hit at 180: +5%
    const far = addMob(world, 900, 500); // hit at 380: +38.33%
    const events = run(world, content, attack, 1).concat(run(world, content, idle, 40));
    expect(hits(events, near.id)).toEqual([10.5]);
    expect(hits(events, far.id)).toEqual([13.833333333333332]);
  });

  it('a spell projectile at the same distance gets no bonus', () => {
    const { content, world } = setup([FAR_SHOT]);
    const mob = addMob(world, 800, 500);
    const events = run(world, content, skill(2), 1).concat(run(world, content, idle, 30));
    expect(hits(events, mob.id)).toEqual([10]);
  });

  it('a trap thrown 300 units away gets no bonus', () => {
    const { content, world } = setup([FAR_SHOT]);
    const mob = addMob(world, 800, 500);
    const events = run(world, content, skill(0), 1).concat(run(world, content, idle, 40));
    expect(hits(events, mob.id)).toEqual([20]);
  });

  it('travelled distance is a plain number on the projectile', () => {
    const { content, world } = setup([FAR_SHOT]);
    step(world, attack, content, DT);
    expect(world.projectiles[0]!.travelled).toBe(10);
  });
});

describe('skill charges (generic, «Мінне поле»)', () => {
  it('trapCharges grants trap actions 3 charges, a cap of 3 traps and chain rules; other actions are untouched', () => {
    const sets = skillChangeSets([MINEFIELD]);
    const resolved = resolveAction(mine, sets);
    expect(resolved.charges).toBe(3);
    expect(resolved.delivery).toEqual({ ...mine.delivery, maxActive: 3, chain: { delay: 0.15, radius: 250 } });
    expect(resolveAction(bolt, sets)).toBe(bolt);
    expect(resolveAction(mine, skillChangeSets([LURE])).delivery).toEqual({ ...mine.delivery, aura: { radius: 150, slow: 0.3 } });
  });

  it('several grants: charges take the highest, the cap the lowest; a charges param adds on top', () => {
    const resolved = resolveAction(mine, [
      { deliveries: ['trap'], grants: { charges: 2, maxActiveTraps: 5 } },
      { deliveries: ['trap'], grants: { charges: 3, maxActiveTraps: 3 } },
      { skillIds: ['mine'], changes: [{ param: 'charges', add: 1 }] },
    ]);
    expect(resolved.charges).toBe(4);
    expect(resolved.delivery).toEqual({ ...mine.delivery, maxActive: 3 });
    expect(resolveAction(bolt, [{ deliveries: ['trap'], grants: { charges: 3 } }])).toBe(bolt);
  });

  it('spawn full; each throw spends a charge; the first throw starts the recharge, later ones do not reset it', () => {
    const { content, world } = setup([MINEFIELD]);
    const action = world.player.actions.skills[0]!;
    expect(chargeInfo(world.player, action)).toEqual({ charges: 3, max: 3, recharge: 0 });
    run(world, content, skill(0), 1);
    expect(world.player.charges.mine).toBe(2);
    expect(world.player.cooldowns.mine).toBe(5);
    run(world, content, skill(0), 2);
    expect(world.player.charges.mine).toBe(0);
    expect(world.player.cooldowns.mine).toBe(5 - DT - DT);
    expect(world.traps).toHaveLength(3);
    // Out of charges: holding the key does nothing.
    run(world, content, skill(0), 1);
    expect(world.traps).toHaveLength(3);
    expect(world.player.charges.mine).toBe(0);
  });

  it('charges recharge one at a time, 5 s each (steps 301, 601, 901 after the first throw), then the timer rests at 0', () => {
    const { content, world } = setup([MINEFIELD]);
    run(world, content, skill(0), 3); // steps 1..3
    const restored: number[] = [];
    for (let n = 4; n <= 1000; n++) {
      const before = world.player.charges.mine!;
      step(world, idle, content, DT);
      if (world.player.charges.mine! > before) restored.push(n);
    }
    expect(restored).toEqual([301, 601, 901]);
    expect(world.player.charges.mine).toBe(3);
    expect(world.player.cooldowns.mine).toBe(0);
  });

  it('without the mechanic the trap has a plain 5 s cooldown and no charge state', () => {
    const { content, world } = setup([]);
    run(world, content, skill(0), 3);
    expect(world.traps).toHaveLength(1);
    expect(world.player.charges).toEqual({});
    expect(world.player.cooldowns.mine).toBe(5 - DT - DT);
  });

  it('mid-run: gaining charges keeps what the hero had (ready = 1, on cooldown = 0); losing them makes a stored charge ready', () => {
    const { content, world } = setup([]);
    setLoadoutModifiers(world, content, [], [MINEFIELD]);
    expect(world.player.charges.mine).toBe(1);
    expect(world.player.cooldowns.mine).toBe(5);

    const b = setup([]);
    run(b.world, b.content, skill(0), 1);
    run(b.world, b.content, idle, 60);
    const left = b.world.player.cooldowns.mine!;
    setLoadoutModifiers(b.world, b.content, [], [MINEFIELD]);
    expect(b.world.player.charges.mine).toBe(0);
    expect(b.world.player.cooldowns.mine).toBe(left);

    const c = setup([MINEFIELD]);
    run(c.world, c.content, skill(0), 1);
    setLoadoutModifiers(c.world, c.content, [], []);
    expect(c.world.player.charges).toEqual({});
    expect(c.world.player.cooldowns.mine).toBe(0);
  });
});

describe('active-trap cap', () => {
  it('a 4th trap removes the oldest without exploding; the cap counts every trap source', () => {
    const { content, world } = setup([MINEFIELD]);
    const ids: number[] = [];
    for (const x of [600, 900, 1200]) {
      throwAt(world, content, x, 500);
      ids.push(world.traps.at(-1)!.id);
    }
    const events = throwAt(world, content, 1500, 500, 1); // mine2: another trap source
    expect(events).toContainEqual({ type: 'trapRemoved', trapId: ids[0], pos: vec(600, 500), reason: 'limit' });
    expect(events.some((e) => e.type === 'area')).toBe(false);
    expect(world.traps.map((t) => t.id)).toEqual([ids[1], ids[2], world.nextId - 1]);
  });

  it('without the mechanic traps of different sources are not capped', () => {
    const { content, world } = setup([]);
    throwAt(world, content, 600, 500, 0);
    throwAt(world, content, 900, 500, 1);
    expect(world.traps).toHaveLength(2);
  });
});

describe('chain detonation', () => {
  it('an explosion sets off traps within 250 after 0.15 s (9 steps), and they chain on; each trap once', () => {
    const { content, world } = setup([MINEFIELD]);
    throwAt(world, content, 800, 500); // A
    throwAt(world, content, 550, 500); // B: exactly 250 from A
    throwAt(world, content, 300, 500); // C: 250 from B, 500 from A

    park(world);
    run(world, content, idle, 40); // all armed
    addMob(world, 840, 500); // next to A only
    const areas: { step: number; origin: number; chain: boolean }[] = [];
    for (let n = 0; n < 40; n++) {
      for (const e of step(world, idle, content, DT)) {
        if (e.type === 'area') areas.push({ step: n, origin: e.origin.x, chain: e.chain === true });
      }
    }
    expect(areas).toEqual([
      { step: 0, origin: 800, chain: false },
      { step: 9, origin: 550, chain: true },
      { step: 18, origin: 300, chain: true },
    ]);
    expect(world.traps).toEqual([]);
  });

  it('traps beyond 250 are not chained; a trap still arming is', () => {
    const { content, world } = setup([MINEFIELD]);
    throwAt(world, content, 800, 500); // A
    throwAt(world, content, 800, 751); // 251 away: not chained
    park(world);
    run(world, content, idle, 40);
    throwAt(world, content, 600, 500); // 200 away, thrown now: still arming when the chain reaches it
    park(world);
    addMob(world, 840, 500);
    const areas: { step: number; x: number; y: number; chain: boolean }[] = [];
    for (let n = 0; n < 20; n++) {
      for (const e of step(world, idle, content, DT)) {
        if (e.type === 'area') areas.push({ step: n, x: e.origin.x, y: e.origin.y, chain: e.chain === true });
      }
    }
    expect(areas).toEqual([
      { step: 0, x: 800, y: 500, chain: false },
      { step: 9, x: 600, y: 500, chain: true },
    ]);
    expect(world.traps.map((t) => t.pos)).toEqual([vec(800, 751)]);
    expect(world.traps[0]!.chainTimer).toBeNull();
  });

  it('no chain without the mechanic', () => {
    const { content, world } = setup([]);
    throwAt(world, content, 800, 500, 0);
    throwAt(world, content, 600, 500, 1);
    park(world);
    run(world, content, idle, 40);
    addMob(world, 840, 500);
    const events = run(world, content, idle, 20);
    expect(events.filter((e) => e.type === 'area')).toHaveLength(1);
    expect(world.traps).toHaveLength(1);
  });
});

describe('trap aura («Приманка»)', () => {
  it('an armed trap slows enemies within 150 (+ their radius) by 30%; arming traps do not', () => {
    const { content, world } = setup([LURE]);
    throwAt(world, content, 800, 500);
    park(world);
    const inRange = addMob(world, 955, 500); // 155 ≤ 150 + 10
    const outside = addMob(world, 965, 500); // 165 > 160
    step(world, idle, content, DT);
    expect(inRange.auraSlow).toBe(0); // still arming
    run(world, content, idle, 30);
    expect(world.traps[0]!.armTimer).toBe(0);
    expect(inRange.auraSlow).toBe(0.3);
    expect(outside.auraSlow).toBe(0);
    expect(slowFraction(inRange, content)).toBe(0.3);
    expect(conditionTarget(inRange).slow).toBeGreaterThan(0);
    expect(conditionTarget(outside).slow).toBe(0);
  });

  it('slows movement while in range, and stops on the step after the mob leaves it', () => {
    const { content, world } = setup([LURE]);
    throwAt(world, content, 800, 500);
    world.player.pos = vec(1600, 500);
    run(world, content, idle, 31);
    const walker = addMob(world, 900, 500, 'walker'); // 100 from the trap, walks towards the hero (away from the trap)
    step(world, idle, content, DT); // aura applied at the end of this step
    const x0 = walker.pos.x;
    step(world, idle, content, DT);
    expect(walker.pos.x - x0).toBeCloseTo(60 * 0.7 * DT, 12);
    walker.pos = vec(1300, 500); // out of range
    step(world, idle, content, DT); // still slowed this step (last step's aura), then recomputed
    expect(walker.auraSlow).toBe(0);
    const x1 = walker.pos.x;
    step(world, idle, content, DT);
    expect(walker.pos.x - x1).toBeCloseTo(60 * DT, 12);
  });

  it('own slot: the strongest slow applies, and a weaker longer slow is not upgraded by the aura', () => {
    const { content, world } = setup([LURE]);
    throwAt(world, content, 800, 500);
    park(world);
    run(world, content, idle, 31);
    const mob = addMob(world, 900, 500);
    mob.slow = 10;
    mob.slowMagnitude = 0.2;
    step(world, idle, content, DT);
    expect(slowFraction(mob, content)).toBe(0.3);
    mob.pos = vec(1500, 500);
    step(world, idle, content, DT);
    expect(mob.slowMagnitude).toBe(0.2);
    expect(slowFraction(mob, content)).toBe(0.2);
  });

  it('the aura ends when the trap explodes', () => {
    const { content, world } = setup([LURE]);
    throwAt(world, content, 800, 500);
    park(world);
    run(world, content, idle, 31);
    const far = addMob(world, 920, 500);
    step(world, idle, content, DT);
    expect(far.auraSlow).toBe(0.3);
    addMob(world, 830, 500); // triggers the trap
    step(world, idle, content, DT);
    expect(world.traps).toEqual([]);
    expect(far.auraSlow).toBe(0);
  });
});

describe('determinism and JSON', () => {
  function scenario(): { world: WorldState; content: Content; log: string } {
    const { content, world } = setup([FAR_SHOT, PIERCING, MINEFIELD, LURE]);
    addMob(world, 900, 500, 'walker');
    addMob(world, 950, 560, 'walker');
    const events: WorldEvent[] = [];
    events.push(...throwAt(world, content, 800, 500));
    events.push(...throwAt(world, content, 650, 520));
    world.player.pos = vec(400, 500);
    events.push(...run(world, content, attack, 90));
    return { world, content, log: JSON.stringify(events) };
  }

  it('same seed, same events; the world survives a JSON round trip and continues identically', () => {
    const a = scenario();
    const b = scenario();
    expect(a.log).toBe(b.log);
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
    const clone = JSON.parse(JSON.stringify(a.world)) as WorldState;
    expect(clone).toEqual(a.world);
    const next = JSON.stringify(run(a.world, a.content, skill(0), 60));
    expect(JSON.stringify(run(clone, a.content, skill(0), 60))).toBe(next);
    expect(JSON.stringify(clone)).toBe(JSON.stringify(a.world));
  });
});

describe('package 4 review follow-ups', () => {
  it('a trap removed by the cap drops its aura at once (placeTrap recomputes auras)', () => {
    const { content, world } = setup([MINEFIELD, LURE]);
    for (const x of [600, 900, 1200]) throwAt(world, content, x, 500);
    park(world);
    run(world, content, idle, 31);
    const mob = addMob(world, 600, 620); // 120 from the oldest trap only
    step(world, idle, content, DT);
    expect(mob.auraSlow).toBe(0.3);
    const ctx: Ctx = { world, content, classDef: content.classes.hero!, rng: createRng(1), events: [], input: idle };
    const newest = world.traps.at(-1)!;
    placeTrap(ctx, { ...newest, id: world.nextId++, pos: vec(1500, 500) }, 3);
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: 'trapRemoved', pos: vec(600, 500) }));
    expect(mob.auraSlow).toBe(0);
  });

  it('a chain-pending trap triggered by a mob first explodes once, without the chain flag', () => {
    const { content, world } = setup([MINEFIELD]);
    throwAt(world, content, 800, 500); // A
    throwAt(world, content, 600, 500); // B, 200 from A
    park(world);
    run(world, content, idle, 40);
    addMob(world, 840, 500);
    const areas: { step: number; x: number; chain: boolean }[] = [];
    const record = (n: number, events: WorldEvent[]): void => {
      for (const e of events) if (e.type === 'area') areas.push({ step: n, x: e.origin.x, chain: e.chain === true });
    };
    record(0, step(world, idle, content, DT)); // A explodes, B scheduled for 9 steps later
    expect(world.traps[0]!.chainTimer).toBe(0.15);
    addMob(world, 630, 500); // steps on B before the chain reaches it
    for (let n = 1; n < 20; n++) record(n, step(world, idle, content, DT));
    expect(areas).toEqual([
      { step: 0, x: 800, chain: false },
      { step: 1, x: 600, chain: false },
    ]);
    expect(world.traps).toEqual([]);
  });

  it('charges recharge faster with cooldown recovery: +25% → 4 s each (steps 241, 481, 721)', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1, { mechanics: [MINEFIELD], modifiers: [{ stat: 'cooldownRecovery', kind: 'increased', value: 0.25 }] });
    world.player.pos = vec(500, 500);
    run(world, content, skill(0), 3);
    const restored: number[] = [];
    for (let n = 4; n <= 800; n++) {
      const before = world.player.charges.mine!;
      step(world, idle, content, DT);
      if (world.player.charges.mine! > before) restored.push(n);
    }
    expect(restored).toEqual([241, 481, 721]);
    expect(world.player.cooldowns.mine).toBe(0);
  });
});

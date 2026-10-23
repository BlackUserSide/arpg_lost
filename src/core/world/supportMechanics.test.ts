// Skill modifier (support) mechanics in the running world (docs/design/skill-modifiers.md): bleed, knockback, chain
// lightning, echo, extra projectiles, pierce, area, ignite on hit (conversion), cast speed, pure power, vampirism,
// wider swing, fast projectiles, stun (incl. the Guardian stun-bar variant), cost multipliers and support drops.
// The support numbers here are test data, not the balance data of src/data/supports.ts.
import { describe, expect, it } from 'vitest';
import { computeDamage } from '../combat/damage';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import { createRng } from '../rng';
import { mergeBonuses } from '../skills/levels';
import { resolveAction } from '../skills/params';
import type { SkillBonus, SkillChangeSet } from '../skills/types';
import type { SupportData, SupportDef, SupportRef } from '../supports/types';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { useTime } from './actions';
import { applyBleed, bleedDps, conditionTarget, tickBleed } from './statuses';
import { createWorld, getClass, setLoadoutModifiers, step, type Ctx, type Loadout, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const mobDef = (id: string, extra: Partial<MobDef> = {}): MobDef => ({
  id,
  radius: 10,
  life: 1000,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 1, max: 1 } }, range: 5, interval: 1, critChance: 0 },
  ...extra,
});

const MOBS: Record<string, MobDef> = {
  dummy: mobDef('dummy'),
  elite: mobDef('elite', { elite: true }),
  boss: mobDef('boss', { boss: true }),
  fireResist: mobDef('fireResist', { resistances: { fire: 0.5, cold: 0, lightning: 0 } }),
  shockResist: mobDef('shockResist', { resistances: { fire: 0, cold: 0, lightning: 0.5 } }),
  brute: mobDef('brute', { attack: { damage: { physical: { min: 1, max: 1 } }, range: 500, interval: 1, critChance: 0 } }),
};

/** Melee attack arc: 10 physical (weapon 10, effectiveness 1). */
const slash: ActionDef = {
  id: 'slash',
  tags: ['attack', 'melee'],
  resourceCost: 10,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 60, angleDeg: 90 },
};
/** Spell projectile: 20 cold, no explosion. */
const zap: ActionDef = {
  id: 'zap',
  tags: ['spell', 'projectile'],
  resourceCost: 10,
  cooldown: 0,
  castTime: 0.5,
  damage: { source: 'skill', base: { cold: { min: 20, max: 20 } }, critChance: 0 },
  delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 600, radius: 2, pierce: 0 },
};
/** Spell nova: 20 cold around the hero. */
const nova: ActionDef = {
  id: 'nova',
  tags: ['spell', 'area'],
  resourceCost: 10,
  cooldown: 0,
  castTime: 0,
  damage: { source: 'skill', base: { cold: { min: 20, max: 20 } }, critChance: 0 },
  delivery: { kind: 'arc', radius: 100, angleDeg: 360 },
};

const hero: ClassDef = {
  id: 'hero',
  radius: 10,
  weaponType: 'sword',
  baseStats: { life: 100, resource: 100, resourceRegen: 0, movementSpeed: 100 },
  resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
  weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
  basicAttack: { ...slash, id: 'strike', resourceCost: 0 },
  skills: [slash, zap, nova],
};

const support = (id: string, bonus: SkillBonus, resourceCostMultiplier = 1, variants?: SupportDef['tiers'][number]['variants']): SupportDef => ({
  id,
  group: 'general',
  compatibility: {},
  resourceCostMultiplier,
  weight: 100,
  tiers: [{ bonus, ...(variants ? { variants } : {}) }],
});

const supports: SupportData = {
  rules: { slotsPerSkill: 2, tabSize: 30, tierMinLevel: [1], tierWeights: [1], dropChance: { normal: 0, elite: 0, boss: 0 }, salvage: [1] },
  supports: {
    bleed: support('bleed', { addOnHit: [{ status: 'bleed', duration: 2, magnitude: 0.5, maxStacks: 3 }] }),
    knockback: support('knockback', { grants: { knockback: { distance: 60, speed: 600, eliteMultiplier: 0.5 } } }),
    chain: support('chain', { grants: { chainHit: { hops: 2, range: 150, effectiveness: 0.5, damageType: 'lightning' } } }, 1.4),
    echo: support('echo', { grants: { echo: { chance: 1, delay: 0.25 } } }, 1.3),
    extra: support('extra', { changes: [{ param: 'projectileCount', add: 2 }, { param: 'spread', add: 20 }], modifiers: [{ stat: 'damage', kind: 'more', value: -0.3 }] }),
    pierce: support('pierce', { changes: [{ param: 'pierce', add: 2 }] }),
    fast: support('fast', { changes: [{ param: 'projectileSpeed', increased: 0.5 }, { param: 'range', increased: 0.25 }] }),
    area: support('area', { changes: [{ param: 'radius', increased: 0.5 }, { param: 'explodeRadius', increased: 0.5 }] }),
    ignite: support('ignite', { addOnHit: [{ status: 'ignite', duration: 2, magnitude: 0.5 }], damageConversion: { to: 'fire', fraction: 0.5 } }),
    haste: support('haste', { modifiers: [{ stat: 'castSpeed', kind: 'increased', value: 0.25 }, { stat: 'attackSpeed', kind: 'increased', value: 0.25 }] }),
    power: support('power', { modifiers: [{ stat: 'damage', kind: 'more', value: 0.5 }] }, 1.4),
    vampirism: support('vampirism', { leech: 0.1 }),
    wide: support('wide', { changes: [{ param: 'angle', increased: 0.5 }, { param: 'radius', increased: 0.2 }] }),
    stun: support('stun', { addOnHit: [{ status: 'stun', duration: 1, chance: 1 }] }, 1, [{ mechanic: 'stunBar', bonus: { stunBarFillIncreased: 1 } }]),
  },
};

function makeContent(data: SupportData | null = supports): Content {
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5 },
    classes: { hero },
    mobs: MOBS,
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
    progression: {
      maxLevel: 5,
      xpCurve: { base: 1000, exponent: 1 },
      mobXpGrowth: 0,
      lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
      mapClearBonus: 0.1,
      perLevel: {},
    },
    ...(data ? { supports: data } : {}),
  };
}

const content = makeContent();
const refs = (...ids: string[]): SupportRef[] => ids.map((defId) => ({ defId, tier: 1 }));

function world(socketed: Record<string, SupportRef[]>, loadout: Loadout = {}, c: Content = content): WorldState {
  return createWorld(c, 'hero', 1, { ...loadout, supports: socketed });
}

function addMob(w: WorldState, x: number, y: number, defId = 'dummy', life = 1000): MobState {
  const mob: MobState = { id: w.nextId++, defId, pos: vec(x, y), facing: vec(0, 1), life, maxLife: life, attackTimer: 10, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0 };
  w.mobs.push(mob);
  return mob;
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
/** Uses skill slot `slot` (0 = slash, 1 = zap, 2 = nova), aiming right. */
const use = (slot: number): PlayerInput => ({ ...idle, skills: [slot === 0, slot === 1, slot === 2] });

function run(w: WorldState, steps: number, input: PlayerInput = idle, c: Content = content): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(w, i === 0 ? input : idle, c, DT));
  return events;
}

const hits = (events: readonly WorldEvent[], targetId?: number): number[] =>
  events.flatMap((e) => (e.type === 'hit' && e.targetId !== 0 && (targetId === undefined || e.targetId === targetId) ? [e.amount] : []));

function ctxOf(w: WorldState, events: WorldEvent[] = []): Ctx {
  return { world: w, content, classDef: getClass(content, 'hero'), rng: createRng(1), events, input: idle };
}

describe('resource cost', () => {
  it('two supports multiply the cost (designer decision 2026-10-23): 10 × 1.4 × 1.3 = 18.2', () => {
    const w = world({ slash: refs('power', 'echo') });
    expect(w.player.actions.skills[0]!.resourceCost).toBeCloseTo(18.2, 10);
    addMob(w, 540, 500);
    run(w, 1, use(0));
    expect(w.player.resource).toBeCloseTo(100 - 18.2, 10);
  });

  it('supports change only their own skill', () => {
    const w = world({ slash: refs('power') });
    expect(w.player.actions.skills[1]).toBe(zap);
    expect(w.player.actions.basicAttack).toBe(hero.basicAttack);
  });
});

describe('bleed', () => {
  it('a hit adds a stack (hit damage × magnitude over the duration) and restarts the shared timer; at most 3 stacks', () => {
    const w = world({});
    const mob = addMob(w, 540, 500);
    const events: WorldEvent[] = [];
    const ctx = ctxOf(w, events);
    applyBleed(ctx, mob, 10, 2, 3);
    expect(events).toEqual([{ type: 'status', targetId: mob.id, pos: mob.pos, status: 'bleed', duration: 2, stacks: 1 }]);
    mob.bleed = 0.5;
    applyBleed(ctx, mob, 20, 2, 3);
    applyBleed(ctx, mob, 30, 2, 3);
    expect(mob.bleedStacks).toEqual([5, 10, 15]);
    expect(mob.bleed).toBe(2);
    // A 4th stack replaces the oldest.
    applyBleed(ctx, mob, 40, 2, 3);
    expect(mob.bleedStacks).toEqual([10, 15, 20]);
    expect(bleedDps(mob)).toBe(45);
    expect(conditionTarget(mob).bleed).toBe(2);
  });

  it('ticks physical damage every step (not reduced by armour) and ends with its timer', () => {
    const w = world({});
    const mob = addMob(w, 540, 500);
    const events: WorldEvent[] = [];
    const ctx = ctxOf(w, events);
    applyBleed(ctx, mob, 12, 2, 3);
    events.length = 0;
    tickBleed(ctx, mob, DT);
    expect(events).toEqual([{ type: 'dot', targetId: mob.id, pos: mob.pos, amount: 6 * DT, status: 'bleed' }]);
    for (let i = 1; i < 120; i++) tickBleed(ctx, mob, DT);
    expect(mob.life).toBeCloseTo(1000 - 12, 9);
    expect(mob.bleed).toBe(0);
    expect(mob.bleedStacks).toEqual([]);
    tickBleed(ctx, mob, DT);
    expect(mob.life).toBeCloseTo(1000 - 12, 9);
  });

  it('a stack after the bleed ended starts fresh', () => {
    const w = world({});
    const mob = addMob(w, 540, 500);
    const ctx = ctxOf(w);
    applyBleed(ctx, mob, 10, 2, 3);
    mob.bleed = 0;
    applyBleed(ctx, mob, 20, 2, 3);
    expect(mob.bleedStacks).toEqual([10]);
  });

  it('the Bleed support makes the skill bleed: 10 hit → 2.5 per second per stack, stacking per swing', () => {
    const w = world({ slash: refs('bleed') });
    const mob = addMob(w, 540, 500);
    const events = run(w, 1, use(0));
    expect(hits(events, mob.id)).toEqual([10]);
    expect(events).toContainEqual({ type: 'status', targetId: mob.id, pos: mob.pos, status: 'bleed', duration: 2, stacks: 1 });
    // Instant hits bleed in the same step (like ignite).
    expect(events.find((e) => e.type === 'dot')).toEqual({ type: 'dot', targetId: mob.id, pos: mob.pos, amount: 2.5 * DT, status: 'bleed' });
    // Next swing once the 0.5 s attack time is over (2 attacks per second): a second stack.
    run(w, 30);
    run(w, 1, use(0));
    expect(mob.bleedStacks).toEqual([2.5, 2.5]);
    expect(mob.bleed).toBeCloseTo(2 - DT, 9);
  });
});

describe('knockback', () => {
  it('pushes a mob away from the hero by distance at speed; it does not attack while pushed', () => {
    const w = world({ slash: refs('knockback') });
    const mob = addMob(w, 540, 500, 'brute');
    mob.attackTimer = 0;
    const first = run(w, 1, use(0));
    expect(first).toContainEqual({ type: 'knockback', targetId: mob.id, pos: vec(540, 500), dir: vec(1, 0), distance: 60 });
    expect(first.some((e) => e.type === 'mobAttack')).toBe(false);
    // 600 per second: 10 per step, 60 in 6 steps (the first one included).
    expect(mob.pos.x).toBeCloseTo(550, 9);
    const rest = run(w, 5);
    expect(mob.pos.x).toBeCloseTo(600, 9);
    expect(mob.knockback).toBeUndefined();
    expect(rest.some((e) => e.type === 'mobAttack')).toBe(false);
    expect(run(w, 1).some((e) => e.type === 'mobAttack')).toBe(true);
  });

  it('elites are pushed half as far; bosses are never pushed (designer decision 2026-10-23)', () => {
    const w = world({ slash: refs('knockback') });
    const elite = addMob(w, 540, 490, 'elite');
    const boss = addMob(w, 540, 510, 'boss');
    const events = run(w, 10, use(0));
    expect(events.filter((e) => e.type === 'knockback').map((e) => (e.type === 'knockback' ? [e.targetId, e.distance] : []))).toEqual([[elite.id, 30]]);
    expect(boss.pos).toEqual(vec(540, 510));
    expect(boss.knockback).toBeUndefined();
  });
});

describe('chain lightning', () => {
  it('a projectile hit releases a bolt hopping to the 2 nearest other mobs at 50% of the base damage, as lightning', () => {
    const w = world({ zap: refs('chain') });
    const a = addMob(w, 600, 500);
    const b = addMob(w, 700, 500, 'shockResist');
    const c = addMob(w, 650, 600);
    const far = addMob(w, 900, 900);
    const events = run(w, 20, use(1));
    expect(events.filter((e) => e.type === 'chain')).toEqual([
      { type: 'chain', actionId: 'zap', fromId: a.id, targetIds: [b.id, c.id], points: [a.pos, b.pos, c.pos], damageType: 'lightning' },
    ]);
    expect(hits(events, a.id)).toEqual([20]);
    // 20 × 0.5 = 10 lightning; the shock-resistant mob takes half.
    expect(hits(events, b.id)).toEqual([5]);
    expect(hits(events, c.id)).toEqual([10]);
    expect(hits(events, far.id)).toEqual([]);
  });

  it('an area impact chains from its closest target to mobs outside the area', () => {
    const w = world({ nova: refs('chain') });
    const near = addMob(w, 550, 500);
    const inside = addMob(w, 500, 580);
    const out = addMob(w, 650, 500);
    const events = run(w, 1, use(2));
    expect(events.filter((e) => e.type === 'chain').map((e) => (e.type === 'chain' ? [e.fromId, e.targetIds] : []))).toEqual([[near.id, [out.id]]]);
    expect(hits(events, inside.id)).toEqual([20]);
    expect(hits(events, out.id)).toEqual([10]);
  });

  it('no bolt without another mob in range', () => {
    const w = world({ zap: refs('chain') });
    addMob(w, 600, 500);
    addMob(w, 900, 900);
    expect(run(w, 20, use(1)).some((e) => e.type === 'chain')).toBe(false);
  });
});

describe('echo', () => {
  it('repeats the skill for free after the delay, once; an echo never echoes again', () => {
    const w = world({ slash: refs('echo') });
    const mob = addMob(w, 540, 500);
    const events: WorldEvent[][] = [];
    for (let i = 0; i < 40; i++) events.push(step(w, i === 0 ? use(0) : idle, content, DT));
    const cost = 10 * 1.3;
    expect(w.player.resource).toBeCloseTo(100 - cost, 9);
    const echoStep = events.findIndex((e) => e.some((x) => x.type === 'echo'));
    // 0.25 s after the use: 15 steps later.
    expect(echoStep).toBe(15);
    expect(events[echoStep]).toContainEqual({ type: 'echo', actionId: 'slash', pos: vec(500, 500), facing: vec(1, 0) });
    expect(hits(events.flat(), mob.id)).toEqual([10, 10]);
    expect(events.flat().filter((e) => e.type === 'action')).toHaveLength(1);
    expect(events.flat().filter((e) => e.type === 'echo')).toHaveLength(1);
    expect(w.player.echoes).toEqual([]);
  });

  it('keeps the original aim: a projectile echo flies the same direction from where the hero is now', () => {
    const w = world({ zap: refs('echo') });
    run(w, 1, use(1));
    w.player.pos = vec(500, 300);
    w.player.facing = vec(0, 1);
    run(w, 15);
    const echoed = w.projectiles.at(-1)!;
    expect(w.projectiles).toHaveLength(2);
    expect(echoed.dir).toEqual(vec(1, 0));
    expect(echoed.pos.y).toBe(300);
  });
});

describe('projectile supports', () => {
  it('extra projectiles: +2 projectiles fanned over +20°, each weaker', () => {
    const w = world({ zap: refs('extra') });
    const zapped = w.player.actions.skills[1]!;
    expect(zapped.delivery).toMatchObject({ count: 3, spreadDeg: 20 });
    run(w, 1, use(1));
    expect(w.projectiles.map((p) => Math.round((Math.atan2(p.dir.y, p.dir.x) * 180) / Math.PI))).toEqual([-10, 0, 10]);
    const mob = addMob(w, 600, 500);
    expect(hits(run(w, 20), mob.id)).toEqual([14]);
  });

  it('pierce: passes through 2 enemies and hits a third', () => {
    const w = world({ zap: refs('pierce') });
    const mobs = [addMob(w, 600, 500), addMob(w, 650, 500), addMob(w, 700, 500), addMob(w, 750, 500)];
    const events = run(w, 30, use(1));
    expect(mobs.map((m) => hits(events, m.id).length)).toEqual([1, 1, 1, 0]);
  });

  it('fast projectiles: speed and range', () => {
    const w = world({ zap: refs('fast') });
    expect(w.player.actions.skills[1]!.delivery).toMatchObject({ speed: 900, range: 750 });
  });
});

describe('area, swing, speed, damage supports', () => {
  it('increased area: the nova reaches 150 instead of 100', () => {
    const w = world({ nova: refs('area') });
    const mob = addMob(w, 640, 500);
    expect(w.player.actions.skills[2]!.delivery).toEqual({ kind: 'arc', radius: 150, angleDeg: 360 });
    expect(hits(run(w, 1, use(2)), mob.id)).toEqual([20]);
  });

  it('wider swing: angle and radius of the arc', () => {
    const w = world({ slash: refs('wide') });
    expect(w.player.actions.skills[0]!.delivery).toEqual({ kind: 'arc', radius: 72, angleDeg: 135 });
    // 60° off the facing: outside a 90° arc, inside 135°.
    const mob = addMob(w, 500 + 50 * Math.cos(Math.PI / 3), 500 + 50 * Math.sin(Math.PI / 3));
    expect(hits(run(w, 1, use(0)), mob.id)).toEqual([10]);
  });

  it('cast speed: +25% cast and attack speed for this skill only', () => {
    const w = world({ zap: refs('haste'), slash: refs('haste') });
    run(w, 1, use(1));
    expect(w.player.actionTimer).toBeCloseTo(0.5 / 1.25, 9);
    const ctx = ctxOf(w);
    expect(useTime(ctx, w.player.actions.skills[0]!)).toBeCloseTo(1 / 2.5, 9);
    expect(useTime(ctx, w.player.actions.basicAttack)).toBeCloseTo(0.5, 9);
  });

  it('pure power: 50% more damage', () => {
    const w = world({ slash: refs('power') });
    const mob = addMob(w, 540, 500);
    expect(hits(run(w, 1, use(0)), mob.id)).toEqual([15]);
  });

  it('vampirism: the hero leeches 10% of the life removed', () => {
    const w = world({ slash: refs('vampirism') });
    w.player.life = 50;
    addMob(w, 540, 500);
    run(w, 1, use(0));
    expect(w.player.life).toBeCloseTo(51, 9);
  });

  it('ignite on hit: half of the damage becomes fire (fire modifiers and resistance apply) and the hit ignites', () => {
    const w = world({ slash: refs('ignite') });
    const mob = addMob(w, 540, 500, 'fireResist');
    const events = run(w, 1, use(0));
    // 5 physical + 5 fire at 50% fire resistance.
    expect(hits(events, mob.id)).toEqual([7.5]);
    expect(events).toContainEqual({ type: 'status', targetId: mob.id, pos: mob.pos, status: 'ignite', duration: 2 });
    expect(computeDamage({ physical: 10 }, [{ stat: 'damage', kind: 'increased', value: 1, tags: ['fire'] }], ['attack'], { to: 'fire', fraction: 0.5 })).toEqual({
      physical: 5,
      fire: 10,
    });
  });
});

describe('stun support', () => {
  it('stuns on hit without the stun bar', () => {
    const w = world({ slash: refs('stun') });
    const mob = addMob(w, 540, 500);
    expect(run(w, 1, use(0))).toContainEqual({ type: 'status', targetId: mob.id, pos: mob.pos, status: 'stun', duration: 1 });
  });

  it('with the stun bar (Guardian) it fills the bar more instead of rolling stuns', () => {
    const bar: PassiveMechanic = { kind: 'stunBar', baseFill: 0.1, damageFill: 1, stunDuration: 1, bossFillFactor: 0.5, bossStunDuration: 1, decayDelay: 5, decayPerSecond: 0.5 };
    const plain = createWorld(content, 'hero', 1, { mechanics: [bar] });
    const supported = world({ slash: refs('stun') }, { mechanics: [bar] });
    const a = addMob(plain, 540, 500);
    const b = addMob(supported, 540, 500);
    run(plain, 1, use(0));
    const events = run(supported, 1, use(0));
    // (0.1 + 10 / 1000) = 0.11, doubled by +100% fill.
    expect(a.stunBar).toBeCloseTo(0.11, 9);
    expect(b.stunBar).toBeCloseTo(0.22, 9);
    expect(events.some((e) => e.type === 'status' && e.status === 'stun')).toBe(false);
  });
});

describe('support drops in the world', () => {
  const dropping: SupportData = { ...supports, rules: { ...supports.rules, dropChance: { normal: 1, elite: 1, boss: 1 } } };

  it('a kill drops a support (supportDrop event, WorldState.supportDrops) from its own rng stream', () => {
    const c = makeContent(dropping);
    const w = createWorld(c, 'hero', 5);
    const mob = addMob(w, 900, 900, 'dummy', 0);
    const events = step(w, idle, c, DT);
    expect(w.supportDrops).toEqual([{ defId: 'stun', tier: 1 }]);
    expect(events).toContainEqual({ type: 'supportDrop', mobId: mob.id, pos: mob.pos, defId: 'stun', tier: 1 });
    // Combat randomness is untouched by loot.
    const plain = createWorld(makeContent(null), 'hero', 5);
    addMob(plain, 900, 900, 'dummy', 0);
    step(plain, idle, makeContent(null), DT);
    expect(w.rngState).toBe(plain.rngState);
    expect(w.lootRngState).not.toBe(plain.lootRngState);
  });

  it('no drop roll without a chance: the loot stream does not advance on a 0% normal mob except its one draw', () => {
    const w = createWorld(content, 'hero', 5);
    const before = w.lootRngState;
    addMob(w, 900, 900, 'dummy', 0);
    step(w, idle, content, DT);
    expect(w.supportDrops).toEqual([]);
    expect(w.lootRngState).not.toBe(before);
  });
});

describe('supports across loadout rebuilds', () => {
  it('a passive change mid-run keeps the socketed supports in the effective skills', () => {
    const w = world({ slash: refs('power') });
    setLoadoutModifiers(w, content, [], []);
    expect(w.player.actions.skills[0]!.modifiers).toEqual([{ stat: 'damage', kind: 'more', value: 0.5 }]);
  });
});

describe('vampirism with the lifeLeech keystone', () => {
  /** Keystone fixture: 5% leech, capped at 20% of max life per second (20 life for the 100-life hero). */
  const keystone: PassiveMechanic = { kind: 'lifeLeech', fraction: 0.05, maxPerSecond: 0.2 };
  /** ×30 damage: one slash removes 300 life from a 1000-life dummy. */
  const huge: Loadout = { modifiers: [{ stat: 'damage', kind: 'more', value: 29 }] };

  it('a small hit leeches the keystone and Vampirism fractions summed: 10 × (0.05 + 0.1) = 1.5', () => {
    const w = world({ slash: refs('vampirism') }, { mechanics: [keystone] });
    w.player.life = 50;
    addMob(w, 540, 500);
    run(w, 1, use(0));
    expect(w.player.life).toBeCloseTo(51.5, 9);
  });

  it('a big hit is clamped by the keystone per-second cap: min(300 × 0.15, 20) = 20', () => {
    const w = world({ slash: refs('vampirism') }, { ...huge, mechanics: [keystone] });
    w.player.life = 50;
    const mob = addMob(w, 540, 500);
    expect(hits(run(w, 1, use(0)), mob.id)).toEqual([300]);
    expect(w.player.life).toBeCloseTo(70, 9);
  });

  it('the same big hit without the keystone is uncapped (30), and the keystone alone gives 15', () => {
    const vampOnly = world({ slash: refs('vampirism') }, huge);
    vampOnly.player.life = 50;
    addMob(vampOnly, 540, 500);
    run(vampOnly, 1, use(0));
    expect(vampOnly.player.life).toBeCloseTo(80, 9);

    const keystoneOnly = world({}, { ...huge, mechanics: [keystone] });
    keystoneOnly.player.life = 50;
    addMob(keystoneOnly, 540, 500);
    run(keystoneOnly, 1, use(0));
    expect(keystoneOnly.player.life).toBeCloseTo(65, 9);
  });
});

describe('dash and every-N-th supports', () => {
  /** Dash attack along the facing: 100 at 1000/s, 10 physical to mobs within 10 (+ their radius) of the path. */
  const charge: ActionDef = {
    id: 'charge',
    tags: ['attack', 'melee'],
    resourceCost: 0,
    cooldown: 0,
    damage: { source: 'weapon', effectiveness: 1 },
    delivery: { kind: 'dash', distance: 100, speed: 1000, hitRadius: 10 },
  };
  /** Dash without path hits; its landing hits within 60 at 50% (5 physical). */
  const leap: ActionDef = { ...charge, id: 'leap', delivery: { kind: 'dash', distance: 100, speed: 1000, hitRadius: 0, landing: { radius: 60, effectiveness: 0.5 } } };
  /** Arc of 90°; every 2nd use is a 360° special swing. */
  const sweep: ActionDef = { ...slash, id: 'sweep', resourceCost: 0, delivery: { kind: 'arc', radius: 60, angleDeg: 90, everyNth: { every: 2, angleDeg: 360 } } };
  const dasher: ClassDef = { ...hero, id: 'dasher', skills: [charge, leap, sweep] };
  const dashContent: Content = { ...content, classes: { hero, dasher } };

  const dashWorld = (socketed: Record<string, SupportRef[]>): WorldState => createWorld(dashContent, 'dasher', 1, { supports: socketed });
  const chains = (events: readonly WorldEvent[]): WorldEvent[] => events.filter((e) => e.type === 'chain');

  it('chain lightning from a dash path hit: the bolt hops from the path target to a mob off the path', () => {
    const w = dashWorld({ charge: refs('chain') });
    const onPath = addMob(w, 550, 500);
    const off = addMob(w, 550, 600);
    const far = addMob(w, 900, 900);
    const events = run(w, 20, use(0), dashContent);
    expect(w.player.pos.x).toBeCloseTo(600, 9);
    // Points are the positions at the hit (the hero later shoulders the path mob aside).
    expect(chains(events)).toEqual([{ type: 'chain', actionId: 'charge', fromId: onPath.id, targetIds: [off.id], points: [vec(550, 500), vec(550, 600)], damageType: 'lightning' }]);
    expect(hits(events, onPath.id)).toEqual([10]);
    // 10 base × 0.5 chain effectiveness, as lightning.
    expect(hits(events, off.id)).toEqual([5]);
    expect(hits(events, far.id)).toEqual([]);
  });

  it('chain lightning from a dash landing: the bolt starts at the closest landing target, at 50% of the base damage', () => {
    const w = dashWorld({ leap: refs('chain') });
    const landed = addMob(w, 620, 500);
    const outside = addMob(w, 620, 620);
    const events = run(w, 20, use(1), dashContent);
    const areas = events.filter((e) => e.type === 'area');
    expect(areas.map((e) => (e.type === 'area' ? e.trigger : undefined))).toEqual(['dashLanding']);
    expect(areas[0]?.type === 'area' ? areas[0].origin.x : 0).toBeCloseTo(600, 9);
    expect(chains(events)).toEqual([{ type: 'chain', actionId: 'leap', fromId: landed.id, targetIds: [outside.id], points: [landed.pos, outside.pos], damageType: 'lightning' }]);
    // Landing: 10 × 0.5. Bolt: chain effectiveness × the rolled base (10 × 0.5), not of the landing hit.
    expect(hits(events, landed.id)).toEqual([5]);
    expect(hits(events, outside.id)).toEqual([5]);
  });

  it('echo of an every-N-th special swing keeps the special angle and does not count as a use', () => {
    const w = dashWorld({ sweep: refs('echo') });
    const behind = addMob(w, 460, 500);
    const swings: (number | string | undefined)[][] = [];
    const record = (events: readonly WorldEvent[]): void => {
      for (const e of events) if (e.type === 'area') swings.push([e.angleDeg, e.trigger]);
    };
    // Use 1 (normal) and its echo; the next use is ready after the 0.5 s attack time (31 steps with float rounding).
    record(run(w, 31, use(2), dashContent));
    expect(w.player.useCounts.sweep).toBe(1);
    // Use 2 (special) and its echo.
    record(run(w, 31, use(2), dashContent));
    expect(w.player.useCounts.sweep).toBe(2);
    // Use 3: normal again, so the special echo was not counted.
    record(run(w, 1, use(2), dashContent));
    expect(w.player.useCounts.sweep).toBe(3);
    expect(swings).toEqual([
      [90, undefined],
      [90, undefined],
      [360, 'everyNth'],
      [360, 'everyNth'],
      [90, undefined],
    ]);
    // Only the 360° swings reach the mob behind the hero: the special use and its echo.
    expect(behind.life).toBe(1000 - 20);
  });
});

describe('combining support bonuses', () => {
  const conv = (to: 'fire' | 'cold', fraction: number): SkillChangeSet => ({ damageConversion: { to, fraction } });

  it('two conversions to the same type add up and cap at 1; another target type is ignored', () => {
    expect(resolveAction(slash, [conv('fire', 0.5), conv('fire', 0.7)]).damageConversion).toEqual({ to: 'fire', fraction: 1 });
    expect(resolveAction(slash, [conv('fire', 0.3), conv('cold', 0.5), conv('fire', 0.2)]).damageConversion).toEqual({ to: 'fire', fraction: 0.5 });
    // The action's own conversion comes first.
    expect(resolveAction({ ...slash, damageConversion: { to: 'cold', fraction: 0.2 } }, [conv('fire', 0.5)]).damageConversion).toEqual({ to: 'cold', fraction: 0.2 });
  });

  it('in the world: Ignite on Hit (fire 50%) + another fire conversion = all fire; + a cold conversion = half fire', () => {
    const extra: SupportData = {
      ...supports,
      supports: {
        ...supports.supports,
        scorch: support('scorch', { damageConversion: { to: 'fire', fraction: 0.7 } }),
        frost: support('frost', { damageConversion: { to: 'cold', fraction: 0.5 } }),
      },
    };
    const c = makeContent(extra);
    const allFire = createWorld(c, 'hero', 1, { supports: { slash: refs('ignite', 'scorch') } });
    const halfFire = createWorld(c, 'hero', 1, { supports: { slash: refs('ignite', 'frost') } });
    expect(allFire.player.actions.skills[0]!.damageConversion).toEqual({ to: 'fire', fraction: 1 });
    expect(halfFire.player.actions.skills[0]!.damageConversion).toEqual({ to: 'fire', fraction: 0.5 });
    const a = addMob(allFire, 540, 500, 'fireResist');
    const b = addMob(halfFire, 540, 500, 'fireResist');
    // 10 fire at 50% resistance; 5 physical + 5 fire at 50%.
    expect(hits(run(allFire, 1, use(0), c), a.id)).toEqual([5]);
    expect(hits(run(halfFire, 1, use(0), c), b.id)).toEqual([7.5]);
  });

  it('mergeBonuses: cost multipliers multiply, leech and stun bar fill add up, conversions combine like sets', () => {
    const merged = mergeBonuses([
      { resourceCostMultiplier: 1.2, leech: 0.05, stunBarFillIncreased: 0.3, damageConversion: { to: 'fire', fraction: 0.5 } },
      { resourceCostMultiplier: 1.5, leech: 0.1, damageConversion: { to: 'cold', fraction: 0.5 } },
      { stunBarFillIncreased: 0.2, damageConversion: { to: 'fire', fraction: 0.75 } },
    ]);
    expect(merged.resourceCostMultiplier).toBeCloseTo(1.8, 10);
    expect(merged.leech).toBeCloseTo(0.15, 10);
    expect(merged.stunBarFillIncreased).toBeCloseTo(0.5, 10);
    expect(merged.damageConversion).toEqual({ to: 'fire', fraction: 1 });
    expect(mergeBonuses([{ leech: 0.1 }, {}])).toEqual({ leech: 0.1 });
    // The merged bonus resolves like the separate sets.
    const resolved = resolveAction(slash, [{ skillIds: ['slash'], ...merged }]);
    expect(resolved.resourceCost).toBeCloseTo(18, 10);
    expect(resolved.leech).toBeCloseTo(0.15, 10);
    expect(resolved.stunBarFillIncreased).toBeCloseTo(0.5, 10);
  });
});

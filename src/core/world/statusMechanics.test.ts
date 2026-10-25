// Ignite, freeze and death explosions in the running world (Pyromancer / Cryomancer spec mechanics).
import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import { createRng } from '../rng';
import type { Modifier } from '../stats/types';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { conditionTarget } from './statuses';
import { createWorld, setLoadoutModifiers, step, type Loadout, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const mobDef = (id: string, extra: Partial<MobDef> = {}): MobDef => ({
  id,
  radius: 10,
  life: 1000,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
  ...extra,
});

const MOBS: Record<string, MobDef> = {
  dummy: mobDef('dummy'),
  resist: mobDef('resist', { resistances: { fire: 0.5, cold: 0, lightning: 0 } }),
  weak: mobDef('weak', { life: 10 }),
  boss: mobDef('boss', { boss: true }),
  walker: mobDef('walker', { moveSpeed: 100 }),
  bossWalker: mobDef('bossWalker', { boss: true, moveSpeed: 100 }),
};

const fireBolt: ActionDef = {
  id: 'fire_bolt',
  tags: ['spell', 'projectile'],
  resourceCost: 0,
  cooldown: 0,
  castTime: 0,
  damage: { source: 'skill', base: { fire: { min: 20, max: 20 } }, critChance: 0 },
  delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 600, range: 400, radius: 2, pierce: 0 },
};
const nova: ActionDef = {
  id: 'nova',
  tags: ['spell', 'area'],
  resourceCost: 0,
  cooldown: 0,
  castTime: 0,
  damage: { source: 'skill', base: { cold: { min: 10, max: 10 } }, critChance: 0 },
  delivery: { kind: 'arc', radius: 100, angleDeg: 360 },
  onHit: [{ status: 'slow', duration: 2.5, magnitude: 0.4 }],
};
const flame: ActionDef = {
  id: 'flame',
  tags: ['spell', 'area'],
  resourceCost: 0,
  cooldown: 0,
  castTime: 0,
  damage: { source: 'skill', base: { fire: { min: 20, max: 20 } }, critChance: 0 },
  delivery: { kind: 'arc', radius: 100, angleDeg: 360 },
};
const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 100, angleDeg: 360 },
};
const blaze: ActionDef = { ...flame, id: 'blaze', damage: { source: 'skill', base: { fire: { min: 60, max: 60 } }, critChance: 0 } };

/** Slots: 0 nova, 1 flame, 2 strike, 3 blaze. Basic attack: fire bolt. Hero stands at (500, 500). */
function makeContent(): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'wand',
    baseStats: { life: 50, resource: 50, resourceRegen: 0, movementSpeed: 100 },
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack: fireBolt,
    skills: [nova, flame, strike, blaze],
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5, maxLifeCostFraction: 0.9 },
    classes: { hero },
    mobs: MOBS,
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

function setup(mechanics: readonly PassiveMechanic[], loadout: Loadout = {}, seed = 1): { content: Content; world: WorldState } {
  const content = makeContent();
  return { content, world: createWorld(content, 'hero', seed, { ...loadout, mechanics }) };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };
const skill = (slot: number): PlayerInput => ({ ...idle, skills: [0, 1, 2, 3].map((i) => i === slot) });
const NOVA = skill(0);
const FLAME = skill(1);
const STRIKE = skill(2);
const BLAZE = skill(3);

function addMob(world: WorldState, x: number, y: number, defId = 'dummy', life = MOBS[defId]!.life): MobState {
  const mob: MobState = {
    id: world.nextId++,
    defId,
    pos: vec(x, y),
    facing: vec(0, 1),
    life,
    maxLife: MOBS[defId]!.life,
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
    radius: MOBS[defId]!.radius,
  };
  world.mobs.push(mob);
  return mob;
}

/** Steps `steps` times, returning all events. */
function run(world: WorldState, content: Content, input: PlayerInput, steps: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, content, DT));
  return events;
}

const hits = (events: readonly WorldEvent[], id: number): number[] =>
  events.flatMap((e) => (e.type === 'hit' && e.targetId === id ? [e.amount] : []));

/** Spec node data as in src/data/passives.ts (Pyromancer / Cryomancer), plus guaranteed variants for exact tests. */
const EMBERS: PassiveMechanic = { kind: 'ignite', damageType: 'fire', chance: 0.3, damageFraction: 0.5, duration: 3 };
const SURE_IGNITE: PassiveMechanic = { ...EMBERS, chance: 1 };
const KINDLING: Modifier[] = [
  { stat: 'igniteChance', kind: 'flat', value: 0.2 },
  { stat: 'igniteDamage', kind: 'increased', value: 0.3 },
];
const PYRE: PassiveMechanic = { kind: 'deathExplosion', status: 'ignite', radius: 100, lifeFraction: 0.3, damageType: 'fire', applyStatus: 'ignite' };
const INFERNO_RADIUS: PassiveMechanic = { kind: 'deathExplosionRadius', increased: 0.2 };
const ASH_TO_ASH: PassiveMechanic = {
  kind: 'conditionalModifiers',
  condition: { kind: 'targetHasStatus', status: 'ignite' },
  modifiers: [{ stat: 'damage', kind: 'more', value: 0.15 }],
};
const ICY_GRIP: PassiveMechanic = { kind: 'freezeSlowed', skillIds: ['nova'], duration: 1, bossDuration: 0.3 };
const ICY_GRIP_SLOW: PassiveMechanic = { kind: 'skillParams', skillIds: ['nova'], statusDurations: [{ status: 'slow', increased: 0.4 }] };
const SHATTER_MORE: PassiveMechanic = {
  kind: 'conditionalModifiers',
  condition: { kind: 'targetHasStatus', status: 'freeze' },
  modifiers: [{ stat: 'damage', kind: 'more', value: 0.25 }],
};
const SHATTER: PassiveMechanic = { kind: 'deathExplosion', status: 'freeze', radius: 90, lifeFraction: 0.2, damageType: 'cold' };
const PERMAFROST: Modifier = { stat: 'freezeDuration', kind: 'increased', value: 0.5 };

describe('ignite', () => {
  it('a fire hit ignites for 50% of its damage as fire over 3 s, ticking every step', () => {
    const { content, world: w } = setup([SURE_IGNITE]);
    const mob = addMob(w, 550, 500);
    const first = step(w, FLAME, content, DT);
    expect(first).toContainEqual({ type: 'status', targetId: mob.id, pos: mob.pos, status: 'ignite', duration: 3 });
    expect(mob.igniteDps).toBeCloseTo(10 / 3, 12);
    // The ignite ticks in the same step as the hit.
    expect(first.filter((e) => e.type === 'dot')).toEqual([{ type: 'dot', targetId: mob.id, pos: mob.pos, amount: (10 / 3) * DT, status: 'ignite' }]);
    expect(mob.life).toBeCloseTo(980 - (10 / 3) * DT, 9);
    const rest = run(w, content, idle, 179);
    expect(rest.filter((e) => e.type === 'dot')).toHaveLength(179);
    expect(mob.life).toBeCloseTo(970, 9);
    expect([mob.ignite, mob.igniteDps]).toEqual([0, 0]);
    run(w, content, idle, 30);
    expect(mob.life).toBeCloseTo(970, 9);
  });

  it('igniteDamage scales the ignite (Kindling +30%: 10 → 13 over 3 s)', () => {
    const { content, world: w } = setup([SURE_IGNITE], { modifiers: KINDLING });
    const mob = addMob(w, 550, 500);
    step(w, FLAME, content, DT);
    run(w, content, idle, 179);
    expect(mob.life).toBeCloseTo(1000 - 20 - 13, 9);
  });

  it('ignite damage is reduced by the target fire resistance (50%: hit 10, ignite 5)', () => {
    const { content, world: w } = setup([SURE_IGNITE]);
    const mob = addMob(w, 550, 500, 'resist');
    step(w, FLAME, content, DT);
    expect(mob.igniteDps).toBeCloseTo(5 / 3, 12);
    run(w, content, idle, 179);
    expect(mob.life).toBeCloseTo(1000 - 10 - 5, 9);
  });

  it('does not stack: a weaker ignite is ignored, a stronger one replaces it and restarts the duration', () => {
    const strongFirst = setup([SURE_IGNITE]);
    const a = addMob(strongFirst.world, 550, 500);
    step(strongFirst.world, BLAZE, strongFirst.content, DT); // 60 fire → 30 over 3 s = 10/s
    run(strongFirst.world, strongFirst.content, idle, 59);
    const remaining = a.ignite;
    expect(remaining).toBeCloseTo(2, 9);
    const events = step(strongFirst.world, FLAME, strongFirst.content, DT); // 10/3 per s: weaker
    expect(events.some((e) => e.type === 'status')).toBe(false);
    expect(a.igniteDps).toBeCloseTo(10, 12);
    expect(a.ignite).toBeCloseTo(remaining - DT, 9);

    const weakFirst = setup([SURE_IGNITE]);
    const b = addMob(weakFirst.world, 550, 500);
    step(weakFirst.world, FLAME, weakFirst.content, DT);
    run(weakFirst.world, weakFirst.content, idle, 59);
    step(weakFirst.world, BLAZE, weakFirst.content, DT);
    expect(b.igniteDps).toBeCloseTo(10, 12);
    expect(b.ignite).toBeCloseTo(3 - DT, 9);
  });

  it('only fire hits ignite; other hits do not roll (no rng draw)', () => {
    const withIgnite = setup([EMBERS]);
    const a = addMob(withIgnite.world, 550, 500);
    step(withIgnite.world, STRIKE, withIgnite.content, DT);
    const without = setup([]);
    addMob(without.world, 550, 500);
    step(without.world, STRIKE, without.content, DT);
    expect(a.ignite).toBe(0);
    expect(withIgnite.world.rngState).toBe(without.world.rngState);
  });

  it('the chance roll is one ctx.rng draw per hit, after the damage and crit draws (seed 7: 30%, then 50% with Kindling)', () => {
    const replay = (chance: number): boolean[] => {
      const rng = createRng(7);
      return Array.from({ length: 10 }, () => {
        rng.next(); // damage roll
        rng.next(); // crit roll
        return rng.chance(chance);
      });
    };
    const ignited = (modifiers: Modifier[]): boolean[] => {
      const { content, world: w } = setup([EMBERS], { modifiers }, 7);
      const mobs = Array.from({ length: 10 }, (_, i) => addMob(w, 510 + 8 * i, 500)); // hit closest first
      step(w, FLAME, content, DT);
      return mobs.map((m) => m.ignite > 0);
    };
    const base = ignited([]);
    expect(base).toEqual(replay(0.3));
    expect(base.filter(Boolean)).toHaveLength(4);
    const kindled = ignited(KINDLING);
    expect(kindled).toEqual(replay(0.5));
    expect(kindled.filter(Boolean)).toHaveLength(5);
  });

  it('a mob killed by its ignite gives kill credit; the ignite does not leech (Bloodsucker)', () => {
    const { content, world: w } = setup([SURE_IGNITE, { kind: 'lifeLeech', fraction: 0.5 }]);
    const mob = addMob(w, 550, 500, 'dummy', 21);
    step(w, FLAME, content, DT); // hit 20 → 1 left (leeches), then the ignite finishes it
    w.player.life = 10;
    const events = run(w, content, idle, 60);
    expect(events).toContainEqual({ type: 'death', id: mob.id, pos: mob.pos });
    expect(w.kills).toBe(1);
    expect(w.mobs).toHaveLength(0);
    expect(w.player.life).toBe(10);
  });

  it('an added on-hit ignite (support-like skill change) needs no fire damage and is guaranteed without a chance', () => {
    const support: PassiveMechanic = { kind: 'skillParams', skillIds: ['strike'], addOnHit: [{ status: 'ignite', duration: 2, magnitude: 0.5 }] };
    const { content, world: w } = setup([support]);
    const mob = addMob(w, 550, 500);
    step(w, STRIKE, content, DT);
    expect([mob.ignite, mob.igniteDps]).toEqual([2 - DT, 2.5]);
  });

  it('Ash to Ash: ignited enemies take 15% more damage from hits', () => {
    const { content, world: w } = setup([SURE_IGNITE, ASH_TO_ASH]);
    const mob = addMob(w, 550, 500);
    const events = [...step(w, FLAME, content, DT), ...step(w, FLAME, content, DT)];
    const [first, second] = hits(events, mob.id);
    expect(first).toBe(20);
    expect(second).toBeCloseTo(23, 12);
  });

  it('projectiles keep the ignite of cast time (the action snapshot)', () => {
    const removed = setup([SURE_IGNITE]);
    const a = addMob(removed.world, 700, 500);
    step(removed.world, attack, removed.content, DT);
    setLoadoutModifiers(removed.world, removed.content, [], []);
    run(removed.world, removed.content, idle, 30);
    expect(a.igniteDps).toBeCloseTo(10 / 3, 12);

    const added = setup([]);
    const b = addMob(added.world, 700, 500);
    step(added.world, attack, added.content, DT);
    setLoadoutModifiers(added.world, added.content, [], [SURE_IGNITE]);
    run(added.world, added.content, idle, 30);
    expect(b.life).toBe(980);
    expect(b.ignite).toBe(0);
  });
});

describe('death explosions', () => {
  it('Pyre: an enemy killed by the hit that ignited it explodes for 30% of its max life and ignites those hit', () => {
    const { content, world: w } = setup([SURE_IGNITE, PYRE]);
    const victim = addMob(w, 590, 500, 'weak'); // in flame range
    const near = addMob(w, 680, 500); // 90 from the victim, 180 from the hero: out of flame range
    const far = addMob(w, 710, 500); // 120 from the victim
    const events = step(w, FLAME, content, DT);
    expect(events).toContainEqual({ type: 'death', id: victim.id, pos: victim.pos });
    expect(events).toContainEqual({
      type: 'area',
      actionId: 'deathExplosion',
      origin: victim.pos,
      facing: vec(1, 0),
      radius: 100,
      angleDeg: 360,
      source: 'deathExplosion',
      damageType: 'fire',
      sourceMobId: victim.id,
    });
    expect(hits(events, near.id)).toEqual([3]);
    expect(near.life).toBe(997);
    // Guaranteed ignite from the explosion: 50% of its 3 damage over 3 s.
    expect([near.ignite, near.igniteDps]).toEqual([3, 0.5]);
    expect(far.life).toBe(1000);
    expect(w.mobs).toEqual([near, far]);
  });

  it('the explosion ignite uses igniteDamage modifiers tagged with its damage type', () => {
    const fireIgnite: Modifier = { stat: 'igniteDamage', kind: 'increased', value: 1, tags: ['fire'] };
    const { content, world: w } = setup([SURE_IGNITE, PYRE], { modifiers: [fireIgnite] });
    addMob(w, 590, 500, 'weak');
    const near = addMob(w, 680, 500);
    step(w, FLAME, content, DT);
    expect([near.ignite, near.igniteDps]).toEqual([3, 1]); // 3 × 0.5 × (1 + 1) over 3 s
  });

  it('Inferno: death explosion radius +20% (100 → 120)', () => {
    const { content, world: w } = setup([SURE_IGNITE, PYRE, INFERNO_RADIUS]);
    addMob(w, 590, 500, 'weak');
    const far = addMob(w, 715, 500); // 125 from the victim: inside 120 + 10
    const events = step(w, FLAME, content, DT);
    expect(events).toContainEqual(expect.objectContaining({ type: 'area', actionId: 'deathExplosion', radius: 120 }));
    expect(far.life).toBe(997);
  });

  it('an enemy that dies without the status does not explode', () => {
    const { content, world: w } = setup([{ ...EMBERS, chance: 0 }, PYRE]);
    addMob(w, 590, 500, 'weak');
    const near = addMob(w, 680, 500);
    const events = step(w, FLAME, content, DT);
    expect(events.some((e) => e.type === 'area' && e.actionId === 'deathExplosion')).toBe(false);
    expect(near.life).toBe(1000);
    expect(w.kills).toBe(1);
  });

  it('chains: explosion kills explode in the same step, each enemy once, in a deterministic order', () => {
    const { content, world: w } = setup([SURE_IGNITE, PYRE]);
    const first = addMob(w, 590, 500, 'weak');
    // A line of 2-life weak mobs 60 apart (each explosion deals 3), then a survivor.
    const line = [650, 710, 770, 830].map((x) => addMob(w, x, 500, 'weak', 2));
    // A tight cluster past the end of the line; the explosion at 770 already reaches all three.
    const cluster = [vec(860, 520), vec(860, 480), vec(880, 500)].map((p) => addMob(w, p.x, p.y, 'weak', 2));
    const survivor = addMob(w, 950, 500);
    const events = step(w, FLAME, content, DT);
    const deaths = events.flatMap((e) => (e.type === 'death' ? [e.id] : []));
    const explosions = events.flatMap((e) => (e.type === 'area' && e.source === 'deathExplosion' ? [e.sourceMobId] : []));
    // 770 hits 830 (60 away), then the two cluster mobs 92.2 away (tie → lower id first), then (880, 500) at 110.
    expect(deaths).toEqual([first.id, line[0]!.id, line[1]!.id, line[2]!.id, line[3]!.id, cluster[0]!.id, cluster[1]!.id, cluster[2]!.id]);
    expect(explosions).toEqual(deaths);
    expect(w.kills).toBe(8);
    expect(w.mobs).toEqual([survivor]);
    expect(survivor.life).toBe(991); // the three cluster explosions reach it (92.2, 92.2, 70 away)
    expect(survivor.igniteDps).toBe(0.5); // equal ignites refresh, they do not stack
  });

  it('Shatter: a frozen enemy that dies deals 20% of its max life as cold in radius 90 and does not freeze', () => {
    const { content, world: w } = setup([ICY_GRIP, SHATTER]);
    const victim = addMob(w, 590, 500, 'weak');
    victim.slow = 1;
    victim.slowMagnitude = 0.4;
    const near = addMob(w, 680, 500); // 90 from the victim: inside 90 + 10
    near.slow = 1;
    near.slowMagnitude = 0.4;
    const events = step(w, NOVA, content, DT); // nova 10 cold kills the 10-life victim and freezes it
    expect(events).toContainEqual(expect.objectContaining({ type: 'area', actionId: 'deathExplosion', radius: 90, damageType: 'cold', sourceMobId: victim.id }));
    expect(hits(events, near.id)).toEqual([2]);
    expect(near.freeze).toBe(0);
  });

  it('Shatter only for enemies frozen at death', () => {
    const { content, world: w } = setup([ICY_GRIP, SHATTER]);
    addMob(w, 590, 500, 'weak'); // not slowed: the nova does not freeze it
    const near = addMob(w, 680, 500);
    const events = step(w, NOVA, content, DT);
    expect(events.some((e) => e.type === 'area' && e.source === 'deathExplosion')).toBe(false);
    expect(near.life).toBe(1000);
  });
});

describe('freeze', () => {
  it('Icy Grip: the nova freezes only enemies slowed before the hit (1 s, Permafrost 1.5 s)', () => {
    const { content, world: w } = setup([ICY_GRIP]);
    const fresh = addMob(w, 550, 500);
    const slowed = addMob(w, 450, 500);
    slowed.slow = 0.5;
    slowed.slowMagnitude = 0.2;
    const events = step(w, NOVA, content, DT);
    expect(fresh.freeze).toBe(0);
    expect(fresh.slow).toBeCloseTo(2.5 - DT, 12);
    expect(slowed.freeze).toBeCloseTo(1 - DT, 12);
    expect(events).toContainEqual({ type: 'status', targetId: slowed.id, pos: slowed.pos, status: 'freeze', duration: 1 });
    // A second nova: the fresh mob is now slowed and freezes.
    step(w, NOVA, content, DT);
    expect(fresh.freeze).toBeCloseTo(1 - DT, 12);

    const long = setup([ICY_GRIP], { modifiers: [PERMAFROST] });
    const m = addMob(long.world, 550, 500);
    m.slow = 1;
    step(long.world, NOVA, long.content, DT);
    expect(m.freeze).toBeCloseTo(1.5 - DT, 12);
  });

  it('Icy Grip slow part extends only the nova slow (2.5 → 3.5 s), not the freeze', () => {
    const { content, world: w } = setup([ICY_GRIP, ICY_GRIP_SLOW]);
    expect(w.player.actions.skills[0]!.onHit).toEqual([
      { status: 'slow', duration: 3.5, magnitude: 0.4 },
      { status: 'freeze', duration: 1, bossDuration: 0.3, requiresStatus: 'slow' },
    ]);
    const mob = addMob(w, 550, 500);
    mob.slow = 1;
    step(w, NOVA, content, DT);
    expect(mob.slow).toBeCloseTo(3.5 - DT, 12);
    expect(mob.freeze).toBeCloseTo(1 - DT, 12);
  });

  it('a frozen enemy cannot move or attack; it resumes when the freeze ends', () => {
    const { content, world: w } = setup([]);
    const mob = addMob(w, 600, 500, 'walker');
    mob.freeze = 1;
    mob.attackTimer = 0.5;
    run(w, content, idle, 59);
    expect(mob.pos).toEqual(vec(600, 500));
    expect(mob.attackTimer).toBe(0.5);
    run(w, content, idle, 3);
    expect(mob.freeze).toBe(0);
    expect(mob.pos.x).toBeLessThan(600);
  });

  it('Shatter: frozen enemies take 25% more damage from hits', () => {
    const { content, world: w } = setup([SHATTER_MORE]);
    const frozen = addMob(w, 550, 500);
    frozen.freeze = 1;
    const normal = addMob(w, 450, 500);
    const events = step(w, FLAME, content, DT);
    expect(hits(events, frozen.id)).toEqual([25]);
    expect(hits(events, normal.id)).toEqual([20]);
  });

  it('bosses are not frozen: a 50% freeze-slow for 0.3 s × freezeDuration in its own slot; a longer weaker slow survives', () => {
    const { content, world: w } = setup([ICY_GRIP, ICY_GRIP_SLOW, SHATTER_MORE], { modifiers: [PERMAFROST] });
    const boss = addMob(w, 600, 500, 'bossWalker');
    boss.slow = 0.5;
    boss.slowMagnitude = 0.2;
    const events = step(w, NOVA, content, DT);
    expect(boss.freeze).toBe(0);
    // Nova slow: 40% for 3.5 s (merged with the old 20%); boss freeze-slow: 0.3 × 1.5 = 0.45 s.
    expect(boss.slowMagnitude).toBe(0.4);
    expect(boss.slow).toBeCloseTo(3.5 - DT, 12);
    expect(boss.freezeSlow).toBeCloseTo(0.45 - DT, 12);
    expect(events).toContainEqual({ type: 'status', targetId: boss.id, pos: vec(600, 500), status: 'freeze', duration: expect.closeTo(0.45, 12) });
    // Moves at 100 × (1 − 0.5) while the freeze-slow runs (the stronger of the two slows).
    expect(boss.pos.x).toBeCloseTo(600 - 50 * DT, 9);
    run(w, content, idle, 9);
    expect(boss.pos.x).toBeCloseTo(600 - 10 * 50 * DT, 9);
    expect(conditionTarget(boss).freeze).toBeGreaterThan(0);
    expect(hits(step(w, FLAME, content, DT), boss.id)).toEqual([25]); // counts as frozen: Shatter +25%

    run(w, content, idle, 29); // 40 steps: the 0.45 s freeze-slow is over, the nova slow is not
    expect(boss.freezeSlow).toBe(0);
    expect(conditionTarget(boss)).toEqual({ stun: 0, slow: boss.slow, ignite: 0, freeze: 0, bleed: 0 });
    const x = boss.pos.x;
    expect(hits(step(w, FLAME, content, DT), boss.id)).toEqual([20]); // just slowed now
    expect(x - boss.pos.x).toBeCloseTo(60 * DT, 9); // 100 × (1 − 0.4)
  });
});

describe('status mechanics: determinism', () => {
  it('runs with ignite, freeze and death explosions stay deterministic and JSON-serializable', () => {
    const play = (): WorldState => {
      const { content, world: w } = setup([EMBERS, PYRE, INFERNO_RADIUS, ASH_TO_ASH, ICY_GRIP, ICY_GRIP_SLOW, SHATTER, SHATTER_MORE], {
        modifiers: [...KINDLING, PERMAFROST],
      });
      for (let i = 0; i < 12; i++) addMob(w, 420 + 15 * i, 440 + ((i * 37) % 120), i % 3 === 0 ? 'walker' : 'weak', i % 3 === 0 ? 1000 : 30);
      for (let i = 0; i < 300; i++) {
        step(w, { ...idle, move: vec(i % 60 < 30 ? 1 : -1, 0), basicAttack: i % 7 === 0, skills: [i % 40 === 0, i % 9 === 0, false, i % 31 === 0] }, content, DT);
      }
      return w;
    };
    const a = play();
    expect(a).toEqual(play());
    expect(a.kills).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

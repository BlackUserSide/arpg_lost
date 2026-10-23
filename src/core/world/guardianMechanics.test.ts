// Guardian spec mechanics in the running world: stun bar (+ stunBonus fill / duration), boss stun → stun-slow,
// counter-attack. Numbers mirror src/data/passives.ts (Guardian branch) but are local to the test.
import { describe, expect, it } from 'vitest';
import { vec } from '../math';
import { isMechanicPending } from '../passives/mechanics';
import type { PassiveMechanic } from '../passives/types';
import { createRng } from '../rng';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { slowFraction } from './mobs';
import { stunBarFill, stunBarStats } from './passiveEffects';
import { applyStatus, conditionTarget } from './statuses';
import { createWorld, setLoadoutModifiers, step, type Ctx, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

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
    attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
    ...extra,
  };
}

const MOBS: Record<string, MobDef> = {
  dummy: mobDef('dummy'),
  boss: mobDef('boss', { boss: true }),
  bossWalker: mobDef('bossWalker', { boss: true, moveSpeed: 100 }),
  // Melee mob that attacks every step (interval 0) for 0 damage: isolates the counter trigger.
  brute: mobDef('brute', { attack: { damage: { physical: { min: 0, max: 0 } }, range: 5, interval: 0, critChance: 0 } }),
  // Melee mob that hits hard enough to kill the hero.
  killer: mobDef('killer', { attack: { damage: { physical: { min: 1000, max: 1000 } }, range: 5, interval: 1, critChance: 0 } }),
  archer: mobDef('archer', {
    preferredRange: 200,
    attack: { damage: { physical: { min: 0, max: 0 } }, range: 300, interval: 0.5, critChance: 0, projectile: { speed: 600, radius: 4 } },
  }),
};

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};
const charge: ActionDef = {
  id: 'charge',
  tags: ['attack', 'melee'],
  resourceCost: 5,
  cooldown: 4,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'dash', distance: 200, speed: 1000, hitRadius: 20 },
  onHit: [{ status: 'stun', duration: 1.2 }],
};

function makeContent(): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'sword',
    baseStats: { life: 50, resource: 50, resourceRegen: 0, movementSpeed: 100 },
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
    basicAttack: strike,
    skills: [charge],
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5 },
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

/** Guardian node data as in src/data/passives.ts. */
const STUN_BAR: PassiveMechanic = { kind: 'stunBar', baseFill: 0.1, damageFill: 1, stunDuration: 1, bossFillFactor: 0.5, bossStunDuration: 0.4, decayDelay: 2, decayPerSecond: 0.25 };
const HEAVY_HAND: PassiveMechanic = { kind: 'stunBonus', fillIncreased: 0.3, durationIncreased: 0.3 };
const COUNTER: PassiveMechanic = { kind: 'counterAttack', effectiveness: 1, cooldown: 1 };

function setup(mechanics: readonly PassiveMechanic[]): { content: Content; world: WorldState } {
  const content = makeContent();
  return { content, world: createWorld(content, 'hero', 1, { mechanics }) };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };

function addMob(world: WorldState, x: number, y: number, defId = 'dummy', life = MOBS[defId]!.life): MobState {
  const mob: MobState = {
    id: world.nextId++,
    defId,
    pos: vec(x, y),
    facing: vec(0, 1),
    life,
    maxLife: life,
    attackTimer: defId === 'brute' || defId === 'killer' ? 0 : 10,
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

/** One basic attack this step (the action timer is cleared first, so every call swings). */
function swing(world: WorldState, content: Content): WorldEvent[] {
  world.player.actionTimer = 0;
  return step(world, attack, content, DT);
}

function hits(events: readonly WorldEvent[], id: number): number[] {
  return events.flatMap((e) => (e.type === 'hit' && e.targetId === id ? [e.amount] : []));
}

function makeCtx(world: WorldState, content: Content): Ctx {
  return { world, content, classDef: content.classes.hero!, rng: createRng(1), events: [], input: idle };
}

describe('Guardian mechanics are live', () => {
  it('stunBar and counterAttack are no longer pending', () => {
    expect([STUN_BAR, HEAVY_HAND, COUNTER].filter(isMechanicPending)).toEqual([]);
  });

  it('stun bar stats are cached on the player per loadout and follow mechanic changes', () => {
    const { content, world } = setup([STUN_BAR, HEAVY_HAND]);
    expect(world.player.stunBarStats).toEqual(stunBarStats([STUN_BAR, HEAVY_HAND]));
    setLoadoutModifiers(world, content, [], [COUNTER]);
    expect(world.player.stunBarStats).toBeUndefined();
    setLoadoutModifiers(world, content, [], [STUN_BAR]);
    expect(world.player.stunBarStats).toEqual(stunBarStats([STUN_BAR]));
  });
});

describe('stun bar: fill formula and stats', () => {
  it('stunBarStats sums stunBonus fill and duration like increased', () => {
    expect(stunBarStats([])).toBeUndefined();
    expect(stunBarStats([HEAVY_HAND])).toBeUndefined();
    const stats = stunBarStats([STUN_BAR, HEAVY_HAND, HEAVY_HAND])!;
    expect(stats.fillMultiplier).toBeCloseTo(1.6, 12);
    expect(stats.durationMultiplier).toBeCloseTo(1.6, 12);
  });

  it('fill = (10% + removed / max life × 100%) × (1 + Σ fill increased), × 0.5 on bosses', () => {
    const plain = stunBarStats([STUN_BAR])!;
    expect(stunBarFill(plain, 50, 1000, false)).toBeCloseTo(0.15, 12);
    expect(stunBarFill(plain, 50, 1000, true)).toBeCloseTo(0.075, 12);
    const heavy = stunBarStats([STUN_BAR, HEAVY_HAND])!;
    expect(stunBarFill(heavy, 50, 1000, false)).toBeCloseTo(0.195, 12);
    expect(stunBarFill(heavy, 0, 1000, false)).toBeCloseTo(0.13, 12);
  });
});

describe('stun bar in the world', () => {
  it('a hit of 10 on a 1000-life mob fills 0.11 and emits a stunBar event', () => {
    const { content, world } = setup([STUN_BAR]);
    const mob = addMob(world, 530, 500);
    const events = swing(world, content);
    expect(hits(events, mob.id)).toEqual([10]);
    expect(mob.stunBar).toBeCloseTo(0.11, 12);
    expect(events).toContainEqual({ type: 'stunBar', targetId: mob.id, value: expect.closeTo(0.11, 12) });
    expect(mob.stun).toBe(0);
  });

  it('Heavy Hand: +30% fill (0.11 → 0.143)', () => {
    const { content, world } = setup([STUN_BAR, HEAVY_HAND]);
    const mob = addMob(world, 530, 500);
    swing(world, content);
    expect(mob.stunBar).toBeCloseTo(0.143, 12);
  });

  it('no stun bar mechanic: hits do not fill', () => {
    const { content, world } = setup([HEAVY_HAND]);
    const mob = addMob(world, 530, 500);
    const events = swing(world, content);
    expect(mob.stunBar).toBe(0);
    expect(events.some((e) => e.type === 'stunBar')).toBe(false);
  });

  it('full bar: stun 1.0 s, bar resets, status event with source stunBar (50-life mob: 0.3 per hit, 4th hit)', () => {
    const { content, world } = setup([STUN_BAR]);
    const mob = addMob(world, 530, 500, 'dummy', 50);
    for (let i = 0; i < 3; i++) swing(world, content);
    expect(mob.stunBar).toBeCloseTo(0.9, 12);
    expect(mob.stun).toBe(0);
    const events = swing(world, content);
    expect(mob.life).toBe(10);
    expect(mob.stunBar).toBe(0);
    expect(events).toContainEqual({ type: 'stunBar', targetId: mob.id, value: 0 });
    expect(events).toContainEqual({ type: 'status', targetId: mob.id, pos: vec(530, 500), status: 'stun', duration: 1, source: 'stunBar' });
    // Instant hit in updatePlayer, then updateMobs ticks the stun once this step.
    expect(mob.stun).toBeCloseTo(1 - DT, 12);
  });

  it('bar stun duration uses the same additive stun bonus sum: 1.0 × (1 + 0.3 + 0.3) = 1.6 s', () => {
    const { content, world } = setup([STUN_BAR, HEAVY_HAND, { kind: 'stunBonus', fillIncreased: 0, durationIncreased: 0.3 }]);
    const mob = addMob(world, 530, 500);
    mob.stunBar = 0.99;
    const events = swing(world, content);
    expect(events).toContainEqual({ type: 'status', targetId: mob.id, pos: vec(530, 500), status: 'stun', duration: expect.closeTo(1.6, 12), source: 'stunBar' });
  });

  it('boss: fill × 0.5 (0.055 per hit of 10 / 1000) and the full bar really stuns it for 0.4 s', () => {
    const { content, world } = setup([STUN_BAR]);
    const boss = addMob(world, 530, 500, 'boss');
    swing(world, content);
    expect(boss.stunBar).toBeCloseTo(0.055, 12);
    boss.stunBar = 0.95;
    const events = swing(world, content);
    expect(boss.stunBar).toBe(0);
    expect(events).toContainEqual({ type: 'status', targetId: boss.id, pos: vec(530, 500), status: 'stun', duration: 0.4, source: 'stunBar' });
    expect(boss.stun).toBeCloseTo(0.4 - DT, 12);
    expect(boss.stunSlow).toBe(0);
  });

  it('boss bar stun with Heavy Hand: 0.4 × 1.3 = 0.52 s', () => {
    const { content, world } = setup([STUN_BAR, HEAVY_HAND]);
    const boss = addMob(world, 530, 500, 'boss');
    boss.stunBar = 0.99;
    const events = swing(world, content);
    expect(events).toContainEqual({ type: 'status', targetId: boss.id, pos: vec(530, 500), status: 'stun', duration: expect.closeTo(0.52, 12), source: 'stunBar' });
  });

  it('fill counts the life actually removed: a killing hit leaves no bar event', () => {
    const { content, world } = setup([STUN_BAR]);
    const mob = addMob(world, 530, 500, 'dummy', 4);
    const events = swing(world, content);
    expect(hits(events, mob.id)).toEqual([10]);
    expect(events.some((e) => e.type === 'stunBar')).toBe(false);
  });

  it('decay: 2 s after the last hit the bar drains 25% per second to 0, without events', () => {
    const { content, world } = setup([STUN_BAR]);
    const mob = addMob(world, 530, 500);
    swing(world, content); // step 0: 0.11
    const quiet: WorldEvent[] = [];
    for (let i = 1; i < 120; i++) quiet.push(...step(world, idle, content, DT));
    expect(mob.stunBar).toBeCloseTo(0.11, 12); // steps 1..119: still within the 2 s delay
    quiet.push(...step(world, idle, content, DT)); // step 120: first drain
    expect(mob.stunBar).toBeCloseTo(0.11 - 0.25 * DT, 12);
    for (let i = 0; i < 25; i++) quiet.push(...step(world, idle, content, DT));
    expect(mob.stunBar).toBeCloseTo(0.11 - 26 * 0.25 * DT, 12);
    quiet.push(...step(world, idle, content, DT)); // 27th drain would go below 0
    expect(mob.stunBar).toBe(0);
    expect(quiet.some((e) => e.type === 'stunBar')).toBe(false);
  });

  it('decay: a new hit restarts the delay', () => {
    const { content, world } = setup([STUN_BAR]);
    const mob = addMob(world, 530, 500);
    swing(world, content);
    for (let i = 0; i < 130; i++) step(world, idle, content, DT); // 11 drain steps
    const drained = 0.11 - 11 * 0.25 * DT;
    expect(mob.stunBar).toBeCloseTo(drained, 12);
    swing(world, content);
    expect(mob.stunBar).toBeCloseTo(drained + 0.11, 12);
    expect(mob.stunBarIdle).toBeCloseTo(DT, 12);
    for (let i = 0; i < 119; i++) step(world, idle, content, DT);
    expect(mob.stunBar).toBeCloseTo(drained + 0.11, 12);
    step(world, idle, content, DT);
    expect(mob.stunBar).toBeCloseTo(drained + 0.11 - 0.25 * DT, 12);
  });

  it('ignite ticks and death explosions do not fill the bar', () => {
    const { content, world } = setup([STUN_BAR, { kind: 'deathExplosion', status: 'ignite', radius: 100, lifeFraction: 0.5, damageType: 'fire' }]);
    const burning = addMob(world, 300, 300, 'dummy', 5);
    burning.ignite = 3;
    burning.igniteDps = 600; // 10 per step: dies on the first tick
    const neighbour = addMob(world, 330, 300);
    const events = step(world, idle, content, DT);
    expect(events.some((e) => e.type === 'death' && e.id === burning.id)).toBe(true);
    // Explosion: 0.5 × 5 = 2.5 fire to the neighbour; no bar fill from either the tick or the explosion.
    expect(hits(events, neighbour.id)).toEqual([2.5]);
    expect(neighbour.stunBar).toBe(0);
    expect(events.some((e) => e.type === 'stunBar')).toBe(false);
  });
});

describe('bosses are not stunned by ordinary stuns', () => {
  it('a stun on a boss becomes the stun-slow (50%) for the stun duration; counts as stunned and slowed, not frozen', () => {
    const { content, world } = setup([]);
    const boss = addMob(world, 600, 500, 'bossWalker');
    const ctx = makeCtx(world, content);
    applyStatus(ctx, boss, { status: 'stun', duration: 1.2 }, { mods: [], tags: [], raw: undefined, before: conditionTarget(boss) });
    expect(boss.stun).toBe(0);
    expect(boss.stunSlow).toBe(1.2);
    expect(ctx.events).toEqual([{ type: 'status', targetId: boss.id, pos: vec(600, 500), status: 'stun', duration: 1.2 }]);
    expect(conditionTarget(boss)).toEqual({ stun: 1.2, slow: 1.2, ignite: 0, freeze: 0, bleed: 0 });
    expect(slowFraction(boss, content)).toBe(0.5);
    // It keeps walking at half speed (100 → 50 px/s).
    step(world, idle, content, DT);
    expect(boss.pos.x).toBeCloseTo(600 - 50 * DT, 9);
    expect(boss.stunSlow).toBeCloseTo(1.2 - DT, 12);
  });

  it('a stronger ordinary slow still wins over the stun-slow', () => {
    const { content, world } = setup([]);
    const boss = addMob(world, 600, 500, 'bossWalker');
    boss.stunSlow = 1;
    boss.slow = 1;
    boss.slowMagnitude = 0.7;
    expect(slowFraction(boss, content)).toBe(0.7);
  });

  it('a normal mob is still stunned', () => {
    const { content, world } = setup([]);
    const mob = addMob(world, 600, 500);
    applyStatus(makeCtx(world, content), mob, { status: 'stun', duration: 1.2 }, { mods: [], tags: [], raw: undefined, before: conditionTarget(mob) });
    expect(mob.stun).toBe(1.2);
    expect(mob.stunSlow).toBe(0);
  });

  it('shield charge on a boss: never stunned, gets the stun-slow', () => {
    const { content, world } = setup([]);
    const boss = addMob(world, 600, 500, 'boss');
    const charging: PlayerInput = { ...idle, skills: [true] };
    let maxStunSlow = 0;
    for (let i = 0; i < 30; i++) {
      step(world, i === 0 ? charging : idle, content, DT);
      expect(boss.stun).toBe(0);
      maxStunSlow = Math.max(maxStunSlow, boss.stunSlow);
    }
    expect(maxStunSlow).toBeCloseTo(1.2 - DT, 12);
  });
});

describe('counter-attack', () => {
  it('a melee hit is answered with the basic attack (100%) at the attacker: free, instant, counter event', () => {
    const { content, world } = setup([COUNTER]);
    const brute = addMob(world, 525, 500, 'brute', 10000);
    const resource = world.player.resource;
    const events = step(world, idle, content, DT);
    expect(events).toContainEqual({ type: 'mobAttack', id: brute.id });
    expect(events).toContainEqual({ type: 'counter', actionId: 'strike', targetId: brute.id, facing: vec(1, 0) });
    expect(hits(events, brute.id)).toEqual([10]);
    expect(brute.life).toBe(9990);
    expect(world.player.actionTimer).toBe(0);
    expect(world.player.resource).toBe(resource);
    expect(world.player.counterCooldown).toBe(1);
  });

  it('an attacker exactly on the hero: the counter faces where the hero faces', () => {
    const { content, world } = setup([COUNTER]);
    const brute = addMob(world, 500, 500, 'brute', 10000);
    const events = step(world, { ...idle, aim: vec(500, 900) }, content, DT);
    expect(events).toContainEqual({ type: 'counter', actionId: 'strike', targetId: brute.id, facing: vec(0, 1) });
    expect(brute.life).toBe(9990);
  });

  it('effectiveness scales the damage (50% → 5)', () => {
    const { content, world } = setup([{ kind: 'counterAttack', effectiveness: 0.5, cooldown: 1 }]);
    const brute = addMob(world, 525, 500, 'brute', 10000);
    expect(hits(step(world, idle, content, DT), brute.id)).toEqual([5]);
  });

  it('internal cooldown: at most once per 1 s (steps 0, 60, 120 under a hit every step)', () => {
    const { content, world } = setup([COUNTER]);
    addMob(world, 525, 500, 'brute', 100000);
    const counterSteps: number[] = [];
    for (let i = 0; i < 150; i++) {
      if (step(world, idle, content, DT).some((e) => e.type === 'counter')) counterSteps.push(i);
    }
    expect(counterSteps).toEqual([0, 60, 120]);
  });

  it('two attackers in one step: only the first is countered', () => {
    const { content, world } = setup([COUNTER]);
    const a = addMob(world, 525, 500, 'brute', 10000);
    const b = addMob(world, 475, 500, 'brute', 10000);
    const events = step(world, idle, content, DT);
    expect(events.filter((e) => e.type === 'counter')).toEqual([{ type: 'counter', actionId: 'strike', targetId: a.id, facing: vec(1, 0) }]);
    expect(b.life).toBe(10000);
  });

  it('mob projectiles do not trigger it', () => {
    const { content, world } = setup([COUNTER]);
    const archer = addMob(world, 700, 500, 'archer', 10000);
    archer.attackTimer = 0;
    let gotHit = false;
    for (let i = 0; i < 60; i++) {
      const events = step(world, idle, content, DT);
      expect(events.some((e) => e.type === 'counter')).toBe(false);
      if (events.some((e) => e.type === 'hit' && e.targetId === world.player.id)) gotHit = true;
    }
    expect(gotHit).toBe(true);
    expect(archer.life).toBe(10000);
  });

  it('no counter without the mechanic, while invulnerable, or when the hit kills the hero', () => {
    {
      const { content, world } = setup([]);
      addMob(world, 525, 500, 'brute', 10000);
      expect(step(world, idle, content, DT).some((e) => e.type === 'counter')).toBe(false);
    }
    {
      const { content, world } = setup([COUNTER]);
      addMob(world, 525, 500, 'brute', 10000);
      world.player.invulnerable = 1;
      expect(step(world, idle, content, DT).some((e) => e.type === 'counter')).toBe(false);
    }
    {
      const { content, world } = setup([COUNTER]);
      const killer = addMob(world, 525, 500, 'killer', 10000);
      const events = step(world, idle, content, DT);
      expect(events).toContainEqual({ type: 'playerDeath' });
      expect(events.some((e) => e.type === 'counter')).toBe(false);
      expect(killer.life).toBe(10000);
    }
  });

  it('uses the effective basic attack (skill changes, on-hit statuses) and fills the stun bar', () => {
    const slowStrike: PassiveMechanic = { kind: 'skillParams', skillIds: ['strike'], addOnHit: [{ status: 'slow', duration: 2, magnitude: 0.2 }] };
    const { content, world } = setup([COUNTER, slowStrike, STUN_BAR]);
    const brute = addMob(world, 525, 500, 'brute', 10000);
    step(world, idle, content, DT);
    expect(brute.slow).toBe(2);
    expect(brute.slowMagnitude).toBe(0.2);
    // 0.1 + 10 / 10000
    expect(brute.stunBar).toBeCloseTo(0.101, 12);
  });
});

describe('determinism and serialization', () => {
  it('same seed and inputs give identical worlds and events; the world stays plain JSON', () => {
    const runOnce = (): { world: WorldState; events: WorldEvent[] } => {
      const { content, world } = setup([STUN_BAR, HEAVY_HAND, COUNTER]);
      addMob(world, 525, 500, 'brute', 300);
      addMob(world, 540, 520, 'dummy', 200);
      addMob(world, 560, 480, 'boss', 500);
      const events: WorldEvent[] = [];
      for (let i = 0; i < 240; i++) events.push(...step(world, i % 20 === 0 ? attack : idle, content, DT));
      return { world, events };
    };
    const a = runOnce();
    const b = runOnce();
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.events.some((e) => e.type === 'counter')).toBe(true);
    expect(a.events.some((e) => e.type === 'stunBar')).toBe(true);
    expect(JSON.parse(JSON.stringify(a.world))).toEqual(a.world);
  });
});

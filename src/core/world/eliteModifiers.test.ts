// Elite modifiers (eliteModifiers.ts, docs/design/mobs.md «Еліти»): fast, fat, fiery (incl. hero ignite), explosive.
import { describe, expect, it } from 'vitest';
import { vec, type Vec2 } from '../math';
import type { ClassDef, Content, EliteModifierDef, MobAbilityDef, MobDef } from './content';
import { applyHeroIgnite } from './eliteModifiers';
import { createWorld, PLAYER_ID, spawnMob, step, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';
import { createRng } from '../rng';

const DT = 1 / 60;

/** Hits for exactly 10 physical, never crits; stands still unless moveSpeed is given. */
const baseMob = (id: string, extra: Partial<MobDef> = {}): MobDef => ({
  id,
  radius: 10,
  life: 20,
  xp: 1,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
  ...extra,
});

const FAN: MobAbilityDef = {
  id: 'fan',
  kind: 'projectileFan',
  windUp: 0.5,
  cooldown: 100,
  count: 1,
  spreadDeg: 0,
  speed: 600,
  radius: 5,
  flightRange: 600,
  damage: { physical: { min: 10, max: 10 } },
};
const NOVA: MobAbilityDef = { id: 'nova', kind: 'nova', windUp: 0.5, cooldown: 100, radius: 100, damage: { cold: { min: 10, max: 10 } } };
const ZONE: MobAbilityDef = { id: 'grave', kind: 'groundZones', windUp: 0.5, cooldown: 100, count: 1, radius: 40, delay: 0.5, scatter: 0, damage: { lightning: { min: 10, max: 10 } } };
/** Nova that can be cast every 2 s (cooldown) after a 1 s wind-up; never in basic attack reach. */
const PULSE: MobAbilityDef = { id: 'pulse', kind: 'nova', windUp: 1, cooldown: 2, radius: 1000, damage: { physical: { min: 0, max: 0 } } };

const MOBS: Record<string, MobDef> = {
  brute: baseMob('brute'),
  walker: baseMob('walker', { moveSpeed: 100, attack: { damage: { physical: { min: 1, max: 1 } }, range: 0, interval: 1, critChance: 0 } }),
  archer: baseMob('archer', { attack: { damage: { physical: { min: 10, max: 10 } }, range: 400, interval: 1000, critChance: 0, projectile: { speed: 600, radius: 5 } } }),
  fanner: baseMob('fanner', { attack: { ...baseMob('x').attack, range: 0, interval: 1000 }, abilities: { recovery: 0, phases: [], list: [FAN] } }),
  novaCaster: baseMob('novaCaster', { attack: { ...baseMob('x').attack, range: 0, interval: 1000 }, abilities: { recovery: 0, phases: [], list: [NOVA] } }),
  graveCaster: baseMob('graveCaster', { attack: { ...baseMob('x').attack, range: 0, interval: 1000 }, abilities: { recovery: 0, phases: [], list: [ZONE] } }),
  pulser: baseMob('pulser', { attack: { ...baseMob('x').attack, range: 0, interval: 1000 }, abilities: { recovery: 0, phases: [], list: [PULSE] } }),
  caller: baseMob('caller', {
    attack: { ...baseMob('x').attack, range: 0, interval: 1000 },
    abilities: { recovery: 0, phases: [], list: [{ id: 'call', kind: 'summon', windUp: 0.1, cooldown: 100, count: 2, maxAlive: 2, ringRadius: 40, pool: [{ mobId: 'brute', weight: 1 }] }] },
  }),
};

const MODIFIERS: Record<string, EliteModifierDef> = {
  fast: { id: 'fast', moveSpeed: 1.5, actionSpeed: 2 },
  fat: { id: 'fat', life: 3 },
  // Guaranteed ignite in the tests (the game's chance is data).
  fiery: { id: 'fiery', damageConversion: { to: 'fire', fraction: 1 }, onHitHero: [{ status: 'ignite', magnitude: 0.5, duration: 2 }] },
  neverIgnites: { id: 'neverIgnites', damageConversion: { to: 'fire', fraction: 1 }, onHitHero: [{ status: 'ignite', chance: 0, magnitude: 0.5, duration: 2 }] },
  explosive: { id: 'explosive', deathZone: { radius: 50, delay: 1, damage: { fire: { min: 20, max: 20 } } } },
};

function makeContent(): Content {
  const hero: ClassDef = {
    id: 'hero',
    radius: 10,
    weaponType: 'wand',
    // Fire resistance 50%; high armour so a physical hit visibly differs from a fire one.
    baseStats: { life: 100, resource: 0, resourceRegen: 0, movementSpeed: 100, fireResistance: 0.5, armour: 1000 },
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: { damage: { physical: { min: 1, max: 1 } }, attacksPerSecond: 1, critChance: 0 },
    basicAttack: { id: 'poke', tags: ['attack', 'melee'], resourceCost: 0, cooldown: 0, damage: { source: 'weapon', effectiveness: 1 }, delivery: { kind: 'arc', radius: 10, angleDeg: 10 } },
    skills: [],
  };
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5 },
    classes: { hero },
    mobs: MOBS,
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['brute'] } },
    progression: { maxLevel: 5, xpCurve: { base: 1000, exponent: 1 }, mobXpGrowth: 0, lowAreaPenalty: { startDiff: 2, multipliers: [1], floor: 1 }, mapClearBonus: 0, perLevel: {} },
    eliteModifiers: MODIFIERS,
  };
}

const content = makeContent();
const idle: PlayerInput = { move: vec(0, 0), aim: vec(600, 500), basicAttack: false, skills: [] };

/** Hero at (500, 500), full life, no ES. */
function newWorld(seed = 1): WorldState {
  return createWorld(content, 'hero', seed);
}

function add(world: WorldState, defId: string, pos: Vec2, eliteModifier?: string, damageScale?: number): MobState {
  return spawnMob(world, content, { defId, rank: 'elite', ...(eliteModifier ? { eliteModifier } : {}), ...(damageScale ? { damageScale } : {}) }, pos, []);
}

function run(world: WorldState, n: number, input: PlayerInput = idle): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...step(world, input, content, DT));
  return out;
}

const heroHits = (events: WorldEvent[]): number[] =>
  events.flatMap((e) => (e.type === 'hit' && e.targetId === PLAYER_ID ? [e.amount] : []));

describe('elite modifier: fat', () => {
  it('multiplies life at spawn on top of the rank and area level scaling', () => {
    const world = createWorld(content, 'hero', 1, {}, 1, { bounds: { width: 1000, height: 1000 }, endless: false, mobScale: { life: 2, damage: 1, armour: 1 } });
    const fat = spawnMob(world, content, { defId: 'brute', rank: 'elite', lifeScale: 4, eliteModifier: 'fat' }, vec(100, 100), []);
    const plain = spawnMob(world, content, { defId: 'brute', rank: 'elite', lifeScale: 4 }, vec(200, 100), []);
    // 20 × 4 (rank) × 3 (fat) × 2 (map level).
    expect(fat).toMatchObject({ life: 480, maxLife: 480, eliteModifier: 'fat' });
    expect(plain).toMatchObject({ life: 160, maxLife: 160 });
    expect(plain.eliteModifier).toBeUndefined();
  });

  it('an unknown modifier id throws', () => {
    expect(() => add(newWorld(), 'brute', vec(100, 100), 'nope')).toThrow('Unknown elite modifier: nope');
  });
});

describe('elite modifier: fast', () => {
  it('walks moveSpeed × faster', () => {
    const world = newWorld();
    const fast = add(world, 'walker', vec(100, 100), 'fast');
    const plain = add(world, 'walker', vec(100, 900), 'fat');
    run(world, 30);
    // Both walk towards the hero at (500, 500) along the diagonal: 0.5 s × 100 (× 1.5).
    expect(Math.hypot(fast.pos.x - 100, fast.pos.y - 100)).toBeCloseTo(75, 6);
    expect(Math.hypot(plain.pos.x - 100, plain.pos.y - 900)).toBeCloseTo(50, 6);
  });

  it('attacks actionSpeed × as often (basic attack interval 1 s → 0.5 s)', () => {
    const fastWorld = newWorld();
    add(fastWorld, 'brute', vec(520, 500), 'fast');
    const plainWorld = newWorld();
    add(plainWorld, 'brute', vec(520, 500));
    // 2 s: attacks at t = 0, 0.5, 1, 1.5 (fast) / 0, 1 (plain).
    const count = (events: WorldEvent[]): number => events.filter((e) => e.type === 'mobAttack').length;
    expect(count(run(fastWorld, 120))).toBe(4);
    expect(count(run(plainWorld, 120))).toBe(2);
  });

  it('ability cooldowns run faster, wind-ups keep their length', () => {
    const world = newWorld();
    const mob = add(world, 'pulser', vec(700, 500), 'fast');
    const events = run(world, 240);
    const casts = events.filter((e) => e.type === 'mobCast' && e.id === mob.id);
    const resolves = events.filter((e) => e.type === 'mobAbility' && e.id === mob.id);
    // Cooldown 2 s at ×2 = 1 s from each start, the wind-up stays 1 s: a cast every 60 steps, each resolving 1 s later.
    expect(casts).toHaveLength(4);
    expect(casts.every((e) => e.type === 'mobCast' && e.duration === 1)).toBe(true);
    expect(resolves).toHaveLength(3);
  });
});

describe('elite modifier: fiery', () => {
  it('melee hits become fire: fire resistance applies, armour does not', () => {
    const plain = newWorld();
    add(plain, 'brute', vec(520, 500));
    const fiery = newWorld();
    add(fiery, 'brute', vec(520, 500), 'neverIgnites');
    // 10 physical vs armour 1000: 10 × (1 − min(0.9, 1000 / (1000 + 50))) = 1.
    expect(heroHits(run(plain, 1))[0]).toBeCloseTo(1, 9);
    // 10 fire, 50% fire resistance.
    expect(heroHits(run(fiery, 1))).toEqual([5]);
  });

  it('basic attack projectiles, ability projectiles, novas and its hostile zones are fire too', () => {
    for (const defId of ['archer', 'fanner', 'novaCaster', 'graveCaster']) {
      const world = newWorld();
      add(world, defId, vec(560, 500), 'neverIgnites');
      expect(heroHits(run(world, 120)), defId).toEqual([5]);
    }
    // The projectile and the zone carry the modifier (render may tint them).
    const world = newWorld();
    add(world, 'archer', vec(700, 500), 'fiery');
    run(world, 1);
    expect(world.projectiles[0]).toMatchObject({ owner: 'mob', eliteModifier: 'fiery' });
    const graves = newWorld();
    add(graves, 'graveCaster', vec(700, 500), 'fiery');
    const spawned = run(graves, 31).find((e) => e.type === 'hostileZoneSpawn');
    expect(spawned).toMatchObject({ abilityId: 'grave', eliteModifier: 'fiery' });
    expect(graves.hostileZones[0]).toMatchObject({ eliteModifier: 'fiery' });
  });

  it('a landed hit ignites the hero: magnitude × hit damage as fire over the duration, after fire resistance', () => {
    const world = newWorld();
    add(world, 'brute', vec(520, 500), 'fiery');
    const events = run(world, 1);
    // Hit 10 fire → burn 10 × 0.5 = 5, × (1 − 0.5) = 2.5 over 2 s.
    expect(world.player).toMatchObject({ ignite: 2, igniteDps: 1.25 });
    expect(events).toContainEqual({ type: 'status', targetId: PLAYER_ID, pos: world.player.pos, status: 'ignite', duration: 2 });
    expect(world.player.life).toBe(95);
    // The burn first ticks on the next step (the hit came after the hero's update).
    const next = run(world, 1);
    expect(next).toContainEqual({ type: 'dot', targetId: PLAYER_ID, pos: world.player.pos, amount: 1.25 * DT, status: 'ignite' });
    expect(world.player.life).toBeCloseTo(95 - 1.25 * DT, 9);
  });

  it('chance 0 never ignites', () => {
    const world = newWorld();
    add(world, 'brute', vec(520, 500), 'neverIgnites');
    run(world, 120);
    expect(world.player.ignite).toBe(0);
  });

  it('a mob without a modifier converts nothing and ignites nothing', () => {
    const world = newWorld();
    add(world, 'brute', vec(520, 500));
    run(world, 120);
    expect(world.player).toMatchObject({ ignite: 0, igniteDps: 0 });
  });
});

describe('hero ignite', () => {
  /** A world whose rng / step context we drive by hand: applies an ignite through a 0-damage step context. */
  function ignite(world: WorldState, amount: number, duration: number): WorldEvent[] {
    const events: WorldEvent[] = [];
    applyHeroIgnite({ world, content, classDef: content.classes.hero!, rng: createRng(1), events, input: idle }, amount, duration);
    return events;
  }

  it('burns for exactly its duration, energy shield first, without resource or combat-idle changes', () => {
    const world = createWorld(content, 'hero', 1, { modifiers: [{ stat: 'energyShield', kind: 'flat', value: 1 }] });
    expect(world.player.energyShield).toBe(1);
    const idleBefore = world.player.combatIdle;
    ignite(world, 12, 1); // 12 × 0.5 = 6 over 1 s
    const events = run(world, 60);
    const dots = events.filter((e) => e.type === 'dot');
    expect(dots).toHaveLength(60);
    expect(world.player).toMatchObject({ ignite: 0, igniteDps: 0 });
    // 6 damage: 1 from ES, 5 from life.
    expect(world.player.energyShield).toBe(0);
    expect(world.player.life).toBeCloseTo(95, 9);
    expect(world.player.combatIdle).toBe(idleBefore);
    expect(run(world, 1).some((e) => e.type === 'dot')).toBe(false);
  });

  it('strongest only: a stronger burn replaces the current one, a weaker one is ignored', () => {
    const world = newWorld();
    ignite(world, 8, 2); // 2 dps
    expect(ignite(world, 4, 2)).toEqual([]); // 1 dps: ignored
    expect(world.player).toMatchObject({ ignite: 2, igniteDps: 1 * 2 });
    run(world, 30);
    ignite(world, 24, 3); // 4 dps: replaces and restarts
    expect(world.player).toMatchObject({ ignite: 3, igniteDps: 4 });
  });

  it('deals nothing while the hero is invulnerable, but keeps running out', () => {
    const world = newWorld();
    world.player.invulnerable = 10;
    ignite(world, 12, 0.5);
    const events = run(world, 30);
    expect(events.some((e) => e.type === 'dot')).toBe(false);
    expect(world.player.life).toBe(100);
    expect(world.player.ignite).toBe(0);
  });

  it('a burn can kill the hero', () => {
    const world = newWorld();
    world.player.life = 0.5;
    ignite(world, 1200, 1); // 600 dps: 10 per step
    const events = run(world, 1);
    expect(world.player.dead).toBe(true);
    expect(events).toContainEqual({ type: 'playerDeath' });
  });
});

describe('elite modifier: explosive', () => {
  function killed(damageScale?: number): { world: WorldState; mob: MobState; events: WorldEvent[] } {
    const world = newWorld();
    const mob = add(world, 'brute', vec(700, 500), 'explosive', damageScale);
    mob.life = 0;
    return { world, mob, events: run(world, 1) };
  }

  it('on death a telegraphed hostile zone appears at its position', () => {
    const { world, mob, events } = killed();
    expect(events).toContainEqual({
      type: 'hostileZoneSpawn',
      zoneId: world.hostileZones[0]!.id,
      sourceId: mob.id,
      abilityId: 'explosive',
      pos: mob.pos,
      radius: 50,
      delay: 1,
      source: 'eliteDeath',
      eliteModifier: 'explosive',
    });
    expect(world.hostileZones).toEqual([
      expect.objectContaining({ sourceId: mob.id, sourceDefId: 'brute', pos: mob.pos, radius: 50, remaining: 1, total: 1, source: 'eliteDeath', damage: { fire: { min: 20, max: 20 } } }),
    ]);
  });

  it('erupts exactly delay later, hitting a hero inside for its damage × damageScale (fire resistance applies)', () => {
    const { world, mob } = killed(1.5);
    world.player.pos = vec(mob.pos.x + 55, mob.pos.y); // radius 50 + hero radius 10 reaches 60
    const before = run(world, 59);
    expect(before.some((e) => e.type === 'hostileZoneErupt')).toBe(false);
    const events = run(world, 1);
    expect(events).toContainEqual({ type: 'hostileZoneErupt', zoneId: expect.any(Number), abilityId: 'explosive', pos: mob.pos, radius: 50, hit: true, source: 'eliteDeath', eliteModifier: 'explosive' });
    // 20 × 1.5 = 30 fire, 50% resistance.
    expect(heroHits(events)).toEqual([15]);
    expect(world.hostileZones).toEqual([]);
  });

  it('a hero who stepped out takes nothing', () => {
    const { world, mob } = killed();
    world.player.pos = vec(mob.pos.x + 61, mob.pos.y);
    const events = run(world, 60);
    expect(events.find((e) => e.type === 'hostileZoneErupt')).toMatchObject({ hit: false });
    expect(heroHits(events)).toEqual([]);
    expect(world.player.life).toBe(100);
  });

  it('mobs without the modifier leave no zone', () => {
    const world = newWorld();
    const mob = add(world, 'brute', vec(700, 500), 'fat');
    mob.life = 0;
    run(world, 1);
    expect(world.hostileZones).toEqual([]);
  });
});

describe('elite modifiers: who carries them', () => {
  it("a summoner elite's modifier is not passed to its minions", () => {
    const world = newWorld();
    const caller = add(world, 'caller', vec(800, 800), 'fat');
    run(world, 10);
    const minions = world.mobs.filter((m) => m.summonerId === caller.id);
    expect(minions).toHaveLength(2);
    for (const m of minions) {
      expect(m.eliteModifier).toBeUndefined();
      expect(m.maxLife).toBe(20);
    }
  });
});

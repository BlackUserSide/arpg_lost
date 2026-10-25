// Raised allies (legendary Eye of the Abyss, 0.4 pkg 6e; docs/design/items.md, designer changes 2026-10-26 in
// overnight-questions.md): non-boss deaths rise as skeletons for 8 s (max 6), enemies attack them, the class resource
// recovers only from the skeletons' kills.
import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data/index';
import { itemsData } from '../../data/items';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { allyTarget, raiseAlliesStats, updateAllies } from './allies';
import { createRng } from '../rng';
import { resourceOnHeroHit, resourceOnHeroHitTaken, tickResource } from './resource';
import { mobTarget, targetAlly, targetDecoy } from './zones';
import { createWorld, step, type Ally, type HostileZone, type MobScale, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 5,
  xp: 10,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};
/** Never dies to an ally's hit, never attacks (out of reach of everything). */
const post: MobDef = { ...dummy, id: 'post', life: 100000, attack: { ...dummy.attack, range: 0 } };
const biter: MobDef = { ...dummy, id: 'biter', life: 100000, attack: { ...dummy.attack, damage: { physical: { min: 1000, max: 1000 } } } };
/** A boss-style caster: a 100-radius cold nova (5) as soon as the hero is within 1000. */
const novaBoss: MobDef = {
  ...dummy,
  id: 'novaBoss',
  life: 100000,
  attack: { ...dummy.attack, range: 0 },
  abilities: {
    recovery: 1,
    phases: [],
    list: [{ id: 'testNova', kind: 'nova', windUp: 0.1, cooldown: 10, initialCooldown: 0, range: 1000, radius: 100, damage: { cold: { min: 5, max: 5 } } }],
  },
};
const sniper: MobDef = { ...dummy, id: 'sniper', life: 100000, attack: { ...dummy.attack, range: 600, projectile: { speed: 600, radius: 5 } } };

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 360 },
};

const heroClass: ClassDef = {
  id: 'hero',
  radius: 10,
  weaponType: 'sword',
  baseStats: { life: 100000, resource: 20, resourceRegen: 0, movementSpeed: 120 },
  resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
  weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
  basicAttack: strike,
  skills: [],
};

const content: Content = {
  ...gameContent,
  classes: { ...gameContent.classes, hero: heroClass },
  mobs: { ...gameContent.mobs, dummy, post, biter, sniper, novaBoss },
  arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
};

/** The real Eye's mechanics (its stat lines are left out: only the mechanics count here). */
const eye: readonly PassiveMechanic[] = itemsData.uniques.abyss_eye!.mechanics!;
const zombie = gameContent.mobs.zombie!;

function hero(mechanics: readonly PassiveMechanic[] = eye, mobScale?: MobScale, classId = 'hero', data: Content = content): WorldState {
  return createWorld(data, classId, 1, { mechanics }, 1, { bounds: { width: 1000, height: 1000 }, endless: true, ...(mobScale ? { mobScale } : {}) });
}

function addMob(world: WorldState, defId: string, x: number, y: number, extra: Partial<MobState> = {}): MobState {
  const def = content.mobs[defId]!;
  const mob: MobState = { id: world.nextId++, defId, pos: vec(x, y), facing: vec(0, 1), life: def.life, maxLife: def.life, attackTimer: 0, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: def.radius, ...extra };
  world.mobs.push(mob);
  return mob;
}

/** A skeleton like the Eye raises at map 1 (zombie def, × 1), placed directly. */
function addAlly(world: WorldState, x: number, y: number, extra: Partial<Ally> = {}): Ally {
  const ally: Ally = {
    kind: 'ally',
    id: world.nextId++,
    defId: 'zombie',
    pos: vec(x, y),
    facing: vec(1, 0),
    radius: zombie.radius,
    life: zombie.life,
    maxLife: zombie.life,
    damageScale: 1,
    armour: 0,
    moveSpeed: zombie.moveSpeed * 2.5,
    leashRadius: 400,
    followDistance: 70,
    remaining: 8,
    duration: 8,
    attackTimer: 0,
    ...extra,
  };
  world.allies.push(ally);
  return ally;
}

/** Kills `mob` outright: removed (and possibly raised) at the end of the next step. */
const kill = (mob: MobState): void => {
  mob.life = 0;
};

const idle: PlayerInput = { move: vec(0, 0), aim: vec(600, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };

function run(world: WorldState, steps: number, input: PlayerInput = idle, data: Content = content): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, data, DT));
  return events;
}

const ofType = <T extends WorldEvent['type']>(events: readonly WorldEvent[], type: T): Extract<WorldEvent, { type: T }>[] =>
  events.filter((e): e is Extract<WorldEvent, { type: T }> => e.type === type);

describe('Eye of the Abyss: data', () => {
  it('a legendary amulet: skeleton warriors for 8 s, max 6, 10% resource per skeleton kill, no own recovery', () => {
    const def = itemsData.uniques.abyss_eye!;
    expect(def.rarity).toBe('legendary');
    expect(itemsData.bases[def.baseId]!.slot).toBe('amulet');
    expect(def.weight).toBe(itemsData.uniques.devourer_crown!.weight);
    expect(def.level).toBe(itemsData.uniques.clock_last_moment!.level);
    expect(def.mechanics).toEqual([
      {
        kind: 'raiseAllies',
        mobId: 'zombie',
        duration: 8,
        max: 6,
        lifeMultiplier: 1,
        damageMultiplier: 1,
        moveSpeedMultiplier: 2.5,
        leashRadius: 400,
        followDistance: 70,
        resourcePerKill: 0.1,
      },
      { kind: 'allyOnlyResource' },
    ]);
    expect(raiseAlliesStats(hero().player)?.max).toBe(6);
    expect(raiseAlliesStats(hero([]).player)).toBeUndefined();
  });
});

describe('raising allies', () => {
  it('a mob the hero kills rises at its position as a skeleton: zombie life and speed × 2.5, 8 s', () => {
    const world = hero();
    const mob = addMob(world, 'dummy', 530, 500);
    const events = run(world, 1, attack);
    expect(ofType(events, 'death').map((e) => e.id)).toEqual([mob.id]);
    const [spawn] = ofType(events, 'allySpawn');
    expect(spawn).toEqual({ type: 'allySpawn', allyId: world.allies[0]!.id, mobId: mob.id, defId: 'zombie', pos: vec(530, 500), duration: 8, life: 16 });
    expect(world.allies).toHaveLength(1);
    expect(world.allies[0]).toMatchObject({ defId: 'zombie', life: 16, maxLife: 16, damageScale: 1, armour: 0, moveSpeed: 187.5, remaining: 8 });
    // Without the mechanic nothing rises.
    const plain = hero([]);
    addMob(plain, 'dummy', 530, 500);
    expect(ofType(run(plain, 1, attack), 'allySpawn')).toEqual([]);
    expect(plain.allies).toEqual([]);
  });

  it('the map growth scales its life, damage and armour (like the mobs it copies)', () => {
    const scale: MobScale = { life: 6, damage: 2.2, armour: 2.5 };
    const world = hero(eye, scale);
    kill(addMob(world, 'dummy', 600, 500));
    run(world, 1);
    expect(world.allies[0]).toMatchObject({ life: 96, maxLife: 96, damageScale: 2.2, armour: 0 });
  });

  it('bosses do not rise; minions and elites do', () => {
    const world = hero();
    const boss = addMob(world, 'dummy', 600, 500, { rank: 'boss' });
    const elite = addMob(world, 'dummy', 600, 600, { rank: 'elite' });
    const minion = addMob(world, 'dummy', 600, 700, { summonerId: 999 });
    for (const m of [boss, elite, minion]) kill(m);
    const events = run(world, 1);
    expect(ofType(events, 'allySpawn').map((e) => e.mobId)).toEqual([elite.id, minion.id]);
  });

  it('at most 6: a 7th skeleton makes the oldest crumble first', () => {
    const world = hero();
    const mobs = Array.from({ length: 7 }, (_, i) => addMob(world, 'dummy', 100 + i * 100, 100));
    for (const m of mobs) kill(m);
    const events = run(world, 1).filter((e) => e.type === 'allySpawn' || e.type === 'allyExpire');
    const spawns = ofType(events, 'allySpawn');
    expect(spawns.map((e) => e.mobId)).toEqual(mobs.map((m) => m.id));
    // Order: six spawns, then the oldest crumbles ('cap') right before the 7th rises.
    expect(events.map((e) => e.type)).toEqual(['allySpawn', 'allySpawn', 'allySpawn', 'allySpawn', 'allySpawn', 'allySpawn', 'allyExpire', 'allySpawn']);
    expect(events[6]).toEqual({ type: 'allyExpire', allyId: spawns[0]!.allyId, pos: vec(100, 100), reason: 'cap' });
    expect(world.allies.map((a) => a.id)).toEqual(spawns.slice(1).map((e) => e.allyId));
  });

  it('a skeleton lasts exactly 8 s, then crumbles (timeout)', () => {
    const world = hero();
    kill(addMob(world, 'dummy', 900, 900));
    run(world, 1);
    const id = world.allies[0]!.id;
    const before = run(world, 479);
    expect(ofType(before, 'allyExpire')).toEqual([]);
    expect(world.allies).toHaveLength(1);
    const last = run(world, 1);
    expect(ofType(last, 'allyExpire')).toEqual([expect.objectContaining({ allyId: id, reason: 'timeout' })]);
    expect(world.allies).toEqual([]);
  });

  it('a mob killed by a skeleton rises too', () => {
    const world = hero();
    const mob = addMob(world, 'dummy', 620, 500, { life: 1 });
    addAlly(world, 620 - 10 - 15 - 5, 500);
    const events = run(world, 1);
    expect(ofType(events, 'allyKill').map((e) => e.mobId)).toEqual([mob.id]);
    expect(ofType(events, 'allySpawn').map((e) => e.mobId)).toEqual([mob.id]);
    expect(world.allies).toHaveLength(2);
  });
});

describe('ally AI', () => {
  it('targets the mob nearest to it among those within 400 of the hero', () => {
    const world = hero();
    const ally = addAlly(world, 850, 500);
    const near = addMob(world, 'post', 560, 500);
    const farFromHero = addMob(world, 'post', 950, 500); // 450 from the hero: out of the leash
    addMob(world, 'post', 300, 500);
    expect(allyTarget(world, ally)?.id).toBe(near.id);
    expect(allyTarget(world, { ...ally, leashRadius: 500 })?.id).toBe(farFromHero.id);
  });

  it('walks to its target and swings the zombie attack (4–7, every 1.3 s) at it, hero modifiers ignored', () => {
    const world = hero();
    const mob = addMob(world, 'post', 700, 500);
    const ally = addAlly(world, 600, 500);
    run(world, 1);
    // 187.5 units / s toward the mob.
    expect(ally.pos.x).toBeCloseTo(600 + 187.5 / 60, 9);
    const events = run(world, 60);
    const swings = ofType(events, 'allyAttack');
    expect(swings).toHaveLength(1);
    expect(swings[0]).toMatchObject({ allyId: ally.id, targetId: mob.id });
    const hits = ofType(events, 'hit').filter((e) => e.source === 'ally');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ targetId: mob.id, allyId: ally.id, isCrit: false });
    expect(hits[0]!.amount).toBeGreaterThanOrEqual(4);
    expect(hits[0]!.amount).toBeLessThanOrEqual(7);
    expect(mob.life).toBe(post.life - hits[0]!.amount);
    // The next swing 1.3 s (78 steps) later.
    const next = run(world, 78);
    expect(ofType(next, 'allyAttack')).toHaveLength(1);
  });

  it('with no mob in the leash it follows the hero and stops 70 away', () => {
    const world = hero();
    const ally = addAlly(world, 800, 500);
    run(world, 1);
    expect(ally.pos.x).toBeCloseTo(800 - 187.5 / 60, 9);
    run(world, 120);
    expect(ally.pos.x).toBeCloseTo(570, 9);
    expect(ally.pos.y).toBe(500);
  });

  it('allies push each other apart', () => {
    const world = hero();
    const a = addAlly(world, 300, 300);
    const b = addAlly(world, 300, 300);
    run(world, 1);
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeGreaterThanOrEqual(2 * zombie.radius - 1e-9);
  });
});

describe('enemies attack allies', () => {
  it('a mob goes for the nearer of hero and skeleton and hits it (no hero hit)', () => {
    const world = hero();
    const mob = addMob(world, 'post', 800, 500, { defId: 'dummy' });
    const ally = addAlly(world, 800 - 10 - 15 - 2, 500, { attackTimer: 100 });
    const events = run(world, 1);
    expect(ofType(events, 'mobAttack')).toEqual([{ type: 'mobAttack', id: mob.id, allyId: ally.id }]);
    expect(ofType(events, 'allyHit')).toEqual([{ type: 'allyHit', allyId: ally.id, pos: ally.pos, amount: 10, isCrit: false }]);
    expect(ally.life).toBe(6);
    expect(ofType(events, 'hit').filter((e) => e.targetId === world.player.id)).toEqual([]);
  });

  it('a skeleton dies to enemy hits (killed), then the mob turns to the hero', () => {
    const world = hero();
    addMob(world, 'biter', 800, 500);
    const ally = addAlly(world, 800 - 10 - 15 - 2, 500, { attackTimer: 100 });
    const events = run(world, 1);
    expect(ofType(events, 'allyExpire')).toEqual([{ type: 'allyExpire', allyId: ally.id, pos: ally.pos, reason: 'killed' }]);
    expect(world.allies).toEqual([]);
    expect(mobTarget(world, world.mobs[0]!)).toBe(world.player);
  });

  it('bosses ignore skeletons (a decoy still taunts them)', () => {
    const world = hero();
    const boss = addMob(world, 'post', 800, 500, { rank: 'boss' });
    const ally = addAlly(world, 780, 500);
    expect(mobTarget(world, boss, true)).toBe(world.player);
    expect(mobTarget(world, boss, false)).toBe(ally);
  });

  it('a taunting decoy wins over a nearer skeleton', () => {
    const world = hero();
    const mob = addMob(world, 'post', 800, 500);
    addAlly(world, 790, 500);
    world.decoys.push({ id: world.nextId++, kind: 'test', pos: vec(700, 500), radius: 10, tauntRadius: 300, remaining: 5, bossTauntRemaining: 5 });
    const target = mobTarget(world, mob);
    expect(targetDecoy(target)?.id).toBe(world.decoys[0]!.id);
    expect(targetAlly(target)).toBeUndefined();
  });

  it("a boss's nova hits skeletons inside it (the boss itself aims at the hero)", () => {
    const world = hero();
    addMob(world, 'novaBoss', 800, 500, { rank: 'boss', phase: 1, abilityTimers: { testNova: 0 }, castRecovery: 0 });
    const ally = addAlly(world, 830, 500, { attackTimer: 100 });
    const events = run(world, 10);
    const nova = ofType(events, 'mobAbility');
    expect(nova).toHaveLength(1);
    expect(nova[0]!.hit).toBe(false);
    expect(ofType(events, 'allyHit')).toEqual([{ type: 'allyHit', allyId: ally.id, pos: ally.pos, amount: 5, isCrit: false }]);
  });

  it("a shot aimed at the hero is stopped by a skeleton in its path (a boss ignores skeletons as targets)", () => {
    const world = hero();
    addMob(world, 'sniper', 900, 500, { rank: 'boss' });
    const ally = addAlly(world, 700, 500, { attackTimer: 100, leashRadius: 0, followDistance: 1000 });
    const events = run(world, 30);
    expect(ofType(events, 'mobAttack')).toEqual([{ type: 'mobAttack', id: world.mobs[0]!.id }]);
    expect(ofType(events, 'allyHit').map((e) => e.allyId)).toEqual([ally.id]);
    expect(ofType(events, 'hit').filter((e) => e.targetId === world.player.id)).toEqual([]);
  });

  it("a fiery elite's hit is fire against a skeleton: its def's fire resistance applies", () => {
    const fireproof: Content = { ...content, mobs: { ...content.mobs, zombie: { ...zombie, resistances: { fire: 0.5, cold: 0, lightning: 0 } } } };
    const hits = (eliteModifier?: string): number[] => {
      const world = hero(eye, undefined, 'hero', fireproof);
      addMob(world, 'post', 800, 500, { defId: 'dummy', rank: 'elite', ...(eliteModifier ? { eliteModifier } : {}) });
      addAlly(world, 800 - 10 - 15 - 2, 500, { attackTimer: 100 });
      return ofType(run(world, 1, idle, fireproof), 'allyHit').map((e) => e.amount);
    };
    expect(hits()).toEqual([10]);
    expect(hits('fiery')).toEqual([5]);
  });

  it('a mob projectile is stopped by a skeleton in its way', () => {
    const world = hero();
    addMob(world, 'sniper', 900, 500);
    const ally = addAlly(world, 700, 500, { attackTimer: 100, leashRadius: 0, followDistance: 1000 });
    // The sniper aims at the nearer target: the skeleton.
    const events = run(world, 30);
    expect(ofType(events, 'allyHit')).toHaveLength(1);
    expect(ally.life).toBe(6);
    expect(ofType(events, 'hit').filter((e) => e.targetId === world.player.id)).toEqual([]);
  });

  it('hostile zones hit skeletons inside them', () => {
    const world = hero();
    const ally = addAlly(world, 200, 200, { leashRadius: 0, followDistance: 1000 });
    const zone: HostileZone = { id: world.nextId++, sourceId: 0, sourceDefId: 'dummy', abilityId: 'test', pos: vec(205, 200), radius: 30, remaining: DT, total: 1, source: 'eliteDeath', damage: { physical: { min: 3, max: 3 } }, critChance: 0 };
    world.hostileZones.push(zone);
    const events = run(world, 1);
    expect(ofType(events, 'allyHit')).toEqual([{ type: 'allyHit', allyId: ally.id, pos: ally.pos, amount: 3, isCrit: false }]);
    expect(ofType(events, 'hostileZoneErupt')[0]!.hit).toBe(false);
  });
});

describe('resource: only skeleton kills restore it', () => {
  it("a skeleton's kill restores 10% of max resource and gives the normal rewards", () => {
    const world = hero();
    world.player.resource = 0;
    const mob = addMob(world, 'dummy', 620, 500, { life: 1 });
    addAlly(world, 620 - 10 - 15 - 5, 500);
    const events = run(world, 1);
    expect(mob.killedBy).toBe('ally');
    expect(ofType(events, 'allyKill')).toEqual([{ type: 'allyKill', mobId: mob.id, pos: mob.pos, resource: 2 }]);
    expect(world.player.resource).toBe(2);
    expect(world.kills).toBe(1);
    expect(world.xpGained).toBeGreaterThan(0);
    // The hero's own kill gives no resource.
    const own = hero();
    own.player.resource = 0;
    addMob(own, 'dummy', 530, 500);
    const ownEvents = run(own, 1, attack);
    expect(ofType(ownEvents, 'allyKill')).toEqual([]);
    expect(own.player.resource).toBe(0);
  });

  it('a skeleton that kills a boss restores resource, but the boss does not rise', () => {
    const world = hero();
    world.player.resource = 0;
    const boss = addMob(world, 'dummy', 620, 500, { life: 1, rank: 'boss' });
    addAlly(world, 620 - 10 - 15 - 5, 500);
    const events = run(world, 1);
    expect(ofType(events, 'allyKill')).toEqual([{ type: 'allyKill', mobId: boss.id, pos: boss.pos, resource: 2 }]);
    expect(ofType(events, 'allySpawn')).toEqual([]);
    expect(world.player.resource).toBe(2);
  });

  const only: readonly PassiveMechanic[] = [{ kind: 'allyOnlyResource' }];

  it.each(['warrior', 'ranger', 'mage'])('%s: no regeneration, no gain on hit or from damage taken', (classId) => {
    const classDef = gameContent.classes[classId]!;
    for (const [mechanics, blocked] of [[only, true], [[], false]] as const) {
      const world = hero(mechanics, undefined, classId, gameContent);
      const player = world.player;
      player.resource = 30;
      player.combatIdle = 0;
      tickResource(classDef, player, 1);
      const regen = player.resource - 30;
      const hitGain = resourceOnHeroHit(classDef, player, player.actions.basicAttack);
      const takenGain = resourceOnHeroHitTaken(classDef, player, 20);
      if (blocked) expect([regen, hitGain, takenGain]).toEqual([0, 0, 0]);
      else expect(regen + hitGain + takenGain).toBeGreaterThan(0);
    }
  });

  it('Rage decay still drains out of combat', () => {
    const classDef = gameContent.classes.warrior!;
    const world = hero(only, undefined, 'warrior', gameContent);
    const player = world.player;
    player.resource = 50;
    // Spawn: out of combat already.
    tickResource(classDef, player, 1);
    expect(player.resource).toBe(50 - classDef.resource.decay!.perSecond);
  });

  it("a skill's resourcePerHit (Barrow Reaper) gives nothing either", () => {
    const reaper = itemsData.uniques.barrow_reaper!.mechanics!;
    const cleave: PlayerInput = { ...idle, skills: [true] };
    const gains = (mechanics: readonly PassiveMechanic[]): number => {
      const world = hero(mechanics, undefined, 'warrior', gameContent);
      world.player.resource = 50;
      // In combat: no Rage decay in this step.
      world.player.combatIdle = 0;
      addMob(world, 'post', 560, 500);
      run(world, 1, cleave, { ...gameContent, mobs: { ...gameContent.mobs, post } });
      return world.player.resource;
    };
    const cost = gameContent.classes.warrior!.skills[0]!.resourceCost;
    expect(gains([...reaper, ...only])).toBe(50 - cost);
    expect(gains(reaper)).toBeGreaterThan(50 - cost);
  });
});

describe('hero death', () => {
  it('a hero who died earlier in the step stops the skeletons (no ageing, moving or swinging)', () => {
    const world = hero();
    const mob = addMob(world, 'post', 620, 500);
    const ally = addAlly(world, 620 - 10 - 15 - 5, 500);
    world.player.dead = true;
    const events: WorldEvent[] = [];
    updateAllies({ world, content, classDef: heroClass, rng: createRng(1), events, input: idle }, DT);
    expect(events).toEqual([]);
    expect(ally.remaining).toBe(8);
    expect(mob.life).toBe(post.life);
  });
});

describe('time stop and determinism', () => {
  it('during a time stop skeletons keep fighting (and ageing) while mobs stand still', () => {
    const world = hero();
    const mob = addMob(world, 'dummy', 620, 500, { life: 1000 });
    const ally = addAlly(world, 620 - 10 - 15 - 5, 500);
    world.timeStop = 3;
    const events = run(world, 60);
    expect(ofType(events, 'allyAttack').length).toBeGreaterThan(0);
    expect(ofType(events, 'mobAttack')).toEqual([]);
    expect(mob.life).toBeLessThan(1000);
    expect(ally.remaining).toBeCloseTo(7, 9);
  });

  it('same seed, same allies, same fight', () => {
    const play = (): string => {
      const world = hero(eye, { life: 3, damage: 2, armour: 1 });
      for (let i = 0; i < 8; i++) addMob(world, i % 2 === 0 ? 'dummy' : 'biter', 400 + i * 30, 450 + (i % 3) * 40);
      const events = run(world, 300, attack);
      return JSON.stringify({ events, allies: world.allies, mobs: world.mobs, rng: world.rngState });
    };
    const a = play();
    expect(play()).toBe(a);
    expect(a).toContain('allySpawn');
  });
});

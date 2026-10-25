// Cheat death and the time stop (legendary Clock of the Last Moment, 0.4 pkg 6d; docs/design/items.md, defaults in
// overnight-questions.md «Пакет 6»): a lethal hit / burn leaves the hero at 1 life, the enemies' time stands still
// for 3 s while the hero acts, then 90 s of recharge with 20% more damage taken.
import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data/index';
import { itemsData } from '../../data/items';
import { vec } from '../math';
import type { PassiveMechanic } from '../passives/types';
import { computeStat } from '../stats/modifiers';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { cheatDeathReady, cheatDeathStats } from './cheatDeath';
import { allModifiers, createWorld, step, type HostileZone, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;
/** Steps of the 3 s stop after the step it started in: the stop runs out at the start of the 180th. */
const FROZEN_STEPS = 179;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 5,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};
const biter: MobDef = { ...dummy, id: 'biter', attack: { ...dummy.attack, damage: { physical: { min: 1000, max: 1000 } } } };
const walker: MobDef = { ...dummy, id: 'walker', moveSpeed: 100 };
const sniper: MobDef = { ...biter, id: 'sniper', attack: { ...biter.attack, range: 400, projectile: { speed: 300, radius: 5 } } };
const archer: MobDef = { ...dummy, id: 'archer', preferredRange: 200, attack: { ...dummy.attack, range: 400, projectile: { speed: 300, radius: 5 } } };

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};

const heroClass: ClassDef = {
  id: 'hero',
  radius: 10,
  weaponType: 'sword',
  baseStats: { life: 100, resource: 20, resourceRegen: 0, movementSpeed: 120 },
  resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
  weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
  basicAttack: strike,
  skills: [],
};

const content: Content = {
  ...gameContent,
  classes: { ...gameContent.classes, hero: heroClass },
  mobs: { ...gameContent.mobs, dummy, biter, sniper, walker, archer },
  arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
};

/** The real Clock's mechanics (its stat lines are left out: only the mechanics count here). */
const clock: readonly PassiveMechanic[] = itemsData.uniques.clock_last_moment!.mechanics!;
const crystalShell: PassiveMechanic = { kind: 'lifeToEnergyShield', maxLife: 1, lifeRegenToShield: true };

function hero(mechanics: readonly PassiveMechanic[] = clock, data: Content = content): WorldState {
  return createWorld(data, 'hero', 1, { mechanics });
}

function addMob(world: WorldState, defId: string, x: number, y: number, extra: Partial<MobState> = {}): MobState {
  const def = content.mobs[defId]!;
  const mob: MobState = { id: world.nextId++, defId, pos: vec(x, y), facing: vec(0, 1), life: def.life, maxLife: def.life, attackTimer: 0, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: def.radius, ...extra };
  world.mobs.push(mob);
  return mob;
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(600, 500), basicAttack: false, skills: [] };
const attack: PlayerInput = { ...idle, basicAttack: true };

function run(world: WorldState, steps: number, input: PlayerInput = idle, data: Content = content): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, data, DT));
  return events;
}

const ofType = <T extends WorldEvent['type']>(events: readonly WorldEvent[], type: T): Extract<WorldEvent, { type: T }>[] =>
  events.filter((e): e is Extract<WorldEvent, { type: T }> => e.type === type);
const heroHits = (world: WorldState, events: readonly WorldEvent[]): number[] =>
  ofType(events, 'hit').filter((e) => e.targetId === world.player.id).map((e) => e.amount);

describe('Clock of the Last Moment: data', () => {
  it('a legendary amulet: survive at 1 life, 3 s stop, 90 s recharge, 20% more damage taken while recharging', () => {
    const def = itemsData.uniques.clock_last_moment!;
    expect(def.rarity).toBe('legendary');
    expect(itemsData.bases[def.baseId]!.slot).toBe('amulet');
    expect(def.weight).toBe(itemsData.uniques.devourer_crown!.weight);
    expect(def.mechanics).toEqual([
      { kind: 'cheatDeath', life: 1, stopDuration: 3, cooldown: 90 },
      { kind: 'conditionalModifiers', condition: { kind: 'cheatDeathRecharging' }, modifiers: [{ stat: 'damageTaken', kind: 'more', value: 0.2 }] },
    ]);
    expect(cheatDeathStats(hero().player)).toEqual({ kind: 'cheatDeath', life: 1, stopDuration: 3, cooldown: 90 });
    expect(cheatDeathStats(hero([]).player)).toBeUndefined();
  });
});

describe('Clock of the Last Moment: cheat death', () => {
  it('a lethal hit leaves the hero at 1 life and stops time; the next mob in the same step does not hit', () => {
    const world = hero();
    expect(cheatDeathReady(world.player)).toBe(true);
    const first = addMob(world, 'biter', 520, 500);
    const second = addMob(world, 'biter', 480, 500);
    const events = run(world, 1);
    expect(heroHits(world, events)).toEqual([1000]);
    expect(events.map((e) => e.type).filter((t) => t === 'hit' || t === 'cheatDeath' || t === 'playerDeath' || t === 'mobAttack')).toEqual([
      'mobAttack',
      'hit',
      'cheatDeath',
    ]);
    expect(ofType(events, 'cheatDeath')).toEqual([{ type: 'cheatDeath', pos: world.player.pos, stopDuration: 3, cooldown: 90 }]);
    expect(world.player).toMatchObject({ life: 1, energyShield: 0, dead: false, cheatDeathCooldown: 90 });
    expect(world.timeStop).toBe(3);
    expect(cheatDeathReady(world.player)).toBe(false);
    expect([first.attackTimer, second.attackTimer]).toEqual([1, 0]);
  });

  it('without the Clock the same hit kills', () => {
    const world = hero([]);
    addMob(world, 'biter', 520, 500);
    const events = run(world, 1);
    expect(ofType(events, 'playerDeath')).toHaveLength(1);
    expect(ofType(events, 'cheatDeath')).toEqual([]);
    expect(world.player.dead).toBe(true);
    expect(world.timeStop).toBe(0);
  });

  it('a lethal burn is survived too and the hero ignite is cleared; the hero keeps acting that step', () => {
    const world = hero();
    world.player.life = 5;
    world.player.ignite = 2;
    world.player.igniteDps = 600;
    const target = addMob(world, 'dummy', 530, 500);
    const events = run(world, 1, attack);
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(['dot', 'cheatDeath']);
    expect(world.player).toMatchObject({ life: 1, ignite: 0, igniteDps: 0, dead: false, cheatDeathCooldown: 90 });
    expect(world.timeStop).toBe(3);
    // Same step: the hero's attack still lands and kills.
    expect(ofType(events, 'death').map((e) => e.id)).toEqual([target.id]);
  });

  it('during the stop mobs, mob projectiles and hostile zones freeze while the hero hits and kills; all resume after 3 s', () => {
    const world = hero();
    addMob(world, 'biter', 480, 500);
    const walking = addMob(world, 'walker', 800, 500, { life: 100, maxLife: 100, ignite: 4, igniteDps: 1, stun: 0.5 });
    const shooter = addMob(world, 'archer', 500, 900, { attackTimer: 0.5 });
    const target = addMob(world, 'dummy', 530, 500);
    world.projectiles.push({ id: world.nextId++, owner: 'mob', sourceId: 'archer', pos: vec(500, 700), dir: vec(0, -1), speed: 300, radius: 5, remaining: 500, travelled: 0, pierceLeft: 0, explodeRadius: 0, hitIds: [], castModifiers: [] });
    const zone: HostileZone = { id: world.nextId++, sourceId: shooter.id, sourceDefId: 'archer', abilityId: 'death', pos: vec(500, 500), radius: 50, remaining: 0.5, total: 1, source: 'eliteDeath', damage: { physical: { min: 10, max: 10 } } };
    world.hostileZones.push(zone);

    const triggered = run(world, 1);
    expect(ofType(triggered, 'cheatDeath')).toHaveLength(1);
    // The walker and the archer came after the biter in the mob loop: already frozen in the step the stop started.
    expect(walking.pos).toEqual(vec(800, 500));
    expect(shooter.attackTimer).toBe(0.5);
    expect(world.projectiles[0]!.pos).toEqual(vec(500, 700));
    expect(zone.remaining).toBe(0.5);

    const during = run(world, FROZEN_STEPS, attack);
    expect(ofType(during, 'death').map((e) => e.id)).toEqual([target.id]);
    expect(heroHits(world, during)).toEqual([]);
    expect(ofType(during, 'mobAttack')).toEqual([]);
    expect(ofType(during, 'timeStopEnd')).toEqual([]);
    expect(walking).toMatchObject({ pos: vec(800, 500), life: 100, ignite: 4, stun: 0.5 });
    expect(shooter.attackTimer).toBe(0.5);
    expect(world.projectiles.filter((p) => p.owner === 'mob').map((p) => p.pos)).toEqual([vec(500, 700)]);
    expect(world.hostileZones.map((z) => z.remaining)).toEqual([0.5]);
    expect(world.player.life).toBe(1);
    expect(world.timeStop).toBeCloseTo(DT, 9);

    // Step 180 after the trigger: the stop runs out first, the enemies act in this very step.
    const resumed = run(world, 1);
    expect(ofType(resumed, 'timeStopEnd')).toEqual([{ type: 'timeStopEnd' }]);
    expect(world.timeStop).toBe(0);
    expect(walking.ignite).toBeCloseTo(4 - DT, 9);
    expect(world.projectiles.find((p) => p.owner === 'mob')!.pos.y).toBeCloseTo(700 - 300 * DT, 9);
    expect(world.hostileZones[0]!.remaining).toBeCloseTo(0.5 - DT, 9);
    // The biter's attack timer (1 s) restarted in the trigger step and ran 1 step since: it bites again 59 steps later,
    // during the recharge, and that hit kills.
    const later = run(world, 59);
    expect(ofType(later, 'playerDeath')).toHaveLength(1);
    expect(ofType(later, 'cheatDeath')).toEqual([]);
    expect(world.player.dead).toBe(true);
  });

  it('a stop starting inside the projectile loop holds the mob projectiles after it in that step', () => {
    const world = hero();
    const shot = (x: number, dirX: number): void => {
      world.projectiles.push({ id: world.nextId++, owner: 'mob', sourceId: 'sniper', pos: vec(x, 500), dir: vec(dirX, 0), speed: 300, radius: 5, remaining: 100, travelled: 0, pierceLeft: 0, explodeRadius: 0, hitIds: [], castModifiers: [] });
    };
    // Both reach the hero this step (5 units per step, contact at 15).
    shot(480, 1);
    shot(520, -1);
    const events = run(world, 1);
    expect(heroHits(world, events)).toEqual([1000]);
    expect(ofType(events, 'cheatDeath')).toHaveLength(1);
    expect(world.player).toMatchObject({ life: 1, dead: false });
    // The second shot did not move and is still there.
    expect(world.projectiles.map((p) => p.pos)).toEqual([vec(520, 500)]);
  });

  it('the arena spawner waits during the stop', () => {
    const spawning: Content = { ...content, arena: { ...content.arena, spawn: { firstDelay: 1, interval: 1, batchStart: 1, batchGrowth: 0, maxAlive: 10, mobIds: ['dummy'] } } };
    const world = hero(clock, spawning);
    world.timeStop = 3;
    const during = run(world, FROZEN_STEPS, idle, spawning);
    expect(ofType(during, 'spawn')).toEqual([]);
    expect(world.spawn.timer).toBe(1);
    const after = run(world, 60, idle, spawning);
    expect(ofType(after, 'timeStopEnd')).toHaveLength(1);
    expect(ofType(after, 'spawn')).toHaveLength(1);
  });

  it('recharges for exactly 90 s of world time, then saves again', () => {
    const world = hero();
    addMob(world, 'biter', 520, 500);
    run(world, 1);
    world.mobs = [];
    run(world, 5399);
    expect(world.player.cheatDeathCooldown).toBeGreaterThan(0);
    expect(cheatDeathReady(world.player)).toBe(false);
    run(world, 1);
    expect(world.player.cheatDeathCooldown).toBe(0);
    expect(cheatDeathReady(world.player)).toBe(true);
    addMob(world, 'biter', 520, 500);
    const again = run(world, 1);
    expect(ofType(again, 'cheatDeath')).toHaveLength(1);
    expect(world.player).toMatchObject({ life: 1, dead: false, cheatDeathCooldown: 90 });
  });

  it('cost: 20% more damage taken while recharging, none while ready', () => {
    const hitFor = (cooldown: number): number => {
      const world = hero();
      world.player.cheatDeathCooldown = cooldown;
      addMob(world, 'dummy', 520, 500);
      return heroHits(world, run(world, 1))[0]!;
    };
    expect(hitFor(0)).toBe(10);
    expect(hitFor(30)).toBeCloseTo(12, 9);
    const world = hero();
    const taken = (): number => computeStat(1, allModifiers(heroClass, world.player), 'damageTaken');
    expect(taken()).toBe(1);
    world.player.cheatDeathCooldown = 0.5;
    expect(taken()).toBeCloseTo(1.2, 9);
    // Without the Clock a running cooldown value means nothing.
    const plain = hero([]);
    plain.player.cheatDeathCooldown = 30;
    expect(computeStat(1, allModifiers(heroClass, plain.player), 'damageTaken')).toBe(1);
  });

  it('Crystal Shell: death is the ES + 1 life pool running out; the save leaves 1 life and no ES', () => {
    const world = hero([crystalShell, ...clock]);
    expect(world.player.life).toBe(1);
    expect(world.player.energyShield).toBe(100);
    addMob(world, 'biter', 520, 500);
    const events = run(world, 1);
    expect(ofType(events, 'cheatDeath')).toHaveLength(1);
    expect(world.player).toMatchObject({ life: 1, energyShield: 0, dead: false });
    // A hit the ES would have absorbed but no longer can: the next one (after the stop, while recharging) kills.
    world.mobs = [];
    run(world, FROZEN_STEPS + 1);
    addMob(world, 'dummy', 520, 500);
    const next = run(world, 1);
    expect(heroHits(world, next)).toEqual([12]);
    expect(world.player.dead).toBe(true);
  });
});

// Unique item mechanics of sub-package 6a (docs/design/items.md, uniques #10 #4 #7 #2) end to end: the item's
// modifiers and mechanics reach the run through heroModifiers / heroMechanics, on the real class data.
import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data/index';
import { itemsData } from '../../data/items';
import { passiveTree } from '../../data/passives';
import type { Equipment } from '../items/equipment';
import type { EquipSlot, Item } from '../items/types';
import { vec } from '../math';
import { createAllocation } from '../passives/allocation';
import { heroMechanics, heroModifiers } from '../progression/hero';
import { computeStat } from '../stats/modifiers';
import type { ActionDef, Content, MobDef } from './content';
import { createWorld, step, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 1000,
  xp: 0,
  armour: 0,
  resistances: { fire: 0.75, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 1, max: 1 } }, range: 5, interval: 100, critChance: 0 },
};

/** The real content without arena spawns, plus a fire-resistant dummy. */
function makeContent(patch: (c: Content) => Content = (c) => c): Content {
  return patch({
    ...gameContent,
    mobs: { ...gameContent.mobs, dummy },
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
  });
}

/** A unique with all stat lines rolled to 0, so only its effect, costs and mechanics count. */
function unique(id: string): Item {
  const def = itemsData.uniques[id]!;
  return { id: `u_${id}`, baseId: def.baseId, level: 1, rarity: def.rarity, name: '', affixes: [], unique: { id, rolls: def.stats.map(() => ({ tier: 5, value: 0 })) } };
}

function loadout(slot: EquipSlot, item: Item | undefined): { modifiers: ReturnType<typeof heroModifiers>; mechanics: ReturnType<typeof heroMechanics> } {
  const equipment: Equipment = item ? { [slot]: item } : {};
  const hero = { equipment, passives: createAllocation() };
  return { modifiers: heroModifiers(hero, itemsData, passiveTree), mechanics: heroMechanics(hero, passiveTree, itemsData) };
}

function addMob(world: WorldState, x: number, y: number): MobState {
  const mob: MobState = { id: world.nextId++, defId: 'dummy', pos: vec(x, y), facing: vec(0, 1), life: 1000, maxLife: 1000, attackTimer: 100, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: 10 };
  world.mobs.push(mob);
  return mob;
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };
const skill0: PlayerInput = { ...idle, skills: [true] };

function run(world: WorldState, content: Content, input: PlayerInput, steps: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...step(world, input, content, DT));
  return events;
}

const hits = (events: readonly WorldEvent[]): Extract<WorldEvent, { type: 'hit' }>[] => events.filter((e): e is Extract<WorldEvent, { type: 'hit' }> => e.type === 'hit');

describe('Glass Cannon Crown (#10)', () => {
  it('+50% more damage and 40% more damage taken, as plain modifiers', () => {
    const { modifiers, mechanics } = loadout('helmet', unique('glass_cannon_crown'));
    expect(mechanics).toEqual([]);
    expect(computeStat(10, modifiers, 'damage')).toBe(15);
    // damageTaken has base 1 (stats/types).
    expect(computeStat(1, modifiers, 'damageTaken')).toBeCloseTo(1.4, 10);
  });
});

describe('Splitter (#4)', () => {
  it('bolts (attack projectiles, basic attack included) pierce 2 more targets; the trap is untouched', () => {
    const content = makeContent();
    const world = createWorld(content, 'ranger', 1, loadout('weapon', unique('splitter')));
    const { basicAttack, skills } = world.player.actions;
    const pierce = (a: ActionDef): number | undefined => (a.delivery.kind === 'projectile' ? a.delivery.pierce : undefined);
    expect(pierce(basicAttack)).toBe(2);
    expect(pierce(skills.find((s) => s.id === 'volley')!)).toBe(2);
    expect(skills.find((s) => s.id === 'explosive_trap')).toEqual(content.classes.ranger!.skills.find((s) => s.id === 'explosive_trap'));
    // The cost: 25% less damage.
    expect(computeStat(100, loadout('weapon', unique('splitter')).modifiers, 'damage', ['attack', 'projectile'])).toBe(75);
  });
});

describe('Heart of Winter (#7)', () => {
  it('Fireball deals cold instead of fire (fire resistance no longer applies) and slows', () => {
    const content = makeContent();
    const world = createWorld(content, 'mage', 3, loadout('weapon', unique('heart_of_winter')));
    const fireball = world.player.actions.skills.find((s) => s.id === 'fireball')!;
    expect(fireball.damageConversion).toEqual({ to: 'cold', fraction: 1 });
    expect(fireball.onHit).toContainEqual({ status: 'slow', duration: 2, magnitude: 0.3 });
    const mob = addMob(world, 700, 500);
    const events = run(world, content, skill0, 1);
    for (let i = 0; i < 120 && mob.life === 1000; i++) events.push(...run(world, content, idle, 1));
    // Fireball base 18–26: unresisted (75% fire resistance would leave at most 6.5, 9.75 on a crit).
    const hit = hits(events).find((h) => h.targetId === mob.id)!;
    expect(hit.amount).toBeGreaterThanOrEqual(18);
    expect(mob.slowMagnitude).toBe(0.3);
    expect(mob.slow).toBeGreaterThan(1.9);

    // Without the wand the same fireball is resisted.
    const plain = createWorld(content, 'mage', 3);
    const target = addMob(plain, 700, 500);
    run(plain, content, skill0, 1);
    for (let i = 0; i < 120 && target.life === 1000; i++) run(plain, content, idle, 1);
    expect(1000 - target.life).toBeLessThanOrEqual(9.75);
    expect(target.slow).toBe(0);
  });

  it('a fire zone the converted Fireball leaves deals cold too (designer default 2026-10-25)', () => {
    // Fireball has no zone in the data; give it one here to test the zone tick conversion.
    const content = makeContent((c) => {
      const mage = c.classes.mage!;
      const skills = mage.skills.map((s) =>
        s.id === 'fireball' ? { ...s, zone: { id: 'fire_puddle', duration: 3, radius: 60, tick: { interval: 0.5, damage: { fire: { min: 4, max: 4 } } } } } : s,
      );
      return { ...c, classes: { ...c.classes, mage: { ...mage, skills } } };
    });
    const tickAmounts = (item: Item | undefined): number[] => {
      const world = createWorld(content, 'mage', 3, loadout('weapon', item));
      addMob(world, 700, 500);
      const events = run(world, content, skill0, 1);
      events.push(...run(world, content, idle, 240));
      return hits(events)
        .filter((h) => h.source === 'zone')
        .map((h) => h.amount);
    };
    // 4 cold per tick, unresisted; 4 fire × (1 − 0.75) = 1 without the wand. 6 ticks in 3 s.
    expect(tickAmounts(unique('heart_of_winter'))).toEqual([4, 4, 4, 4, 4, 4]);
    expect(tickAmounts(undefined)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe('Barrow Reaper (#2)', () => {
  it('Cleave grants 2 Rage per enemy hit, on top of the usual gains; other skills do not', () => {
    const rageAfterCleave = (item: Item | undefined): { rage: number; hit: number } => {
      const content = makeContent();
      const world = createWorld(content, 'warrior', 1, loadout('weapon', item));
      world.player.resource = 50;
      // In combat: no Rage decay during the swing.
      world.player.combatIdle = 0;
      const mobs = [addMob(world, 560, 470), addMob(world, 570, 500), addMob(world, 560, 530)];
      run(world, content, skill0, 1);
      for (let i = 0; i < 60 && mobs.some((m) => m.life === 1000); i++) run(world, content, idle, 1);
      return { rage: world.player.resource, hit: mobs.filter((m) => m.life < 1000).length };
    };
    const reaper = rageAfterCleave(unique('barrow_reaper'));
    const plain = rageAfterCleave(undefined);
    expect(reaper.hit).toBe(3);
    expect(plain.hit).toBe(3);
    // Cleave costs 6 and gives no Rage of its own (the warrior's onHit counts the basic attack only).
    expect(plain.rage).toBe(44);
    expect(reaper.rage).toBe(50);
  });

  it('only Cleave gets resourcePerHit', () => {
    const world = createWorld(makeContent(), 'warrior', 1, loadout('weapon', unique('barrow_reaper')));
    const { basicAttack, skills } = world.player.actions;
    expect(skills.find((s) => s.id === 'cleave')!.resourcePerHit).toBe(2);
    expect([basicAttack, ...skills.filter((s) => s.id !== 'cleave')].map((a) => a.resourcePerHit)).toEqual([undefined, undefined, undefined]);
  });
});

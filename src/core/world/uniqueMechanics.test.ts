// Unique item mechanics of sub-packages 6a / 6b (docs/design/items.md, uniques #10 #4 #7 #2, #1 #9 #3 #6 #5 #8) end to end: the item's
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
import { mitigate } from '../combat/mitigation';
import type { PassiveMechanic } from '../passives/types';
import { createRng } from '../rng';
import { computeStat } from '../stats/modifiers';
import type { Modifier } from '../stats/types';
import type { ActionDef, Content, MobDef } from './content';
import { damagePlayer } from './mobs';
import { createWorld, playerStat, step, type Ctx, type Loadout, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

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

describe('Heart of Winter (#7): split fireballs', () => {
  it('the level-3 split children carry the cold conversion and the slow (child action snapshot)', () => {
    const content = makeContent();
    const world = createWorld(content, 'mage', 3, { ...loadout('weapon', unique('heart_of_winter')), skills: { fireball: { level: 3, xp: 0 } } });
    addMob(world, 700, 500);
    const events = run(world, content, skill0, 1);
    for (let i = 0; i < 120 && !events.some((e) => e.type === 'projectileSplit'); i++) events.push(...run(world, content, idle, 1));
    const split = events.find((e): e is Extract<WorldEvent, { type: 'projectileSplit' }> => e.type === 'projectileSplit')!;
    expect(split.childIds).toHaveLength(3);
    const children = world.projectiles.filter((p) => split.childIds.includes(p.id));
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.action!.damageConversion).toEqual({ to: 'cold', fraction: 1 });
      expect(child.action!.onHit).toContainEqual({ status: 'slow', duration: 2, magnitude: 0.3 });
    }
  });
});

// ── Sub-package 6b: #1 #9 #3 #6 #5 #8 ──

/** One step's context for calling core systems directly (damagePlayer). */
function ctxOf(world: WorldState, content: Content, seed = 1): Ctx {
  return { world, content, classDef: content.classes[world.player.classId]!, rng: createRng(seed), events: [], input: idle };
}

const mechanicsOf = (nodeId: string): PassiveMechanic[] => [...(passiveTree.nodes[nodeId]!.mechanics ?? [])];

describe('Iron Heart Oath (#1)', () => {
  it('mitigate: elemental armour reduces each elemental part after its resistance; physical uses plain armour', () => {
    const defences = { armour: 100, elementalArmour: 50, resistances: { fire: 0.5, cold: 0, lightning: 0 } };
    const result = mitigate({ physical: 100, fire: 100 }, defences, gameContent.combat);
    // Fire: 100 × 0.5 = 50, then armour 50 vs a 50 hit: 50 / (50 + 5 × 50) = 1/6 → 41.67.
    expect(result.fire).toBeCloseTo(50 * (5 / 6), 10);
    // Physical: armour 100 vs 100: 100 / 600 = 1/6.
    expect(result.physical).toBeCloseTo(100 * (5 / 6), 10);
    // Without elemental armour the fire part is only resisted.
    expect(mitigate({ fire: 100 }, { armour: 100, resistances: defences.resistances }, gameContent.combat).fire).toBe(50);
  });

  it('a fire hit on the hero is reduced by 50% of the armour; cost: 20% less movement speed', () => {
    const content = makeContent();
    const hitFor = (item: Item | undefined): { taken: number; armour: number; speed: number } => {
      const world = createWorld(content, 'warrior', 1, loadout('armour', item));
      world.player.energyShield = 0;
      const before = world.player.life;
      damagePlayer(ctxOf(world, content), { fire: { min: 20, max: 20 } }, 0);
      const classDef = content.classes.warrior!;
      return { taken: before - world.player.life, armour: playerStat(classDef, world.player, 'armour'), speed: playerStat(classDef, world.player, 'movementSpeed') };
    };
    const oath = hitFor(unique('iron_heart_oath'));
    const plain = hitFor(undefined);
    expect(oath.armour).toBe(60);
    // Warrior: 0 fire resistance; armour 60 × 0.5 = 30 vs 20: 30 / (30 + 100) → 20 × 100 / 130.
    expect(oath.taken).toBeCloseTo(2000 / 130, 10);
    expect(plain.taken).toBe(20);
    expect(plain.speed).toBe(200);
    expect(oath.speed).toBe(160);
  });
});

describe('Bloody Pupil (#9)', () => {
  it('cost: 15% less max life', () => {
    const content = makeContent();
    const life = (item: Item | undefined): number => createWorld(content, 'warrior', 1, loadout('ring1', item)).player.life;
    expect(life(unique('bloody_pupil'))).toBeCloseTo(life(undefined) * 0.85, 10);
  });

  it('crits heal 2% of max life, at most once per 0.2 s: three crits in one swing heal once (with Steady Hand)', () => {
    const content = makeContent();
    const gear = loadout('ring1', unique('bloody_pupil'));
    const world = createWorld(content, 'warrior', 1, { ...gear, mechanics: [...gear.mechanics, ...mechanicsOf('k_precise')] });
    const maxLife = world.player.life;
    world.player.life = 20;
    world.player.resource = 50;
    world.player.combatIdle = 0;
    const mobs = [addMob(world, 560, 470), addMob(world, 570, 500), addMob(world, 560, 530)];
    const first = run(world, content, skill0, 1);
    expect(hits(first).filter((h) => mobs.some((m) => m.id === h.targetId)).map((h) => h.isCrit)).toEqual([true, true, true]);
    const heals = (events: readonly WorldEvent[]): number[] => events.filter((e): e is Extract<WorldEvent, { type: 'critHeal' }> => e.type === 'critHeal').map((e) => e.amount);
    expect(heals(first)).toHaveLength(1);
    expect(heals(first)[0]).toBeCloseTo(maxLife * 0.02, 10);
    expect(world.player.critHealCooldown).toBe(0.2);
    // The internal cooldown ends after exactly 12 steps; the next swing (0.625 s later) heals again.
    run(world, content, idle, 12);
    expect(world.player.critHealCooldown).toBe(0);
    const later: WorldEvent[] = [];
    for (let i = 0; i < 60 && heals(later).length === 0; i++) later.push(...run(world, content, skill0, 1));
    expect(heals(later)).toHaveLength(1);
    expect(heals(later)[0]).toBeCloseTo(maxLife * 0.02, 10);
  });

  it('no heal without the ring, crits or not', () => {
    const content = makeContent();
    const world = createWorld(content, 'warrior', 1, { mechanics: mechanicsOf('k_precise') });
    world.player.life = 20;
    world.player.resource = 50;
    addMob(world, 560, 500);
    const events = run(world, content, skill0, 1);
    expect(hits(events).some((h) => h.isCrit)).toBe(true);
    expect(events.some((e) => e.type === 'critHeal')).toBe(false);
  });
});

describe('Ancestral Horn (#3)', () => {
  it('Battle Cry stuns enemies within 180 for 1 s (a boss gets the stun-slow), its cooldown is halved; cost: 10% less life', () => {
    const content = makeContent();
    const world = createWorld(content, 'warrior', 1, loadout('amulet', unique('ancestral_horn')));
    const cry = world.player.actions.skills.find((s) => s.id === 'battle_cry')!;
    expect(cry.cooldown).toBe(6);
    expect(cry.burst).toEqual({ radius: 180 });
    expect(cry.onHit).toEqual([{ status: 'stun', duration: 1 }]);
    world.player.resource = 50;
    const near = addMob(world, 650, 500);
    const far = addMob(world, 800, 500);
    const boss: MobState = { ...addMob(world, 500, 650), rank: 'boss' };
    world.mobs[world.mobs.length - 1] = boss;
    const events = run(world, content, { ...idle, skills: [false, false, true] }, 1);
    expect(events).toContainEqual({ type: 'area', actionId: 'battle_cry', origin: vec(500, 500), facing: vec(1, 0), radius: 180, angleDeg: 360, trigger: 'burst' });
    const stuns = events.filter((e): e is Extract<WorldEvent, { type: 'status' }> => e.type === 'status' && e.status === 'stun');
    expect(stuns.map((s) => [s.targetId, s.duration])).toEqual([
      [near.id, 1],
      [boss.id, 1],
    ]);
    expect(near.stun).toBeGreaterThan(0);
    expect(far.stun).toBe(0);
    // Bosses: the usual stun → slow rule.
    expect(boss.stun).toBe(0);
    expect(boss.stunSlow).toBeGreaterThan(0);
    // No damage: the cry only stuns.
    expect(hits(events)).toEqual([]);
    expect(world.player.cooldowns.battle_cry).toBe(6);
    // The buff still applies.
    expect(world.player.buffs.map((b) => b.id)).toEqual(['battle_cry']);

    const life = (item: Item | undefined): number => createWorld(content, 'warrior', 1, loadout('amulet', item)).player.life;
    expect(life(unique('ancestral_horn'))).toBeCloseTo(life(undefined) * 0.9, 10);
  });

  it('without the horn Battle Cry has no burst and a 12 s cooldown', () => {
    const world = createWorld(makeContent(), 'warrior', 1);
    const cry = world.player.actions.skills.find((s) => s.id === 'battle_cry')!;
    expect(cry.cooldown).toBe(12);
    expect(cry.burst).toBeUndefined();
    expect(cry.onHit).toBeUndefined();
  });
});

describe("Madman's Gloves (#6)", () => {
  const trapInput: PlayerInput = { ...idle, aim: vec(800, 500), skills: [false, true, false] };

  it('Explosive Trap throws 3 traps in a 40° fan at the throw distance; its cooldown is doubled', () => {
    const content = makeContent();
    const world = createWorld(content, 'ranger', 1, loadout('gloves', unique('madman_gloves')));
    const trap = world.player.actions.skills.find((s) => s.id === 'explosive_trap')!;
    expect(trap.cooldown).toBe(10);
    expect(trap.delivery.kind === 'trap' && trap.delivery.fan).toEqual({ count: 3, spreadDeg: 40 });
    run(world, content, trapInput, 1);
    expect(world.traps).toHaveLength(3);
    const rad = (20 * Math.PI) / 180;
    const [a, b, c] = world.traps.map((t) => t.pos);
    expect(a!.x).toBeCloseTo(500 + 300 * Math.cos(rad), 10);
    expect(a!.y).toBeCloseTo(500 - 300 * Math.sin(rad), 10);
    expect(b!.x).toBeCloseTo(800, 10);
    expect(b!.y).toBeCloseTo(500, 10);
    expect(c!.x).toBeCloseTo(500 + 300 * Math.cos(rad), 10);
    expect(c!.y).toBeCloseTo(500 + 300 * Math.sin(rad), 10);
    expect(world.player.cooldowns.explosive_trap).toBe(10);
  });

  it('with Minefield the fan shares the active-trap cap of 3: a second fan removes the first three', () => {
    const content = makeContent();
    const gear = loadout('gloves', unique('madman_gloves'));
    const world = createWorld(content, 'ranger', 1, { ...gear, mechanics: [...gear.mechanics, ...mechanicsOf('tr_key')] });
    const trap = world.player.actions.skills.find((s) => s.id === 'explosive_trap')!;
    expect(trap.delivery.kind === 'trap' && trap.delivery.maxActive).toBe(3);
    expect(trap.charges).toBe(3);
    run(world, content, trapInput, 1);
    const firstIds = world.traps.map((t) => t.id);
    expect(firstIds).toHaveLength(3);
    // Wait out the throw (cast time 0.35 s), then throw a second fan with the next charge.
    run(world, content, idle, 30);
    const events = run(world, content, trapInput, 1);
    const removed = events.filter((e): e is Extract<WorldEvent, { type: 'trapRemoved' }> => e.type === 'trapRemoved');
    expect(removed.map((e) => e.trapId)).toEqual(firstIds);
    expect(world.traps).toHaveLength(3);
    expect(world.traps.every((t) => !firstIds.includes(t.id))).toBe(true);
    expect(world.player.charges.explosive_trap).toBe(1);
  });
});

describe('Shadow Boots (#5)', () => {
  const roll: PlayerInput = { ...idle, skills: [false, false, true] };
  const attack: PlayerInput = { ...idle, basicAttack: true };

  it('after a Roll the next attack is a guaranteed crit (projectile snapshot); consumed by that attack only', () => {
    const content = makeContent();
    const world = createWorld(content, 'ranger', 1, loadout('boots', unique('shadow_boots')));
    run(world, content, roll, 1);
    expect(world.player.nextAttackCrit).toBe(true);
    // The roll ends after 0.25 s; the flag has no time limit.
    run(world, content, idle, 120);
    expect(world.player.nextAttackCrit).toBe(true);
    const mob = addMob(world, world.player.pos.x + 200, world.player.pos.y);
    run(world, content, attack, 1);
    expect(world.player.nextAttackCrit).toBe(false);
    const bolt = world.projectiles.at(-1)!;
    expect(bolt.action!.guaranteedCrit).toBe(true);
    // The effective action itself is untouched.
    expect(world.player.actions.basicAttack.guaranteedCrit).toBeUndefined();
    const events: WorldEvent[] = [];
    for (let i = 0; i < 60 && mob.life === 1000; i++) events.push(...run(world, content, idle, 1));
    expect(hits(events).find((h) => h.targetId === mob.id)!.isCrit).toBe(true);
    // The next bolt (after the attack time) is an ordinary one.
    run(world, content, idle, 60);
    run(world, content, attack, 1);
    expect(world.projectiles.at(-1)!.action!.guaranteedCrit).toBeUndefined();
  });

  it('every projectile of a Volley crits; a non-attack skill (trap) does not use the crit up', () => {
    const content = makeContent();
    const world = createWorld(content, 'ranger', 1, loadout('boots', unique('shadow_boots')));
    run(world, content, roll, 1);
    run(world, content, idle, 30);
    run(world, content, { ...idle, skills: [false, true, false] }, 1);
    expect(world.traps).toHaveLength(1);
    expect(world.player.nextAttackCrit).toBe(true);
    run(world, content, idle, 30);
    world.player.resource = 40;
    run(world, content, skill0, 1);
    const volley = world.projectiles.filter((p) => p.sourceId === 'volley');
    expect(volley).toHaveLength(5);
    expect(volley.every((p) => p.action!.guaranteedCrit === true)).toBe(true);
    expect(world.player.nextAttackCrit).toBe(false);
  });

  it('without the boots a Roll arms nothing', () => {
    const content = makeContent();
    const world = createWorld(content, 'ranger', 1);
    run(world, content, roll, 1);
    expect(world.player.nextAttackCrit).toBe(false);
  });
});

describe('Rift Ring (#8)', () => {
  const teleport: PlayerInput = { ...idle, aim: vec(200, 500), skills: [false, false, true] };

  it('Teleport has no cooldown and leaves a lightning blast at the start, scaled by spell damage', () => {
    const blastHit = (modifiers: readonly Modifier[]): { amount: number; events: WorldEvent[]; world: WorldState } => {
      const content = makeContent();
      const gear = loadout('ring1', unique('rift_ring'));
      const world = createWorld(content, 'mage', 7, { ...gear, modifiers: [...gear.modifiers, ...modifiers] });
      const mob = addMob(world, 560, 500);
      const events = run(world, content, teleport, 1);
      return { amount: hits(events).find((h) => h.targetId === mob.id)!.amount, events, world };
    };
    const plain = blastHit([]);
    expect(plain.events).toContainEqual({ type: 'teleport', from: vec(500, 500), to: vec(200, 500) });
    expect(plain.events).toContainEqual({ type: 'area', actionId: 'teleport', origin: vec(500, 500), facing: vec(-1, 0), radius: 100, angleDeg: 360, trigger: 'originBlast' });
    // 10–18 lightning (×1.5 on a crit); the dummy has no lightning resistance.
    expect(plain.amount).toBeGreaterThanOrEqual(10);
    expect(plain.amount).toBeLessThanOrEqual(27);
    expect(plain.world.player.cooldowns.teleport ?? 0).toBe(0);
    // +100% spell damage doubles it (same seed, same rolls).
    const boosted = blastHit([{ stat: 'damage', kind: 'increased', value: 1, tags: ['spell'] }]);
    expect(boosted.amount).toBeCloseTo(plain.amount * 2, 10);
    // An area modifier applies too (the blast is a spell + area hit).
    expect(blastHit([{ stat: 'damage', kind: 'increased', value: 1, tags: ['area'] }]).amount).toBeCloseTo(plain.amount * 2, 10);

    const action = plain.world.player.actions.skills.find((s) => s.id === 'teleport')!;
    expect(action.cooldown).toBe(0);
    expect(action.lifeCostFraction).toBe(0.15);
  });

  it('every Teleport costs 15% of the current life and never kills; teleports back to back', () => {
    const content = makeContent();
    const world = createWorld(content, 'mage', 7, loadout('ring1', unique('rift_ring')));
    const classDef = content.classes.mage!;
    world.player.life = 40;
    const regen = playerStat(classDef, world.player, 'lifeRegen') * DT;
    const events = run(world, content, teleport, 1);
    const cost = events.find((e): e is Extract<WorldEvent, { type: 'lifeCost' }> => e.type === 'lifeCost')!;
    expect(cost.actionId).toBe('teleport');
    expect(cost.amount).toBeCloseTo((40 + regen) * 0.15, 10);
    expect(world.player.life).toBeCloseTo((40 + regen) * 0.85, 10);

    // Cast time 0.25 s, then again at once (no cooldown), even at almost no life.
    run(world, content, idle, 16);
    world.player.life = 0.001;
    world.player.energyShield = 0;
    const again = run(world, content, { ...teleport, aim: vec(500, 500) }, 1);
    expect(again.some((e) => e.type === 'teleport')).toBe(true);
    expect(world.player.life).toBeGreaterThan(0);
    expect(world.player.dead).toBe(false);
  });

  it('without the ring Teleport keeps its 4 s cooldown, no blast and no life cost', () => {
    const content = makeContent();
    const world = createWorld(content, 'mage', 7);
    addMob(world, 560, 500);
    const events = run(world, content, teleport, 1);
    expect(world.player.cooldowns.teleport).toBe(4);
    expect(events.some((e) => e.type === 'area' || e.type === 'lifeCost' || e.type === 'hit')).toBe(false);
  });
});

// ── 6b review follow-ups: Crystal Shell, Echo, the life cost cap ──

describe('uniques under Crystal Shell (lifeToEnergyShield)', () => {
  const withShell = (slot: EquipSlot, item: Item | undefined, extra: readonly PassiveMechanic[] = []): Loadout => {
    const gear = loadout(slot, item);
    return { ...gear, mechanics: [...gear.mechanics, ...mechanicsOf('k_crystal'), ...extra] };
  };

  it('"less life" costs (Bloody Pupil, Ancestral Horn) also shrink the energy shield made from base life', () => {
    const content = makeContent();
    const baseEs = content.classes.mage!.baseStats.energyShield ?? 0;
    const maxEs = (slot: EquipSlot, item: Item | undefined): number => createWorld(content, 'mage', 1, withShell(slot, item)).player.energyShield;
    const plain = maxEs('ring1', undefined);
    const fromLife = plain - baseEs;
    expect(fromLife).toBeGreaterThan(0);
    expect(maxEs('ring1', unique('bloody_pupil'))).toBeCloseTo(baseEs + fromLife * 0.85, 10);
    expect(maxEs('amulet', unique('ancestral_horn'))).toBeCloseTo(baseEs + fromLife * 0.9, 10);
    // Life itself stays at the shell's fixed 1.
    expect(createWorld(content, 'mage', 1, withShell('ring1', unique('bloody_pupil'))).player.life).toBe(1);
  });

  it('Bloody Pupil: a crit heals 2% of max energy shield into the shield', () => {
    const content = makeContent();
    const world = createWorld(content, 'mage', 1, withShell('ring1', unique('bloody_pupil'), mechanicsOf('k_precise')));
    const maxEs = world.player.energyShield;
    world.player.energyShield = 5;
    const mob = addMob(world, 700, 500);
    const events = run(world, content, { ...idle, basicAttack: true }, 1);
    for (let i = 0; i < 60 && mob.life === 1000; i++) events.push(...run(world, content, idle, 1));
    const heal = events.find((e): e is Extract<WorldEvent, { type: 'critHeal' }> => e.type === 'critHeal')!;
    expect(heal.amount).toBeCloseTo(maxEs * 0.02, 10);
    expect(world.player.life).toBe(1);
  });

  it('Rift Ring: the 15% cost comes out of the current energy shield; life stays at 1', () => {
    const content = makeContent();
    const world = createWorld(content, 'mage', 7, withShell('ring1', unique('rift_ring')));
    world.player.energyShield = 50;
    const regen = playerStat(content.classes.mage!, world.player, 'energyShieldRegen') * DT;
    const events = run(world, content, { ...idle, aim: vec(200, 500), skills: [false, false, true] }, 1);
    const cost = events.find((e): e is Extract<WorldEvent, { type: 'lifeCost' }> => e.type === 'lifeCost')!;
    expect(cost.amount).toBeCloseTo((50 + regen) * 0.15, 10);
    expect(world.player.energyShield).toBeCloseTo((50 + regen) * 0.85, 10);
    expect(world.player.life).toBe(1);
  });
});

describe('life cost cap', () => {
  it('summed life cost fractions (0.6 + 0.6) are capped at CombatConfig.maxLifeCostFraction (0.9): no cliff at 1', () => {
    const content = makeContent();
    expect(content.combat.maxLifeCostFraction).toBe(0.9);
    const fixture: PassiveMechanic = { kind: 'skillParams', skillIds: ['teleport'], lifeCostFraction: 0.6 };
    const world = createWorld(content, 'mage', 7, { mechanics: [fixture, fixture] });
    expect(world.player.actions.skills.find((s) => s.id === 'teleport')!.lifeCostFraction).toBe(1.2);
    world.player.life = 40;
    const regen = playerStat(content.classes.mage!, world.player, 'lifeRegen') * DT;
    const events = run(world, content, { ...idle, aim: vec(200, 500), skills: [false, false, true] }, 1);
    const cost = events.find((e): e is Extract<WorldEvent, { type: 'lifeCost' }> => e.type === 'lifeCost')!;
    expect(cost.amount).toBeCloseTo((40 + regen) * 0.9, 10);
    expect(world.player.life).toBeCloseTo((40 + regen) * 0.1, 10);
    expect(world.player.dead).toBe(false);
  });
});

describe('Shadow Boots + Echo', () => {
  it('the echo of a guaranteed-crit Volley fires ordinary projectiles', () => {
    const content = makeContent();
    const gear = loadout('boots', unique('shadow_boots'));
    const echo: PassiveMechanic = { kind: 'skillParams', skillIds: ['volley'], grants: { echo: { chance: 1, delay: 0.25 } } };
    const world = createWorld(content, 'ranger', 1, { ...gear, mechanics: [...gear.mechanics, echo] });
    run(world, content, { ...idle, skills: [false, false, true] }, 1);
    run(world, content, idle, 30);
    world.player.resource = 40;
    run(world, content, skill0, 1);
    const first = world.projectiles.filter((p) => p.sourceId === 'volley').map((p) => p.id);
    expect(first).toHaveLength(5);
    expect(world.projectiles.filter((p) => first.includes(p.id)).every((p) => p.action!.guaranteedCrit === true)).toBe(true);
    const events = run(world, content, idle, 20);
    expect(events.some((e) => e.type === 'echo' && e.actionId === 'volley')).toBe(true);
    const echoed = world.projectiles.filter((p) => p.sourceId === 'volley' && !first.includes(p.id));
    expect(echoed).toHaveLength(5);
    expect(echoed.every((p) => p.action!.guaranteedCrit === undefined)).toBe(true);
  });
});

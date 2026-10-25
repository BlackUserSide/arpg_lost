import { describe, expect, it } from 'vitest';
import { content as gameContent } from '../../data/index';
import { vec } from '../math';
import type { SkillLevelData } from '../skills/levels';
import type { ActionDef, ClassDef, Content, MobDef } from './content';
import { createWorld, setLoadoutModifiers, step, type Loadout, type MobState, type PlayerInput, type WorldEvent, type WorldState } from './world';

const DT = 1 / 60;

const dummy: MobDef = {
  id: 'dummy',
  radius: 10,
  life: 100,
  xp: 10,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 10, max: 10 } }, range: 5, interval: 1, critChance: 0 },
};

const strike: ActionDef = {
  id: 'strike',
  tags: ['attack', 'melee'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 90, maxTargets: 1 },
};

const sweep: ActionDef = {
  id: 'sweep',
  tags: ['attack', 'melee', 'area'],
  resourceCost: 0,
  cooldown: 0,
  damage: { source: 'weapon', effectiveness: 1 },
  delivery: { kind: 'arc', radius: 50, angleDeg: 180 },
};

const blink: ActionDef = { id: 'blink', tags: ['spell'], resourceCost: 0, cooldown: 5, castTime: 0, delivery: { kind: 'teleport', range: 100 } };

const hero: ClassDef = {
  id: 'hero',
  radius: 10,
  weaponType: 'sword',
  baseStats: { life: 50, resource: 20, resourceRegen: 0, movementSpeed: 100 },
  resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
  weapon: { damage: { physical: { min: 10, max: 10 } }, attacksPerSecond: 2, critChance: 0 },
  basicAttack: strike,
  skills: [sweep, blink],
};

// 10 XP mobs × 0.5 = 5 skill XP per kill: level 2 after 2 kills, level 3 after 4 more.
const skillLevels: SkillLevelData = {
  rules: { maxLevel: 3, xpToNext: [10, 20], killXpMultiplier: 0.5 },
  skills: {
    sweep: { perLevel: [{ modifiers: [{ stat: 'damage', kind: 'more', value: 0.5 }] }, { modifiers: [{ stat: 'damage', kind: 'more', value: 0.5 }] }] },
    blink: { perLevel: [{}, {}], effect: { level: 3, grants: { charges: 2 } } },
  },
};

function makeContent(levels: SkillLevelData | null = skillLevels): Content {
  return {
    combat: { resistanceCap: 0.75, critMultiplierBase: 1.5, armourK: 5, armourMaxReduction: 0.9, bossFreezeSlow: 0.5, bossStunSlow: 0.5, maxLifeCostFraction: 0.9 },
    classes: { hero },
    mobs: { dummy },
    arena: { width: 1000, height: 1000, spawn: { firstDelay: 1000, interval: 1000, batchStart: 0, batchGrowth: 0, maxAlive: 0, mobIds: ['dummy'] } },
    progression: {
      maxLevel: 5,
      xpCurve: { base: 1000, exponent: 1 },
      mobXpGrowth: 0,
      lowAreaPenalty: { startDiff: 2, multipliers: [0.5], floor: 0.1 },
      mapClearBonus: 0.1,
      perLevel: { life: 10 },
    },
    ...(levels ? { skillLevels: levels } : {}),
  };
}

const idle: PlayerInput = { move: vec(0, 0), aim: vec(1000, 500), basicAttack: false, skills: [] };

function addMob(world: WorldState, x: number, y: number, life = 100, defId = 'dummy'): MobState {
  const mob: MobState = { id: world.nextId++, defId, pos: vec(x, y), facing: vec(0, 1), life, maxLife: life, attackTimer: 10, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: 10 };
  world.mobs.push(mob);
  return mob;
}

/** One step in which a mob already at 0 life dies (kill credited, no hit needed). */
function kill(world: WorldState, content: Content): WorldEvent[] {
  addMob(world, 900, 900, 0);
  return step(world, idle, content, DT);
}

const skillEvents = (events: readonly WorldEvent[]): WorldEvent[] => events.filter((e) => e.type === 'skillLevelUp');

describe('world: skill levels', () => {
  it('every kill gives every class skill the same XP; skills level up mid-run with an event', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    expect(world.player.skillProgress).toEqual({ sweep: { level: 1, xp: 0 }, blink: { level: 1, xp: 0 } });

    expect(skillEvents(kill(world, content))).toEqual([]);
    expect(world.player.skillProgress).toEqual({ sweep: { level: 1, xp: 5 }, blink: { level: 1, xp: 5 } });
    expect(world.skillXpGained).toBe(5);

    expect(skillEvents(kill(world, content))).toEqual([
      { type: 'skillLevelUp', skillId: 'sweep', level: 2 },
      { type: 'skillLevelUp', skillId: 'blink', level: 2 },
    ]);
    expect(world.player.skillProgress).toEqual({ sweep: { level: 2, xp: 0 }, blink: { level: 2, xp: 0 } });
    expect(world.skillXpGained).toBe(10);
    // Hero XP is unaffected by skill XP (10 per kill, own curve).
    expect(world.player.xp).toBe(20);
  });

  it('a mid-run level-up changes the resolved action: the next hit deals the new damage', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1);
    const before = addMob(world, 530, 500);
    step(world, { ...idle, skills: [true] }, content, DT);
    expect(before.life).toBe(90);

    kill(world, content);
    kill(world, content);
    expect(world.player.actions.skills[0]!.modifiers).toEqual([{ stat: 'damage', kind: 'more', value: 0.5 }]);
    world.player.actionTimer = 0;
    const after = addMob(world, 530, 500);
    step(world, { ...idle, skills: [true] }, content, DT);
    expect(after.life).toBe(85);
  });

  it('several levels from one kill emit one event per level', () => {
    const content = makeContent({ ...skillLevels, rules: { ...skillLevels.rules, killXpMultiplier: 4 } });
    const world = createWorld(content, 'hero', 1);
    expect(skillEvents(kill(world, content))).toEqual([
      { type: 'skillLevelUp', skillId: 'sweep', level: 2 },
      { type: 'skillLevelUp', skillId: 'sweep', level: 3 },
      { type: 'skillLevelUp', skillId: 'blink', level: 2 },
      { type: 'skillLevelUp', skillId: 'blink', level: 3 },
    ]);
    expect(world.player.skillProgress).toEqual({ sweep: { level: 3, xp: 0 }, blink: { level: 3, xp: 0 } });
  });

  it('a level-3 charge grant follows mid-run: the skill on cooldown keeps its timer and recharges into 2 charges', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1, { skills: { blink: { level: 2, xp: 15 } } });
    step(world, { ...idle, skills: [false, true] }, content, DT);
    expect(world.player.cooldowns.blink).toBe(5);

    const events = kill(world, content);
    expect(skillEvents(events)).toContainEqual({ type: 'skillLevelUp', skillId: 'blink', level: 3 });
    expect(world.player.actions.skills[1]!.charges).toBe(2);
    expect(world.player.charges.blink).toBe(0);
    expect(world.player.cooldowns.blink).toBeCloseTo(5 - DT, 10);
    // 5 s per charge, sequentially.
    for (let i = 0; i < 299; i++) step(world, idle, content, DT);
    expect(world.player.charges.blink).toBe(1);
    for (let i = 0; i < 300; i++) step(world, idle, content, DT);
    expect(world.player.charges.blink).toBe(2);
  });

  it('stored skill progress applies at spawn; a passive change mid-run keeps the skill levels', () => {
    const content = makeContent();
    const world = createWorld(content, 'hero', 1, { skills: { sweep: { level: 3, xp: 0 }, blink: { level: 9, xp: 4 } } });
    expect(world.player.skillProgress).toEqual({ sweep: { level: 3, xp: 0 }, blink: { level: 3, xp: 0 } });
    expect(world.player.actions.skills[0]!.modifiers).toHaveLength(2);
    expect(world.player.charges.blink).toBe(2);

    setLoadoutModifiers(world, content, [], [{ kind: 'stunBonus', durationIncreased: 0.3, fillIncreased: 0 }]);
    expect(world.player.actions.skills[0]!.modifiers).toHaveLength(2);
    expect(world.player.actions.skills[1]!.charges).toBe(2);
  });

  it('max-level skills take no XP; a max-level hero still levels skills', () => {
    const content = makeContent();
    const capped = createWorld(content, 'hero', 1, { skills: { sweep: { level: 3, xp: 0 }, blink: { level: 3, xp: 0 } } });
    expect(skillEvents(kill(capped, content))).toEqual([]);
    expect(capped.player.skillProgress).toEqual({ sweep: { level: 3, xp: 0 }, blink: { level: 3, xp: 0 } });

    const maxHero = createWorld(content, 'hero', 1, { level: 5 });
    kill(maxHero, content);
    expect(maxHero.player.skillProgress.sweep).toEqual({ level: 1, xp: 5 });
    expect(maxHero.xpGained).toBe(0);
  });

  it('without skill level data skills stay at their class definition', () => {
    const content = makeContent(null);
    const world = createWorld(content, 'hero', 1, { skills: { sweep: { level: 3, xp: 0 } } });
    expect(world.player.skillProgress).toEqual({});
    expect(world.player.actions.skills[0]).toBe(sweep);
    expect(skillEvents(kill(world, content))).toEqual([]);
    expect(world.skillXpGained).toBe(0);
  });

  it('is deterministic and the state stays plain JSON', () => {
    const content = makeContent();
    const play = (): { world: WorldState; log: string } => {
      const world = createWorld(content, 'hero', 7, { skills: { sweep: { level: 1, xp: 5 } } });
      const events: WorldEvent[] = [];
      for (let i = 0; i < 6; i++) {
        addMob(world, 530, 500, 15);
        for (let s = 0; s < 40; s++) events.push(...step(world, { ...idle, skills: [true] }, content, DT));
      }
      return { world, log: JSON.stringify(events) };
    };
    const a = play();
    const b = play();
    expect(a.log).toBe(b.log);
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
    expect(a.world.player.skillProgress).toEqual({ sweep: { level: 3, xp: 0 }, blink: { level: 3, xp: 0 } });
    expect(JSON.parse(JSON.stringify(a.world.player))).toEqual(a.world.player);
  });
});

describe('world: skill levels with game data', () => {
  const ranger = (loadout: Loadout): WorldState => createWorld(gameContent, 'ranger', 1, loadout);

  it('Volley at level 3 fires piercing bolts; levels 1 and 2 do not pierce', () => {
    const delivery = (level: number): unknown => ranger({ skills: { volley: { level, xp: 0 } } }).player.actions.skills[0]!.delivery;
    expect(delivery(1)).toMatchObject({ kind: 'projectile', pierce: 0 });
    expect(delivery(2)).toMatchObject({ kind: 'projectile', pierce: 0 });
    expect(delivery(3)).toMatchObject({ kind: 'projectile', pierce: 1 });
  });

  it('a zombie kill gives each ranger skill 3 skill XP', () => {
    const world = ranger({});
    addMob(world, 0, 0, 0, 'zombie');
    step(world, idle, gameContent, DT);
    expect(world.player.skillProgress).toEqual({ volley: { level: 1, xp: 3 }, explosive_trap: { level: 1, xp: 3 }, roll: { level: 1, xp: 3 } });
  });
});

// Class resource rhythm simulation (Rage / Energy / Mana) over the real core world loop.
// Run: npx vitest run --config tools/sim/vitest.config.ts tools/sim/resource.sim.ts
//
// The hero stands in the arena centre next to an unkillable dummy (and optionally attacking zombies) and
// presses buttons by a fixed policy; every rule (use time, cooldowns, costs, Rage gains, decay, regen) is core's.
// Policies:
//  - "skills only": cooldown skills whenever ready and affordable, otherwise the spammable skill (slot 1);
//    no basic attack. Measures how long the pool lasts and the skill uptime once it is dry.
//  - "with basic": same, but the basic attack fills every moment no skill is affordable, and the player saves up
//    for a cooldown skill that is off cooldown (normal play).
//  Roll / Teleport (pure mobility) are used at most every MOBILITY_INTERVAL s, not on cooldown.
// Metrics: "full bar lasts" = skills only, from a full pool, until the first idle moment; "demand" = resource/s the
// skill rotation spends while affordable; "sustain" = steady-state (60 s+) spend with basic attack / demand;
// uptime = share of time busy with a skill (use time / motion of skill actions).
import { describe, it } from 'vitest';
import { content as gameContent } from '../../src/data';
import { itemsData } from '../../src/data/items';
import { generateItem } from '../../src/core/items/generate';
import { createRng } from '../../src/core/rng';
import { vec } from '../../src/core/math';
import type { ActionDef, ClassDef, Content, MobDef } from '../../src/core/world/content';
import type { Modifier } from '../../src/core/stats/types';
import { actionReady, canAfford, createWorld, maxResource, playerStat, step, type MobState, type PlayerInput, type WorldState } from '../../src/core/world/world';

const DT = 1 / 60;
const SEED = 12345;
const MOBILITY_INTERVAL = 6;

const DUMMY: MobDef = {
  id: 'sim_dummy',
  radius: 15,
  life: 1e12,
  xp: 0,
  armour: 0,
  resistances: { fire: 0, cold: 0, lightning: 0 },
  moveSpeed: 0,
  attack: { damage: { physical: { min: 0, max: 0 } }, range: 1, interval: 1e9, critChance: 0 },
};

/** Candidate numbers for one class (undefined = keep data). */
interface ClassVariant {
  readonly max?: number;
  readonly regen?: number;
  readonly costs?: Readonly<Record<string, number>>;
  readonly hitGain?: number;
  readonly damageGain?: number;
  readonly decay?: { delay: number; perSecond: number };
  readonly startFraction?: number;
}
interface Variant {
  readonly warrior?: ClassVariant;
  readonly ranger?: ClassVariant;
  readonly mage?: ClassVariant;
  /** Overrides progression.perLevel.resource. */
  readonly perLevelResource?: number;
}

function withVariant(base: Content, variant: Variant): Content {
  const classes: Record<string, ClassDef> = {};
  for (const [id, cls] of Object.entries(base.classes)) {
    const byClass: Record<string, ClassVariant | undefined> = { warrior: variant.warrior, ranger: variant.ranger, mage: variant.mage };
    const v: ClassVariant = byClass[id] ?? {};
    const cost = (a: ActionDef): ActionDef => ({ ...a, resourceCost: v.costs?.[a.id] ?? a.resourceCost });
    const r = cls.resource;
    classes[id] = {
      ...cls,
      baseStats: { ...cls.baseStats, resource: v.max ?? cls.baseStats.resource ?? 0, resourceRegen: v.regen ?? cls.baseStats.resourceRegen ?? 0 },
      resource: {
        ...r,
        startFraction: v.startFraction ?? r.startFraction,
        ...(r.onHit ? { onHit: { ...r.onHit, amount: v.hitGain ?? r.onHit.amount } } : {}),
        ...(r.onDamageTaken ? { onDamageTaken: { perPoolFraction: v.damageGain ?? r.onDamageTaken.perPoolFraction } } : {}),
        ...(r.decay ? { decay: v.decay ?? r.decay } : {}),
      },
      skills: cls.skills.map(cost),
    };
  }
  return {
    ...base,
    classes,
    progression: variant.perLevelResource === undefined ? base.progression : { ...base.progression, perLevel: { ...base.progression.perLevel, resource: variant.perLevelResource } },
    mobs: { ...base.mobs, [DUMMY.id]: DUMMY },
    arena: { ...base.arena, spawn: { ...base.arena.spawn, firstDelay: 1e9, maxAlive: 0 } },
  };
}

function addMob(world: WorldState, content: Content, defId: string, x: number, y: number): MobState {
  const def = content.mobs[defId]!;
  const mob: MobState = {
    id: world.nextId++, defId, pos: vec(x, y), facing: vec(0, 1), life: def.life, maxLife: def.life,
    attackTimer: def.attack.interval, stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0,
    freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: def.radius,
  };
  world.mobs.push(mob);
  return mob;
}

interface Scenario {
  readonly classId: string;
  readonly level: number;
  readonly gear: readonly Modifier[];
  readonly basic: boolean;
  /** Zombies hitting the hero (life is topped up every step so the hero never dies). */
  readonly attackers?: number;
  /** Starting resource as a fraction of max (default: class startFraction). */
  readonly start?: number;
  readonly seconds: number;
}

interface Result {
  readonly max: number;
  readonly regen: number;
  /** First moment the hero stands idle (skills only) or falls back to the basic attack because no skill is affordable. */
  readonly dryAt: number;
  readonly firstSkillAt: number;
  readonly firstCryAt: number;
  /** Skill uptime over [0, 15 s), [15 s, 60 s), [60 s, end). */
  readonly uptimeBurst: number;
  readonly uptimeMid: number;
  readonly uptimeSteady: number;
  readonly avgResourceSteady: number;
  /** Life + ES lost per second (zombie scenarios). */
  readonly dtps: number;
  /** Resource spent on skills per second: before running dry, and over 60 s+. */
  readonly demand: number;
  readonly spendSteady: number;
}

function simulate(content: Content, s: Scenario): Result {
  const world = createWorld(content, s.classId, SEED, { level: s.level, modifiers: s.gear });
  const cls = content.classes[s.classId]!;
  const player = world.player;
  const centre = vec(content.arena.width / 2, content.arena.height / 2);
  const dummyPos = vec(centre.x + 40, centre.y);
  addMob(world, content, DUMMY.id, dummyPos.x, dummyPos.y);
  const zombies: Array<{ mob: MobState; pos: { x: number; y: number } }> = [];
  for (let i = 0; i < (s.attackers ?? 0); i++) {
    const angle = Math.PI / 2 + (i * Math.PI) / Math.max(1, s.attackers ?? 1);
    const pos = vec(centre.x + Math.cos(angle) * 30, centre.y + Math.sin(angle) * 30);
    zombies.push({ mob: addMob(world, content, 'zombie', pos.x, pos.y), pos });
  }
  const max = maxResource(cls, player);
  if (s.start !== undefined) player.resource = s.start * max;

  const spam = player.actions.skills[0]!;
  const cdSkills = player.actions.skills.slice(1);
  const skillIds = new Set(player.actions.skills.map((a) => a.id));
  const cry = player.actions.skills[2]!;
  // Pure mobility (roll, teleport) is used to reposition, not on cooldown: at most every MOBILITY_INTERVAL s.
  const isMobility = (a: ActionDef): boolean => a.delivery.kind === 'teleport' || (a.delivery.kind === 'dash' && a.delivery.hitRadius === 0);
  const lastUse: Record<string, number> = {};
  let busyWith: string | undefined;
  let dryAt = Infinity;
  let firstSkillAt = Infinity;
  let firstCryAt = Infinity;
  const buckets = [0, 0, 0];
  const bucketSteps = [0, 0, 0];
  let resSum = 0;
  let resSteps = 0;
  let lost = 0;
  let spentPreDry = 0;
  let spentSteady = 0;
  const costOf = new Map(player.actions.skills.map((a) => [a.id, a.resourceCost]));
  const steps = Math.round(s.seconds / DT);

  for (let i = 0; i < steps; i++) {
    const t = i * DT;
    player.pos = vec(centre.x, centre.y);
    world.mobs[0]!.pos = dummyPos;
    for (const z of zombies) {
      z.mob.pos = vec(z.pos.x, z.pos.y);
      z.mob.life = z.mob.maxLife;
    }
    if (zombies.length > 0) player.life = playerStat(cls, player, 'life');

    const free = player.actionTimer <= 0 && !player.motion;
    const wanted = (a: ActionDef): boolean => actionReady(player, a) && (!isMobility(a) || t - (lastUse[a.id] ?? -Infinity) >= MOBILITY_INTERVAL);
    const readyCd = cdSkills.map((a) => wanted(a) && canAfford(player, a));
    const useCd = readyCd.some(Boolean);
    // With the basic attack available, the player saves up for a cooldown skill that is off cooldown.
    const saving = s.basic && !useCd && cdSkills.some((a) => wanted(a) && !canAfford(player, a));
    const input: PlayerInput = {
      move: vec(0, 0),
      aim: dummyPos,
      basicAttack: s.basic,
      skills: useCd ? [false, ...readyCd] : [!saving, false, false],
    };
    if (free && !useCd && !canAfford(player, spam) && dryAt === Infinity) dryAt = t;

    const lifeBefore = player.life + player.energyShield;
    const events = step(world, input, content, DT);
    lost += Math.max(0, lifeBefore - player.life - player.energyShield);
    for (const e of events) {
      if (e.type !== 'action') continue;
      busyWith = e.actionId;
      lastUse[e.actionId] = t;
      const cost = costOf.get(e.actionId) ?? 0;
      if (dryAt === Infinity) spentPreDry += cost;
      if (t >= 60) spentSteady += cost;
      if (skillIds.has(e.actionId) && firstSkillAt === Infinity) firstSkillAt = t;
      if (e.actionId === cry.id && firstCryAt === Infinity) firstCryAt = t;
    }
    const busy = player.actionTimer > 0 || player.motion !== undefined;
    const b = t < 15 ? 0 : t < 60 ? 1 : 2;
    bucketSteps[b]! += 1;
    if (busy && busyWith && skillIds.has(busyWith)) buckets[b]! += 1;
    if (b === 2) {
      resSum += player.resource;
      resSteps += 1;
    }
  }
  const share = (k: number): number => (bucketSteps[k]! > 0 ? buckets[k]! / bucketSteps[k]! : NaN);
  return {
    max,
    regen: playerStat(cls, player, 'resourceRegen'),
    dryAt,
    firstSkillAt,
    firstCryAt,
    uptimeBurst: share(0),
    uptimeMid: share(1),
    uptimeSteady: share(2),
    avgResourceSteady: resSteps > 0 ? resSum / resSteps : NaN,
    dtps: lost / s.seconds,
    demand: spentPreDry / Math.min(dryAt, s.seconds),
    spendSteady: spentSteady / (s.seconds - 60),
  };
}

// ── Gear: expected resource affix rolls from core item generation ──

interface AffixStats {
  /** Mean rolled value of the affix when present. */
  readonly mean: number;
  /** Chance that a rare item of the slot rolls it. */
  readonly chance: number;
}

function affixStats(affixId: string, itemLevel: number, slot: 'helmet' | 'ring' | 'amulet', samples = 20_000): AffixStats {
  const rng = createRng(SEED + itemLevel);
  let sum = 0;
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const item = generateItem(rng, `s${i}`, { itemLevel, rarity: 'rare', slot }, itemsData);
    const a = item.affixes.find((x) => x.affixId === affixId);
    if (a) {
      sum += a.value;
      hits += 1;
    }
  }
  return { mean: hits > 0 ? sum / hits : 0, chance: hits / samples };
}

function bestTierMean(affixId: string, itemLevel: number): number {
  const tiers = itemsData.affixes[affixId]!.tiers.filter((t) => t.minLevel <= itemLevel);
  const best = tiers[tiers.length - 1]!;
  return (best.min + best.max) / 2;
}

const helmImplicit = (level: number): number => {
  const bases = Object.values(itemsData.bases).filter((b) => b.slot === 'helmet' && b.level <= level && b.implicit?.stat === 'resource');
  const top = Math.max(...bases.map((b) => b.level));
  const r = bases.find((b) => b.level === top)!.implicit!.range;
  return (r.min + r.max) / 2;
};

interface GearProfile {
  readonly name: string;
  readonly flat: number;
  readonly regen: number;
}

function gearProfiles(level: number): GearProfile[] {
  const flat = affixStats('resource_flat', level, 'ring');
  const regen = affixStats('resource_regen', level, 'ring');
  const lapis = itemsData.bases['lapis_amulet']!.implicit!.range;
  const lapisMean = (lapis.min + lapis.max) / 2;
  return [
    { name: 'no gear', flat: 0, regen: 0 },
    // Typical: resource implicit on the helmet, one +resource and one +regen roll somewhere.
    { name: 'typical', flat: helmImplicit(level) + flat.mean, regen: regen.mean },
    // Stacked: helmet + Lapis implicits, best available tier of both affixes on helmet, 2 rings, amulet.
    { name: 'stacked', flat: helmImplicit(level) + lapisMean + 4 * bestTierMean('resource_flat', level), regen: 4 * bestTierMean('resource_regen', level) },
  ];
}

const gearMods = (g: GearProfile): Modifier[] => [
  { stat: 'resource', kind: 'flat', value: g.flat },
  { stat: 'resourceRegen', kind: 'flat', value: g.regen },
];

// ── Report ──

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '∞');
const pc = (x: number): string => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');

function report(label: string, variant: Variant): void {
  const content = withVariant(gameContent, variant);
  const lines: string[] = [`\n=== ${label} ===`];
  lines.push('class   | lvl | gear    |   max | regen | full bar lasts | refill | first skill / cry | uptime 0-15s | 60s+ | demand | sustain');
  for (const classId of ['warrior', 'ranger', 'mage']) {
    for (const level of [1, 10, 20]) {
      for (const g of gearProfiles(level)) {
        const gear = gearMods(g);
        const only = simulate(content, { classId, level, gear, basic: false, start: 1, seconds: 120 });
        const play = simulate(content, { classId, level, gear, basic: true, seconds: 120 });
        const decays = content.classes[classId]!.resource.decay !== undefined;
        lines.push(
          [
            classId.padEnd(7),
            String(level).padStart(3),
            g.name.padEnd(7),
            f1(only.max).padStart(5),
            f1(only.regen).padStart(5),
            `${f1(only.dryAt)} s`.padStart(13),
            (decays || only.regen <= 0 ? '-' : `${f1(only.max / only.regen)} s`).padStart(6),
            `${f1(play.firstSkillAt)} s / ${f1(play.firstCryAt)} s`.padStart(17),
            pc(play.uptimeBurst).padStart(12),
            pc(play.uptimeSteady).padStart(4),
            `${f1(only.demand)}/s`.padStart(6),
            pc(Math.min(1, play.spendSteady / only.demand)).padStart(7),
          ].join(' | '),
        );
      }
    }
  }
  // Warrior Rage from damage taken: zombies hitting him (life topped up), level 1, no gear.
  lines.push('\nwarrior Rage from damage taken (no gear, with basic, zombies hitting him, life topped up)');
  const demand = simulate(content, { classId: 'warrior', level: 1, gear: [], basic: false, start: 1, seconds: 120 }).demand;
  for (const level of [1, 20]) {
    for (const attackers of [0, 1, 3]) {
      const r = simulate(content, { classId: 'warrior', level, gear: [], basic: true, attackers, seconds: 120 });
      lines.push(`  lvl ${level}, ${attackers} zombies: damage taken ${f1(r.dtps)}/s -> uptime 60s+ ${pc(r.uptimeSteady)}, sustain ${pc(Math.min(1, r.spendSteady / demand))}`);
    }
  }
  console.log(lines.join('\n'));
}

function affixTable(): void {
  const lines = ['\n=== resource affixes on rare rings (core generateItem, 20k samples per row) ==='];
  lines.push('ilvl | resource_flat chance / mean | best tier | resource_regen chance / mean | best tier | helmet implicit');
  for (const level of [1, 10, 20, 30]) {
    const flat = affixStats('resource_flat', level, 'ring');
    const regen = affixStats('resource_regen', level, 'ring');
    lines.push(
      `${String(level).padStart(4)} | ${pc(flat.chance)} / ${flat.mean.toFixed(1)} | ${bestTierMean('resource_flat', level).toFixed(1)} | ${pc(regen.chance)} / ${regen.mean.toFixed(2)} | ${bestTierMean('resource_regen', level).toFixed(2)} | ${helmImplicit(level).toFixed(1)}`,
    );
  }
  console.log(lines.join('\n'));
}

function quick(label: string, variant: Variant, classIds = ['warrior', 'ranger', 'mage']): void {
  const content = withVariant(gameContent, variant);
  const lines = [`--- ${label}`];
  for (const classId of classIds) {
    for (const level of [1, 20]) {
      const g = gearProfiles(level)[level === 1 ? 0 : 1]!;
      const gear = gearMods(g);
      const only = simulate(content, { classId, level, gear, basic: false, start: 1, seconds: 120 });
      const play = simulate(content, { classId, level, gear, basic: true, seconds: 120 });
      lines.push(
        `  ${classId} L${level} ${g.name}: max ${f1(only.max)} regen ${f1(only.regen)} | dry ${f1(only.dryAt)} s, skills-only ${pc(only.uptimeSteady)} | first ${f1(play.firstSkillAt)}/${f1(play.firstCryAt)} s, uptime ${pc(play.uptimeBurst)} / ${pc(play.uptimeMid)} / ${pc(play.uptimeSteady)} | demand ${f1(only.demand)}/s, sustain ${pc(play.spendSteady / only.demand)}`,
      );
    }
  }
  console.log(lines.join('\n'));
}

describe('class resource simulation', () => {
  it('reports', () => {
    affixTable();
    report('DATA (proposal)', {});
    quick('DATA with +1 resource per level (old progression)', { perLevelResource: 1 });
    {
      const c = withVariant(gameContent, { warrior: { damageGain: 100 } });
      const demand = simulate(c, { classId: 'warrior', level: 1, gear: [], basic: false, start: 1, seconds: 120 }).demand;
      for (const attackers of [1, 3]) {
        const r = simulate(c, { classId: 'warrior', level: 1, gear: [], basic: true, attackers, seconds: 120 });
        console.log(`Rage +100 per pool lost, lvl 1, ${attackers} zombies: damage taken ${f1(r.dtps)}/s -> sustain ${pc(Math.min(1, r.spendSteady / demand))}`);
      }
    }
    report('BEFORE (resource branch start: Rage 100 / Energy 40+10 / Mana 100+5, Volley 7, Trap 12, +1/level)', {
      perLevelResource: 1,
      ranger: { max: 40, regen: 10, costs: { volley: 7, explosive_trap: 12 } },
      mage: { max: 100, regen: 5 },
    });
    quick('OLDEST (one mana for all: 40/4, 50/5, 80/7, start full, no Rage gains)', {
      perLevelResource: 1,
      warrior: { max: 40, regen: 4, hitGain: 0, damageGain: 0, decay: { delay: 1e9, perSecond: 0 }, startFraction: 1 },
      ranger: { max: 50, regen: 5, costs: { volley: 7, explosive_trap: 12 } },
      mage: { max: 80, regen: 7 },
    });
  });
});

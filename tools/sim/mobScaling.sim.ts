// Mob growth with the map level (docs/design/mobs.md, decision 2026-10-25 "noticeably harder") vs hero growth.
// Run: npx vitest run --config tools/sim/vitest.config.ts tools/sim/mobScaling.sim.ts --silent=false --disable-console-intercept
// Overrides (env, "linear,compound"): SIM_LIFE, SIM_DMG, SIM_ARMOUR replace data mobScaling curves for what-ifs.
// Filter (env): SIM_ONLY=pace,hero,maps,newmobs,curve (curve: every map 1..40, slower)
//
// Sections:
//  1. Pace: XP per map run (real wave / elite / boss rules and mob XP), runs per hero level at a matching map, and the
//     skill level reached by then (data/skillLevels.ts) -> the skill level schedule used below.
//  2. Hero: per class and profile at hero level = map level: main skill hit, uses / s, life + ES, armour, resistances.
//     Profiles (ASSUMPTION, see PROFILES): "average" = best of the real chest drops (rarity roll with luck) at item
//     level = map level, items per slot from the pace (averageDraws, 1 at map 1 → 6 from map 8); "geared" = best of 25
//     crafted rares per slot at item level map + 3 (the cap); "stale" = average gear of 10 maps ago.
//     Passives: a fixed sensible order per class (PASSIVE_ORDER, class zone -> neighbour hybrid -> inner ring ->
//     keystone), spent as far as the level's points go; spec entry / keystone / 3 more spec nodes on milestones.
//     Items are picked greedily per slot by (main skill DPS × effective life vs a zombie hit of that map).
//     Not modelled: supports (2 slots, mostly utility, ≤ +20% more), Battle Cry and other temporary buffs, leech.
//  3. Maps: per map level, the scaled zombie / archer / boss vs both profiles: hits to kill (main skill), mob hit as %
//     of hero life + ES (after hero armour), boss fight and run time estimates (RUN_MODEL).
//  4. New mobs at their first map: shieldbearer armour vs the hero's physical hits, hits to kill of all four.
// Every rule is core's (generateItem / itemModifiers / passive allocation / createWorld / computeDamage / useTime /
// armourReduction / mobLevelScaling); this file only sets up heroes and counts.
import { describe, it } from 'vitest';
import { content as gameContent } from '../../src/data';
import { itemsData } from '../../src/data/items';
import { mapsData } from '../../src/data/maps';
import { passiveTree } from '../../src/data/passives';
import { computeDamage, totalDamage, type BaseDamage, type DamageByType } from '../../src/core/combat/damage';
import { armourReduction, resistanceMultiplier } from '../../src/core/combat/mitigation';
import { generateItem } from '../../src/core/items/generate';
import { itemModifiers } from '../../src/core/items/generate';
import type { Item, Slot } from '../../src/core/items/types';
import { allocate, allocatePath, createAllocation, passiveMechanics, passiveModifiers } from '../../src/core/passives/allocation';
import type { PassiveHero } from '../../src/core/passives/types';
import { mobXp, xpToNextLevel } from '../../src/core/progression/levels';
import { createRng, type Rng } from '../../src/core/rng';
import { levelCurveMultiplier } from '../../src/core/run/mobScaling';
import type { LevelCurve } from '../../src/core/run/types';
import { computeStat } from '../../src/core/stats/modifiers';
import type { Modifier } from '../../src/core/stats/types';
import { useTime } from '../../src/core/world/actions';
import type { ActionDef, MobDef } from '../../src/core/world/content';
import { critStats } from '../../src/core/world/passiveEffects';
import { allModifiers, type Ctx } from '../../src/core/world/state';
import { createWorld, playerStat } from '../../src/core/world/world';

const SEED = 20261025;
const SAMPLES = Number(process.env['SIM_SAMPLES'] ?? 60); // heroes per (class, profile, level); medians reported
const ONLY = (process.env['SIM_ONLY'] ?? '').split(',').filter(Boolean);
const on = (s: string): boolean => ONLY.length === 0 || ONLY.includes(s);
const MAPS = [1, 5, 10, 15, 20, 25, 30, 35, 40];
const ALL_MAPS = Array.from({ length: 40 }, (_, i) => i + 1);

// ── Mob scaling (data, or env what-if) ──

const rules = mapsData.rules;
function curve(env: string, fallback: LevelCurve): LevelCurve {
  const raw = process.env[env];
  if (!raw) return fallback;
  const [linear, compound] = raw.split(',').map(Number);
  return { linear: linear ?? 0, compound: compound ?? 0 };
}
const dataScaling = rules.mobScaling;
const LIFE = curve('SIM_LIFE', dataScaling.life);
const DMG = curve('SIM_DMG', dataScaling.damage);
const ARMOUR = curve('SIM_ARMOUR', dataScaling.armour);
const scaleAt = (L: number): { life: number; damage: number; armour: number } => ({
  life: levelCurveMultiplier(LIFE, L),
  damage: levelCurveMultiplier(DMG, L),
  armour: levelCurveMultiplier(ARMOUR, L),
});

// ── Hero model ──

interface ClassSetup {
  readonly mainSkill: string;
  /** Hits of one cast on one ordinary mob / on the boss (Volley: 5 bolts, ~1.3 land on a lone mob, ~2 on the boss). */
  readonly hitsPerCastMob: number;
  readonly hitsPerCastBoss: number;
  /** Ordinary mobs hit per cast in a pack (arc 150°, explosion r80, 5 bolts) — ASSUMPTION for the run time model. */
  readonly targetsPerCast: number;
  readonly spec: string;
  readonly specNodes: readonly string[];
}
const CLASSES: Record<string, ClassSetup> = {
  warrior: { mainSkill: 'cleave', hitsPerCastMob: 1, hitsPerCastBoss: 1, targetsPerCast: 3, spec: 'berserker', specNodes: ['bz_entry', 'bz_key', 'bz_b1', 'bz_a1', 'bz_c1'] },
  ranger: { mainSkill: 'volley', hitsPerCastMob: 1.3, hitsPerCastBoss: 2, targetsPerCast: 3.5, spec: 'sniper', specNodes: ['sn_entry', 'sn_key', 'sn_a1', 'sn_b1', 'sn_c1'] },
  mage: { mainSkill: 'fireball', hitsPerCastMob: 1, hitsPerCastBoss: 1, targetsPerCast: 2.5, spec: 'pyromancer', specNodes: ['py_entry', 'py_key', 'py_a1', 'py_b1', 'py_c1'] },
};

// Sensible order: damage + life of the own zone first, notables, then a hybrid and a keystone. allocatePath takes the
// cheapest path to each target; targets that do not fit the remaining points are skipped.
const PASSIVE_ORDER: Record<string, readonly string[]> = {
  warrior: ['w_a1', 'w_a2', 'w_a3', 'w_c1', 'w_c2', 'w_a4', 'w_n1', 'i_w', 'w_b1', 'w_b2', 'w_d1', 'w_n2', 'wr_3', 'wr_2', 'wr_4', 'wr_5', 'wr_n', 'i_wr', 'k_precise', 'wr_1', 'mw_1', 'mw_2', 'mw_4', 'mw_5', 'mw_n', 'i_mw'],
  ranger: ['r_a1', 'r_a2', 'r_a4', 'r_n1', 'r_a3', 'r_b1', 'r_b2', 'r_c1', 'r_c2', 'r_d1', 'r_n2', 'i_r', 'wr_1', 'wr_2', 'wr_4', 'wr_5', 'wr_n', 'i_wr', 'k_precise', 'rm_3', 'rm_2', 'rm_4', 'rm_5', 'rm_n', 'i_rm'],
  mage: ['m_a1', 'm_a2', 'm_a3', 'm_a4', 'm_n1', 'm_b1', 'm_b2', 'm_c1', 'm_c2', 'm_d1', 'm_n2', 'i_m', 'mw_3', 'mw_2', 'mw_4', 'mw_5', 'mw_n', 'i_mw', 'rm_1', 'rm_2', 'rm_4', 'rm_5', 'rm_n', 'i_rm', 'k_crystal'],
};

function passivesAt(classId: string, level: number): { mods: Modifier[]; mechanics: ReturnType<typeof passiveMechanics> } {
  const hero: PassiveHero = { classId, level, passives: createAllocation() };
  for (const target of PASSIVE_ORDER[classId]!) allocatePath(passiveTree, hero, target);
  const setup = CLASSES[classId]!;
  for (const id of setup.specNodes) allocate(passiveTree, hero, id);
  return { mods: passiveModifiers(passiveTree, hero.passives), mechanics: passiveMechanics(passiveTree, hero.passives) };
}

// Skill level schedule from section 1 (pace): hero level at which the main skill reaches level 2 / 3.
const SKILL_LEVEL_AT = { 2: 6, 3: 10 } as const;
const skillLevelAt = (heroLevel: number): number => (heroLevel >= SKILL_LEVEL_AT[3] ? 3 : heroLevel >= SKILL_LEVEL_AT[2] ? 2 : 1);

interface GearProfile {
  readonly name: string;
  /** Candidates rolled per slot; the best is equipped. 0 = averageDraws(map level). */
  readonly draws: number;
  readonly ilvlBonus: number;
  /** undefined = real chest rarity roll with `luck`; 'rare' = crafted rares. */
  readonly rarity?: 'rare';
  readonly luck: number;
}
const PROFILES: readonly GearProfile[] = [
  { name: 'average', draws: 0, ilvlBonus: 0, luck: 0.15 },
  { name: 'geared', draws: 25, ilvlBonus: 3, rarity: 'rare', luck: 0 },
  // The hero who stopped upgrading: average gear of 10 maps ago (passives and level keep up).
  { name: 'stale', draws: 0, ilvlBonus: -10, luck: 0.15 },
];

const GEAR_SLOTS: readonly Slot[] = ['weapon', 'helmet', 'armour', 'gloves', 'boots', 'ring', 'ring', 'amulet'];

interface HeroEval {
  /** Expected main skill hit per hit event (crit included), split by type before enemy mitigation. */
  readonly hit: DamageByType;
  readonly hitTotal: number;
  readonly useTime: number;
  readonly life: number;
  readonly energyShield: number;
  readonly armour: number;
  readonly resist: number;
}

function evaluate(classId: string, level: number, gear: readonly Item[], passive: ReturnType<typeof passivesAt>): HeroEval {
  const setup = CLASSES[classId]!;
  const classDef = gameContent.classes[classId]!;
  const weaponItem = gear.find((i) => itemsData.bases[i.baseId]?.slot === 'weapon');
  const wBase = weaponItem ? itemsData.bases[weaponItem.baseId]?.weapon : undefined;
  const weapon = wBase ? { damage: wBase.damage, attacksPerSecond: wBase.attacksPerSecond, critChance: wBase.critChance } : classDef.weapon;
  const mods = [...gear.flatMap((i) => itemModifiers(i, itemsData)), ...passive.mods];
  const sl = skillLevelAt(level);
  const world = createWorld(gameContent, classId, 1, { level, modifiers: mods, weapon, mechanics: passive.mechanics, skills: { [setup.mainSkill]: { level: sl, xp: 0 } } });
  const player = world.player;
  const action: ActionDef = player.actions.skills.find((a) => a.id === setup.mainSkill)!;
  const ctx: Ctx = { world, content: gameContent, classDef, rng: createRng(1), events: [], input: { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, basicAttack: false, skills: [] } };
  const all = [...allModifiers(classDef, player), ...(action.modifiers ?? [])];
  const dmg = action.damage!;
  const mean = (b: BaseDamage, f: number): DamageByType => Object.fromEntries(Object.entries(b).map(([t, r]) => [t, ((r.min + r.max) / 2) * f]));
  const base = dmg.source === 'weapon' ? mean(player.weapon.damage, dmg.effectiveness) : mean(dmg.base, 1);
  const baseCrit = dmg.source === 'weapon' ? player.weapon.critChance : dmg.critChance;
  const scaled = computeDamage(base, all, action.tags, action.damageConversion);
  const crit = critStats(player.mechanics, {
    critChance: computeStat(baseCrit, all, 'critChance', action.tags),
    critMultiplier: computeStat(gameContent.combat.critMultiplierBase, all, 'critMultiplier', action.tags),
  });
  const critFactor = 1 + Math.min(1, crit.critChance) * (crit.critMultiplier - 1);
  const hit = Object.fromEntries(Object.entries(scaled).map(([t, v]) => [t, (v ?? 0) * critFactor])) as DamageByType;
  return {
    hit,
    hitTotal: totalDamage(hit),
    useTime: useTime(ctx, action),
    life: playerStat(classDef, player, 'life'),
    energyShield: playerStat(classDef, player, 'energyShield'),
    armour: playerStat(classDef, player, 'armour'),
    resist: (playerStat(classDef, player, 'fireResistance') + playerStat(classDef, player, 'coldResistance') + playerStat(classDef, player, 'lightningResistance')) / 3,
  };
}

const avgHit = (def: MobDef): number => {
  const d = def.attack.damage;
  return Object.values(d).reduce((s, r) => s + (r.min + r.max) / 2, 0);
};

/** Damage a hero actually takes from a physical hit of `amount`. */
const physTaken = (h: HeroEval, amount: number): number => amount * (1 - armourReduction(h.armour, amount, gameContent.combat));
const elemTaken = (h: HeroEval, amount: number): number => amount * resistanceMultiplier(h.resist, gameContent.combat);

/** Effective hit vs a mob with `armour`: the physical part is reduced per hit. */
function hitVs(h: HeroEval, armour: number): number {
  let total = 0;
  for (const [type, v] of Object.entries(h.hit)) {
    if (!v) continue;
    total += type === 'physical' ? v * (1 - armourReduction(armour, v, gameContent.combat)) : v;
  }
  return total;
}

function score(h: HeroEval, L: number): number {
  const zombieHit = avgHit(gameContent.mobs['zombie']!) * scaleAt(L).damage;
  const taken = 0.75 * physTaken(h, zombieHit) + 0.25 * elemTaken(h, zombieHit);
  return (h.hitTotal / h.useTime) * ((h.life + h.energyShield) / Math.max(0.01, taken / zombieHit));
}

function rollFor(rng: Rng, classId: string, slot: Slot, ilvl: number, p: GearProfile, n: number): Item {
  const type = gameContent.classes[classId]!.weaponType;
  for (let guard = 0; guard < 1000; guard++) {
    const item = generateItem(rng, `i${n}_${guard}`, { itemLevel: ilvl, slot, luck: p.luck, ...(p.rarity ? { rarity: p.rarity } : {}) }, itemsData);
    if (slot !== 'weapon' || itemsData.bases[item.baseId]?.weapon?.type === type) return item;
  }
  throw new Error('no weapon');
}

function buildHero(rng: Rng, classId: string, level: number, mapLevel: number, p: GearProfile): HeroEval {
  const passive = passivesAt(classId, level);
  const ilvl = Math.max(1, Math.min(43, mapLevel + p.ilvlBonus));
  const candidates = GEAR_SLOTS.map((slot, s) => Array.from({ length: p.draws }, (_, k) => rollFor(rng, classId, slot, ilvl, p, s * 100 + k)));
  const chosen: Item[] = candidates.map((c) => c[0]!);
  for (let pass = 0; pass < 2; pass++) {
    for (let s = 0; s < GEAR_SLOTS.length; s++) {
      let best = -1;
      for (const cand of candidates[s]!) {
        const trial = chosen.slice();
        trial[s] = cand;
        const v = score(evaluate(classId, level, trial, passive), mapLevel);
        if (v > best) {
          best = v;
          chosen[s] = cand;
        }
      }
    }
  }
  return evaluate(classId, level, chosen, passive);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Median per field over SAMPLES heroes (DPS, life, ...); the hit split is the median-DPS hero's. */
function heroAt(classId: string, mapLevel: number, p: GearProfile): HeroEval {
  const level = Math.min(gameContent.progression.maxLevel, mapLevel);
  const rng = createRng(SEED ^ (mapLevel * 7919) ^ (classId.length * 104729) ^ ((p.ilvlBonus + 20) * 31));
  const draws = p.draws > 0 ? p.draws : averageDraws(Math.max(1, mapLevel + p.ilvlBonus));
  const hs = Array.from({ length: SAMPLES }, () => buildHero(rng, classId, level, mapLevel, { ...p, draws }));
  const byDps = hs.map((h) => ({ h, dps: h.hitTotal / h.useTime })).sort((a, b) => a.dps - b.dps);
  const mid = byDps[Math.floor(byDps.length / 2)]!.h;
  const m = (k: 'life' | 'energyShield' | 'armour' | 'resist'): number => median(hs.map((h) => h[k]));
  return { ...mid, life: m('life'), energyShield: m('energyShield'), armour: m('armour'), resist: m('resist') };
}

// ── Pace ──

function runXpAt(L: number): { runBase: number; runXp: number } {
  const prog = gameContent.progression;
  const pool = poolAt(L);
  const wSum = pool.reduce((s, e) => s + e.w, 0);
  const baseXp = pool.reduce((s, e) => s + (e.w / wSum) * e.def.xp, 0);
  const runBase = rules.combatRooms * (mobsPerRoom * baseXp + elitesPerRoom * baseXp * rules.elites.scaling.xp) + gameContent.mobs['necromancer']!.xp;
  return { runBase, runXp: mobXp(runBase, L, prog) * (1 + prog.mapClearBonus) };
}
const runsForLevel = (L: number): number => (L < gameContent.progression.maxLevel ? xpToNextLevel(L, gameContent.progression) / runXpAt(L).runXp : 0);

/**
 * "average" gear: items seen at about this level = chest items (2 base + speed bonus ≈ 3 per run, rewards.chest) ×
 * runs spent at hero levels L − 2 .. L (hero level = map level), spread over 8 slots; at least 1, at most 6 per slot.
 */
const ITEMS_PER_RUN = 3;
function averageDraws(L: number): number {
  let runs = 0;
  for (let l = Math.max(1, L - 2); l <= L; l++) runs += Math.max(1, runsForLevel(l));
  return Math.max(1, Math.min(6, Math.round((runs * ITEMS_PER_RUN) / 8)));
}

// ── Run time model (ASSUMPTION) ──
const RUN_MODEL = {
  roomOverhead: 22, // s per room: walking, wave delays (1 + 1.5 s), regrouping
  combatEfficiency: 0.5, // share of time spent casting into packs while clearing
  bossUptime: 0.55, // share of the boss fight spent hitting it (dodging telegraphs, minions, phase roar)
  bossRoomOverhead: 12, // walk to the altar + spawn delay + phase roar
};
const mobsPerRoom = (((rules.waves.count.min + rules.waves.count.max) / 2) * (rules.waves.mobs.min + rules.waves.mobs.max)) / 2;
const elitesPerRoom = (rules.elites.count.min + rules.elites.count.max) / 2;

function poolAt(L: number): Array<{ def: MobDef; w: number }> {
  return rules.waves.mobPool.filter((e) => (e.minMapLevel ?? 1) <= L).map((e) => ({ def: gameContent.mobs[e.mobId]!, w: e.weight }));
}

function mapRow(classId: string, L: number, h: HeroEval) {
  const setup = CLASSES[classId]!;
  const sc = scaleAt(L);
  const zombie = gameContent.mobs['zombie']!;
  const boss = gameContent.mobs['necromancer']!;
  const zLife = zombie.life * sc.life;
  const hitsZombie = zLife / (hitVs(h, zombie.armour * sc.armour) * setup.hitsPerCastMob);
  // Average casts per pool mob (armour of each def scaled).
  const pool = poolAt(L);
  const wSum = pool.reduce((s, e) => s + e.w, 0);
  const castsPerMob = pool.reduce((s, e) => s + (e.w / wSum) * Math.max(1, Math.ceil((e.def.life * sc.life) / (hitVs(h, e.def.armour * sc.armour) * setup.hitsPerCastMob))), 0);
  const roomCombat = (mobsPerRoom * castsPerMob * h.useTime) / setup.targetsPerCast / RUN_MODEL.combatEfficiency;
  const eliteCasts = elitesPerRoom * Math.ceil((zombie.life * rules.elites.scaling.life * sc.life) / (hitVs(h, 0) * setup.hitsPerCastMob));
  const room = RUN_MODEL.roomOverhead + roomCombat + (eliteCasts * h.useTime) / RUN_MODEL.combatEfficiency;
  const bossDps = (hitVs(h, boss.armour * sc.armour) * setup.hitsPerCastBoss) / h.useTime;
  const bossFight = (boss.life * sc.life) / (bossDps * RUN_MODEL.bossUptime);
  const run = rules.combatRooms * room + RUN_MODEL.bossRoomOverhead + bossFight;
  const pool2 = h.life + h.energyShield;
  const zHit = physTaken(h, avgHit(zombie) * sc.damage);
  const eliteHit = physTaken(h, avgHit(zombie) * rules.elites.scaling.damage * sc.damage);
  const nova = elemTaken(h, 26 * sc.damage);
  return { zLife, zHitRaw: avgHit(zombie) * sc.damage, hitsZombie, castsPerMob, dps: hitVs(h, 0) * setup.hitsPerCastBoss / h.useTime, zHitPct: zHit / pool2, eliteHitPct: eliteHit / pool2, novaPct: nova / pool2, bossLife: boss.life * sc.life, bossFight, room, run };
}

const f = (x: number, d = 1): string => x.toFixed(d);
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const table = (head: string[], rows: string[][]): void => {
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
};

describe('mob scaling vs hero growth', () => {
  it('runs', () => {
    console.log(`\nCurves: life ${JSON.stringify(LIFE)}, damage ${JSON.stringify(DMG)}, armour ${JSON.stringify(ARMOUR)}`);
    if (on('pace')) {
      console.log('\n## 1. Pace (hero level = map level)');
      const skillRules = gameContent.skillLevels!.rules;
      let cumRuns = 0;
      let skillXp = 0;
      const rows: string[][] = [];
      for (let L = 1; L <= 40; L++) {
        const { runBase, runXp } = runXpAt(L);
        const runs = runsForLevel(L);
        const skillLevel = skillXp >= skillRules.xpToNext[0]! + skillRules.xpToNext[1]! ? 3 : skillXp >= skillRules.xpToNext[0]! ? 2 : 1;
        if ([1, 2, 3, 5, 6, 8, 10, 12, 15, 20, 25, 30, 35, 39].includes(L)) {
          rows.push([`${L}`, f(runXp, 0), f(runs), f(cumRuns, 0), f((cumRuns * 4) / 60, 1), `${skillLevel}`, `${averageDraws(L)}`]);
        }
        cumRuns += runs;
        skillXp += runs * runBase;
      }
      table(['hero = map L', 'XP / run', 'runs for next level', 'runs to reach L', 'hours (4 min runs)', 'skill level at L', 'average: items per slot'], rows);
    }

    const heroes: Record<string, Record<string, Record<number, HeroEval>>> = {};
    for (const classId of Object.keys(CLASSES)) {
      heroes[classId] = {};
      for (const p of PROFILES) {
        heroes[classId]![p.name] = {};
        for (const L of on('curve') ? ALL_MAPS : MAPS) heroes[classId]![p.name]![L] = heroAt(classId, L, p);
      }
    }

    if (on('curve')) {
      console.log('\n## Curve: casts to kill a zombie per map (hero level = map level), mob hit % of hero life + ES');
      const cls = Object.keys(CLASSES);
      table(
        ['map', 'life ×', 'damage ×', 'armour ×', ...cls.map((c) => `avg ${c}`), ...cls.map((c) => `geared ${c}`), ...cls.map((c) => `stale ${c}`), 'avg zombie hit %', 'geared zombie hit %', 'avg boss s', 'geared boss s', 'avg run s', 'geared run s', 'stale run s'],
        ALL_MAPS.map((L) => {
          const sc = scaleAt(L);
          const avgRows = cls.map((c) => mapRow(c, L, heroes[c]!['average']![L]!));
          const gearRows = cls.map((c) => mapRow(c, L, heroes[c]!['geared']![L]!));
          const staleRows = cls.map((c) => mapRow(c, L, heroes[c]!['stale']![L]!));
          const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
          return [
            `${L}`, f(sc.life, 2), f(sc.damage, 2), f(sc.armour, 2),
            ...avgRows.map((r) => f(r.hitsZombie, 2)), ...gearRows.map((r) => f(r.hitsZombie, 2)),
            ...staleRows.map((r) => f(r.hitsZombie, 2)),
            pct(mean(avgRows.map((r) => r.zHitPct))), pct(mean(gearRows.map((r) => r.zHitPct))), f(mean(avgRows.map((r) => r.bossFight)), 0), f(mean(gearRows.map((r) => r.bossFight)), 0),
            f(mean(avgRows.map((r) => r.run)), 0), f(mean(gearRows.map((r) => r.run)), 0), f(mean(staleRows.map((r) => r.run)), 0),
          ];
        }),
      );
    }

    if (on('hero')) {
      console.log('\n## 2. Hero growth (median of samples)');
      for (const classId of Object.keys(CLASSES)) {
        for (const p of PROFILES) {
          console.log(`\n### ${classId} — ${p.name}`);
          const h1 = heroes[classId]![p.name]![1]!;
          table(
            ['map = hero L', 'hit', 'phys share', 'uses/s', 'DPS ×L1', 'life', 'ES', 'armour', 'avg res'],
            MAPS.map((L) => {
              const h = heroes[classId]![p.name]![L]!;
              return [`${L}`, f(h.hitTotal), pct((h.hit.physical ?? 0) / h.hitTotal), f(1 / h.useTime, 2), f(h.hitTotal / h.useTime / (h1.hitTotal / h1.useTime), 2), f(h.life, 0), f(h.energyShield, 0), f(h.armour, 0), pct(h.resist)];
            }),
          );
        }
      }
    }

    if (on('maps')) {
      console.log('\n## 3. Maps');
      for (const classId of Object.keys(CLASSES)) {
        for (const p of PROFILES) {
          console.log(`\n### ${classId} — ${p.name}`);
          table(
            ['map', 'mob life ×', 'zombie life', 'zombie hit', 'hero DPS (1 target)', 'casts to kill zombie', 'avg casts / pool mob', 'zombie hit % pool', 'elite hit %', 'boss nova %', 'boss life', 'boss fight s', 'room s', 'run s'],
            MAPS.map((L) => {
              const r = mapRow(classId, L, heroes[classId]![p.name]![L]!);
              return [`${L}`, f(scaleAt(L).life, 2), f(r.zLife, 0), f(r.zHitRaw, 1), f(r.dps, 0), f(r.hitsZombie, 2), f(r.castsPerMob, 2), pct(r.zHitPct), pct(r.eliteHitPct), pct(r.novaPct), f(r.bossLife, 0), f(r.bossFight, 0), f(r.room, 0), f(r.run, 0)];
            }),
          );
        }
      }
    }

    if (on('newmobs')) {
      console.log('\n## 4. New mobs at their first map (and +10 maps)');
      const firsts: Array<[string, number]> = rules.waves.mobPool.filter((e) => e.minMapLevel).map((e) => [e.mobId, e.minMapLevel!]);
      const rows: string[][] = [];
      for (const [mobId, first] of firsts) {
        for (const L of [first, Math.min(40, first + 10), 40]) {
          const def = gameContent.mobs[mobId]!;
          const sc = scaleAt(L);
          const near = MAPS.reduce((a, b) => (Math.abs(b - L) < Math.abs(a - L) ? b : a));
          for (const classId of Object.keys(CLASSES)) {
            const h = heroes[classId]!['average']![near]!;
            const setup = CLASSES[classId]!;
            const arm = def.armour * sc.armour;
            const phys = h.hit.physical ?? 0;
            const red = armourReduction(arm, phys, gameContent.combat);
            const casts = (def.life * sc.life) / (hitVs(h, arm) * setup.hitsPerCastMob);
            const zCasts = (gameContent.mobs['zombie']!.life * sc.life) / (hitVs(h, 0) * setup.hitsPerCastMob);
            rows.push([mobId, `${L} (hero ~${near})`, classId, f(def.life * sc.life, 0), f(arm, 0), pct(red), f(casts, 2), f(zCasts, 2)]);
          }
        }
      }
      table(['mob', 'map', 'class (average)', 'life', 'armour', 'armour cuts hero phys hit', 'casts to kill', 'zombie casts'], rows);
    }
  });
});

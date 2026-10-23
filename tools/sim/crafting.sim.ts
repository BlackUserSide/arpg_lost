// Crafting economy simulation (docs/design/crafting.md) over the real core item rolls and craft operations.
// Run: npx vitest run --config tools/sim/vitest.config.ts tools/sim/crafting.sim.ts --silent=false --disable-console-intercept
// Filter (env): SIM_ONLY=income,costs,paths,tiers,chase
//
// Sections:
//  1. Income: shards per arena run at hero level 1 / 10 / 20 from the real reward rules (data/items.ts arenaRewards,
//     rarity weights, salvage values) and support drops (core rollSupportDrop, ~280 normal kills per run as in
//     data/skillLevels.ts, salvage by tier from data/supports.ts). "All" = every drop salvaged (upper bound);
//     "typical" = KEEP fractions below (ASSUMPTION: what a player keeps instead of salvaging at that stage).
//  2. Costs: core craftCost per op at counter 0 / 5 / 10 / 20, in runs of typical income, for data/crafting.ts and
//     growth variants.
//  3. Paths: core applyCraft on real generated rings (item level 20): magic → rare, rare 3 → 6 affixes,
//     normal → 6-affix rare, value rerolls, one affix reroll.
//  4. Tiers: affix tier share on dropped rares vs crafted rares by item level (same table by design).
//  5. Chase vs drops: from a normal ring (upgrade, add, upgrade) or a dropped rare: add while a slot is free, then
//     greedy rerollAffix on an affix that misses the goal
//     until the goal is met (cap MAX_CRAFTS counted crafts). Goals use a fixed "wanted" set (caster ring: 3 prefixes +
//     3 suffixes). Compared with the chance that a dropped item already meets the goal (runs to drop one).
// applyCraft draws the same RNG whatever the prices (currency is unlimited here), so each outcome is simulated once as
// a trace of (op, item before) and priced per rule variant with core craftCost.
// Every rule is core's (generateItem / applyCraft / craftCost / rollSupportDrop); this file only sets up and counts.
import { describe, it } from 'vitest';
import { craftingRules } from '../../src/data/crafting';
import { itemsData } from '../../src/data/items';
import { content as gameContent } from '../../src/data';
import { applyCraft, craftCost, ESSENCE_CURRENCY, type CraftData, type CraftingRules, type CraftOp } from '../../src/core/items/craft';
import { availableBases, generateItem } from '../../src/core/items/generate';
import { SALVAGE_CURRENCY } from '../../src/core/items/inventory';
import type { Item } from '../../src/core/items/types';
import { createProfile, type Profile } from '../../src/core/progression/profile';
import { rollSupportDrop } from '../../src/core/supports/drops';
import { createRng, type Rng } from '../../src/core/rng';

const SEED = 20261023;
const ONLY = (process.env['SIM_ONLY'] ?? '').split(',').filter(Boolean);
const on = (section: string): boolean => ONLY.length === 0 || ONLY.includes(section);

const LEVELS = [1, 10, 20] as const;
const RUNS = 20_000;
const KILLS_PER_RUN = 280;
/** ASSUMPTION: share of magic / rare items and of supports the player keeps (not salvaged) at each hero level. */
const KEEP: Record<number, { items: number; supports: number }> = {
  1: { items: 0.4, supports: 1 },
  10: { items: 0.15, supports: 0.5 },
  20: { items: 0.05, supports: 0.1 },
};
const MAX_CRAFTS = 400;
const CHASE_SAMPLES = 1000;
const UNECONOMIC_RUNS = 5;

const supportsData = gameContent.supports!;
const items = itemsData;

// ── Rule variants (data/crafting.ts first) ──

const withGrowth = (growth: CraftingRules['growth']): CraftingRules => ({ ...craftingRules, growth });
// The pre-tuning draft (first PROPOSAL in data/crafting.ts), kept as a reference row.
const DRAFT: CraftingRules = {
  ops: {
    upgradeRarity: { cost: { [SALVAGE_CURRENCY]: 6 }, costByRarity: { normal: { [SALVAGE_CURRENCY]: 6 }, magic: { [SALVAGE_CURRENCY]: 15 } }, counted: true },
    addAffix: { cost: { [SALVAGE_CURRENCY]: 8 }, counted: true },
    rerollAffix: { cost: { [SALVAGE_CURRENCY]: 10, [ESSENCE_CURRENCY]: 1 }, counted: true },
    rerollValues: { cost: { [SALVAGE_CURRENCY]: 4 }, counted: false },
    removeAffix: { cost: { [SALVAGE_CURRENCY]: 8, [ESSENCE_CURRENCY]: 1 }, counted: true },
  },
  growth: { kind: 'linear', perCraft: 0.5 },
};
const VARIANTS: Array<{ name: string; rules: CraftingRules }> = [
  { name: 'data', rules: craftingRules },
  { name: 'draft (lin 0.5)', rules: DRAFT },
  { name: 'lin 0.2', rules: withGrowth({ kind: 'linear', perCraft: 0.2 }) },
  { name: 'lin 0.15', rules: withGrowth({ kind: 'linear', perCraft: 0.15 }) },
  { name: 'geo 1.1', rules: withGrowth({ kind: 'geometric', factor: 1.1 }) },
];

const fmt = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : 'inf');
const pctile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

// ── 1. Income ──

interface Income {
  itemsAll: number;
  itemsTypical: number;
  supportsAll: number;
  supportsTypical: number;
  supportsPerRun: number;
}

function income(level: number): Income {
  const rng = createRng(SEED + level);
  const keep = KEEP[level]!;
  const r = items.rules.arenaRewards;
  const count = Math.min(r.maxItems, Math.floor(KILLS_PER_RUN / r.killsPerItem));
  const out: Income = { itemsAll: 0, itemsTypical: 0, supportsAll: 0, supportsTypical: 0, supportsPerRun: 0 };
  for (let run = 0; run < RUNS; run++) {
    for (let i = 0; i < count; i++) {
      // Item level does not change salvage; area level + 2 is the usual wave bonus.
      const item = generateItem(rng, 'x', { itemLevel: level + 2 }, items);
      const value = items.rules.salvage[item.rarity];
      out.itemsAll += value;
      if (!(item.rarity !== 'normal' && rng.chance(keep.items))) out.itemsTypical += value;
    }
    for (let k = 0; k < KILLS_PER_RUN; k++) {
      const s = rollSupportDrop(rng, supportsData, 'normal', level);
      if (!s) continue;
      out.supportsPerRun++;
      const value = supportsData.rules.salvage[s.tier - 1] ?? 0;
      out.supportsAll += value;
      if (!rng.chance(keep.supports)) out.supportsTypical += value;
    }
  }
  for (const key of Object.keys(out) as Array<keyof Income>) out[key] /= RUNS;
  return out;
}

const INCOME: Record<number, Income> = Object.fromEntries(LEVELS.map((l) => [l, income(l)]));
const typical = (level: number): number => INCOME[level]!.itemsTypical + INCOME[level]!.supportsTypical;
const runsAt = (shards: number): string => LEVELS.map((l) => fmt(shards / typical(l))).join(' / ');

// ── Craft traces ──

type Trace = Array<{ readonly op: CraftOp; readonly item: Item }>;
const SIM_DATA: CraftData = { items, crafting: craftingRules };

function newProfile(item: Item): Profile {
  const profile = createProfile();
  profile.stash.items.push(item);
  profile.currency[SALVAGE_CURRENCY] = 1e15;
  profile.currency[ESSENCE_CURRENCY] = 1e15;
  return profile;
}

function craft(profile: Profile, op: CraftOp, rng: Rng, trace: Trace, index?: number): Item | undefined {
  const before = profile.stash.items[0]!;
  const res = applyCraft(profile, before.id, op, index === undefined ? {} : { index }, rng, SIM_DATA);
  if (!res.ok) return undefined;
  trace.push({ op, item: before });
  return res.item;
}

/** normal → magic → add → rare → add until 6 (the full shard path). */
function craftToSixAffixRare(profile: Profile, rng: Rng, trace: Trace): Item {
  craft(profile, 'upgradeRarity', rng, trace);
  craft(profile, 'addAffix', rng, trace);
  craft(profile, 'upgradeRarity', rng, trace);
  while (craft(profile, 'addAffix', rng, trace));
  return profile.stash.items[0]!;
}

interface Price {
  shards: number;
  essence: number;
  crafts: number;
}

function price(trace: Trace, rules: CraftingRules): Price {
  const out = { shards: 0, essence: 0, crafts: 0 };
  for (const { op, item } of trace) {
    const c = craftCost(item, op, rules);
    out.shards += c[SALVAGE_CURRENCY] ?? 0;
    out.essence += c[ESSENCE_CURRENCY] ?? 0;
    if (rules.ops[op].counted) out.crafts++;
  }
  return out;
}

// ── Chase goals (caster ring) ──

const WANTED = new Set(['life_flat', 'added_lightning', 'added_cold', 'cast_speed', 'fire_res', 'cold_res']);
const kindOf = (affixId: string): 'prefix' | 'suffix' => items.affixes[affixId]!.kind;

interface Goal {
  readonly name: string;
  /** tier: 1 = best. At item level 30 all 5 tiers exist, at 20 tiers 3–5. */
  readonly good: (affixId: string, tier: number) => boolean;
  readonly prefixes: number;
  readonly suffixes: number;
}

const GOALS: Goal[] = [
  { name: 'solid: 2+2 wanted', good: (id) => WANTED.has(id), prefixes: 2, suffixes: 2 },
  { name: 'great: 3+3 wanted', good: (id) => WANTED.has(id), prefixes: 3, suffixes: 3 },
  { name: 'near-perfect: 3+3 wanted, tier <= 3', good: (id, t) => WANTED.has(id) && t <= 3, prefixes: 3, suffixes: 3 },
  { name: 'perfect: 3+3 wanted, tier <= 2', good: (id, t) => WANTED.has(id) && t <= 2, prefixes: 3, suffixes: 3 },
];

function missing(item: Item, goal: Goal): Record<'prefix' | 'suffix', number> {
  const need = { prefix: goal.prefixes, suffix: goal.suffixes };
  for (const a of item.affixes) if (goal.good(a.affixId, a.tier)) need[kindOf(a.affixId)]--;
  return need;
}
const meets = (item: Item, goal: Goal): boolean => {
  const need = missing(item, goal);
  return need.prefix <= 0 && need.suffix <= 0;
};
/** An affix that misses the goal on a side that still needs more. */
function badIndex(item: Item, goal: Goal): number {
  const need = missing(item, goal);
  return item.affixes.findIndex((a) => !goal.good(a.affixId, a.tier) && need[kindOf(a.affixId)] > 0);
}

describe('crafting economy', () => {
  it('runs', () => {
    if (on('income')) {
      console.log(`\n## 1. Shards per arena run (3 items, ~${KILLS_PER_RUN} kills), ${RUNS} runs per level`);
      console.log('| hero level | items, all salvaged | items, typical | supports / run | supports, all | supports, typical | TOTAL typical | TOTAL all |');
      console.log('|---|---|---|---|---|---|---|---|');
      for (const l of LEVELS) {
        const i = INCOME[l]!;
        console.log(`| ${l} | ${fmt(i.itemsAll, 2)} | ${fmt(i.itemsTypical, 2)} | ${fmt(i.supportsPerRun, 2)} | ${fmt(i.supportsAll, 2)} | ${fmt(i.supportsTypical, 2)} | **${fmt(typical(l), 2)}** | ${fmt(i.itemsAll + i.supportsAll, 2)} |`);
      }
    }

    if (on('costs')) {
      console.log('\n## 2. Cost per op: shards (essence); runs of typical shard income at L1 / L10 / L20');
      const sample = (rarity: Item['rarity'], crafts: number): Item => ({ id: 'x', baseId: 'iron_ring', level: 20, rarity, name: '', affixes: [], crafts });
      const rows: Array<[string, CraftOp, Item['rarity']]> = [
        ['normal -> magic', 'upgradeRarity', 'normal'],
        ['magic -> rare', 'upgradeRarity', 'magic'],
        ['add affix', 'addAffix', 'rare'],
        ['reroll values', 'rerollValues', 'rare'],
        ['reroll affix', 'rerollAffix', 'rare'],
        ['remove affix', 'removeAffix', 'rare'],
      ];
      for (const v of VARIANTS) {
        console.log(`\n### ${v.name} ${JSON.stringify(v.rules.growth)}`);
        console.log('| op | T0 | @5 | @10 | @20 | runs T0 | runs @5 |');
        console.log('|---|---|---|---|---|---|---|');
        for (const [name, op, rarity] of rows) {
          const c = (n: number): Record<string, number> => craftCost(sample(rarity, n), op, v.rules);
          const show = (n: number): string => {
            const x = c(n);
            return `${x[SALVAGE_CURRENCY] ?? 0}${x[ESSENCE_CURRENCY] ? ` (${x[ESSENCE_CURRENCY]})` : ''}`;
          };
          console.log(`| ${name} | ${show(0)} | ${show(5)} | ${show(10)} | ${show(20)} | ${runsAt(c(0)[SALVAGE_CURRENCY] ?? 0)} | ${runsAt(c(5)[SALVAGE_CURRENCY] ?? 0)} |`);
        }
        // "Uneconomic": the counter at which one affix reroll costs more than UNECONOMIC_RUNS runs of L20 income.
        let n = 0;
        while ((craftCost(sample('rare', n), 'rerollAffix', v.rules)[SALVAGE_CURRENCY] ?? 0) < UNECONOMIC_RUNS * typical(20) && n < 1000) n++;
        console.log(`Affix reroll costs >= ${UNECONOMIC_RUNS} runs of L20 income from counter ${n}.`);
      }
    }

    if (on('paths')) {
      const rng = createRng(SEED);
      const traces: Record<string, Trace[]> = {
        'magic(1) -> rare': [],
        'dropped rare(3) -> 6 affixes': [],
        'normal -> 6-affix rare': [],
        'then reroll values x3': [],
        'then reroll 1 affix': [],
      };
      for (let s = 0; s < 5000; s++) {
        const m = generateItem(rng, 'a', { itemLevel: 20, rarity: 'magic', slot: 'ring' }, items);
        let t: Trace = [];
        craft(newProfile({ ...m, affixes: m.affixes.slice(0, 1) }), 'upgradeRarity', rng, t);
        traces['magic(1) -> rare']!.push(t);

        const r = generateItem(rng, 'b', { itemLevel: 20, rarity: 'rare', slot: 'ring' }, items);
        const pr = newProfile({ ...r, affixes: r.affixes.slice(0, 3) });
        t = [];
        while (craft(pr, 'addAffix', rng, t));
        traces['dropped rare(3) -> 6 affixes']!.push(t);

        const pn = newProfile(generateItem(rng, 'c', { itemLevel: 20, rarity: 'normal', slot: 'ring' }, items));
        t = [];
        craftToSixAffixRare(pn, rng, t);
        traces['normal -> 6-affix rare']!.push(t);
        t = [];
        for (let k = 0; k < 3; k++) craft(pn, 'rerollValues', rng, t, 0);
        traces['then reroll values x3']!.push(t);
        t = [];
        craft(pn, 'rerollAffix', rng, t, 0);
        traces['then reroll 1 affix']!.push(t);
      }
      console.log('\n## 3. Paths on real rings (item level 20), 5000 samples; mean shards (essence), runs at L1 / L10 / L20');
      for (const v of VARIANTS) {
        console.log(`\n### ${v.name}`);
        console.log('| path | counted crafts | shards | essence | runs L1 / L10 / L20 |');
        console.log('|---|---|---|---|---|');
        for (const [name, ts] of Object.entries(traces)) {
          const ps = ts.map((tr) => price(tr, v.rules));
          const sh = mean(ps.map((p) => p.shards));
          console.log(`| ${name} | ${fmt(mean(ps.map((p) => p.crafts)))} | ${fmt(sh)} | ${fmt(mean(ps.map((p) => p.essence)))} | ${runsAt(sh)} |`);
        }
      }
    }

    if (on('tiers')) {
      // Affix tier share (1 = best) on dropped rares vs on normal rings crafted to 6-affix rares: same table by design.
      console.log('\n## 4. Affix tier share by item level: dropped rare vs crafted (normal -> 6-affix rare), 20000 items each');
      console.log('| item level | source | T1 | T2 | T3 | T4 | T5 | mean affixes |');
      console.log('|---|---|---|---|---|---|---|---|');
      for (const ilvl of [8, 15, 20, 23, 30]) {
        for (const source of ['drop', 'craft'] as const) {
          const rng = createRng(SEED + ilvl * 13 + (source === 'drop' ? 0 : 1));
          const count = [0, 0, 0, 0, 0];
          let affixes = 0;
          for (let s = 0; s < 20_000; s++) {
            let item: Item;
            if (source === 'drop') item = generateItem(rng, 'f', { itemLevel: ilvl, rarity: 'rare', slot: 'ring' }, items);
            else item = craftToSixAffixRare(newProfile(generateItem(rng, 'f', { itemLevel: ilvl, rarity: 'normal', slot: 'ring' }, items)), rng, []);
            for (const a of item.affixes) count[a.tier - 1]!++;
            affixes += item.affixes.length;
          }
          console.log(`| ${ilvl} | ${source} | ${count.map((c) => `${fmt((100 * c) / affixes)}%`).join(' | ')} | ${fmt(affixes / 20_000, 2)} |`);
        }
      }
    }

    if (on('chase')) {
      const r = items.rules.arenaRewards;
      const itemsPerRun = Math.min(r.maxItems, Math.floor(KILLS_PER_RUN / r.killsPerItem));
      const w = items.rules.rarityWeights;
      const pRare = w.rare / (w.normal + w.magic + w.rare);
      for (const ilvl of [20, 30]) {
        const bases = availableBases(items, ilvl);
        const pRing = bases.filter((b) => b.slot === 'ring').length / bases.length;
        const drng = createRng(SEED + ilvl);
        const N = 400_000;
        const hits = GOALS.map(() => 0);
        for (let s = 0; s < N; s++) {
          const it = generateItem(drng, 'd', { itemLevel: ilvl, rarity: 'rare', slot: 'ring' }, items);
          GOALS.forEach((g, i) => {
            if (meets(it, g)) hits[i]!++;
          });
        }
        console.log(`\n## 5. Caster ring, item level ${ilvl}: crafting chase vs drops`);
        console.log(`Drop: P(ring) = ${fmt(pRing, 3)}, P(rare) = ${fmt(pRare, 3)}, ${itemsPerRun} items per run; ${N} rare rings sampled; ${CHASE_SAMPLES} chases per goal.`);
        console.log('| goal | P(rare ring meets) | runs to DROP one (mean) |');
        console.log('|---|---|---|');
        GOALS.forEach((goal, gi) => {
          const p = hits[gi]! / N;
          console.log(`| ${goal.name} | ${p.toExponential(2)} | ${fmt(1 / (p * pRing * pRare * itemsPerRun), 0)} |`);
        });

        // Policy: stop when the goal is met; add an affix while a slot is free; otherwise reroll an affix that misses.
        for (const start of ['normal', 'dropped rare'] as const) {
          const traces = GOALS.map((goal, gi) => {
            const crng = createRng(SEED * 3 + gi * 101 + ilvl + (start === 'normal' ? 0 : 7));
            const out: Array<Trace | null> = [];
            for (let s = 0; s < CHASE_SAMPLES; s++) {
              const prof = newProfile(generateItem(crng, 'e', { itemLevel: ilvl, rarity: start === 'normal' ? 'normal' : 'rare', slot: 'ring' }, items));
              const t: Trace = [];
              if (start === 'normal') {
                craft(prof, 'upgradeRarity', crng, t);
                craft(prof, 'addAffix', crng, t);
                craft(prof, 'upgradeRarity', crng, t);
              }
              let item = prof.stash.items[0]!;
              let attempts = 0;
              while (!meets(item, goal) && attempts++ < MAX_CRAFTS) {
                const added = item.affixes.length < 6 ? craft(prof, 'addAffix', crng, t) : undefined;
                if (added) {
                  item = added;
                  continue;
                }
                const idx = badIndex(item, goal);
                if (idx < 0) break;
                item = craft(prof, 'rerollAffix', crng, t, idx) ?? item;
              }
              out.push(meets(item, goal) ? t : null);
            }
            return out;
          });
          console.log(`\n### Chase from a ${start} ring: counted crafts p50 / p90 (share reached within ${MAX_CRAFTS})`);
          console.log(`| goal | crafts | ${VARIANTS.map((v) => `${v.name}: shards p50 / p90 (runs L20) [essence p50]`).join(' | ')} |`);
          console.log(`|---|---|${VARIANTS.map(() => '---').join('|')}|`);
          GOALS.forEach((goal, gi) => {
            const tr = traces[gi]!;
            const crafts = tr.map((t) => (t ? t.length : Infinity));
            const reached = tr.filter((t) => t !== null).length;
            const cells = VARIANTS.map((v) => {
              const ps = tr.map((t) => (t ? price(t, v.rules) : { shards: Infinity, essence: Infinity, crafts: Infinity }));
              const sh = ps.map((p) => p.shards);
              return `${fmt(pctile(sh, 0.5), 0)} / ${fmt(pctile(sh, 0.9), 0)} (${fmt(pctile(sh, 0.5) / typical(20), 0)} / ${fmt(pctile(sh, 0.9) / typical(20), 0)}) [${fmt(pctile(ps.map((p) => p.essence), 0.5), 0)}]`;
            });
            console.log(`| ${goal.name} | ${fmt(pctile(crafts, 0.5), 0)} / ${fmt(pctile(crafts, 0.9), 0)} (${fmt((100 * reached) / CHASE_SAMPLES, 0)}%) | ${cells.join(' | ')} |`);
          });
        }
      }
    }
  });
});

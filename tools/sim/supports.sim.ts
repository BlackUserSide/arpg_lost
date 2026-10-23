// Skill modifier ("support") balance simulation over the real core world loop and core drop rolls.
// Run: npx vitest run --config tools/sim/vitest.config.ts tools/sim/supports.sim.ts --silent=false --disable-console-intercept --testTimeout=0
// Filters (env): SIM_ONLY=drops,dps,resource,leech; SIM_SKILL=<skill id> (DPS tables); SIM_FOCUS=<support id> (DPS
// tables: only that support's single row and the pairs containing it). The full run takes ~15 min.
//
// Sections:
//  1. Drops: supports per run from core rollSupportDrop, kills drawn from the real arena spawn list (arena.ts), and
//     the planned map run (3 rooms × 1–2 elites + boss, docs/design/maps.md / mobs.md). Tier split per area level.
//     Plus "arena bot": kills a stationary immortal hero gets in a 4-minute arena run (real spawner and mobs).
//  2. DPS: every damaging class skill with no support, each compatible support (tier 1 / 3) and every compatible
//     pair (tier 3, best tier-1 pair too), for three hero profiles per class. Measured as damage dealt per second
//     (hit + dot + zone events) to unkillable dummies, skill only, resource topped up (raw power):
//       - crowd: 10 walking zombie-dummies starting over 240° around the hero (real zombie attacks; hero life topped up, damage taken = DTPS),
//         used by melee skills and Frost Nova; the hero stands in the centre.
//       - pack: 12 still dummies in a disc (radius 100) 280 in front, used by projectile skills and the trap.
//       - boss: one still boss dummy (boss rules: no knockback, stun -> slow), 55 away (melee / nova) or 280.
//  3. Resource: skill casts per second with the real resource and the basic attack as filler (steady state,
//     30–120 s) relative to unlimited casts, for no support, cheapest / priciest single and priciest pair.
//  4. Leech: life per second from Vampirism on the pack / boss (hero held at half life, no incoming damage).
// Earlier what-ifs, resolved by the designer 2026-10-23: Chain Lightning on Volley rejected (spell-only); Extra
// Projectiles as (count + 1) × 1.2 with -25/-20/-15% adopted into src/data/supports.ts.
// Every rule is core's (createWorld / step / rollSupportDrop / supportFits); this file only sets up scenes and counts.
import { describe, it } from 'vitest';
import { content as gameContent } from '../../src/data';
import { passiveTree } from '../../src/data/passives';
import { passiveMechanics, passiveModifiers } from '../../src/core/passives/allocation';
import type { PassiveMechanic } from '../../src/core/passives/types';
import { rollSupport, rollSupportDrop } from '../../src/core/supports/drops';
import { supportFits } from '../../src/core/supports/rules';
import type { SupportData, SupportDef, SupportRef } from '../../src/core/supports/types';
import { createRng } from '../../src/core/rng';
import { distance, vec, type Vec2 } from '../../src/core/math';
import type { ActionDef, Content, MobDef } from '../../src/core/world/content';
import type { Modifier } from '../../src/core/stats/types';
import { createWorld, maxResource, playerStat, step, type MobState, type PlayerInput, type WorldState } from '../../src/core/world/world';

const DT = 1 / 60;
const SEED = 4242;

// ── Scene content ──

const zombie = gameContent.mobs['zombie']!;
// Dummies are topped up to full life every step (they never die); their life only sets the stun bar fill per hit.
const CROWD: MobDef = { ...zombie, id: 'sim_crowd', life: 2000, xp: 0 };
const STILL: MobDef = { ...zombie, id: 'sim_still', life: 2000, xp: 0, moveSpeed: 0, attack: { ...zombie.attack, damage: { physical: { min: 0, max: 0 } } } };
const BOSS: MobDef = { ...STILL, id: 'sim_boss', life: 10000, radius: 30, boss: true };

function sceneContent(supports: SupportData = gameContent.supports!): Content {
  return {
    ...gameContent,
    supports,
    mobs: { ...gameContent.mobs, [CROWD.id]: CROWD, [STILL.id]: STILL, [BOSS.id]: BOSS },
    arena: { ...gameContent.arena, spawn: { ...gameContent.arena.spawn, firstDelay: 1e9, maxAlive: 0 } },
  };
}

function addMob(world: WorldState, content: Content, defId: string, pos: Vec2): MobState {
  const def = content.mobs[defId]!;
  const mob: MobState = {
    id: world.nextId++, defId, pos, facing: vec(0, 1), life: def.life, maxLife: def.life, attackTimer: def.attack.interval,
    stun: 0, slow: 0, slowMagnitude: 0, ignite: 0, igniteDps: 0, freeze: 0, freezeSlow: 0, stunSlow: 0, stunBar: 0, stunBarIdle: 0, auraSlow: 0, radius: def.radius,
  };
  world.mobs.push(mob);
  return mob;
}

// ── Hero profiles ──

interface Hero {
  readonly name: string;
  readonly classId: string;
  readonly level: number;
  readonly skillLevel: number;
  readonly modifiers: readonly Modifier[];
  readonly mechanics: readonly PassiveMechanic[];
}

/** Level 20, skill level 3, gear ≈ +40% increased damage, ~19 wheel points in the class zone + spec entry & keystone. */
function build(name: string, classId: string, wheel: string[], spec: string, prefix: string): Hero {
  const alloc = { nodes: wheel, spec, specNodes: [`${prefix}_entry`, `${prefix}_key`] };
  return {
    name,
    classId,
    level: 20,
    skillLevel: 3,
    modifiers: [{ stat: 'damage', kind: 'increased', value: 0.4 }, ...passiveModifiers(passiveTree, alloc)],
    mechanics: passiveMechanics(passiveTree, alloc),
  };
}

const W_WHEEL = ['w_a1', 'w_a2', 'w_a3', 'w_a4', 'w_n1', 'w_c1', 'w_c2', 'w_b1', 'w_b2', 'wr_1', 'wr_2', 'wr_3', 'wr_4', 'wr_n', 'i_w', 'i_wr'];
const R_WHEEL = ['r_a1', 'r_a2', 'r_a3', 'r_a4', 'r_n1', 'r_b1', 'r_b2', 'r_c1', 'r_c2', 'rm_1', 'rm_3', 'rm_5', 'rm_n', 'i_r', 'i_rm'];
const M_WHEEL = ['m_a1', 'm_a2', 'm_a3', 'm_a4', 'm_n1', 'm_b1', 'm_b2', 'm_c1', 'm_c2', 'm_d1', 'mw_1', 'mw_3', 'mw_n', 'i_m', 'i_mw'];

const fresh = (classId: string): Hero => ({ name: 'L1', classId, level: 1, skillLevel: 1, modifiers: [], mechanics: [] });

const HEROES: Record<string, Hero[]> = {
  warrior: [fresh('warrior'), build('L20 berserker', 'warrior', W_WHEEL, 'berserker', 'bz'), build('L20 guardian', 'warrior', W_WHEEL, 'guardian', 'gd')],
  ranger: [fresh('ranger'), build('L20 sniper', 'ranger', R_WHEEL, 'sniper', 'sn'), build('L20 trapper', 'ranger', R_WHEEL, 'trapper', 'tr')],
  mage: [fresh('mage'), build('L20 pyromancer', 'mage', M_WHEEL, 'pyromancer', 'py'), build('L20 cryomancer', 'mage', M_WHEEL, 'cryomancer', 'cr')],
};

// ── DPS scene ──

type Target = 'crowd' | 'pack' | 'spread' | 'boss' | 'bossClose';

/** Hex rings 0..rings around the origin, `gap` apart (1 + 3·r·(r+1) points). */
function hexRings(rings: number, gap: number): Vec2[] {
  const out: Vec2[] = [vec(0, 0)];
  for (let r = 1; r <= rings; r++) {
    for (let side = 0; side < 6; side++) {
      const a = (side * Math.PI) / 3;
      const b = ((side + 1) * Math.PI) / 3;
      for (let k = 0; k < r; k++) {
        const t = k / r;
        out.push(vec(gap * r * ((1 - t) * Math.cos(a) + t * Math.cos(b)), gap * r * ((1 - t) * Math.sin(a) + t * Math.sin(b))));
      }
    }
  }
  return out;
}

/** `count` points spread over a disc (fixed seed), at least 32 apart and at least `inner` from the centre. */
function scatter(count: number, radius: number, inner: number, seed: number): Vec2[] {
  const rng = createRng(777 + seed);
  const out: Vec2[] = [];
  while (out.length < count) {
    const p = vec((rng.next() * 2 - 1) * radius, (rng.next() * 2 - 1) * radius);
    const d = Math.hypot(p.x, p.y);
    if (d > radius || d < inner || out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 32)) continue;
    out.push(p);
  }
  return out;
}

interface Scene {
  readonly hero: Hero;
  readonly skillId: string;
  readonly supports: readonly SupportRef[];
  readonly target: Target;
  /** True: resource topped up every step and the skill is pressed alone. False: real resource, basic attack fills. */
  readonly unlimited: boolean;
  readonly seconds: number;
  /** Hero held at half life, mobs deal no damage: measures life gained (leech). */
  readonly leech?: boolean;
  readonly content?: Content;
  /** Spread scene: which scattered layout (seed). */
  readonly layout?: number;
}

/** Spread scenes are averaged over this many scattered layouts (radius changes are lumpy on one layout). */
const SPREAD_LAYOUTS = 3;

/** runScene, averaged over the spread layouts for the spread scene. */
function runTarget(s: Scene): SceneResult {
  if (s.target !== 'spread') return runScene(s);
  const runs = Array.from({ length: SPREAD_LAYOUTS }, (_, layout) => runScene({ ...s, layout, seconds: s.seconds / 2 }));
  const mean = (f: (r: SceneResult) => number): number => runs.reduce((sum, r) => sum + f(r), 0) / runs.length;
  return { dps: mean((r) => r.dps), dtps: mean((r) => r.dtps), casts: mean((r) => r.casts), lifePerSecond: mean((r) => r.lifePerSecond), resourceCost: runs[0]!.resourceCost };
}

interface SceneResult {
  readonly dps: number;
  readonly dtps: number;
  readonly casts: number;
  readonly lifePerSecond: number;
  readonly resourceCost: number;
}

const isMelee = (a: ActionDef): boolean => a.delivery.kind === 'arc' || a.delivery.kind === 'dash';

function runScene(s: Scene): SceneResult {
  const content = s.content ?? sceneContent();
  const cls = content.classes[s.hero.classId]!;
  const skills = Object.fromEntries(cls.skills.map((a) => [a.id, { level: s.hero.skillLevel, xp: 0 }]));
  const world = createWorld(content, s.hero.classId, SEED, {
    level: s.hero.level,
    modifiers: s.hero.modifiers,
    mechanics: s.hero.mechanics,
    skills,
    supports: s.supports.length > 0 ? { [s.skillId]: s.supports } : {},
  });
  const player = world.player;
  const slot = cls.skills.findIndex((a) => a.id === s.skillId);
  const action = player.actions.skills[slot]!;
  const near = isMelee(cls.skills[slot]!) || cls.skills[slot]!.id === 'frost_nova';
  const centre = vec(content.arena.width / 2, content.arena.height / 2);
  const ids = new Set<number>();
  const still: Array<{ mob: MobState; pos: Vec2 }> = [];
  const place = (pos: Vec2): void => {
    const mob = addMob(world, content, STILL.id, pos);
    ids.add(mob.id);
    still.push({ mob, pos });
  };
  /** Aim point of ranged scenes. */
  const focus = vec(centre.x + 300, centre.y);
  if (s.target === 'crowd') {
    for (let i = 0; i < 10; i++) {
      const angle = (-2 * Math.PI) / 3 + (i / 9) * ((4 * Math.PI) / 3);
      const r = 70 + (i % 3) * 40;
      ids.add(addMob(world, content, s.leech ? STILL.id : CROWD.id, vec(centre.x + Math.cos(angle) * r, centre.y + Math.sin(angle) * r)).id);
    }
    if (s.leech) for (const m of world.mobs) still.push({ mob: m, pos: m.pos });
  } else if (s.target === 'pack') {
    // Dense pack: hex rings 0..2, 50 apart (19 mobs, radius ~100) around the aim point.
    for (const o of hexRings(2, 50)) place(vec(focus.x + o.x, focus.y + o.y));
  } else if (s.target === 'spread') {
    // Loose mobs: 24 still dummies scattered over a disc of radius 230 (fixed seed), around the hero for
    // close-range skills, around the aim point for ranged ones.
    const c = near ? centre : focus;
    for (const o of scatter(24, 230, near ? 45 : 0, s.layout ?? 0)) place(vec(c.x + o.x, c.y + o.y));
  } else {
    const pos = vec(centre.x + (near ? 55 : s.target === 'bossClose' ? 110 : 280), centre.y);
    const mob = addMob(world, content, BOSS.id, pos);
    ids.add(mob.id);
    still.push({ mob, pos });
  }
  const maxLife = playerStat(cls, player, 'life');
  const max = maxResource(cls, player);
  const regen = playerStat(cls, player, 'lifeRegen');
  let damage = 0;
  let lost = 0;
  let casts = 0;
  let gained = 0;
  const steps = Math.round(s.seconds / DT);
  const warm = s.unlimited ? 0 : Math.round(30 / DT);
  for (let i = 0; i < steps; i++) {
    if (!player.motion) player.pos = vec(centre.x, centre.y);
    for (const st of still) st.mob.pos = st.pos;
    for (const m of world.mobs) m.life = m.maxLife;
    if (s.unlimited) player.resource = max;
    player.life = s.leech ? maxLife / 2 : maxLife;
    const alive = world.mobs.filter((m) => ids.has(m.id));
    let aim = alive[0]?.pos ?? centre;
    if (s.target === 'crowd' || (s.target === 'spread' && near)) {
      let best = Infinity;
      for (const m of alive) {
        const d = distance(m.pos, player.pos);
        if (d < best) {
          best = d;
          aim = m.pos;
        }
      }
    } else if (s.target === 'pack' || s.target === 'spread') aim = focus;
    const input: PlayerInput = { move: vec(0, 0), aim, basicAttack: !s.unlimited, skills: cls.skills.map((_, k) => k === slot) };
    const before = player.life;
    const events = step(world, input, content, DT);
    if (s.leech) gained += Math.max(0, player.life - before - regen * DT);
    else lost += Math.max(0, before - player.life);
    if (i < warm) continue;
    for (const e of events) {
      if ((e.type === 'hit' || e.type === 'dot') && ids.has(e.targetId)) damage += e.amount;
      if (e.type === 'action' && e.actionId === s.skillId) casts++;
    }
  }
  const t = (steps - warm) * DT;
  return { dps: damage / t, dtps: lost / s.seconds, casts: casts / t, lifePerSecond: gained / s.seconds, resourceCost: action.resourceCost };
}

// ── Helpers ──

const supportDefs = (data: SupportData): SupportDef[] => Object.values(data.supports);
const compatible = (data: SupportData, skill: ActionDef): SupportDef[] => supportDefs(data).filter((d) => supportFits(d, skill));
const pc = (x: number): string => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;
const f0 = (x: number): string => x.toFixed(0);
const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);
const short = (id: string): string =>
  ({
    wider_swing: 'wide',
    stun: 'stun',
    bleed: 'bleed',
    knockback: 'knock',
    extra_projectiles: 'xproj',
    pierce: 'pierce',
    fast_projectiles: 'fast',
    increased_area: 'area',
    ignite_on_hit: 'ignite',
    chain_lightning: 'chain',
    cast_speed: 'speed',
    pure_power: 'power',
    vampirism: 'vamp',
    echo: 'echo',
  })[id] ?? id;

const targetsFor = (skill: ActionDef): Target[] =>
  isMelee(skill) || skill.id === 'frost_nova' ? ['crowd', 'spread', 'boss'] : skill.delivery.kind === 'projectile' ? ['pack', 'spread', 'boss', 'bossClose'] : ['pack', 'spread', 'boss'];

// ── 1. Drops ──

function dropTable(): void {
  const data = gameContent.supports!;
  const spawn = gameContent.arena.spawn;
  const lines = ['\n=== 1. Support drops per run (core rollSupportDrop, 100k runs per row, mobs drawn from arena.spawn.mobIds) ==='];
  lines.push(`dropChance normal ${data.rules.dropChance.normal} / elite ${data.rules.dropChance.elite} / boss ${data.rules.dropChance.boss}`);
  lines.push('run                                   | mean | P(0) | P(1) | P(2+)');
  const runs = 100_000;
  const row = (label: string, kills: number, elites: () => number, boss: boolean, seed: number): void => {
    const rng = createRng(seed);
    const counts = [0, 0, 0];
    let total = 0;
    for (let r = 0; r < runs; r++) {
      let drops = 0;
      const e = elites();
      for (let k = 0; k < kills; k++) {
        const def = gameContent.mobs[spawn.mobIds[rng.int(0, spawn.mobIds.length - 1)]!]!;
        const rank = k < e ? 'elite' : def.boss ? 'boss' : def.elite ? 'elite' : 'normal';
        if (rollSupportDrop(rng, data, rank, 10)) drops++;
      }
      if (boss && rollSupportDrop(rng, data, 'boss', 10)) drops++;
      total += drops;
      counts[Math.min(2, drops)]! += 1;
    }
    lines.push(`${label.padEnd(37)} | ${f2(total / runs)} | ${pc(counts[0]! / runs).padStart(4)} | ${pc(counts[1]! / runs).padStart(4)} | ${pc(counts[2]! / runs).padStart(4)}`);
  };
  const r = createRng(SEED);
  for (const kills of [200, 280, 360]) row(`arena ${kills} kills (all normal)`, kills, () => 0, false, SEED + kills);
  for (const kills of [200, 280]) row(`map ${kills} kills, 3 rooms × 1-2 elites, boss`, kills, () => 3 + r.int(0, 1) + r.int(0, 1) + r.int(0, 1), true, SEED + kills + 1);
  console.log(lines.join('\n'));

  const tierLines = ['\n--- tier split per area level (core rollSupport, 100k drops)'];
  for (const level of [1, 7, 8, 14, 15, 30]) {
    const rng = createRng(SEED + level);
    const t = [0, 0, 0];
    for (let i = 0; i < 100_000; i++) t[rollSupport(rng, data, level)!.tier - 1]! += 1;
    tierLines.push(`  area ${String(level).padStart(2)}: T1 ${pc(t[0]! / 1e5)}  T2 ${pc(t[1]! / 1e5)}  T3 ${pc(t[2]! / 1e5)}`);
  }
  console.log(tierLines.join('\n'));
}

/** Kills in a 4-minute arena run: immortal hero in the centre, aims at the nearest mob, skills on cooldown + basic attack. */
function arenaBot(): void {
  const lines = ['\n--- arena bot: kills in 240 s (real spawner, hero immortal and stationary, spam skill + cooldown skills + basic)'];
  for (const classId of ['warrior', 'ranger', 'mage']) {
    for (const hero of [HEROES[classId]![0]!, HEROES[classId]![1]!]) {
      const cls = gameContent.classes[classId]!;
      const skills = Object.fromEntries(cls.skills.map((a) => [a.id, { level: hero.skillLevel, xp: 0 }]));
      const world = createWorld(gameContent, classId, SEED, { level: hero.level, modifiers: hero.modifiers, mechanics: hero.mechanics, skills });
      const centre = vec(gameContent.arena.width / 2, gameContent.arena.height / 2);
      const maxLife = playerStat(cls, world.player, 'life');
      const damaging = cls.skills.map((a) => a.damage !== undefined);
      for (let i = 0; i < Math.round(240 / DT); i++) {
        world.player.life = maxLife;
        if (!world.player.motion) world.player.pos = centre;
        let aim = centre;
        let best = Infinity;
        for (const m of world.mobs) {
          const d = distance(m.pos, centre);
          if (d < best) {
            best = d;
            aim = m.pos;
          }
        }
        step(world, { move: vec(0, 0), aim, basicAttack: true, skills: damaging.map((d) => d && best < 320) }, gameContent, DT);
      }
      lines.push(`  ${classId.padEnd(7)} ${hero.name.padEnd(15)}: ${world.kills} kills`);
    }
  }
  console.log(lines.join('\n'));
}

// ── 2. DPS ──

interface ComboResult {
  readonly refs: SupportRef[];
  readonly gain: Record<string, number>;
  readonly dtps: number;
  readonly cost: number;
}

/** `focus`: only that support's single row and the pairs containing it (what-if tables). */
function dpsTable(classId: string, skillId: string, data: SupportData = gameContent.supports!, content?: Content, focus?: string): void {
  const skill = gameContent.classes[classId]!.skills.find((a) => a.id === skillId)!;
  const defs = compatible(data, skill);
  const targets = targetsFor(skill);
  // Cooldown skills cast rarely: longer runs keep chance effects (echo, ignite) out of the noise.
  const seconds = skill.cooldown >= 2 ? 300 : 120;
  for (const hero of HEROES[classId]!) {
    const run = (refs: SupportRef[], target: Target): SceneResult =>
      runTarget({ hero, skillId, supports: refs, target, unlimited: true, seconds, ...(content ? { content } : {}) });
    const base: Record<string, SceneResult> = Object.fromEntries(targets.map((t) => [t, run([], t)]));
    const combo = (refs: SupportRef[]): ComboResult => {
      const gain: Record<string, number> = {};
      let dtps = 0;
      let cost = 0;
      for (const t of targets) {
        const r = run(refs, t);
        gain[t] = r.dps / base[t]!.dps - 1;
        if (t === 'crowd') dtps = r.dtps / base[t]!.dtps - 1;
        cost = r.resourceCost / base[t]!.resourceCost;
      }
      return { refs, gain, dtps, cost };
    };
    const lines = [`\n=== ${classId} / ${skillId} / ${hero.name}: base ${targets.map((t) => `${t} ${f0(base[t]!.dps)} dps`).join(', ')}${targets.includes('crowd') ? `, DTPS ${f1(base['crowd']!.dtps)}` : ''}, ${f2(base[targets[0]!]!.casts)} casts/s, cost ${f1(base[targets[0]!]!.resourceCost)}`];
    lines.push(`  single     | ${targets.map((t) => `${t} T1/T2/T3`.padEnd(20)).join(' | ')}${targets.includes('crowd') ? ' | DTPS T1 / T3' : ''}`);
    for (const d of defs) {
      if (focus && d.id !== focus) continue;
      const r = [1, 2, 3].map((tier) => combo([{ defId: d.id, tier }]));
      lines.push(
        `  ${short(d.id).padEnd(10)} | ${targets.map((t) => `${pc(r[0]!.gain[t]!)} / ${pc(r[1]!.gain[t]!)} / ${pc(r[2]!.gain[t]!)}`.padEnd(20)).join(' | ')}${targets.includes('crowd') ? ` | ${pc(r[0]!.dtps)} / ${pc(r[2]!.dtps)}` : ''}`,
      );
    }
    const pairs: ComboResult[] = [];
    const pairsT1: ComboResult[] = [];
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        if (focus && defs[i]!.id !== focus && defs[j]!.id !== focus) continue;
        // Tier-1 pairs for the fresh hero (tier 1 is all that drops below area 8), tier-3 pairs for level 20.
        const tier = hero.level < 8 ? 1 : 3;
        (tier === 3 ? pairs : pairsT1).push(combo([{ defId: defs[i]!.id, tier }, { defId: defs[j]!.id, tier }]));
      }
    }
    const label = (c: ComboResult): string => c.refs.map((r) => short(r.defId)).join('+');
    const fmt = (c: ComboResult): string =>
      `${label(c).padEnd(14)} ${targets.map((t) => `${t} ${pc(c.gain[t]!)}`).join(', ')}${targets.includes('crowd') ? `, DTPS ${pc(c.dtps)}` : ''}, cost ×${f2(c.cost)}`;
    // Ranking: mean gain over the main targets (bossClose is a point-blank check, not ranked).
    const ranked = targets.filter((t) => t !== 'bossClose');
    const score = (c: ComboResult): number => ranked.reduce((sum, t) => sum + c.gain[t]!, 0) / ranked.length;
    const list = pairs.length > 0 ? pairs : pairsT1;
    const tierLabel = pairs.length > 0 ? 'T3' : 'T1';
    lines.push(`  best ${tierLabel} pairs (mean of ${ranked.join(' / ')}):`);
    for (const c of [...list].sort((a, b) => score(b) - score(a)).slice(0, 5)) lines.push(`    ${fmt(c)}`);
    for (const t of ranked) {
      const top = [...list].sort((a, b) => b.gain[t]! - a.gain[t]!)[0]!;
      lines.push(`  top ${tierLabel} pair for ${t}: ${fmt(top)}`);
    }
    console.log(lines.join('\n'));
  }
}

// ── 3. Resource ──

function resourceTable(): void {
  const data = gameContent.supports!;
  const lines = ['\n=== 3. Resource sustain: casts/s with real resource + basic filler (30-120 s) / casts/s unlimited ==='];
  lines.push('class / skill / hero                 | none         | cheapest single      | priciest single      | priciest pair');
  for (const classId of ['warrior', 'ranger', 'mage']) {
    const cls = gameContent.classes[classId]!;
    for (const skill of cls.skills.filter((a) => a.damage)) {
      const defs = compatible(data, skill).sort((a, b) => a.resourceCostMultiplier - b.resourceCostMultiplier);
      const cheap = defs[0]!;
      const dear = defs[defs.length - 1]!;
      const second = defs[defs.length - 2]!;
      const sets: SupportRef[][] = [[], [{ defId: cheap.id, tier: 3 }], [{ defId: dear.id, tier: 3 }], [{ defId: dear.id, tier: 3 }, { defId: second.id, tier: 3 }]];
      for (const hero of [HEROES[classId]![0]!, HEROES[classId]![1]!]) {
        const target = targetsFor(skill)[0]!;
        const cells = sets.map((refs) => {
          const free = runScene({ hero, skillId: skill.id, supports: refs, target, unlimited: true, seconds: 30 });
          const real = runScene({ hero, skillId: skill.id, supports: refs, target, unlimited: false, seconds: 120 });
          const name = refs.length === 0 ? 'none' : refs.map((r) => short(r.defId)).join('+');
          return `${name} ${pc(real.casts / free.casts).replace('+', '')}`.padEnd(20);
        });
        lines.push(`${`${classId} / ${skill.id} / ${hero.name}`.padEnd(37)} | ${cells.join(' | ')}`);
      }
    }
  }
  console.log(lines.join('\n'));
}

// ── 4. Leech ──

function leechTable(): void {
  const lines = ['\n=== 4. Vampirism: life leeched per second (hero at half life, no incoming damage) as % of max life per second ==='];
  for (const classId of ['warrior', 'ranger', 'mage']) {
    const cls = gameContent.classes[classId]!;
    const skill = cls.skills[0]!;
    for (const hero of [HEROES[classId]![0]!, HEROES[classId]![1]!]) {
      const world = createWorld(sceneContent(), classId, SEED, { level: hero.level, modifiers: hero.modifiers, mechanics: hero.mechanics });
      const maxLife = playerStat(cls, world.player, 'life');
      const cells = [1, 3].map((tier) =>
        targetsFor(skill)
          .map((t) => {
            const r = runScene({ hero, skillId: skill.id, supports: [{ defId: 'vampirism', tier }], target: t, unlimited: true, seconds: 20, leech: true });
            return `${t} ${f1(r.lifePerSecond)}/s (${pc(r.lifePerSecond / maxLife)})`;
          })
          .join(', '),
      );
      lines.push(`  ${classId} ${skill.id} ${hero.name} (life ${f0(maxLife)}): T1 ${cells[0]} | T3 ${cells[1]}`);
    }
  }
  console.log(lines.join('\n'));
}

describe('support balance simulation', () => {
  it('reports', () => {
    const only = process.env['SIM_ONLY'];
    const want = (k: string): boolean => !only || only.split(',').includes(k);
    if (want('drops')) {
      dropTable();
      arenaBot();
    }
    if (want('dps')) {
      for (const [classId, skillId] of [
        ['warrior', 'cleave'],
        ['warrior', 'shield_charge'],
        ['ranger', 'volley'],
        ['ranger', 'explosive_trap'],
        ['mage', 'fireball'],
        ['mage', 'frost_nova'],
      ] as const) {
        if (!process.env['SIM_SKILL'] || process.env['SIM_SKILL'].split(',').includes(skillId)) dpsTable(classId, skillId, undefined, undefined, process.env['SIM_FOCUS']);
      }
    }
    if (want('resource')) resourceTable();
    if (want('leech')) leechTable();
  });
});

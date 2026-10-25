// Eye of the Abyss skeletons (raiseAllies, src/core/world/allies.ts) vs map growth: are they absurd next to the hero?
// Run: npx vitest run --config tools/sim/vitest.config.ts tools/sim/allies.sim.ts --silent=false --disable-console-intercept
//
// Everything runs through the real world loop (createWorld / step) with the real Eye mechanics and the map's real mob
// scaling (mobLevelScaling). The hero stands aside with huge life and does nothing.
//  1. Damage: 6 skeletons raised next to an unkillable target with the zombie's / the shieldbearer's defences (armour
//     × the map's armour growth); damage dealt over their 8 s / 8 = DPS of a full set of 6.
//     Compare with the hero's single-target DPS from tools/sim/mobScaling.sim.ts (average / geared profile).
//  2. Tank: one skeleton with 1 / 3 real map zombies around it (they pick it over the hero): seconds it survives.
//  3. Resource: what one skeleton kill gives per class (10% of the class's base max).
import { describe, it } from 'vitest';
import { content as gameContent } from '../../src/data';
import { itemsData } from '../../src/data/items';
import { mapsData } from '../../src/data/maps';
import { vec } from '../../src/core/math';
import { mobLevelScaling } from '../../src/core/run/mobScaling';
import type { ClassDef, Content, MobDef } from '../../src/core/world/content';
import { createWorld, spawnMob, step, type MobScale, type PlayerInput, type WorldEvent, type WorldState } from '../../src/core/world/world';

const DT = 1 / 60;
const SEED = 777;
const MAPS = [1, 10, 20, 30, 40];
const eye = itemsData.uniques.abyss_eye!.mechanics!;
const raise = eye.find((m) => m.kind === 'raiseAllies')!;
if (raise.kind !== 'raiseAllies') throw new Error('no raiseAllies');

const SIM_HERO: ClassDef = {
  ...gameContent.classes.warrior!,
  id: 'sim_hero',
  baseStats: { ...gameContent.classes.warrior!.baseStats, life: 1e9 },
};
const target = (def: MobDef): MobDef => ({ ...def, id: `sim_target_${def.id}`, life: 1e9, moveSpeed: 0, attack: { ...def.attack, range: -1000 } });
const corpse: MobDef = { ...gameContent.mobs.zombie!, id: 'sim_corpse', life: 1, moveSpeed: 0, attack: { ...gameContent.mobs.zombie!.attack, range: -1000 } };
const content: Content = {
  ...gameContent,
  classes: { ...gameContent.classes, sim_hero: SIM_HERO },
  mobs: {
    ...gameContent.mobs,
    sim_corpse: corpse,
    sim_target_zombie: target(gameContent.mobs.zombie!),
    sim_target_shieldbearer: target(gameContent.mobs.shieldbearer!),
  },
};
const idle: PlayerInput = { move: vec(0, 0), aim: vec(0, 0), basicAttack: false, skills: [] };

function world(scale: MobScale): WorldState {
  return createWorld(content, 'sim_hero', SEED, { mechanics: eye }, 1, { bounds: { width: 2000, height: 2000 }, endless: false, start: vec(700, 1000), mobScale: scale });
}

/** Raises n skeletons around (x, y) by killing corpses there. */
function raiseAround(w: WorldState, n: number, x: number, y: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    spawnMob(w, content, { defId: 'sim_corpse' }, vec(x + Math.cos(a) * 40, y + Math.sin(a) * 40), []).life = 0;
  }
  step(w, idle, content, DT);
}

function allyDps(scale: MobScale, defId: string): number {
  const w = world(scale);
  spawnMob(w, content, { defId: `sim_target_${defId}` }, vec(1000, 1000), []);
  raiseAround(w, raise.max, 1000, 1000);
  let dealt = 0;
  for (let t = 0; t < raise.duration / DT; t++) {
    for (const e of step(w, idle, content, DT)) if (e.type === 'hit' && e.source === 'ally') dealt += e.amount;
  }
  return dealt / raise.duration;
}

function survival(scale: MobScale, zombies: number): number {
  const w = world(scale);
  raiseAround(w, 1, 1300, 1000);
  for (let i = 0; i < zombies; i++) {
    const a = (i / zombies) * Math.PI * 2;
    spawnMob(w, content, { defId: 'zombie' }, vec(1300 + Math.cos(a) * 30, 1000 + Math.sin(a) * 30), []);
  }
  for (let t = 0; t < raise.duration / DT; t++) {
    const events: WorldEvent[] = step(w, idle, content, DT);
    if (events.some((e) => e.type === 'allyExpire' && e.reason === 'killed')) return (t + 1) * DT;
  }
  return Infinity;
}

describe('Eye of the Abyss skeletons vs map growth', () => {
  it('prints DPS, survival and resource numbers', () => {
    const rows: string[] = ['| map | life × | dmg × | skeleton life | 6 skeletons DPS vs zombie | vs shieldbearer | survives 1 zombie, s | 3 zombies, s |', '|---|---|---|---|---|---|---|---|'];
    for (const map of MAPS) {
      const scale = mobLevelScaling(mapsData.rules, map);
      const life = gameContent.mobs.zombie!.life * raise.lifeMultiplier * scale.life;
      const fmt = (s: number): string => (Number.isFinite(s) ? s.toFixed(1) : `> ${raise.duration}`);
      rows.push(
        `| ${map} | ${scale.life.toFixed(1)} | ${scale.damage.toFixed(1)} | ${life.toFixed(0)} | ${allyDps(scale, 'zombie').toFixed(0)} | ${allyDps(scale, 'shieldbearer').toFixed(0)} | ${fmt(survival(scale, 1))} | ${fmt(survival(scale, 3))} |`,
      );
    }
    console.log(['', '## Eye of the Abyss: 6 skeletons', ...rows].join('\n'));
    const res = Object.values(gameContent.classes).map((c) => `${c.id}: +${(raise.resourcePerKill * (c.baseStats.resource ?? 0)).toFixed(1)} ${c.resource.id} per skeleton kill (base max ${c.baseStats.resource ?? 0})`);
    console.log(['', ...res].join('\n'));
  });
});

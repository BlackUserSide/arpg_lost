import { describe, expect, it } from 'vitest';
import { classStart, findPath, neighbors, passiveModifiers, validateAllocation } from '../core/passives/allocation';
import { respecCost } from '../core/passives/respec';
import { resolveActions, type ActionSet } from '../core/skills/params';
import type { ActionDef } from '../core/world/content';
import { skillChangeSets } from '../core/world/passiveEffects';
import type { PassiveHero, PassiveMechanic, PassiveNodeDef } from '../core/passives/types';
import { DAMAGE_TYPES, SKILL_TAGS, STAT_IDS, type Modifier } from '../core/stats/types';
import { content } from './index';
import { passiveTree as tree } from './passives';

const nodes = Object.values(tree.nodes);
const wheel = nodes.filter((n) => n.type !== 'start' && n.specId === undefined);
const starts = nodes.filter((n) => n.type === 'start');
const specNodes = nodes.filter((n) => n.specId !== undefined);
const CLASSES = ['warrior', 'ranger', 'mage'] as const;

const freshHero = (classId: string, level = 40): PassiveHero => ({ classId, level, passives: { nodes: [], spec: null, specNodes: [] } });

/** Ids reachable from `from` without entering nodes rejected by `pass`. */
function flood(from: string, pass: (n: PassiveNodeDef) => boolean): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    for (const next of neighbors(tree, queue.shift()!)) {
      if (!seen.has(next) && pass(tree.nodes[next]!)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('passive tree data', () => {
  it('ids are unique and match their keys', () => {
    for (const [key, node] of Object.entries(tree.nodes)) expect(node.id).toBe(key);
    for (const [key, spec] of Object.entries(tree.specs)) expect(spec.id).toBe(key);
    for (const n of nodes) expect(n.name.length, n.id).toBeGreaterThan(0);
  });

  it('wheel has 63 nodes (48 small, 9 notable, 6 keystones) costing 84, plus 3 starts', () => {
    expect(wheel).toHaveLength(63);
    expect(wheel.filter((n) => n.type === 'small')).toHaveLength(48);
    expect(wheel.filter((n) => n.type === 'notable')).toHaveLength(9);
    expect(wheel.filter((n) => n.type === 'keystone')).toHaveLength(6);
    for (const n of wheel) expect(n.cost).toBe({ small: 1, notable: 2, keystone: 3 }[n.type as string]);
    expect(wheel.reduce((s, n) => s + n.cost, 0)).toBe(84);
    expect(starts.map((s) => s.classId).sort()).toEqual([...CLASSES].sort());
    for (const s of starts) expect(s.cost).toBe(0);
  });

  it('has 6 spec branches of 7 nodes (1 entry, 1 keystone), 2 per class, each node 1 spec point', () => {
    expect(Object.keys(tree.specs)).toHaveLength(6);
    for (const cls of CLASSES) expect(Object.values(tree.specs).filter((s) => s.classId === cls)).toHaveLength(2);
    for (const spec of Object.values(tree.specs)) {
      const branch = specNodes.filter((n) => n.specId === spec.id);
      expect(branch).toHaveLength(7);
      expect(branch.filter((n) => n.type === 'specEntry')).toHaveLength(1);
      expect(branch.filter((n) => n.type === 'specKeystone')).toHaveLength(1);
      for (const n of branch) expect(n.cost).toBe(1);
    }
    expect(specNodes).toHaveLength(42);
    for (const n of specNodes) expect(tree.specs[n.specId!]).toBeDefined();
    expect(tree.points.specMilestones).toEqual([6, 14, 22, 30, 40]);
  });

  it('edges reference existing nodes, with no self-loops or duplicates', () => {
    const seen = new Set<string>();
    for (const [a, b] of tree.edges) {
      expect(tree.nodes[a], a).toBeDefined();
      expect(tree.nodes[b], b).toBeDefined();
      expect(a).not.toBe(b);
      const key = [a, b].sort().join('|');
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    for (const n of nodes) expect(neighbors(tree, n.id).length, n.id).toBeGreaterThan(0);
  });

  it('the whole graph is connected', () => {
    expect(flood(starts[0]!.id, () => true).size).toBe(nodes.length);
  });

  it('every wheel node is reachable from each start without crossing other starts', () => {
    for (const cls of CLASSES) {
      const start = classStart(tree, cls)!;
      const reached = flood(start, (n) => n.type !== 'start' && n.specId === undefined);
      for (const n of wheel) expect(reached.has(n.id), `${cls} -> ${n.id}`).toBe(true);
    }
  });

  it('keystones are dead ends; spec branches hang only off their own class start', () => {
    for (const k of wheel.filter((n) => n.type === 'keystone')) expect(neighbors(tree, k.id)).toHaveLength(1);
    for (const n of specNodes) {
      const spec = tree.specs[n.specId!]!;
      for (const next of neighbors(tree, n.id)) {
        const other = tree.nodes[next]!;
        if (other.type === 'start') {
          expect(n.type).toBe('specEntry');
          expect(other.classId).toBe(spec.classId);
        } else {
          expect(other.specId).toBe(n.specId);
        }
      }
      if (n.type === 'specKeystone') expect(neighbors(tree, n.id).map((id) => tree.nodes[id]!.type)).toContain('specEntry');
    }
  });

  it('the six central keystones sit 60° apart at one radius, each a dead end off the inner node at its angle', () => {
    const keystones = wheel.filter((n) => n.type === 'keystone');
    expect(keystones.map((k) => k.pos.angleDeg).sort((a, b) => a - b)).toEqual([30, 90, 150, 210, 270, 330]);
    expect(new Set(keystones.map((k) => k.pos.radius))).toEqual(new Set([75]));
    for (const k of keystones) {
      const [inner] = neighbors(tree, k.id);
      expect(inner, k.id).toMatch(/^i_/);
      expect(tree.nodes[inner!]!.pos.angleDeg, k.id).toBe(k.pos.angleDeg);
    }
    expect(neighbors(tree, 'k_leech')).toEqual(['i_w']);
    expect(neighbors(tree, 'k_glass')).toEqual(['i_m']);
  });

  it('Bloodsucker and Glass Cannon data (PROPOSAL numbers)', () => {
    expect(tree.nodes.k_leech).toMatchObject({
      name: 'Кровопивець',
      cost: 3,
      modifiers: [{ stat: 'lifeRegen', kind: 'more', value: -1 }],
      mechanics: [
        { kind: 'lifeLeech', fraction: 0.05, maxPerSecond: 0.2 },
        { kind: 'lifePotionEffectiveness', multiplier: 0.5 },
      ],
    });
    expect(tree.nodes.k_glass).toMatchObject({
      name: 'Скляна гармата',
      cost: 3,
      modifiers: [
        { stat: 'damage', kind: 'more', value: 0.4 },
        { stat: 'damageTaken', kind: 'more', value: 0.4 },
      ],
    });
    expect(tree.nodes.k_glass!.mechanics).toBeUndefined();
  });

  it('Blood Magic and Crystal Shell are mutually exclusive', () => {
    expect(tree.nodes.k_blood!.exclusiveGroup).toBeDefined();
    expect(tree.nodes.k_blood!.exclusiveGroup).toBe(tree.nodes.k_crystal!.exclusiveGroup);
    expect(nodes.filter((n) => n.exclusiveGroup !== undefined).map((n) => n.id)).toEqual(['k_blood', 'k_crystal']);
  });

  it('modifiers and mechanics use the core vocabulary and existing skills', () => {
    const tags = new Set<string>([...DAMAGE_TYPES, ...SKILL_TAGS]);
    const skillIds = new Set(Object.values(content.classes).flatMap((c) => [c.basicAttack.id, ...c.skills.map((s) => s.id)]));
    const checkMods = (mods: readonly Modifier[]): void => {
      for (const m of mods) {
        expect(STAT_IDS).toContain(m.stat);
        for (const t of m.tags ?? []) expect(tags.has(t), t).toBe(true);
      }
    };
    const checkMechanic = (m: PassiveMechanic): void => {
      if (m.kind === 'conditionalModifiers') checkMods(m.modifiers);
      if (m.kind === 'skillParams') {
        for (const id of m.skillIds ?? []) expect(skillIds.has(id), id).toBe(true);
        checkMods(m.buffModifiers ?? []);
      }
      if (m.kind === 'freezeSlowed') for (const id of m.skillIds) expect(skillIds.has(id), id).toBe(true);
    };
    for (const n of nodes) {
      checkMods(n.modifiers ?? []);
      for (const m of n.mechanics ?? []) checkMechanic(m);
      if (n.type === 'small' || n.type === 'notable') {
        expect(n.modifiers?.length, n.id).toBeGreaterThan(0);
        expect(n.mechanics, n.id).toBeUndefined();
      }
      if (n.type === 'keystone' || n.type === 'specKeystone') expect((n.mechanics?.length ?? 0) + (n.modifiers?.length ?? 0), n.id).toBeGreaterThan(0);
    }
  });

  it('small nodes give the standard values from the design doc', () => {
    const mods = (id: string): Modifier[] => passiveModifiers(tree, { nodes: [id], spec: null, specNodes: [] });
    expect(mods('w_a1')).toEqual([{ stat: 'damage', kind: 'increased', value: 0.08, tags: ['melee'] }]);
    expect(mods('i_w')).toEqual([{ stat: 'damage', kind: 'increased', value: 0.05 }]);
    expect(mods('r_c2')).toEqual([
      { stat: 'fireResistance', kind: 'flat', value: 0.05 },
      { stat: 'coldResistance', kind: 'flat', value: 0.05 },
      { stat: 'lightningResistance', kind: 'flat', value: 0.05 },
    ]);
    expect(mods('m_n2')).toEqual([
      { stat: 'energyShield', kind: 'increased', value: 0.16 },
      { stat: 'energyShieldRegen', kind: 'flat', value: 2 },
      { stat: 'manaRegen', kind: 'flat', value: 1.5 },
    ]);
  });

  it('cheapest paths match the design table', () => {
    const cost = (cls: string, target: string): number => findPath(tree, freshHero(cls), target)!.cost;
    const table: Record<string, Record<string, number>> = {
      warrior: { k_blood: 8, k_precise: 8, k_crystal: 10, k_swift: 9, k_leech: 7, k_glass: 9, w_n2: 4, w_n1: 5, mw_n: 8, wr_n: 8 },
      ranger: { k_blood: 10, k_precise: 8, k_crystal: 8, k_swift: 7, k_leech: 9, k_glass: 9, r_n2: 4, r_n1: 5, wr_n: 8, rm_n: 8 },
      mage: { k_blood: 8, k_precise: 10, k_crystal: 8, k_swift: 9, k_leech: 9, k_glass: 7, m_n2: 4, m_n1: 5, rm_n: 8, mw_n: 8 },
    };
    for (const [cls, targets] of Object.entries(table)) {
      for (const [target, expected] of Object.entries(targets)) expect(cost(cls, target), `${cls} -> ${target}`).toBe(expected);
    }
    expect(findPath(tree, freshHero('warrior'), 'k_blood')!.nodes).toEqual(['w_a1', 'w_a2', 'w_a3', 'i_w', 'i_mw', 'k_blood']);
    // Spec keystone needs the entry (2 spec points: level 14).
    expect(findPath(tree, freshHero('warrior'), 'bz_key')).toEqual({ nodes: ['bz_entry', 'bz_key'], cost: 2 });
    expect(findPath(tree, freshHero('ranger'), 'bz_key')).toBeNull();
  });

  it('the documented warrior build (own zone, both hybrids, inner ring, 2 keystones) is valid at 39 points', () => {
    const ids = [
      ...wheel.filter((n) => /^(w_|mw_|wr_|i_)/.test(n.id)).map((n) => n.id),
      'k_blood',
      'k_precise',
    ];
    // Order nodes so each is connected when added (BFS from the start through the chosen set).
    const chosen = new Set(ids);
    const ordered = [...flood(classStart(tree, 'warrior')!, (n) => chosen.has(n.id))].filter((id) => chosen.has(id));
    const hero: PassiveHero = { classId: 'warrior', level: 40, passives: { nodes: ordered, spec: null, specNodes: [] } };
    expect(ordered).toHaveLength(31);
    expect(validateAllocation(tree, hero)).toBeNull();
    expect(validateAllocation(tree, { ...hero, passives: { ...hero.passives, nodes: [...ordered, 'k_crystal'] } })).toBe('exclusive');
  });

  it('respec costs match the design table', () => {
    expect(tree.respec.currency).toBe('shards');
    expect(respecCost(tree, 9, 'node') + respecCost(tree, 9, 'wheel') + respecCost(tree, 9, 'spec')).toBe(0);
    expect([20, 40].map((l) => respecCost(tree, l, 'node'))).toEqual([3, 5]);
    expect([20, 40].map((l) => respecCost(tree, l, 'wheel'))).toEqual([20, 40]);
    expect([20, 40].map((l) => respecCost(tree, l, 'spec'))).toEqual([30, 60]);
    expect(respecCost(tree, 10, 'node')).toBe(2);
  });
});

describe('spec skill-parameter nodes resolve to the design doc numbers', () => {
  const resolveFor = (classId: string, nodeIds: readonly string[]): ActionSet => {
    const mechanics = nodeIds.flatMap((id) => tree.nodes[id]!.mechanics ?? []);
    return resolveActions(content.classes[classId]!, skillChangeSets(mechanics));
  };
  const skill = (set: ActionSet, id: string): ActionDef => [set.basicAttack, ...set.skills].find((a) => a.id === id)!;

  it('warrior: Bloody Cry 6 → 9 s (+20% attack speed), Shield Ready cooldown 4 → 3 s', () => {
    const set = resolveFor('warrior', ['bz_b2', 'gd_c1']);
    const buff = skill(set, 'battle_cry').selfEffects?.find((e) => e.kind === 'buff');
    expect(buff).toMatchObject({ duration: 9 });
    expect(buff?.kind === 'buff' ? buff.modifiers : []).toContainEqual({ stat: 'attackSpeed', kind: 'increased', value: 0.2 });
    expect(skill(set, 'shield_charge').cooldown).toBe(3);
  });

  it('ranger: pierce +1, range +25% (bolt 620 → 775), arm 0.5 → 0.25 s, explosion 110 → 137.5, roll 3 → 2.5 s', () => {
    const set = resolveFor('ranger', ['sn_a1', 'sn_b2', 'tr_a1', 'tr_a2', 'tr_c1']);
    expect(skill(set, 'ranger_bolt').delivery).toMatchObject({ pierce: 1, range: 775, speed: 900 });
    expect(skill(set, 'volley').delivery).toMatchObject({ pierce: 1, range: 650 });
    expect(skill(set, 'explosive_trap').delivery).toMatchObject({ armTime: 0.25, triggerRadius: 50, explodeRadius: 137.5 });
    expect(skill(set, 'roll').cooldown).toBe(2.5);
  });

  it('mage: Inferno fireball explosion 80 → 96; Blizzard nova 150 → 180, 3 → 2.5 s; Icy Grip slow 2.5 → 3.5 s; Cold Blood slows', () => {
    const set = resolveFor('mage', ['py_a2', 'cr_entry', 'cr_a2', 'cr_b2']);
    expect(skill(set, 'fireball').delivery).toMatchObject({ explodeRadius: 96 });
    const nova = skill(set, 'frost_nova');
    expect(nova.delivery).toMatchObject({ radius: 180 });
    expect(nova.cooldown).toBe(2.5);
    expect(nova.onHit?.[0]?.duration).toBeCloseTo(3.5, 9);
    expect(skill(set, 'wand_bolt').onHit).toEqual([{ status: 'slow', duration: 2, magnitude: 0.2 }]);
  });
});

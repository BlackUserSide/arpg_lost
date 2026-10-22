import { describe, expect, it } from 'vitest';
import type { ItemsData } from '../items/types';
import { heroMechanics, heroModifiers } from '../progression/hero';
import {
  allocatableNodes,
  allocate,
  allocatePath,
  canAllocate,
  canDeallocate,
  classSpecs,
  classStart,
  createAllocation,
  deallocate,
  findPath,
  neighbors,
  passiveMechanics,
  passiveModifiers,
  resetSpec,
  resetWheel,
  spentPoints,
  totalPoints,
  totalSpecPoints,
  nextSpecMilestone,
  unspentPoints,
  validateAllocation,
} from './allocation';
import { changeSpec, refundNode, refundWheel, respecCost } from './respec';
import type { PassiveHero, PassiveMechanic, PassiveNodeDef, PassiveTreeData } from './types';

/*
 Test tree:
                 k1   k2          (keystones, exclusive group "g")
                   \ /
   sa_k - sa_e - [A] - n1 - n2 - n3 - [B] - x1 - x2
          sb_e -/      |                \
                       n4 - n5          sc_e
*/
const pos = { angleDeg: 0, radius: 0 };
const n = (id: string, type: PassiveNodeDef['type'], cost: number, extra: Partial<PassiveNodeDef> = {}): PassiveNodeDef => ({ id, name: id, type, cost, pos, ...extra });

const tree: PassiveTreeData = {
  nodes: Object.fromEntries(
    [
      n('A', 'start', 0, { classId: 'a' }),
      n('B', 'start', 0, { classId: 'b' }),
      n('n1', 'small', 1, { modifiers: [{ stat: 'life', kind: 'increased', value: 0.1 }] }),
      n('n2', 'notable', 2, { modifiers: [{ stat: 'damage', kind: 'increased', value: 0.2, tags: ['fire'] }] }),
      n('n3', 'small', 1),
      n('n4', 'small', 1),
      n('n5', 'small', 1, { modifiers: [{ stat: 'mana', kind: 'flat', value: 10 }] }),
      n('x1', 'small', 1),
      n('x2', 'small', 1),
      n('k1', 'keystone', 3, { exclusiveGroup: 'g', mechanics: [{ kind: 'bloodMagic', lifePerMana: 1 }] }),
      n('k2', 'keystone', 3, { exclusiveGroup: 'g' }),
      n('sa_e', 'specEntry', 1, { specId: 'sa', modifiers: [{ stat: 'armour', kind: 'flat', value: 5 }] }),
      n('sa_k', 'specKeystone', 1, { specId: 'sa', mechanics: [{ kind: 'deathExplosionRadius', increased: 0.5 }] }),
      n('sb_e', 'specEntry', 1, { specId: 'sb' }),
      n('sc_e', 'specEntry', 1, { specId: 'sc' }),
    ].map((node) => [node.id, node]),
  ),
  edges: [
    ['A', 'n1'],
    ['n1', 'n2'],
    ['n2', 'n3'],
    ['n3', 'B'],
    ['B', 'x1'],
    ['x1', 'x2'],
    ['n1', 'n4'],
    ['n4', 'n5'],
    ['n1', 'k1'],
    ['n1', 'k2'],
    ['A', 'sa_e'],
    ['sa_e', 'sa_k'],
    ['A', 'sb_e'],
    ['B', 'sc_e'],
  ],
  specs: {
    sa: { id: 'sa', name: 'SA', classId: 'a' },
    sb: { id: 'sb', name: 'SB', classId: 'a' },
    sc: { id: 'sc', name: 'SC', classId: 'b' },
  },
  points: { perLevel: 1, specMilestones: [3, 5] },
  respec: {
    currency: 'shards',
    freeBelowLevel: 4,
    node: { base: 1, perLevel: 0.1 },
    wheel: { base: 0, perLevel: 1 },
    spec: { base: 0, perLevel: 1.5 },
  },
};

const hero = (level: number, classId = 'a', nodes: string[] = [], specNodes: string[] = [], spec: string | null = null): PassiveHero => ({
  classId,
  level,
  passives: { nodes, spec, specNodes },
});

describe('passive graph and points', () => {
  it('builds symmetric adjacency from the edge list', () => {
    expect(neighbors(tree, 'n1')).toEqual(['A', 'n2', 'n4', 'k1', 'k2']);
    expect(neighbors(tree, 'n4')).toEqual(['n1', 'n5']);
    expect(neighbors(tree, 'nope')).toEqual([]);
  });

  it('finds class starts and specs', () => {
    expect(classStart(tree, 'a')).toBe('A');
    expect(classStart(tree, 'b')).toBe('B');
    expect(classStart(tree, 'c')).toBeUndefined();
    expect(classSpecs(tree, 'a')).toEqual(['sa', 'sb']);
  });

  it('gives one point per level above 1 and spec points at milestones', () => {
    expect([1, 2, 5, 40].map((l) => totalPoints(tree, l))).toEqual([0, 1, 4, 39]);
    expect([1, 2, 3, 4, 5, 40].map((l) => totalSpecPoints(tree, l))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('finds the next spec milestone above the level', () => {
    expect([1, 3, 4, 5].map((l) => nextSpecMilestone(tree, l))).toEqual([3, 5, 5, undefined]);
  });

  it('counts spent and unspent points separately for wheel and spec', () => {
    const h = hero(5, 'a', ['n1', 'n2'], ['sa_e'], 'sa');
    expect(spentPoints(tree, h.passives)).toBe(3);
    expect(unspentPoints(tree, h)).toEqual({ points: 1, specPoints: 1 });
  });
});

describe('allocating', () => {
  it('rejects unknown, start and already allocated nodes', () => {
    const h = hero(10, 'a', ['n1']);
    expect(canAllocate(tree, h, 'zzz')).toBe('unknown-node');
    expect(canAllocate(tree, h, 'A')).toBe('start-node');
    expect(canAllocate(tree, h, 'n1')).toBe('already-allocated');
  });

  it('requires a connection to the class start or an allocated node', () => {
    const h = hero(10);
    expect(canAllocate(tree, h, 'n2')).toBe('not-connected');
    expect(allocate(tree, h, 'n1')).toBeNull();
    expect(allocate(tree, h, 'n2')).toBeNull();
    expect(h.passives.nodes).toEqual(['n1', 'n2']);
  });

  it('requires enough points for the node cost', () => {
    const h = hero(1);
    expect(canAllocate(tree, h, 'n1')).toBe('no-points');
    h.passives.nodes.push('n1');
    const h2 = { ...h, level: 3 }; // 2 points, 1 spent, notable costs 2
    expect(canAllocate(tree, h2, 'n2')).toBe('no-points');
    expect(canAllocate(tree, { ...h, level: 4 }, 'n2')).toBeNull();
  });

  it("cannot path through another class's start", () => {
    // Class a reaches n3 (next to B) but not x1 behind B.
    const a = hero(20, 'a', ['n1', 'n2', 'n3']);
    expect(canAllocate(tree, a, 'x1')).toBe('not-connected');
    expect(findPath(tree, a, 'x1')).toBeNull();
    // Class b starts there.
    expect(canAllocate(tree, hero(20, 'b'), 'x1')).toBeNull();
  });

  it('enforces exclusive groups', () => {
    const h = hero(20, 'a', ['n1', 'k1']);
    expect(canAllocate(tree, h, 'k2')).toBe('exclusive');
    expect(findPath(tree, h, 'k2')).toBeNull();
  });

  it('lists allocatable nodes in tree order', () => {
    expect(allocatableNodes(tree, hero(3))).toEqual(['n1', 'sa_e', 'sb_e']);
    expect(allocatableNodes(tree, hero(2))).toEqual(['n1']);
  });
});

describe('specializations', () => {
  it('spec nodes need spec points, not passive points', () => {
    expect(canAllocate(tree, hero(2), 'sa_e')).toBe('no-spec-points');
    const h = hero(3);
    expect(allocate(tree, h, 'sa_e')).toBeNull();
    expect(h.passives).toEqual({ nodes: [], spec: 'sa', specNodes: ['sa_e'] });
    expect(unspentPoints(tree, h)).toEqual({ points: 2, specPoints: 0 });
    expect(canAllocate(tree, h, 'sa_k')).toBe('no-spec-points');
    expect(allocate(tree, { ...h, level: 5 }, 'sa_k')).toBeNull();
  });

  it('the first spec node locks the other branch of the class', () => {
    const h = hero(5, 'a', [], ['sa_e'], 'sa');
    expect(canAllocate(tree, h, 'sb_e')).toBe('other-spec');
  });

  it("other classes' branches are always locked", () => {
    expect(canAllocate(tree, hero(5, 'a'), 'sc_e')).toBe('other-class-spec');
    expect(canAllocate(tree, hero(5, 'b'), 'sc_e')).toBeNull();
  });

  it('spec keystone requires the entry node', () => {
    expect(canAllocate(tree, hero(5), 'sa_k')).toBe('not-connected');
    expect(findPath(tree, hero(5), 'sa_k')).toEqual({ nodes: ['sa_e', 'sa_k'], cost: 2 });
  });

  it('resetSpec clears the choice; resetWheel keeps spec nodes', () => {
    const h = hero(5, 'a', ['n1'], ['sa_e'], 'sa');
    resetWheel(h.passives);
    expect(h.passives).toEqual({ nodes: [], spec: 'sa', specNodes: ['sa_e'] });
    resetSpec(h.passives);
    expect(h.passives).toEqual({ nodes: [], spec: null, specNodes: [] });
    expect(canAllocate(tree, h, 'sb_e')).toBeNull();
  });
});

describe('deallocating', () => {
  it('only removes nodes whose removal keeps the tree connected', () => {
    const h = hero(10, 'a', ['n1', 'n4', 'n5', 'n2']);
    expect(canDeallocate(tree, h, 'n1')).toBe('disconnects');
    expect(canDeallocate(tree, h, 'n4')).toBe('disconnects');
    expect(canDeallocate(tree, h, 'n3')).toBe('not-allocated');
    expect(canDeallocate(tree, h, 'zzz')).toBe('unknown-node');
    expect(deallocate(tree, h, 'n5')).toBeNull();
    expect(deallocate(tree, h, 'n4')).toBeNull();
    expect(h.passives.nodes).toEqual(['n1', 'n2']);
  });

  it('keeps the spec choice when the last spec node is removed', () => {
    const h = hero(5, 'a', [], ['sa_e'], 'sa');
    expect(deallocate(tree, h, 'sa_e')).toBeNull();
    expect(h.passives).toEqual({ nodes: [], spec: 'sa', specNodes: [] });
    expect(canAllocate(tree, h, 'sb_e')).toBe('other-spec');
  });
});

describe('paths', () => {
  it('finds the cheapest path of unallocated nodes, ending at the target', () => {
    expect(findPath(tree, hero(10), 'n5')).toEqual({ nodes: ['n1', 'n4', 'n5'], cost: 3 });
    expect(findPath(tree, hero(10, 'a', ['n1']), 'n3')).toEqual({ nodes: ['n2', 'n3'], cost: 3 });
    expect(findPath(tree, hero(10, 'a', ['n1']), 'n1')).toBeNull();
    expect(findPath(tree, hero(10), 'A')).toBeNull();
  });

  it('allocatePath is all or nothing', () => {
    const poor = hero(3);
    expect(allocatePath(tree, poor, 'n5')).toBe('no-points');
    expect(poor.passives.nodes).toEqual([]);
    const rich = hero(4);
    expect(allocatePath(tree, rich, 'n5')).toBeNull();
    expect(rich.passives.nodes).toEqual(['n1', 'n4', 'n5']);
    expect(allocatePath(tree, hero(20), 'x1')).toBe('not-connected');
    expect(allocatePath(tree, hero(5), 'sa_k')).toBeNull();
    expect(allocatePath(tree, hero(3), 'sa_k')).toBe('no-spec-points');
  });

  it('allocatePath leaves the allocation untouched when a later step fails (exclusive pair on one path)', () => {
    // A - p1 - p2 - p3, where p1 and p3 share an exclusive group.
    const chain: PassiveTreeData = {
      ...tree,
      nodes: {
        A: n('A', 'start', 0, { classId: 'a' }),
        p1: n('p1', 'small', 1, { exclusiveGroup: 'x' }),
        p2: n('p2', 'small', 1),
        p3: n('p3', 'small', 1, { exclusiveGroup: 'x' }),
      },
      edges: [
        ['A', 'p1'],
        ['p1', 'p2'],
        ['p2', 'p3'],
      ],
      specs: {},
    };
    const h = hero(10);
    expect(findPath(chain, h, 'p3')).toEqual({ nodes: ['p1', 'p2', 'p3'], cost: 3 });
    expect(allocatePath(chain, h, 'p3')).toBe('exclusive');
    expect(h.passives).toEqual({ nodes: [], spec: null, specNodes: [] });
    expect(allocatePath(chain, h, 'p2')).toBeNull();
    expect(h.passives.nodes).toEqual(['p1', 'p2']);
  });
});

describe('validation', () => {
  it('accepts a consistent allocation', () => {
    expect(validateAllocation(tree, hero(10, 'a', ['n1', 'n4', 'k1'], ['sa_e'], 'sa'))).toBeNull();
    expect(validateAllocation(tree, hero(1))).toBeNull();
  });

  it('reports the first problem', () => {
    expect(validateAllocation(tree, hero(10, 'zz'))).toBe('unknown-class');
    expect(validateAllocation(tree, hero(10, 'a', ['n1', 'n1']))).toBe('duplicate');
    expect(validateAllocation(tree, hero(10, 'a', ['qq']))).toBe('unknown-node');
    expect(validateAllocation(tree, hero(10, 'a', ['B']))).toBe('start-node');
    expect(validateAllocation(tree, hero(10, 'a', ['sa_e']))).toBe('wrong-layer');
    expect(validateAllocation(tree, hero(10, 'a', [], ['n1'], 'sa'))).toBe('wrong-layer');
    expect(validateAllocation(tree, hero(10, 'a', [], ['sb_e'], 'sa'))).toBe('other-spec');
    expect(validateAllocation(tree, hero(10, 'a', [], ['sc_e'], 'sc'))).toBe('other-class-spec');
    expect(validateAllocation(tree, hero(10, 'a', ['n1', 'k1', 'k2']))).toBe('exclusive');
    expect(validateAllocation(tree, hero(2, 'a', ['n1', 'n2']))).toBe('no-points');
    expect(validateAllocation(tree, hero(3, 'a', [], ['sa_e', 'sa_k'], 'sa'))).toBe('no-spec-points');
    expect(validateAllocation(tree, hero(10, 'a', ['n2']))).toBe('not-connected');
    expect(validateAllocation(tree, hero(20, 'a', ['n1', 'n2', 'n3', 'x1']))).toBe('not-connected');
  });
});

describe('modifiers and mechanics', () => {
  it('collects modifiers of allocated wheel and spec nodes', () => {
    const alloc = { nodes: ['n1', 'n2', 'n5'], spec: 'sa', specNodes: ['sa_e', 'sa_k'] };
    expect(passiveModifiers(tree, alloc)).toEqual([
      { stat: 'life', kind: 'increased', value: 0.1 },
      { stat: 'damage', kind: 'increased', value: 0.2, tags: ['fire'] },
      { stat: 'mana', kind: 'flat', value: 10 },
      { stat: 'armour', kind: 'flat', value: 5 },
    ]);
    expect(passiveMechanics(tree, alloc)).toEqual([{ kind: 'deathExplosionRadius', increased: 0.5 }]);
    expect(passiveModifiers(tree, createAllocation())).toEqual([]);
  });

  it('heroModifiers merges equipment and passives', () => {
    const items = { bases: {}, affixes: [], rules: {} } as unknown as ItemsData;
    expect(heroModifiers({ equipment: {}, passives: { nodes: ['n1'], spec: null, specNodes: [] } }, items, tree)).toEqual([{ stat: 'life', kind: 'increased', value: 0.1 }]);
  });

  it('heroMechanics returns the mechanics of allocated nodes', () => {
    expect(heroMechanics({ passives: { nodes: ['n1', 'k1'], spec: 'sa', specNodes: ['sa_e', 'sa_k'] } }, tree)).toEqual([
      { kind: 'bloodMagic', lifePerMana: 1 },
      { kind: 'deathExplosionRadius', increased: 0.5 },
    ]);
  });
});

describe('respec', () => {
  it('is free below the threshold level, then floor(base + level × perLevel)', () => {
    expect(respecCost(tree, 3, 'node')).toBe(0);
    expect(respecCost(tree, 3, 'spec')).toBe(0);
    expect([4, 9, 10, 20, 29, 30, 40].map((l) => respecCost(tree, l, 'node'))).toEqual([1, 1, 2, 3, 3, 4, 5]);
    expect([4, 20, 40].map((l) => respecCost(tree, l, 'wheel'))).toEqual([4, 20, 40]);
    expect([4, 20, 21, 40].map((l) => respecCost(tree, l, 'spec'))).toEqual([6, 30, 31, 60]);
  });

  it('refundNode charges the wallet only on success', () => {
    const h = hero(20, 'a', ['n1', 'n4', 'n5']);
    const wallet: Record<string, number> = { shards: 2 };
    expect(refundNode(tree, h, 'n5', wallet)).toBe('currency');
    expect(wallet.shards).toBe(2);
    expect(h.passives.nodes).toEqual(['n1', 'n4', 'n5']);
    wallet.shards = 5;
    expect(refundNode(tree, h, 'n4', wallet)).toBe('disconnects');
    expect(wallet.shards).toBe(5);
    expect(refundNode(tree, h, 'n5', wallet)).toBeNull();
    expect(wallet.shards).toBe(2);
    expect(h.passives.nodes).toEqual(['n1', 'n4']);
  });

  it('is free with an empty wallet below the threshold', () => {
    const h = hero(3, 'a', ['n1'], ['sa_e'], 'sa');
    const wallet: Record<string, number> = {};
    expect(refundNode(tree, h, 'n1', wallet)).toBeNull();
    expect(changeSpec(tree, h, wallet)).toBeNull();
    expect(wallet).toEqual({});
    expect(h.passives).toEqual({ nodes: [], spec: null, specNodes: [] });
  });

  it('refundWheel clears wheel nodes for level × 1', () => {
    const h = hero(20, 'a', ['n1', 'n2'], ['sa_e'], 'sa');
    const wallet: Record<string, number> = { shards: 25 };
    expect(refundWheel(tree, h, wallet)).toBeNull();
    expect(wallet.shards).toBe(5);
    expect(h.passives).toEqual({ nodes: [], spec: 'sa', specNodes: ['sa_e'] });
    expect(refundWheel(tree, h, wallet)).toBe('nothing-to-reset');
  });

  it('changeSpec costs level × 1.5 and frees the other branch', () => {
    const h = hero(20, 'a', ['n1'], ['sa_e'], 'sa');
    const wallet: Record<string, number> = { shards: 29 };
    expect(changeSpec(tree, h, wallet)).toBe('currency');
    expect(h.passives.spec).toBe('sa');
    wallet.shards = 30;
    expect(changeSpec(tree, h, wallet)).toBeNull();
    expect(wallet.shards).toBe(0);
    expect(h.passives).toEqual({ nodes: ['n1'], spec: null, specNodes: [] });
    expect(changeSpec(tree, h, wallet)).toBe('nothing-to-reset');
    expect(allocate(tree, h, 'sb_e')).toBeNull();
  });

  it('changeSpec is free when the spec has no nodes left', () => {
    const h = hero(20, 'a', [], [], 'sa');
    const wallet: Record<string, number> = {};
    expect(changeSpec(tree, h, wallet)).toBeNull();
    expect(wallet).toEqual({});
    expect(h.passives.spec).toBeNull();
  });
});

describe('pending mechanics', () => {
  it('flags nodes whose mechanics are not implemented yet', async () => {
    const { hasPendingMechanics } = await import('./mechanics');
    const node = (mechanics: PassiveMechanic[]): PassiveNodeDef => ({ id: 'k', name: 'k', type: 'keystone', cost: 3, pos: { angleDeg: 0, radius: 0 }, mechanics });
    expect(hasPendingMechanics({ id: 'x', name: 'x', type: 'small', cost: 1, pos: { angleDeg: 0, radius: 0 } })).toBe(false);
    expect(hasPendingMechanics(node([{ kind: 'trapAura', radius: 100, slow: 0.3 }]))).toBe(true);
    expect(hasPendingMechanics(node([{ kind: 'alwaysCrit', critMultiplier: 1.3 }, { kind: 'trapAura', radius: 100, slow: 0.3 }]))).toBe(true);
  });

  it('the wheel keystone mechanics are implemented', async () => {
    const { isMechanicPending } = await import('./mechanics');
    const implemented: PassiveMechanic[] = [
      { kind: 'lifeLeech', fraction: 0.05, maxPerSecond: 0.2 },
      { kind: 'lifePotionEffectiveness', multiplier: 0.5 },
      { kind: 'bloodMagic', lifePerMana: 1 },
      { kind: 'alwaysCrit', critMultiplier: 1.3 },
      { kind: 'lifeToEnergyShield', maxLife: 1, lifeRegenToShield: true },
      { kind: 'conditionalModifiers', condition: { kind: 'movedWithin', seconds: 0.5 }, modifiers: [] },
      { kind: 'conditionalModifiers', condition: { kind: 'stationaryFor', seconds: 0.5 }, modifiers: [] },
      { kind: 'conditionalModifiers', condition: { kind: 'lifeBelow', fraction: 0.5 }, modifiers: [] },
      { kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'stun' }, modifiers: [] },
      { kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'slow' }, modifiers: [] },
      { kind: 'moreDamagePerMissingLife', perMissingLife: 0.6, max: 0.45 },
      { kind: 'stunBonus', fillIncreased: 0.3, durationIncreased: 0.3 },
      { kind: 'skillParams', skillIds: ['roll'], changes: [{ param: 'cooldown', add: -0.5 }] },
      { kind: 'skillParams', skillIds: ['wand_bolt'], addOnHit: [{ status: 'slow', duration: 2, magnitude: 0.2 }] },
    ];
    expect(implemented.filter(isMechanicPending)).toEqual([]);
  });

  it('pyromancer / cryomancer mechanics and ignite / freeze statuses are implemented', async () => {
    const { isMechanicPending } = await import('./mechanics');
    const implemented: PassiveMechanic[] = [
      { kind: 'ignite', damageType: 'fire', chance: 0.3, damageFraction: 0.5, duration: 3 },
      { kind: 'deathExplosion', status: 'ignite', radius: 100, lifeFraction: 0.3, damageType: 'fire', applyStatus: 'ignite' },
      { kind: 'deathExplosionRadius', increased: 0.2 },
      { kind: 'freezeSlowed', skillIds: ['frost_nova'], duration: 1, bossDuration: 0.3 },
      { kind: 'skillParams', addOnHit: [{ status: 'ignite', duration: 3 }] },
      { kind: 'skillParams', addOnHit: [{ status: 'slow', duration: 1 }, { status: 'freeze', duration: 1 }] },
      { kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'freeze' }, modifiers: [] },
      { kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'ignite' }, modifiers: [] },
    ];
    expect(implemented.filter(isMechanicPending)).toEqual([]);
  });
});

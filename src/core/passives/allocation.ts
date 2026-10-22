// Passive tree allocation rules (docs/design/passives.md). Pure functions over plain data;
// mutating helpers change only the hero's PassiveAllocation.

import type { Modifier } from '../stats/types';
import type { PassiveAllocation, PassiveHero, PassiveMechanic, PassiveNodeDef, PassiveTreeData } from './types';

export type AllocateError =
  | 'unknown-node'
  | 'start-node'
  | 'already-allocated'
  /** Spec branch of another class. */
  | 'other-class-spec'
  /** The other spec branch of the hero's class while a spec is chosen. */
  | 'other-spec'
  /** Another node of the same exclusive group is allocated. */
  | 'exclusive'
  | 'not-connected'
  | 'no-points'
  | 'no-spec-points';

export type DeallocateError = 'unknown-node' | 'not-allocated' | 'disconnects';

export type AllocationProblem = AllocateError | 'duplicate' | 'wrong-layer' | 'unknown-class';

const graphs = new WeakMap<PassiveTreeData, ReadonlyMap<string, readonly string[]>>();

/** Adjacency lists built from the undirected edge list (cached per tree object). */
export function passiveGraph(tree: PassiveTreeData): ReadonlyMap<string, readonly string[]> {
  const cached = graphs.get(tree);
  if (cached) return cached;
  const graph = new Map<string, string[]>();
  for (const id of Object.keys(tree.nodes)) graph.set(id, []);
  for (const [a, b] of tree.edges) {
    graph.get(a)?.push(b);
    graph.get(b)?.push(a);
  }
  graphs.set(tree, graph);
  return graph;
}

export function neighbors(tree: PassiveTreeData, id: string): readonly string[] {
  return passiveGraph(tree).get(id) ?? [];
}

export function createAllocation(): PassiveAllocation {
  return { nodes: [], spec: null, specNodes: [] };
}

export function cloneAllocation(alloc: PassiveAllocation): PassiveAllocation {
  return { nodes: [...alloc.nodes], spec: alloc.spec, specNodes: [...alloc.specNodes] };
}

/** Id of the class's start node. */
export function classStart(tree: PassiveTreeData, classId: string): string | undefined {
  return Object.values(tree.nodes).find((n) => n.type === 'start' && n.classId === classId)?.id;
}

export function isSpecNode(node: PassiveNodeDef): boolean {
  return node.specId !== undefined;
}

/** Spec branches the class can choose from. */
export function classSpecs(tree: PassiveTreeData, classId: string): string[] {
  return Object.values(tree.specs)
    .filter((s) => s.classId === classId)
    .map((s) => s.id);
}

export function isAllocated(alloc: PassiveAllocation, id: string): boolean {
  return alloc.nodes.includes(id) || alloc.specNodes.includes(id);
}

/** Passive points earned by this level (one per level above 1 with the default data). */
export function totalPoints(tree: PassiveTreeData, level: number): number {
  return Math.max(0, level - 1) * tree.points.perLevel;
}

/** Spec points earned by this level (one per milestone reached). */
export function totalSpecPoints(tree: PassiveTreeData, level: number): number {
  return tree.points.specMilestones.filter((m) => m <= level).length;
}

/** The next hero level that grants a spec point, or undefined after the last milestone. */
export function nextSpecMilestone(tree: PassiveTreeData, level: number): number | undefined {
  return tree.points.specMilestones.filter((m) => m > level).sort((a, b) => a - b)[0];
}

function costOf(tree: PassiveTreeData, ids: readonly string[]): number {
  return ids.reduce((sum, id) => sum + (tree.nodes[id]?.cost ?? 0), 0);
}

export function spentPoints(tree: PassiveTreeData, alloc: PassiveAllocation): number {
  return costOf(tree, alloc.nodes);
}

export function spentSpecPoints(tree: PassiveTreeData, alloc: PassiveAllocation): number {
  return costOf(tree, alloc.specNodes);
}

export interface PassivePoints {
  readonly points: number;
  readonly specPoints: number;
}

/** Unspent passive and spec points (the "you have N points" badge). */
export function unspentPoints(tree: PassiveTreeData, hero: PassiveHero): PassivePoints {
  return {
    points: totalPoints(tree, hero.level) - spentPoints(tree, hero.passives),
    specPoints: totalSpecPoints(tree, hero.level) - spentSpecPoints(tree, hero.passives),
  };
}

/** Why the spec node cannot be taken by this hero at all (independent of points and connectivity). */
function specBlock(tree: PassiveTreeData, hero: PassiveHero, node: PassiveNodeDef): AllocateError | null {
  if (node.specId === undefined) return null;
  const spec = tree.specs[node.specId];
  if (!spec || spec.classId !== hero.classId) return 'other-class-spec';
  if (hero.passives.spec !== null && hero.passives.spec !== node.specId) return 'other-spec';
  return null;
}

function exclusiveConflict(tree: PassiveTreeData, alloc: PassiveAllocation, node: PassiveNodeDef): boolean {
  if (node.exclusiveGroup === undefined) return false;
  return [...alloc.nodes, ...alloc.specNodes].some((id) => id !== node.id && tree.nodes[id]?.exclusiveGroup === node.exclusiveGroup);
}

/** True if the node touches the hero's start or an allocated node. */
function touchesOwned(tree: PassiveTreeData, hero: PassiveHero, nodeId: string): boolean {
  const start = classStart(tree, hero.classId);
  return neighbors(tree, nodeId).some((n) => n === start || isAllocated(hero.passives, n));
}

export function canAllocate(tree: PassiveTreeData, hero: PassiveHero, nodeId: string): AllocateError | null {
  const node = tree.nodes[nodeId];
  if (!node) return 'unknown-node';
  if (node.type === 'start') return 'start-node';
  if (isAllocated(hero.passives, nodeId)) return 'already-allocated';
  const blocked = specBlock(tree, hero, node);
  if (blocked) return blocked;
  if (exclusiveConflict(tree, hero.passives, node)) return 'exclusive';
  if (!touchesOwned(tree, hero, nodeId)) return 'not-connected';
  const unspent = unspentPoints(tree, hero);
  if (isSpecNode(node)) {
    if (node.cost > unspent.specPoints) return 'no-spec-points';
  } else if (node.cost > unspent.points) {
    return 'no-points';
  }
  return null;
}

/** Allocates one node; the first spec node also chooses the spec. Returns an error and changes nothing on failure. */
export function allocate(tree: PassiveTreeData, hero: PassiveHero, nodeId: string): AllocateError | null {
  const error = canAllocate(tree, hero, nodeId);
  if (error) return error;
  const node = tree.nodes[nodeId]!;
  if (node.specId !== undefined) {
    hero.passives.specNodes.push(nodeId);
    hero.passives.spec = node.specId;
  } else {
    hero.passives.nodes.push(nodeId);
  }
  return null;
}

/** All nodes the hero can allocate right now, in tree order. */
export function allocatableNodes(tree: PassiveTreeData, hero: PassiveHero): string[] {
  return Object.keys(tree.nodes).filter((id) => canAllocate(tree, hero, id) === null);
}

/** Ids reachable from the class start through `owned` only. */
function reachable(tree: PassiveTreeData, classId: string, owned: ReadonlySet<string>): Set<string> {
  const start = classStart(tree, classId);
  const seen = new Set<string>();
  if (start === undefined) return seen;
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of neighbors(tree, id)) {
      if (owned.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Structural check only (no currency): the node is allocated and the rest stays connected to the start. */
export function canDeallocate(tree: PassiveTreeData, hero: PassiveHero, nodeId: string): DeallocateError | null {
  if (!tree.nodes[nodeId]) return 'unknown-node';
  if (!isAllocated(hero.passives, nodeId)) return 'not-allocated';
  const rest = new Set([...hero.passives.nodes, ...hero.passives.specNodes]);
  rest.delete(nodeId);
  if (reachable(tree, hero.classId, rest).size !== rest.size) return 'disconnects';
  return null;
}

/**
 * Removes one node (no currency; see respec.ts for the paid version).
 * The spec choice is kept even if no spec nodes remain: only a spec change clears it.
 */
export function deallocate(tree: PassiveTreeData, hero: PassiveHero, nodeId: string): DeallocateError | null {
  const error = canDeallocate(tree, hero, nodeId);
  if (error) return error;
  removeNode(hero.passives, nodeId);
  return null;
}

/** Removes a node without any checks. Callers must have run canDeallocate. */
export function removeNode(alloc: PassiveAllocation, nodeId: string): void {
  alloc.nodes = alloc.nodes.filter((id) => id !== nodeId);
  alloc.specNodes = alloc.specNodes.filter((id) => id !== nodeId);
}

/** Clears all wheel nodes; spec nodes stay (they hang off the class start). */
export function resetWheel(alloc: PassiveAllocation): void {
  alloc.nodes = [];
}

/** Clears the spec choice and all spec nodes. */
export function resetSpec(alloc: PassiveAllocation): void {
  alloc.spec = null;
  alloc.specNodes = [];
}

export interface PassivePath {
  /** Unallocated nodes to take, in order (each connects to the previous ones). Ends with the target. */
  readonly nodes: readonly string[];
  /** Total cost in passive points (wheel target) or spec points (spec target). */
  readonly cost: number;
}

/**
 * Cheapest path of unallocated nodes from the hero's owned nodes to `targetId`, in the target's layer
 * (wheel or its spec branch). Ignores available points. Null if the target is not reachable or not takeable.
 * Ties are broken by tree order, so the result is deterministic.
 */
export function findPath(tree: PassiveTreeData, hero: PassiveHero, targetId: string): PassivePath | null {
  const target = tree.nodes[targetId];
  if (!target || target.type === 'start' || isAllocated(hero.passives, targetId)) return null;
  if (specBlock(tree, hero, target) || exclusiveConflict(tree, hero.passives, target)) return null;

  const start = classStart(tree, hero.classId);
  const passable = (node: PassiveNodeDef): boolean =>
    node.type !== 'start' && node.specId === target.specId && !isAllocated(hero.passives, node.id) && !exclusiveConflict(tree, hero.passives, node);
  const isSource = (id: string): boolean => id === start || isAllocated(hero.passives, id);

  const ids = Object.keys(tree.nodes);
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (const id of ids) {
    const node = tree.nodes[id]!;
    if (!passable(node)) continue;
    if (neighbors(tree, id).some(isSource)) dist.set(id, node.cost);
  }
  for (;;) {
    let current: string | undefined;
    for (const id of ids) {
      const d = dist.get(id);
      if (d === undefined || done.has(id)) continue;
      if (current === undefined || d < dist.get(current)!) current = id;
    }
    if (current === undefined) return null;
    if (current === targetId) break;
    done.add(current);
    for (const next of neighbors(tree, current)) {
      const node = tree.nodes[next];
      if (!node || done.has(next) || !passable(node)) continue;
      const d = dist.get(current)! + node.cost;
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d);
        prev.set(next, current);
      }
    }
  }
  const nodes: string[] = [];
  for (let id: string | undefined = targetId; id !== undefined; id = prev.get(id)) nodes.unshift(id);
  return { nodes, cost: dist.get(targetId)! };
}

/** Allocates the cheapest path to the target if the hero has the points for all of it. All or nothing. */
export function allocatePath(tree: PassiveTreeData, hero: PassiveHero, targetId: string): AllocateError | null {
  const path = findPath(tree, hero, targetId);
  if (!path) return canAllocate(tree, hero, targetId) ?? 'not-connected';
  const unspent = unspentPoints(tree, hero);
  const spec = isSpecNode(tree.nodes[targetId]!);
  if (path.cost > (spec ? unspent.specPoints : unspent.points)) return spec ? 'no-spec-points' : 'no-points';
  // Dry run on a copy: every step must pass (e.g. two path nodes may share an exclusive group).
  const trial: PassiveHero = { classId: hero.classId, level: hero.level, passives: cloneAllocation(hero.passives) };
  for (const id of path.nodes) {
    const error = allocate(tree, trial, id);
    if (error) return error;
  }
  hero.passives.nodes = trial.passives.nodes;
  hero.passives.spec = trial.passives.spec;
  hero.passives.specNodes = trial.passives.specNodes;
  return null;
}

/**
 * Checks a whole allocation (e.g. after loading a save or a data change). Returns the first problem or null.
 * A hero with an invalid allocation should get a free reset.
 */
export function validateAllocation(tree: PassiveTreeData, hero: PassiveHero): AllocationProblem | null {
  const alloc = hero.passives;
  if (classStart(tree, hero.classId) === undefined) return 'unknown-class';
  const all = [...alloc.nodes, ...alloc.specNodes];
  if (new Set(all).size !== all.length) return 'duplicate';
  if (alloc.spec !== null && tree.specs[alloc.spec]?.classId !== hero.classId) return 'other-class-spec';
  for (const [ids, specLayer] of [
    [alloc.nodes, false],
    [alloc.specNodes, true],
  ] as const) {
    for (const id of ids) {
      const node = tree.nodes[id];
      if (!node) return 'unknown-node';
      if (node.type === 'start') return 'start-node';
      if (isSpecNode(node) !== specLayer) return 'wrong-layer';
      if (specLayer && node.specId !== alloc.spec) return 'other-spec';
    }
  }
  const groups = all.map((id) => tree.nodes[id]!.exclusiveGroup).filter((g) => g !== undefined);
  if (new Set(groups).size !== groups.length) return 'exclusive';
  if (spentPoints(tree, alloc) > totalPoints(tree, hero.level)) return 'no-points';
  if (spentSpecPoints(tree, alloc) > totalSpecPoints(tree, hero.level)) return 'no-spec-points';
  if (reachable(tree, hero.classId, new Set(all)).size !== all.length) return 'not-connected';
  return null;
}

function allocatedNodes(tree: PassiveTreeData, alloc: PassiveAllocation): PassiveNodeDef[] {
  return [...alloc.nodes, ...alloc.specNodes].flatMap((id) => tree.nodes[id] ?? []);
}

/** Stat modifiers of all allocated nodes, for the hero stat pipeline. */
export function passiveModifiers(tree: PassiveTreeData, alloc: PassiveAllocation): Modifier[] {
  return allocatedNodes(tree, alloc).flatMap((n) => n.modifiers ?? []);
}

/** Non-stat mechanics of all allocated nodes (keystones, spec effects). Consumers implement them by `kind`. */
export function passiveMechanics(tree: PassiveTreeData, alloc: PassiveAllocation): PassiveMechanic[] {
  return allocatedNodes(tree, alloc).flatMap((n) => n.mechanics ?? []);
}

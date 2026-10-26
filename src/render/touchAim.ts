import { normalize, vec, type Vec2 } from '../core/math';
import type { Delivery } from '../core/world/content';
import { ISO_K } from './iso';

// Pure aiming rules of the mobile touch controls (docs/design/controls.md). No Phaser: unit-tested in touchAim.test.ts.
// They only choose the aim point sent as RunInput.aim; what a skill does with it (range caps, facing) stays core's.

/** Which enemies auto-aim may pick (only those on screen); absent = all. */
export type AimFilter = (target: AimTarget) => boolean;

/** The camera's view in screen (iso) coordinates, as Phaser's camera.worldView. */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Whether an enemy is on screen: its feet (iso projection of its world position) inside the view grown by its body
 * radius, so a body at the very edge still counts.
 */
export function onScreen(target: AimTarget, view: ScreenRect): boolean {
  const sx = (target.pos.x - target.pos.y) * ISO_K;
  const sy = ((target.pos.x + target.pos.y) * ISO_K) / 2;
  const m = target.radius;
  return sx >= view.x - m && sx <= view.x + view.width + m && sy >= view.y - m && sy <= view.y + view.height + m;
}

/** An enemy as auto-aim sees it (MobState fits). */
export interface AimTarget {
  readonly pos: Vec2;
  readonly radius: number;
  readonly life: number;
}

/** The hero as auto-aim sees it (PlayerState fits). */
export interface AimHero {
  readonly pos: Vec2;
  readonly facing: Vec2;
}

export interface AimTuning {
  /** See TouchControlsTuning.autoAimRadius. */
  readonly autoAimRadius: number;
}

/**
 * How a tap aims an action:
 * - 'target': at the nearest enemy, else forward (attacks, projectiles, traps);
 * - 'charge': moving → along the stick; standing → at the nearest enemy, else forward (a dash that hits: Shield Charge);
 * - 'forward': moving → along the stick; standing → along the facing (a dash that does not hit: Roll; Teleport);
 * - 'none': the aim does not matter (self buffs, a full circle around the hero): keep facing / follow movement.
 */
export type TapStyle = 'target' | 'charge' | 'forward' | 'none';

export function tapStyle(delivery: Delivery): TapStyle {
  switch (delivery.kind) {
    case 'teleport':
      return 'forward';
    case 'dash':
      return delivery.hitRadius > 0 ? 'charge' : 'forward';
    case 'self':
      return 'none';
    case 'arc':
      return delivery.angleDeg >= 360 ? 'none' : 'target';
    default:
      return 'target';
  }
}

/** How far the action reaches from the hero (world units); 0 when it is not aimed (self, full circle). */
export function deliveryReach(delivery: Delivery): number {
  switch (delivery.kind) {
    case 'arc':
      return delivery.angleDeg >= 360 ? 0 : delivery.radius;
    case 'projectile':
      return delivery.range;
    case 'dash':
      return delivery.distance;
    case 'teleport':
      return delivery.range;
    case 'trap':
      return delivery.throwRange;
    case 'self':
      return 0;
  }
}

/** Whether a drag on its button aims it (shows the arrow): only actions with a direction. */
export function isAimed(delivery: Delivery): boolean {
  return tapStyle(delivery) !== 'none';
}

/**
 * The nearest living enemy whose body edge is within `range` of `from` (centre distance minus its radius, so a big
 * boss counts once its body is in range); undefined when none.
 */
export function nearestEnemy<T extends AimTarget>(mobs: readonly T[], from: Vec2, range: number, filter?: AimFilter): T | undefined {
  let best: T | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < mobs.length; i++) {
    const mob = mobs[i]!;
    if (mob.life <= 0 || (filter && !filter(mob))) continue;
    const edge = Math.hypot(mob.pos.x - from.x, mob.pos.y - from.y) - mob.radius;
    if (edge <= range && edge < bestDist) {
      best = mob;
      bestDist = edge;
    }
  }
  return best;
}

/** Forward: the movement direction while moving, else the facing (east if it is degenerate). Unit length. */
export function forwardDir(hero: AimHero, moveDir: Vec2 | undefined): Vec2 {
  const dir = moveDir && (moveDir.x !== 0 || moveDir.y !== 0) ? moveDir : hero.facing;
  const n = normalize(dir);
  return n.x === 0 && n.y === 0 ? vec(1, 0) : n;
}

/** A point `dist` (at least 1) ahead of the hero along `dir` (unit). */
function ahead(hero: AimHero, dir: Vec2, dist: number): Vec2 {
  const d = Math.max(1, dist);
  return vec(hero.pos.x + dir.x * d, hero.pos.y + dir.y * d);
}

/**
 * How far ahead a direction-only aim point is put (world units). Core moves the hero before it turns to the aim, so
 * a point close to the hero would end up behind them after a step's movement and flip the facing.
 */
export const DIRECTION_AIM_DISTANCE = 1000;

/** Aim with nothing pressed: keep the facing, or turn with the movement. */
export function idleAim(hero: AimHero, moveDir: Vec2 | undefined): Vec2 {
  return ahead(hero, forwardDir(hero, moveDir), DIRECTION_AIM_DISTANCE);
}

/** Radius auto-aim searches for an action: the "nearby" radius, or the action's reach if that is longer. */
export function autoAimRange(delivery: Delivery, tuning: AimTuning): number {
  return Math.max(tuning.autoAimRadius, deliveryReach(delivery));
}

/**
 * Aim point of a tap (or of the held basic attack) by the action's TapStyle. `moveDir`: world direction of the stick
 * while the hero moves, undefined while standing. Forward aims go to the action's full reach (Teleport and traps use
 * the distance; the rest only the direction).
 */
export function tapAim(delivery: Delivery, hero: AimHero, mobs: readonly AimTarget[], moveDir: Vec2 | undefined, tuning: AimTuning, filter?: AimFilter): Vec2 {
  const style = tapStyle(delivery);
  const reach = deliveryReach(delivery);
  const moving = moveDir !== undefined && (moveDir.x !== 0 || moveDir.y !== 0);
  if (style === 'none') return idleAim(hero, moveDir);
  if (style === 'forward' || (style === 'charge' && moving)) return ahead(hero, forwardDir(hero, moveDir), reach);
  const target = nearestEnemy(mobs, hero.pos, autoAimRange(delivery, tuning), filter);
  if (target) return vec(target.pos.x, target.pos.y);
  return ahead(hero, forwardDir(hero, moveDir), reach);
}

/** Actions whose drag aims a distance too (the drag length), not only a direction: traps and Teleport. */
export function isDistanceAimed(delivery: Delivery): boolean {
  return delivery.kind === 'trap' || delivery.kind === 'teleport';
}

/** Shortest share of the reach a distance-aimed drag gives (a tiny drag still lands clearly ahead of the hero). */
export const MIN_DRAG_DISTANCE = 0.15;

/** Drag length on screen → share of the reach (0..1): the edge of the drag radius = full reach. */
export function dragFraction(length: number, dragRadius: number): number {
  if (dragRadius <= 0) return 1;
  return Math.min(1, Math.max(MIN_DRAG_DISTANCE, length / dragRadius));
}

/**
 * Aim point of a dragged (manually aimed) action along `dir` (world direction, any length): traps and Teleport at
 * `fraction` (dragFraction) of their reach, the rest at full reach (only the direction matters to them).
 */
export function manualAim(delivery: Delivery, hero: AimHero, dir: Vec2, fraction = 1): Vec2 {
  const share = isDistanceAimed(delivery) ? Math.min(1, Math.max(MIN_DRAG_DISTANCE, fraction)) : 1;
  return ahead(hero, forwardDir(hero, dir), deliveryReach(delivery) * share);
}

/**
 * Stick deflection → screen direction: zero inside the dead zone (share of `radius`), else the unit direction of
 * (dx, dy). Core normalizes the move anyway, so the stick only steers.
 */
export function stickDirection(dx: number, dy: number, radius: number, deadZone: number): Vec2 {
  const len = Math.hypot(dx, dy);
  if (len <= 0 || len < radius * deadZone) return vec(0, 0);
  return vec(dx / len, dy / len);
}

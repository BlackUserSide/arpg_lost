import type { BaseDamage } from '../combat/damage';
import { add, distance, rotate, scale } from '../math';
import { DAMAGE_TYPES, type Modifier, type Tag } from '../stats/types';
import type { ActionDef, DamageSpec, ProjectileSplit } from './content';
import { damageMob, explode, releaseChain } from './actions';
import { damagePlayer, hitPlayer } from './mobs';
import { abilityHit } from './abilities';
import { distanceDamageModifier } from './passiveEffects';
import { getMob, insideArena, type Ctx, type Projectile } from './state';


/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/**
 * Moves every projectile one step. Projectiles created during the step (split children) are appended after the
 * survivors and first move on the next step.
 */
export function updateProjectiles(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const current = world.projectiles;
  world.projectiles = [];
  const alive: Projectile[] = [];
  for (const p of current) {
    if (stepProjectile(ctx, p, dt)) alive.push(p);
  }
  world.projectiles = [...alive, ...world.projectiles];
}

/** Returns false when the projectile is gone. */
function stepProjectile(ctx: Ctx, p: Projectile, dt: number): boolean {
  const { world, content } = ctx;
  const stepLen = Math.min(p.speed * dt, p.remaining);
  p.pos = add(p.pos, scale(p.dir, stepLen));
  p.remaining -= stepLen;
  p.travelled += stepLen;

  if (p.owner === 'mob') {
    // A decoy in the way absorbs the shot (whoever it was aimed at).
    if (world.decoys.some((d) => distance(p.pos, d.pos) <= p.radius + d.radius)) return false;
    const player = world.player;
    if (!player.dead && distance(p.pos, player.pos) <= p.radius + player.radius) {
      const def = getMob(content, p.sourceId);
      if (p.abilityId === undefined) hitPlayer(ctx, def, p.damageScale ?? 1);
      else {
        const { damage, critChance } = abilityHit(def, p.abilityId);
        damagePlayer(ctx, damage, critChance, p.damageScale ?? 1);
      }
      return false;
    }
  } else {
    const action = p.action;
    if (!action) throw new Error('Player projectile without an action snapshot: ' + p.sourceId);
    for (const mob of world.mobs) {
      if (mob.life <= 0 || p.hitIds.includes(mob.id)) continue;
      if (distance(p.pos, mob.pos) > p.radius + mob.radius) continue;
      if (p.explodeRadius > 0) {
        const hit = explode(ctx, action, p.pos, p.explodeRadius, hitModifiers(ctx, p, action.tags), { zoneModifiers: p.castModifiers });
        splitProjectile(ctx, p, action, hit);
        return false;
      }
      p.hitIds.push(mob.id);
      const mods = hitModifiers(ctx, p, action.tags);
      damageMob(ctx, action, mob, mods);
      releaseChain(ctx, action, mob, p.hitIds, mods);
      if (--p.pierceLeft < 0) {
        splitProjectile(ctx, p, action, p.hitIds);
        return false;
      }
    }
  }

  if (p.remaining <= 0 || !insideArena(p.pos, world)) {
    if (p.action && p.explodeRadius > 0) {
      const hit = explode(ctx, p.action, p.pos, p.explodeRadius, hitModifiers(ctx, p, p.action.tags), { zoneModifiers: p.castModifiers });
      splitProjectile(ctx, p, p.action, hit);
    }
    return false;
  }
  return true;
}

/**
 * ProjectileSplit: `count` children fanned over spreadDeg around the parent's direction (evenly, like a volley),
 * from the parent's position. They carry a child action: the parent's with damage × damageMultiplier, a plain
 * projectile delivery (no split, so splitting never recurses) and no ground zone. `ignoreIds` (the mobs the
 * parent's impact / explosion hit) are pre-filled in their hitIds: no contact hit with them, though a child's own
 * explosion can still splash them. Nothing happens outside the arena.
 */
function splitProjectile(ctx: Ctx, parent: Projectile, action: ActionDef, ignoreIds: readonly number[]): void {
  const { world, events } = ctx;
  if (action.delivery.kind !== 'projectile') return;
  const split = action.delivery.split;
  if (!split || split.count < 1 || !insideArena(parent.pos, world)) return;
  const child = childAction(action, split);
  const count = Math.floor(split.count);
  const spread = (split.spreadDeg * Math.PI) / 180;
  const childIds: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = count > 1 ? -spread / 2 + (spread * i) / (count - 1) : 0;
    const id = world.nextId++;
    childIds.push(id);
    world.projectiles.push({
      id,
      owner: 'player',
      sourceId: parent.sourceId,
      action: child,
      pos: parent.pos,
      dir: rotate(parent.dir, offset),
      speed: split.speed,
      radius: split.radius,
      remaining: split.range,
      travelled: 0,
      pierceLeft: 0,
      explodeRadius: split.explodeRadius ?? 0,
      hitIds: [...ignoreIds],
      castModifiers: parent.castModifiers,
    });
  }
  events.push({ type: 'projectileSplit', projectileId: parent.id, actionId: action.id, pos: parent.pos, childIds });
}

/** The action a split child carries (see splitProjectile). */
function childAction(action: ActionDef, split: ProjectileSplit): ActionDef {
  const { zone, damage, ...rest } = action;
  void zone;
  return {
    ...rest,
    ...(damage ? { damage: scaleDamageSpec(damage, split.damageMultiplier) } : {}),
    delivery: {
      kind: 'projectile',
      count: 1,
      spreadDeg: 0,
      speed: split.speed,
      range: split.range,
      radius: split.radius,
      pierce: 0,
      ...(split.explodeRadius !== undefined ? { explodeRadius: split.explodeRadius } : {}),
    },
  };
}

function scaleDamageSpec(spec: DamageSpec, factor: number): DamageSpec {
  if (spec.source === 'weapon') return { ...spec, effectiveness: spec.effectiveness * factor };
  const base: BaseDamage = {};
  for (const type of DAMAGE_TYPES) {
    const range = spec.base[type];
    if (range) base[type] = { min: range.min * factor, max: range.max * factor };
  }
  return { ...spec, base };
}

/**
 * Cast-time modifiers of a player projectile hit plus distanceDamage (mechanic read live at the hit, like the stun
 * bar): more damage from the distance travelled so far, measured at the end of the step in which it hits.
 * Pierced targets further along get more. Applies only to actions with the mechanic's tags (attack projectiles in data).
 */
function hitModifiers(ctx: Ctx, p: Projectile, tags: readonly Tag[]): readonly Modifier[] {
  const mod = distanceDamageModifier(ctx.world.player.mechanics, tags, p.travelled);
  return mod ? [...p.castModifiers, mod] : p.castModifiers;
}

/**
 * Hero traps for one step, in two passes (auras are then recomputed with the ground zones, see updateZones):
 * 1. Timers: arming, lifetime and running chain timers advance by dt.
 * 2. Explosions, in trap order (oldest first): a trap explodes when its chain timer ends ('area' event with
 *    chain: true), when armed and an enemy is inside triggerRadius (+ its radius), or when its lifetime ends.
 *    An exploding trap with chain rules schedules every other hero trap within chain.radius of it (armed or still
 *    arming) that is not scheduled yet: it explodes chain.delay seconds later (its timer first runs next step, so
 *    a step-n explosion detonates it at step n + delay / dt). Each trap explodes once; it hits with its own
 *    snapshot (action, castModifiers, explodeRadius) and leaves the action's ground zone, if any.
 */
// Designer decision 2026-10-22 (default): chain detonation also sets off traps that are still arming.
export function updateTraps(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  for (const trap of world.traps) {
    trap.armTimer = Math.max(0, trap.armTimer - dt);
    trap.lifetime -= dt;
    if (trap.chainTimer !== null) trap.chainTimer = trap.chainTimer - dt > TIME_EPSILON ? trap.chainTimer - dt : 0;
  }

  const exploded = new Set<number>();
  for (const trap of world.traps) {
    const chained = trap.chainTimer !== null && trap.chainTimer <= 0;
    const triggered =
      !chained &&
      trap.armTimer <= 0 &&
      world.mobs.some((mob) => mob.life > 0 && distance(mob.pos, trap.pos) <= trap.triggerRadius + mob.radius);
    if (!chained && !triggered && trap.lifetime > 0) continue;
    exploded.add(trap.id);
    explode(ctx, trap.action, trap.pos, trap.explodeRadius, trap.castModifiers, { chain: chained });
    const chain = trap.chain;
    if (!chain) continue;
    for (const other of world.traps) {
      if (exploded.has(other.id) || other.chainTimer !== null) continue;
      if (distance(other.pos, trap.pos) <= chain.radius) other.chainTimer = chain.delay;
    }
  }
  if (exploded.size > 0) world.traps = world.traps.filter((t) => !exploded.has(t.id));
}

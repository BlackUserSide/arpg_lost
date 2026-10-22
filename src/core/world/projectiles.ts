import { add, distance, scale } from '../math';
import type { Modifier, Tag } from '../stats/types';
import { damageMob, explode } from './actions';
import { hitPlayer } from './mobs';
import { distanceDamageModifier } from './passiveEffects';
import { getMob, insideArena, type Ctx, type Projectile } from './state';
import { updateTrapAuras } from './statuses';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

export function updateProjectiles(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const alive: Projectile[] = [];
  for (const p of world.projectiles) {
    if (stepProjectile(ctx, p, dt)) alive.push(p);
  }
  world.projectiles = alive;
}

/** Returns false when the projectile is gone. */
function stepProjectile(ctx: Ctx, p: Projectile, dt: number): boolean {
  const { world, content } = ctx;
  const stepLen = Math.min(p.speed * dt, p.remaining);
  p.pos = add(p.pos, scale(p.dir, stepLen));
  p.remaining -= stepLen;
  p.travelled += stepLen;

  if (p.owner === 'mob') {
    const player = world.player;
    if (!player.dead && distance(p.pos, player.pos) <= p.radius + player.radius) {
      hitPlayer(ctx, getMob(content, p.sourceId));
      return false;
    }
  } else {
    const action = p.action;
    if (!action) throw new Error('Player projectile without an action snapshot: ' + p.sourceId);
    for (const mob of world.mobs) {
      if (mob.life <= 0 || p.hitIds.includes(mob.id)) continue;
      if (distance(p.pos, mob.pos) > p.radius + getMob(content, mob.defId).radius) continue;
      if (p.explodeRadius > 0) {
        explode(ctx, action, p.pos, p.explodeRadius, hitModifiers(ctx, p, action.tags));
        return false;
      }
      p.hitIds.push(mob.id);
      damageMob(ctx, action, mob, hitModifiers(ctx, p, action.tags));
      if (--p.pierceLeft < 0) return false;
    }
  }

  if (p.remaining <= 0 || !insideArena(p.pos, content)) {
    if (p.action && p.explodeRadius > 0) explode(ctx, p.action, p.pos, p.explodeRadius, hitModifiers(ctx, p, p.action.tags));
    return false;
  }
  return true;
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
 * Hero traps for one step, in three passes:
 * 1. Timers: arming, lifetime and running chain timers advance by dt.
 * 2. Explosions, in trap order (oldest first): a trap explodes when its chain timer ends ('area' event with
 *    chain: true), when armed and an enemy is inside triggerRadius (+ its radius), or when its lifetime ends.
 *    An exploding trap with chain rules schedules every other hero trap within chain.radius of it (armed or still
 *    arming) that is not scheduled yet: it explodes chain.delay seconds later (its timer first runs next step, so
 *    a step-n explosion detonates it at step n + delay / dt). Each trap explodes once; it hits with its own
 *    snapshot (action, castModifiers, explodeRadius).
 * 3. Auras: every mob's auraSlow is recomputed from the armed traps left (strongest aura in range applies).
 */
// Designer decision 2026-10-22 (default): chain detonation also sets off traps that are still arming.
export function updateTraps(ctx: Ctx, dt: number): void {
  const { world, content } = ctx;
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
      world.mobs.some((mob) => mob.life > 0 && distance(mob.pos, trap.pos) <= trap.triggerRadius + getMob(content, mob.defId).radius);
    if (!chained && !triggered && trap.lifetime > 0) continue;
    exploded.add(trap.id);
    explode(ctx, trap.action, trap.pos, trap.explodeRadius, trap.castModifiers, chained);
    const chain = trap.chain;
    if (!chain) continue;
    for (const other of world.traps) {
      if (exploded.has(other.id) || other.chainTimer !== null) continue;
      if (distance(other.pos, trap.pos) <= chain.radius) other.chainTimer = chain.delay;
    }
  }
  if (exploded.size > 0) world.traps = world.traps.filter((t) => !exploded.has(t.id));

  updateTrapAuras(ctx);
}

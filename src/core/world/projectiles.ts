import { add, distance, scale } from '../math';
import { damageMob, explode } from './actions';
import { hitPlayer } from './mobs';
import { getMob, insideArena, type Ctx, type Projectile } from './state';

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
        explode(ctx, action, p.pos, p.explodeRadius, p.castModifiers);
        return false;
      }
      p.hitIds.push(mob.id);
      damageMob(ctx, action, mob, p.castModifiers);
      if (--p.pierceLeft < 0) return false;
    }
  }

  if (p.remaining <= 0 || !insideArena(p.pos, content)) {
    if (p.action && p.explodeRadius > 0) explode(ctx, p.action, p.pos, p.explodeRadius, p.castModifiers);
    return false;
  }
  return true;
}

export function updateTraps(ctx: Ctx, dt: number): void {
  const { world, content } = ctx;
  world.traps = world.traps.filter((trap) => {
    trap.armTimer = Math.max(0, trap.armTimer - dt);
    trap.lifetime -= dt;
    const { action, triggerRadius, explodeRadius } = trap;
    const triggered =
      trap.armTimer <= 0 &&
      world.mobs.some((mob) => mob.life > 0 && distance(mob.pos, trap.pos) <= triggerRadius + getMob(content, mob.defId).radius);
    if (triggered || trap.lifetime <= 0) {
      explode(ctx, action, trap.pos, explodeRadius, trap.castModifiers);
      return false;
    }
    return true;
  });
}

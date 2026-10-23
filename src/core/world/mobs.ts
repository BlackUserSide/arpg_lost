import { applyDamageTaken, rollBaseDamage, totalDamage } from '../combat/damage';
import { applyDamage, resolveHit } from '../combat/hit';
import type { Defences } from '../combat/mitigation';
import { add, distance, normalize, scale, sub, vec, type Vec2 } from '../math';
import { createRng, type Rng } from '../rng';
import { rollSupportDrop } from '../supports/drops';
import type { SupportData } from '../supports/types';
import type { Content, MobDef } from './content';
import { counterAttack } from './actions';
import { heroDeathExplosions } from './deathExplosions';
import { gainKillXp } from './experience';
import { decayStunBar, tickBleed, tickIgnite } from './statuses';
import { resourceOnHeroHitTaken } from './resource';
import { mobTarget } from './zones';
import { allModifiers, clampToArena, getMob, playerStat, type Ctx, type MobState, type WorldState } from './state';

export function updateMobs(ctx: Ctx, dt: number): void {
  const { world, content, events } = ctx;
  const player = world.player;
  const barStats = player.stunBarStats;
  for (const mob of world.mobs) {
    // Mobs killed earlier this step neither act nor tick: their statuses at death stay as they were.
    if (mob.life <= 0) continue;
    tickIgnite(ctx, mob, dt);
    if (mob.life <= 0) continue;
    tickBleed(ctx, mob, dt);
    if (mob.life <= 0) continue;
    const def = getMob(content, mob.defId);
    mob.slow = Math.max(0, mob.slow - dt);
    mob.freezeSlow = Math.max(0, mob.freezeSlow - dt);
    mob.stunSlow = Math.max(0, mob.stunSlow - dt);
    if (barStats) decayStunBar(mob, barStats, dt);
    const speedFactor = 1 - slowFraction(mob, content);
    // Stunned or frozen: cannot move or attack (the attack timer does not run either).
    const disabled = mob.stun > 0 || mob.freeze > 0;
    mob.stun = Math.max(0, mob.stun - dt);
    mob.freeze = Math.max(0, mob.freeze - dt);
    // Being pushed (Knockback support): the push moves the mob even while stunned; it neither walks nor attacks.
    const pushed = moveKnockback(mob, def, content, dt);
    if (disabled || pushed) continue;
    mob.attackTimer = Math.max(0, mob.attackTimer - dt * speedFactor);

    // The hero, or a decoy taunting this mob (mobTarget): the mob chases and attacks it the same way.
    const target = mobTarget(world, mob, def.boss === true);
    const toTarget = normalize(sub(target.pos, mob.pos));
    if (toTarget.x !== 0 || toTarget.y !== 0) mob.facing = toTarget;
    const gap = distance(target.pos, mob.pos) - target.radius - def.radius;
    const maxStep = def.moveSpeed * speedFactor * dt;

    if (def.preferredRange !== undefined) {
      // Ranged: close in to preferred range, back off if the player gets too close.
      if (gap > def.preferredRange) mob.pos = add(mob.pos, scale(toTarget, Math.min(maxStep, gap - def.preferredRange)));
      else if (gap < def.preferredRange * 0.6) mob.pos = add(mob.pos, scale(toTarget, -maxStep));
    } else if (gap > def.attack.range * 0.8) {
      mob.pos = add(mob.pos, scale(toTarget, Math.min(maxStep, gap)));
    }

    if (gap <= def.attack.range && mob.attackTimer <= 0 && !player.dead) {
      mob.attackTimer = def.attack.interval;
      events.push({ type: 'mobAttack', id: mob.id, ...(target.decoy ? { decoyId: target.decoy.id } : {}) });
      if (def.attack.projectile) {
        world.projectiles.push({
          id: world.nextId++,
          owner: 'mob',
          sourceId: def.id,
          pos: add(mob.pos, scale(toTarget, def.radius)),
          dir: toTarget,
          speed: def.attack.projectile.speed,
          radius: def.attack.projectile.radius,
          remaining: def.attack.range + target.radius + def.radius,
          travelled: 0,
          pierceLeft: 0,
          explodeRadius: 0,
          hitIds: [],
          castModifiers: [],
        });
      } else if (!target.decoy) {
        // A melee swing at a decoy does nothing (it has no life): the mob just wastes its attack.
        hitPlayer(ctx, def, mob);
      }
    }
  }
  separateMobs(world, content);
}

/** Advances a mob's knockback by one step (clamped to the arena). Returns true if it was being pushed this step. */
function moveKnockback(mob: MobState, def: MobDef, content: Content, dt: number): boolean {
  const push = mob.knockback;
  if (!push) return false;
  const len = Math.min(push.speed * dt, push.remaining);
  mob.pos = clampToArena(add(mob.pos, scale(push.dir, len)), def.radius, content);
  push.remaining -= len;
  if (push.remaining <= TIME_EPSILON) delete mob.knockback;
  return true;
}

/** Distances / seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** Fraction of speed removed now: the strongest of the active slow, the trap aura slow and the boss freeze- / stun-slows (0..1). */
export function slowFraction(mob: MobState, content: Content): number {
  const slow = mob.slow > 0 ? mob.slowMagnitude : 0;
  const freezeSlow = mob.freezeSlow > 0 ? content.combat.bossFreezeSlow : 0;
  const stunSlow = mob.stunSlow > 0 ? content.combat.bossStunSlow : 0;
  return Math.min(1, Math.max(0, slow, mob.auraSlow, freezeSlow, stunSlow));
}

/**
 * A mob attack lands on the hero. `meleeAttacker`: the attacking mob, for melee hits only (mob projectiles pass
 * nothing); a melee hit that the hero survives may trigger counterAttack against it.
 */
export function hitPlayer(ctx: Ctx, mobDef: MobDef, meleeAttacker?: MobState): void {
  const { world, content, classDef, rng, events } = ctx;
  const player = world.player;
  if (player.dead || player.invulnerable > 0) return;
  const defences: Defences = {
    armour: playerStat(classDef, player, 'armour'),
    resistances: {
      fire: playerStat(classDef, player, 'fireResistance'),
      cold: playerStat(classDef, player, 'coldResistance'),
      lightning: playerStat(classDef, player, 'lightningResistance'),
    },
  };
  const damage = rollBaseDamage(rng, mobDef.attack.damage);
  const hit = resolveHit(
    rng,
    { damage, critChance: mobDef.attack.critChance, critMultiplier: content.combat.critMultiplierBase },
    defences,
    content.combat,
  );
  // Damage taken modifiers (e.g. Glass Cannon) apply after mitigation, before the ES / life split.
  const taken = totalDamage(applyDamageTaken(hit.damage, allModifiers(classDef, player)));
  const result = applyDamage({ life: player.life, energyShield: player.energyShield }, taken);
  player.life = result.pools.life;
  player.energyShield = result.pools.energyShield;
  events.push({ type: 'hit', targetId: player.id, pos: player.pos, amount: taken, isCrit: hit.isCrit });
  if (result.isDead) {
    player.dead = true;
    player.motion = undefined;
    events.push({ type: 'playerDeath' });
    return;
  }
  resourceOnHeroHitTaken(classDef, player, result.shieldLost + result.lifeLost);
  if (meleeAttacker) counterAttack(ctx, meleeAttacker);
}

/** Pushes overlapping mobs apart and out of the player, so crowds surround instead of stacking. */
function separateMobs(world: WorldState, content: Content): void {
  const { mobs, player } = world;
  for (let i = 0; i < mobs.length; i++) {
    const a = mobs[i]!;
    const ra = getMob(content, a.defId).radius;
    for (let j = i + 1; j < mobs.length; j++) {
      const b = mobs[j]!;
      const rb = getMob(content, b.defId).radius;
      const d = distance(a.pos, b.pos);
      const overlap = ra + rb - d;
      if (overlap <= 0) continue;
      const dir = d > 0 ? scale(sub(b.pos, a.pos), 1 / d) : vec(1, 0);
      a.pos = sub(a.pos, scale(dir, overlap / 2));
      b.pos = add(b.pos, scale(dir, overlap / 2));
    }
    const d = distance(a.pos, player.pos);
    const overlap = ra + player.radius - d;
    if (overlap > 0) {
      const dir = d > 0 ? scale(sub(a.pos, player.pos), 1 / d) : vec(1, 0);
      a.pos = add(a.pos, scale(dir, overlap));
    }
    a.pos = clampToArena(a.pos, ra, content);
  }
}

/**
 * Removes dead mobs: kill count, death event, XP, then death explosions. Mobs killed by an explosion are queued
 * and processed in the same call (their own explosions included); every mob dies once, so chains terminate.
 */
export function removeDeadMobs(ctx: Ctx): void {
  const { world, events, content } = ctx;
  const queue = world.mobs.filter((mob) => mob.life <= 0);
  if (queue.length === 0) return;
  // Loot has its own seeded stream (WorldState.lootRngState): drops never shift combat rolls.
  const loot = content.supports ? createRng(world.lootRngState) : undefined;
  for (let i = 0; i < queue.length; i++) {
    const mob = queue[i]!;
    const def = getMob(content, mob.defId);
    world.kills++;
    events.push({ type: 'death', id: mob.id, pos: mob.pos });
    gainKillXp(ctx, def.xp);
    if (loot && content.supports) dropSupport(ctx, loot, content.supports, mob, def);
    queue.push(...heroDeathExplosions(ctx, mob));
  }
  if (loot) world.lootRngState = loot.getState();
  world.mobs = world.mobs.filter((mob) => mob.life > 0);
}

/**
 * A kill's support drop (docs/design/skill-modifiers.md «Випадіння»): chance by rank (boss / elite / normal), tier by
 * area level (rollSupportDrop). Recorded in WorldState.supportDrops with a 'supportDrop' event.
 */
function dropSupport(ctx: Ctx, loot: Rng, data: SupportData, mob: MobState, def: MobDef): void {
  const rank = def.boss ? 'boss' : def.elite ? 'elite' : 'normal';
  const drop = rollSupportDrop(loot, data, rank, ctx.world.areaLevel);
  if (!drop) return;
  ctx.world.supportDrops.push(drop);
  ctx.events.push({ type: 'supportDrop', mobId: mob.id, pos: mob.pos, defId: drop.defId, tier: drop.tier });
}

export function updateSpawner(ctx: Ctx, dt: number): void {
  const { world, content, rng, events } = ctx;
  const spawn = content.arena.spawn;
  world.spawn.timer -= dt;
  if (world.spawn.timer > 0) return;
  world.spawn.timer += spawn.interval;
  world.spawn.wave++;
  const count = spawn.batchStart + Math.floor((world.spawn.wave - 1) * spawn.batchGrowth);
  for (let i = 0; i < count && world.mobs.length < spawn.maxAlive; i++) {
    const defId = spawn.mobIds[rng.int(0, spawn.mobIds.length - 1)];
    if (defId === undefined) return;
    const def = getMob(content, defId);
    const mob: MobState = {
      id: world.nextId++,
      defId,
      pos: randomEdgePoint(rng, def.radius, content),
      facing: vec(0, 1),
      life: def.life,
      maxLife: def.life,
      attackTimer: 0,
      stun: 0,
      slow: 0,
      slowMagnitude: 0,
      ignite: 0,
      igniteDps: 0,
      freeze: 0,
      freezeSlow: 0,
      stunSlow: 0,
      stunBar: 0,
      stunBarIdle: 0,
      auraSlow: 0,
    };
    world.mobs.push(mob);
    events.push({ type: 'spawn', id: mob.id });
  }
}

function randomEdgePoint(rng: Rng, radius: number, content: Content): Vec2 {
  const { width, height } = content.arena;
  const side = rng.int(0, 3);
  const t = rng.next();
  switch (side) {
    case 0:
      return vec(radius + t * (width - 2 * radius), radius);
    case 1:
      return vec(width - radius, radius + t * (height - 2 * radius));
    case 2:
      return vec(radius + t * (width - 2 * radius), height - radius);
    default:
      return vec(radius, radius + t * (height - 2 * radius));
  }
}

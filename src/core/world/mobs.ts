import { applyDamageTaken, rollBaseDamage, totalDamage } from '../combat/damage';
import { applyDamage, resolveHit } from '../combat/hit';
import type { Defences } from '../combat/mitigation';
import { add, distance, normalize, scale, sub, vec, type Vec2 } from '../math';
import type { Rng } from '../rng';
import type { Content, MobDef } from './content';
import { gainKillXp } from './experience';
import { allModifiers, clampToArena, getMob, playerStat, type Ctx, type MobState, type WorldState } from './state';

export function updateMobs(ctx: Ctx, dt: number): void {
  const { world, content, events } = ctx;
  const player = world.player;
  for (const mob of world.mobs) {
    const def = getMob(content, mob.defId);
    mob.slow = Math.max(0, mob.slow - dt);
    if (mob.stun > 0) {
      mob.stun = Math.max(0, mob.stun - dt);
      continue;
    }
    const speedFactor = mob.slow > 0 ? Math.max(0, 1 - mob.slowMagnitude) : 1;
    mob.attackTimer = Math.max(0, mob.attackTimer - dt * speedFactor);

    const toPlayer = normalize(sub(player.pos, mob.pos));
    if (toPlayer.x !== 0 || toPlayer.y !== 0) mob.facing = toPlayer;
    const gap = distance(player.pos, mob.pos) - player.radius - def.radius;
    const maxStep = def.moveSpeed * speedFactor * dt;

    if (def.preferredRange !== undefined) {
      // Ranged: close in to preferred range, back off if the player gets too close.
      if (gap > def.preferredRange) mob.pos = add(mob.pos, scale(toPlayer, Math.min(maxStep, gap - def.preferredRange)));
      else if (gap < def.preferredRange * 0.6) mob.pos = add(mob.pos, scale(toPlayer, -maxStep));
    } else if (gap > def.attack.range * 0.8) {
      mob.pos = add(mob.pos, scale(toPlayer, Math.min(maxStep, gap)));
    }

    if (gap <= def.attack.range && mob.attackTimer <= 0 && !player.dead) {
      mob.attackTimer = def.attack.interval;
      events.push({ type: 'mobAttack', id: mob.id });
      if (def.attack.projectile) {
        world.projectiles.push({
          id: world.nextId++,
          owner: 'mob',
          sourceId: def.id,
          pos: add(mob.pos, scale(toPlayer, def.radius)),
          dir: toPlayer,
          speed: def.attack.projectile.speed,
          radius: def.attack.projectile.radius,
          remaining: def.attack.range + player.radius + def.radius,
          pierceLeft: 0,
          explodeRadius: 0,
          hitIds: [],
          castModifiers: [],
        });
      } else {
        hitPlayer(ctx, def);
      }
    }
  }
  separateMobs(world, content);
}

export function hitPlayer(ctx: Ctx, mobDef: MobDef): void {
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
  }
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

export function removeDeadMobs(ctx: Ctx): void {
  const { world, events } = ctx;
  const alive: MobState[] = [];
  for (const mob of world.mobs) {
    if (mob.life > 0) {
      alive.push(mob);
      continue;
    }
    world.kills++;
    events.push({ type: 'death', id: mob.id, pos: mob.pos });
    gainKillXp(ctx, getMob(ctx.content, mob.defId).xp);
  }
  world.mobs = alive;
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
      attackTimer: 0,
      stun: 0,
      slow: 0,
      slowMagnitude: 0,
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

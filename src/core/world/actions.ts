import { computeDamage, rollBaseDamage, scaleDamage, type DamageByType } from '../combat/damage';
import { resolveHit } from '../combat/hit';
import { add, distance, dot, normalize, rotate, scale, sub, type Vec2 } from '../math';
import { computeStat } from '../stats/modifiers';
import type { ActionDef, StatusEffect } from './content';
import { allModifiers, clampToArena, getMob, type Ctx, type MobState } from './state';

export function findAction(ctx: Ctx, id: string): ActionDef {
  const { classDef } = ctx;
  const action = [classDef.basicAttack, ...classDef.skills].find((a) => a.id === id);
  if (!action) throw new Error(`Unknown action for ${classDef.id}: ${id}`);
  return action;
}

/** Seconds the player is busy after starting this action. */
export function useTime(ctx: Ctx, action: ActionDef): number {
  const mods = allModifiers(ctx.world.player);
  if (action.tags.includes('attack')) {
    const rate = computeStat(ctx.classDef.weapon.attacksPerSecond, mods, 'attackSpeed', action.tags);
    return rate > 0 ? 1 / rate : Infinity;
  }
  const base = action.castTime ?? 0;
  if (!action.tags.includes('spell')) return base;
  return base / Math.max(0.01, computeStat(1, mods, 'castSpeed', action.tags));
}

export function pickAction(ctx: Ctx): ActionDef | undefined {
  const { classDef, input, world } = ctx;
  const player = world.player;
  for (let i = 0; i < classDef.skills.length; i++) {
    const skill = classDef.skills[i];
    if (!skill || !input.skills[i]) continue;
    if ((player.cooldowns[skill.id] ?? 0) > 0 || player.mana < skill.manaCost) continue;
    return skill;
  }
  return input.basicAttack ? classDef.basicAttack : undefined;
}

export function performAction(ctx: Ctx, action: ActionDef): void {
  const { world, content, events, input } = ctx;
  const player = world.player;
  player.mana -= action.manaCost;
  if (action.cooldown > 0) player.cooldowns[action.id] = action.cooldown;
  player.actionTimer = useTime(ctx, action);
  events.push({ type: 'action', actionId: action.id, facing: player.facing });

  const delivery = action.delivery;
  switch (delivery.kind) {
    case 'arc':
      hitArc(ctx, action, player.pos, player.facing, delivery.radius, delivery.angleDeg, delivery.maxTargets);
      break;
    case 'projectile': {
      const spread = (delivery.spreadDeg * Math.PI) / 180;
      for (let i = 0; i < delivery.count; i++) {
        const offset = delivery.count > 1 ? -spread / 2 + (spread * i) / (delivery.count - 1) : 0;
        const dir = rotate(player.facing, offset);
        world.projectiles.push({
          id: world.nextId++,
          owner: 'player',
          sourceId: action.id,
          pos: add(player.pos, scale(dir, player.radius)),
          dir,
          speed: delivery.speed,
          radius: delivery.radius,
          remaining: delivery.range,
          pierceLeft: delivery.pierce,
          explodeRadius: delivery.explodeRadius ?? 0,
          hitIds: [],
        });
      }
      break;
    }
    case 'dash':
      player.motion = {
        actionId: action.id,
        dir: player.facing,
        speed: delivery.speed,
        hitRadius: delivery.hitRadius,
        remaining: delivery.distance,
        hitIds: [],
      };
      break;
    case 'teleport': {
      const offset = sub(input.aim, player.pos);
      const dist = Math.min(delivery.range, distance(input.aim, player.pos));
      const from = player.pos;
      player.pos = clampToArena(add(player.pos, scale(normalize(offset), dist)), player.radius, content);
      events.push({ type: 'teleport', from, to: player.pos });
      break;
    }
    case 'trap': {
      const dist = Math.min(delivery.throwRange, distance(input.aim, player.pos));
      world.traps.push({
        id: world.nextId++,
        actionId: action.id,
        pos: clampToArena(add(player.pos, scale(player.facing, dist)), 0, content),
        armTimer: delivery.armTime,
        lifetime: delivery.lifetime,
      });
      break;
    }
    case 'self':
      break;
  }

  for (const effect of action.selfEffects ?? []) {
    if (effect.kind === 'invulnerable') {
      player.invulnerable = Math.max(player.invulnerable, effect.duration);
    } else {
      player.buffs = player.buffs.filter((b) => b.id !== effect.id);
      player.buffs.push({ id: effect.id, modifiers: effect.modifiers, remaining: effect.duration });
    }
  }
}

/** Advances a dash: moves the player and hits enemies along the path once. Returns true while dashing. */
export function updateMotion(ctx: Ctx, dt: number): boolean {
  const { world, content } = ctx;
  const player = world.player;
  const motion = player.motion;
  if (!motion) return false;

  const stepLen = Math.min(motion.speed * dt, motion.remaining);
  const target = add(player.pos, scale(motion.dir, stepLen));
  const clamped = clampToArena(target, player.radius, content);
  const blocked = clamped.x !== target.x || clamped.y !== target.y;
  player.pos = clamped;
  motion.remaining -= stepLen;

  if (motion.hitRadius > 0) {
    const action = findAction(ctx, motion.actionId);
    for (const mob of world.mobs) {
      if (mob.life <= 0 || motion.hitIds.includes(mob.id)) continue;
      if (distance(mob.pos, player.pos) > motion.hitRadius + getMob(content, mob.defId).radius) continue;
      motion.hitIds.push(mob.id);
      damageMob(ctx, action, mob);
    }
  }
  if (motion.remaining <= 0 || blocked) player.motion = undefined;
  return true;
}

export function hitArc(
  ctx: Ctx,
  action: ActionDef,
  origin: Vec2,
  facing: Vec2,
  radius: number,
  angleDeg: number,
  maxTargets?: number,
): void {
  const { world, content, events } = ctx;
  events.push({ type: 'area', actionId: action.id, origin, facing, radius, angleDeg });
  const halfAngleCos = Math.cos(((angleDeg / 2) * Math.PI) / 180);
  const targets = world.mobs
    .filter((mob) => mob.life > 0)
    .map((mob) => ({ mob, mobRadius: getMob(content, mob.defId).radius, dist: distance(origin, mob.pos) }))
    .filter(({ mob, mobRadius, dist }) => {
      if (dist > radius + mobRadius) return false;
      if (angleDeg >= 360 || dist <= mobRadius) return true;
      return dot(normalize(sub(mob.pos, origin)), facing) >= halfAngleCos;
    })
    .sort((a, b) => a.dist - b.dist || a.mob.id - b.mob.id)
    .slice(0, maxTargets ?? Infinity);
  for (const { mob } of targets) damageMob(ctx, action, mob);
}

/** Circle damage at a point (projectile explosions, traps). */
export function explode(ctx: Ctx, action: ActionDef, pos: Vec2, radius: number): void {
  hitArc(ctx, action, pos, ctx.world.player.facing, radius, 360);
}

export function damageMob(ctx: Ctx, action: ActionDef, mob: MobState): void {
  const { world, content, classDef, rng, events } = ctx;
  if (action.damage) {
    const mods = allModifiers(world.player);
    let rolled: DamageByType;
    let baseCrit: number;
    if (action.damage.source === 'weapon') {
      rolled = scaleDamage(rollBaseDamage(rng, classDef.weapon.damage), action.damage.effectiveness);
      baseCrit = classDef.weapon.critChance;
    } else {
      rolled = rollBaseDamage(rng, action.damage.base);
      baseCrit = action.damage.critChance;
    }
    const damage = computeDamage(rolled, mods, action.tags);
    const critChance = computeStat(baseCrit, mods, 'critChance', action.tags);
    const critMultiplier = computeStat(content.combat.critMultiplierBase, mods, 'critMultiplier', action.tags);
    const def = getMob(content, mob.defId);
    const hit = resolveHit(rng, { damage, critChance, critMultiplier }, { armour: def.armour, resistances: def.resistances }, content.combat);
    mob.life -= hit.total;
    events.push({ type: 'hit', targetId: mob.id, pos: mob.pos, amount: hit.total, isCrit: hit.isCrit });
  }
  for (const effect of action.onHit ?? []) applyStatus(ctx, mob, effect);
}

function applyStatus(ctx: Ctx, mob: MobState, effect: StatusEffect): void {
  if (effect.chance !== undefined && !ctx.rng.chance(effect.chance)) return;
  switch (effect.status) {
    case 'stun':
      mob.stun = Math.max(mob.stun, effect.duration);
      break;
    case 'slow': {
      const magnitude = effect.magnitude ?? 0;
      mob.slowMagnitude = mob.slow > 0 ? Math.max(mob.slowMagnitude, magnitude) : magnitude;
      mob.slow = Math.max(mob.slow, effect.duration);
      break;
    }
  }
}

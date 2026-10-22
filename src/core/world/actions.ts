import { computeDamage, rollBaseDamage, scaleDamage, type DamageByType } from '../combat/damage';
import { resolveHit } from '../combat/hit';
import { add, distance, dot, normalize, rotate, scale, sub, type Vec2 } from '../math';
import { computeStat } from '../stats/modifiers';
import type { ActionDef } from './content';
import { applyLeech } from './experience';
import { actionCost, canPay, counterAttackStats, critStats, stunBarStats } from './passiveEffects';
import { applyStatus, conditionTarget, fillStunBar } from './statuses';
import type { Modifier } from '../stats/types';
import { allModifiers, clampToArena, getMob, heroConditionalModifiers, movePlayer, type Ctx, type MobState, type PlayerState } from './state';

/** The hero's effective action (class data + skill changes, see PlayerState.actions). */
export function findAction(ctx: Ctx, id: string): ActionDef {
  const { basicAttack, skills } = ctx.world.player.actions;
  const action = basicAttack.id === id ? basicAttack : skills.find((a) => a.id === id);
  if (!action) throw new Error(`Unknown action for ${ctx.classDef.id}: ${id}`);
  return action;
}

/** Seconds the player is busy after starting this action. */
export function useTime(ctx: Ctx, action: ActionDef): number {
  const mods = allModifiers(ctx.classDef, ctx.world.player);
  if (action.tags.includes('attack')) {
    const rate = computeStat(ctx.world.player.weapon.attacksPerSecond, mods, 'attackSpeed', action.tags);
    return rate > 0 ? 1 / rate : Infinity;
  }
  const base = action.castTime ?? 0;
  if (!action.tags.includes('spell')) return base;
  return base / Math.max(0.01, computeStat(1, mods, 'castSpeed', action.tags));
}

export function pickAction(ctx: Ctx): ActionDef | undefined {
  const { input, world } = ctx;
  const player = world.player;
  const { basicAttack, skills } = player.actions;
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    if (!skill || !input.skills[i]) continue;
    if ((player.cooldowns[skill.id] ?? 0) > 0 || !canAfford(player, skill)) continue;
    return skill;
  }
  return input.basicAttack && canAfford(player, basicAttack) ? basicAttack : undefined;
}

/** True if the player can pay the action's cost now (mana, or life under blood magic: life must stay above 0). */
export function canAfford(player: PlayerState, action: ActionDef): boolean {
  return canPay(player, actionCost(player.mechanics, action.manaCost));
}

function payCost(player: PlayerState, action: ActionDef): void {
  const cost = actionCost(player.mechanics, action.manaCost);
  if (cost.pool === 'life') player.life -= cost.amount;
  else player.mana -= cost.amount;
}

export function performAction(ctx: Ctx, action: ActionDef): void {
  const { world, content, events, input } = ctx;
  const player = world.player;
  payCost(player, action);
  if (action.cooldown > 0) player.cooldowns[action.id] = action.cooldown;
  player.actionTimer = useTime(ctx, action);
  events.push({ type: 'action', actionId: action.id, facing: player.facing });

  const delivery = action.delivery;
  switch (delivery.kind) {
    case 'arc':
      hitArc(ctx, action, player.pos, player.facing, delivery.radius, delivery.angleDeg, delivery.maxTargets);
      break;
    case 'projectile': {
      const castModifiers = heroConditionalModifiers(ctx.classDef, player);
      const spread = (delivery.spreadDeg * Math.PI) / 180;
      for (let i = 0; i < delivery.count; i++) {
        const offset = delivery.count > 1 ? -spread / 2 + (spread * i) / (delivery.count - 1) : 0;
        const dir = rotate(player.facing, offset);
        world.projectiles.push({
          id: world.nextId++,
          owner: 'player',
          sourceId: action.id,
          action,
          pos: add(player.pos, scale(dir, player.radius)),
          dir,
          speed: delivery.speed,
          radius: delivery.radius,
          remaining: delivery.range,
          pierceLeft: delivery.pierce,
          explodeRadius: delivery.explodeRadius ?? 0,
          hitIds: [],
          castModifiers,
        });
      }
      break;
    }
    case 'dash':
      player.motion = {
        actionId: action.id,
        action,
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
      movePlayer(player, clampToArena(add(player.pos, scale(normalize(offset), dist)), player.radius, content));
      events.push({ type: 'teleport', from, to: player.pos });
      break;
    }
    case 'trap': {
      const dist = Math.min(delivery.throwRange, distance(input.aim, player.pos));
      world.traps.push({
        id: world.nextId++,
        actionId: action.id,
        action,
        pos: clampToArena(add(player.pos, scale(player.facing, dist)), 0, content),
        armTimer: delivery.armTime,
        lifetime: delivery.lifetime,
        triggerRadius: delivery.triggerRadius,
        explodeRadius: delivery.explodeRadius,
        castModifiers: heroConditionalModifiers(ctx.classDef, player),
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
  movePlayer(player, clamped);
  motion.remaining -= stepLen;

  if (motion.hitRadius > 0) {
    const action = motion.action;
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
  castModifiers?: readonly Modifier[],
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
  for (const { mob } of targets) damageMob(ctx, action, mob, castModifiers);
}

/** Circle damage at a point (projectile explosions, traps); `castModifiers` as in damageMob. */
export function explode(ctx: Ctx, action: ActionDef, pos: Vec2, radius: number, castModifiers?: readonly Modifier[]): void {
  hitArc(ctx, action, pos, ctx.world.player.facing, radius, 360, undefined, castModifiers);
}

/**
 * Resolves one player hit on a mob. Instant hits evaluate hero conditions now (cast == hit); delayed hits
 * (projectiles, traps) pass `castModifiers`, the hero conditions locked when the action fired.
 * Target conditions (stunned / slowed / ignited / frozen target) are always evaluated at the hit, before its
 * statuses apply. On-hit statuses come from the action (cast-time snapshot for delayed hits); see applyStatus.
 * `effectiveness` scales the rolled base damage (counter-attacks). Damage hits then fill the stun bar (stunBar
 * mechanic, read live at the hit) with the life actually removed, after the on-hit statuses.
 * Only these direct hero hits fill the bar: ignite ticks and death explosions do not.
 * Fill uses the life actually removed (designer decision 2026-10-22).
 */
export function damageMob(ctx: Ctx, action: ActionDef, mob: MobState, castModifiers?: readonly Modifier[], effectiveness = 1): void {
  const { world, content, classDef, rng, events } = ctx;
  if (!action.damage && !(action.onHit && action.onHit.length > 0)) return;
  const def = getMob(content, mob.defId);
  const before = conditionTarget(mob);
  const mods = allModifiers(classDef, world.player, before, castModifiers);
  let raw: DamageByType | undefined;
  let removed = 0;
  if (action.damage) {
    let rolled: DamageByType;
    let baseCrit: number;
    if (action.damage.source === 'weapon') {
      rolled = scaleDamage(rollBaseDamage(rng, world.player.weapon.damage), action.damage.effectiveness * effectiveness);
      baseCrit = world.player.weapon.critChance;
    } else {
      rolled = rollBaseDamage(rng, action.damage.base);
      if (effectiveness !== 1) rolled = scaleDamage(rolled, effectiveness);
      baseCrit = action.damage.critChance;
    }
    const damage = computeDamage(rolled, mods, action.tags);
    const { critChance, critMultiplier } = critStats(world.player.mechanics, {
      critChance: computeStat(baseCrit, mods, 'critChance', action.tags),
      critMultiplier: computeStat(content.combat.critMultiplierBase, mods, 'critMultiplier', action.tags),
    });
    const hit = resolveHit(rng, { damage, critChance, critMultiplier }, { armour: def.armour, resistances: def.resistances }, content.combat);
    // Leech counts only the life actually removed (overkill does not leech).
    removed = Math.max(0, Math.min(hit.total, mob.life));
    mob.life -= hit.total;
    events.push({ type: 'hit', targetId: mob.id, pos: mob.pos, amount: hit.total, isCrit: hit.isCrit });
    applyLeech(classDef, world.player, removed);
    raw = hit.raw;
  }
  const hit = { mods, tags: action.tags, raw, before };
  for (const effect of action.onHit ?? []) applyStatus(ctx, mob, effect, hit);
  if (action.damage) {
    const bar = stunBarStats(world.player.mechanics);
    if (bar) fillStunBar(ctx, mob, bar, removed);
  }
}

/**
 * counterAttack: the hero survived a melee hit from `attacker`. If the internal cooldown is ready, the effective
 * basic attack (player.actions.basicAttack: its damage, tags, crit and on-hit statuses) hits the attacker directly
 * at `effectiveness`, then the cooldown restarts. Free and instant: no cost, no action timer, no basic-attack
 * delivery (no arc / projectile; only the attacker is hit), facing unchanged. Emits 'counter' for the animation.
 * It ignores the basic attack's delivery (single target, even for a ranged basic attack), costs nothing and
 * triggers while dashing / casting too (designer decision 2026-10-22).
 */
export function counterAttack(ctx: Ctx, attacker: MobState): void {
  const player = ctx.world.player;
  const counter = counterAttackStats(player.mechanics);
  if (!counter || player.counterCooldown > 0 || player.dead || attacker.life <= 0) return;
  player.counterCooldown = counter.cooldown;
  const action = player.actions.basicAttack;
  ctx.events.push({ type: 'counter', actionId: action.id, targetId: attacker.id, facing: normalize(sub(attacker.pos, player.pos)) });
  damageMob(ctx, action, attacker, undefined, counter.effectiveness);
}

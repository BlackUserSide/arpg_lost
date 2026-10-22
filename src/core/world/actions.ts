import { computeDamage, rollBaseDamage, scaleDamage, type DamageByType } from '../combat/damage';
import { resolveHit } from '../combat/hit';
import { add, distance, dot, normalize, rotate, scale, sub, type Vec2 } from '../math';
import { computeStat } from '../stats/modifiers';
import type { ActionDef } from './content';
import { applyLeech } from './experience';
import { actionReady, spendCharge } from './charges';
import { actionCost, canPay, counterAttackStats, critStats } from './passiveEffects';
import { applyStatus, conditionTarget, fillStunBar, updateAuraSlows } from './statuses';
import { resourceOnHeroHit, startResourceUse } from './resource';
import { spawnDecoy, spawnZone } from './zones';
import type { Modifier } from '../stats/types';
import { allModifiers, clampToArena, getMob, heroConditionalModifiers, movePlayer, type Ctx, type MobState, type PlayerState, type Trap } from './state';

/** The hero's effective action (class data + skill changes, see PlayerState.actions). */
export function findAction(ctx: Ctx, id: string): ActionDef {
  const { basicAttack, skills } = ctx.world.player.actions;
  const action = basicAttack.id === id ? basicAttack : skills.find((a) => a.id === id);
  if (!action) throw new Error(`Unknown action for ${ctx.classDef.id}: ${id}`);
  return action;
}

/** Seconds the player is busy after starting this action. */
export function useTime(ctx: Ctx, action: ActionDef): number {
  const mods = withActionModifiers(allModifiers(ctx.classDef, ctx.world.player), action);
  if (action.tags.includes('attack')) {
    const rate = computeStat(ctx.world.player.weapon.attacksPerSecond, mods, 'attackSpeed', action.tags);
    return rate > 0 ? 1 / rate : Infinity;
  }
  const base = action.castTime ?? 0;
  if (!action.tags.includes('spell')) return base;
  return base / Math.max(0.01, computeStat(1, mods, 'castSpeed', action.tags));
}

/** The hero's modifiers plus the action's own (ActionDef.modifiers: skill level, later supports). */
function withActionModifiers(mods: readonly Modifier[], action: ActionDef): readonly Modifier[] {
  return action.modifiers && action.modifiers.length > 0 ? [...mods, ...action.modifiers] : mods;
}

export function pickAction(ctx: Ctx): ActionDef | undefined {
  const { input, world } = ctx;
  const player = world.player;
  const { basicAttack, skills } = player.actions;
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    if (!skill || !input.skills[i]) continue;
    if (!actionReady(player, skill) || !canAfford(player, skill)) continue;
    return skill;
  }
  return input.basicAttack && canAfford(player, basicAttack) ? basicAttack : undefined;
}

/** True if the player can pay the action's cost now (class resource, or life under blood magic: life must stay above 0). */
export function canAfford(player: PlayerState, action: ActionDef): boolean {
  return canPay(player, actionCost(player.mechanics, action.resourceCost));
}

function payCost(player: PlayerState, action: ActionDef): void {
  const cost = actionCost(player.mechanics, action.resourceCost);
  if (cost.pool === 'life') player.life -= cost.amount;
  else player.resource -= cost.amount;
}

export function performAction(ctx: Ctx, action: ActionDef): void {
  const { world, content, events, input } = ctx;
  const player = world.player;
  payCost(player, action);
  startResourceUse(ctx.classDef, player, action);
  spendCharge(player, action);
  player.actionTimer = useTime(ctx, action);
  events.push({ type: 'action', actionId: action.id, facing: player.facing });

  const delivery = action.delivery;
  switch (delivery.kind) {
    case 'arc': {
      const special = delivery.everyNth !== undefined && countUse(player, action.id) % Math.max(1, Math.floor(delivery.everyNth.every)) === 0;
      const angleDeg = special && delivery.everyNth ? delivery.everyNth.angleDeg : delivery.angleDeg;
      hitArc(ctx, action, player.pos, player.facing, delivery.radius, angleDeg, {
        ...(delivery.maxTargets !== undefined ? { maxTargets: delivery.maxTargets } : {}),
        ...(special ? { trigger: 'everyNth' as const } : {}),
      });
      if (action.zone) spawnZone(ctx, action, player.pos, delivery.radius, heroConditionalModifiers(ctx.classDef, player));
      break;
    }
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
          travelled: 0,
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
      const trap: Trap = {
        id: world.nextId++,
        actionId: action.id,
        action,
        pos: clampToArena(add(player.pos, scale(player.facing, dist)), 0, content),
        armTimer: delivery.armTime,
        lifetime: delivery.lifetime,
        triggerRadius: delivery.triggerRadius,
        explodeRadius: delivery.explodeRadius,
        chain: delivery.chain ?? null,
        aura: delivery.aura ?? null,
        chainTimer: null,
        castModifiers: heroConditionalModifiers(ctx.classDef, player),
      };
      placeTrap(ctx, trap, delivery.maxActive);
      break;
    }
    case 'self':
      break;
  }

  for (const effect of action.selfEffects ?? []) {
    switch (effect.kind) {
      case 'invulnerable':
        player.invulnerable = Math.max(player.invulnerable, effect.duration);
        break;
      case 'buff':
        player.buffs = player.buffs.filter((b) => b.id !== effect.id);
        player.buffs.push({ id: effect.id, modifiers: effect.modifiers, remaining: effect.duration });
        break;
      case 'decoy':
        // Where the hero stood when the action started: a dash has not moved them yet (updateMotion runs next step).
        spawnDecoy(ctx, effect, player.pos, player.radius);
        break;
    }
  }
}

/** Counts one more use of the action for its use rhythm (PlayerState.useCounts); returns the new count. */
function countUse(player: PlayerState, actionId: string): number {
  const count = (player.useCounts[actionId] ?? 0) + 1;
  player.useCounts[actionId] = count;
  return count;
}

/**
 * Adds a hero trap under the active-trap cap `maxActive` (undefined = no cap). The cap counts every hero trap,
 * whatever action threw it, so any trap source (e.g. a fan of traps) shares it: while the cap is reached the
 * oldest trap (lowest id) is removed without exploding ('trapRemoved' event).
 */
// Designer decision 2026-10-22: over the cap the oldest trap vanishes without exploding.
export function placeTrap(ctx: Ctx, trap: Trap, maxActive: number | undefined): void {
  const { world, events } = ctx;
  let removed = false;
  if (maxActive !== undefined) {
    const cap = Math.max(1, Math.floor(maxActive));
    while (world.traps.length >= cap) {
      const oldest = world.traps.reduce((a, b) => (b.id < a.id ? b : a));
      world.traps = world.traps.filter((t) => t !== oldest);
      events.push({ type: 'trapRemoved', trapId: oldest.id, pos: oldest.pos, reason: 'limit' });
      // A removed trap's aura ends now, not at the next updateTraps.
      removed = true;
    }
  }
  world.traps.push(trap);
  if (removed) updateAuraSlows(ctx);
}

/**
 * Advances a dash: moves the player and hits enemies along the path once. Returns true while dashing.
 * When the dash ends (distance covered or blocked by the arena edge) and its delivery has a landing, everyone
 * around the hero is hit once more at the landing's effectiveness ('area' event with trigger 'dashLanding'),
 * including targets already hit on the way. A dash cut short by the hero's death has no landing.
 */
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
  if (motion.remaining <= 0 || blocked) {
    player.motion = undefined;
    const delivery = motion.action.delivery;
    if (delivery.kind === 'dash' && delivery.landing && !player.dead) {
      hitArc(ctx, motion.action, player.pos, player.facing, delivery.landing.radius, 360, {
        trigger: 'dashLanding',
        effectiveness: delivery.landing.effectiveness,
      });
    }
  }
  return true;
}

export interface HitArcOptions {
  readonly maxTargets?: number;
  /** Cast-time hero conditions of a delayed hit (see damageMob). */
  readonly castModifiers?: readonly Modifier[];
  /** Marks the 'area' event of a chain-detonated trap. */
  readonly chain?: boolean;
  /** What set off the area, for render ('area' event `trigger`). */
  readonly trigger?: 'everyNth' | 'dashLanding';
  /** Scales the rolled damage of every hit (see damageMob). */
  readonly effectiveness?: number;
}

/** Hits every living mob in the sector (closest first, up to maxTargets). Returns the ids of the mobs it hit, in order. */
export function hitArc(ctx: Ctx, action: ActionDef, origin: Vec2, facing: Vec2, radius: number, angleDeg: number, opts: HitArcOptions = {}): number[] {
  const { world, content, events } = ctx;
  const { maxTargets, castModifiers, chain = false, trigger, effectiveness = 1 } = opts;
  events.push({
    type: 'area',
    actionId: action.id,
    origin,
    facing,
    radius,
    angleDeg,
    ...(chain ? { chain: true as const } : {}),
    ...(trigger ? { trigger } : {}),
  });
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
  for (const { mob } of targets) damageMob(ctx, action, mob, castModifiers, effectiveness);
  return targets.map(({ mob }) => mob.id);
}

export interface ExplodeOptions {
  /** Marks the 'area' event of a chain-detonated trap. */
  readonly chain?: boolean;
  /**
   * Cast snapshot for the ground zone left behind, when the explosion's hits carry hit-only modifiers on top of it
   * (a projectile's distanceDamage). Omit: the explosion's `castModifiers`.
   */
  readonly zoneModifiers?: readonly Modifier[];
}

/**
 * Circle damage at a point (projectile explosions, traps); `castModifiers` as in damageMob. Leaves the action's
 * ground zone there (ActionDef.zone) with the cast snapshot (opts.zoneModifiers). Returns the ids of the mobs hit.
 */
export function explode(ctx: Ctx, action: ActionDef, pos: Vec2, radius: number, castModifiers?: readonly Modifier[], opts: ExplodeOptions = {}): number[] {
  const { chain = false, zoneModifiers = castModifiers ?? [] } = opts;
  const hit = hitArc(ctx, action, pos, ctx.world.player.facing, radius, 360, { ...(castModifiers ? { castModifiers } : {}), chain });
  if (action.zone) spawnZone(ctx, action, pos, radius, zoneModifiers);
  return hit;
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
 * Every damage hit also puts the hero back in combat for resource decay and may grant class resource
 * (ResourceDef.onHit, see resourceOnHeroHit).
 */
export function damageMob(ctx: Ctx, action: ActionDef, mob: MobState, castModifiers?: readonly Modifier[], effectiveness = 1): void {
  const { world, content, classDef, rng, events } = ctx;
  if (!action.damage && !(action.onHit && action.onHit.length > 0)) return;
  const def = getMob(content, mob.defId);
  const before = conditionTarget(mob);
  const mods = withActionModifiers(allModifiers(classDef, world.player, before, castModifiers), action);
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
    resourceOnHeroHit(classDef, world.player, action);
    raw = hit.raw;
  }
  const hit = { mods, tags: action.tags, raw, before };
  for (const effect of action.onHit ?? []) applyStatus(ctx, mob, effect, hit);
  if (action.damage) {
    const bar = world.player.stunBarStats;
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
  // An attacker exactly on the hero has no direction: fall back to the hero's facing.
  const toAttacker = normalize(sub(attacker.pos, player.pos));
  const facing = toAttacker.x !== 0 || toAttacker.y !== 0 ? toAttacker : player.facing;
  ctx.events.push({ type: 'counter', actionId: action.id, targetId: attacker.id, facing });
  startResourceUse(ctx.classDef, player, action);
  damageMob(ctx, action, attacker, undefined, counter.effectiveness);
}

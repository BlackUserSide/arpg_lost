import { computeDamage, rollBaseDamage, scaleDamage, type DamageByType } from '../combat/damage';
import { resolveHit } from '../combat/hit';
import { add, distance, dot, normalize, rotate, scale, sub, type Vec2 } from '../math';
import { computeStat } from '../stats/modifiers';
import type { ActionDef, KnockbackDef } from './content';
import { applyLeech } from './experience';
import { actionReady, spendCharge } from './charges';
import { actionCost, canPay, counterAttackStats, critStats } from './passiveEffects';
import { applyStatus, conditionTarget, fillStunBar, updateAuraSlows } from './statuses';
import { recoverResource, resourceOnHeroHit, startResourceUse } from './resource';
import { spawnDecoy, spawnZone } from './zones';
import type { DamageType, Modifier } from '../stats/types';
import { allModifiers, clampToArena, getMob, heroConditionalModifiers, isImmune, mobDefences, mobRank, movePlayer, type Ctx, type MobState, type PendingEcho, type PlayerState, type Trap } from './state';

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
  const { world, events, input, rng } = ctx;
  const player = world.player;
  payCost(player, action);
  startResourceUse(ctx.classDef, player, action);
  spendCharge(player, action);
  player.actionTimer = useTime(ctx, action);
  events.push({ type: 'action', actionId: action.id, facing: player.facing });

  const delivery = action.delivery;
  const special = delivery.kind === 'arc' && delivery.everyNth !== undefined && countUse(player, action.id) % Math.max(1, Math.floor(delivery.everyNth.every)) === 0;
  const use: ActionUse = { facing: player.facing, aim: input.aim, special };
  deliver(ctx, action, use);

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

  // Echo: one chance draw per use, after the use's own hits.
  if (action.echo && rng.chance(action.echo.chance)) {
    player.echoes.push({ actionId: action.id, action, timer: action.echo.delay, facing: use.facing, aim: use.aim, ...(special ? { special } : {}) });
  }
}

/** How one use (or its echo) is aimed. */
interface ActionUse {
  readonly facing: Vec2;
  readonly aim: Vec2;
  /** Arc: the every-N-th special swing. */
  readonly special: boolean;
}

/**
 * Echo repeats for one step: timers run down (also while dashing or busy); a due echo fires its action's delivery
 * from the hero's current position with the facing and aim locked at the original use ('echo' event first). Free:
 * no cost, charge, cooldown, action time or resource-hit count restart, no self effects (Echo never fits buffs or
 * movement skills), not counted as a use, never echoes again; an every-N-th special swing repeats as special.
 */
export function updateEchoes(ctx: Ctx, dt: number): void {
  const player = ctx.world.player;
  if (player.echoes.length === 0) return;
  const due: PendingEcho[] = [];
  for (const echo of player.echoes) {
    echo.timer = echo.timer - dt > TIME_EPSILON ? echo.timer - dt : 0;
    if (echo.timer <= 0) due.push(echo);
  }
  if (due.length === 0) return;
  player.echoes = player.echoes.filter((e) => !due.includes(e));
  for (const echo of due) {
    ctx.events.push({ type: 'echo', actionId: echo.actionId, pos: player.pos, facing: echo.facing });
    deliver(ctx, echo.action, { facing: echo.facing, aim: echo.aim, special: echo.special === true });
  }
}

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** Resolves the action's delivery for one use: hits, projectiles, motion, teleport or trap. */
function deliver(ctx: Ctx, action: ActionDef, use: ActionUse): void {
  const { world, events } = ctx;
  const player = world.player;
  const delivery = action.delivery;
  switch (delivery.kind) {
    case 'arc': {
      const angleDeg = use.special && delivery.everyNth ? delivery.everyNth.angleDeg : delivery.angleDeg;
      hitArc(ctx, action, player.pos, use.facing, delivery.radius, angleDeg, {
        ...(delivery.maxTargets !== undefined ? { maxTargets: delivery.maxTargets } : {}),
        ...(use.special ? { trigger: 'everyNth' as const } : {}),
      });
      if (action.zone) spawnZone(ctx, action, player.pos, delivery.radius, heroConditionalModifiers(ctx.classDef, player));
      break;
    }
    case 'projectile': {
      const castModifiers = heroConditionalModifiers(ctx.classDef, player);
      const spread = (delivery.spreadDeg * Math.PI) / 180;
      for (let i = 0; i < delivery.count; i++) {
        const offset = delivery.count > 1 ? -spread / 2 + (spread * i) / (delivery.count - 1) : 0;
        const dir = rotate(use.facing, offset);
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
        dir: use.facing,
        speed: delivery.speed,
        hitRadius: delivery.hitRadius,
        remaining: delivery.distance,
        hitIds: [],
      };
      break;
    case 'teleport': {
      const offset = sub(use.aim, player.pos);
      const dist = Math.min(delivery.range, distance(use.aim, player.pos));
      const from = player.pos;
      movePlayer(player, clampToArena(add(player.pos, scale(normalize(offset), dist)), player.radius, ctx.world));
      events.push({ type: 'teleport', from, to: player.pos });
      break;
    }
    case 'trap': {
      const dist = Math.min(delivery.throwRange, distance(use.aim, player.pos));
      const trap: Trap = {
        id: world.nextId++,
        actionId: action.id,
        action,
        pos: clampToArena(add(player.pos, scale(use.facing, dist)), 0, ctx.world),
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
  const { world } = ctx;
  const player = world.player;
  const motion = player.motion;
  if (!motion) return false;

  const stepLen = Math.min(motion.speed * dt, motion.remaining);
  const target = add(player.pos, scale(motion.dir, stepLen));
  const clamped = clampToArena(target, player.radius, ctx.world);
  const blocked = clamped.x !== target.x || clamped.y !== target.y;
  movePlayer(player, clamped);
  motion.remaining -= stepLen;

  if (motion.hitRadius > 0) {
    const action = motion.action;
    for (const mob of world.mobs) {
      if (mob.life <= 0 || motion.hitIds.includes(mob.id)) continue;
      if (distance(mob.pos, player.pos) > motion.hitRadius + mob.radius) continue;
      motion.hitIds.push(mob.id);
      damageMob(ctx, action, mob);
      releaseChain(ctx, action, mob, motion.hitIds);
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
  const { world, events } = ctx;
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
    .map((mob) => ({ mob, mobRadius: mob.radius, dist: distance(origin, mob.pos) }))
    .filter(({ mob, mobRadius, dist }) => {
      if (dist > radius + mobRadius) return false;
      if (angleDeg >= 360 || dist <= mobRadius) return true;
      return dot(normalize(sub(mob.pos, origin)), facing) >= halfAngleCos;
    })
    .sort((a, b) => a.dist - b.dist || a.mob.id - b.mob.id)
    .slice(0, maxTargets ?? Infinity);
  for (const { mob } of targets) damageMob(ctx, action, mob, castModifiers, effectiveness);
  const hitIds = targets.map(({ mob }) => mob.id);
  const first = targets[0];
  if (first) releaseChain(ctx, action, first.mob, hitIds, castModifiers);
  return hitIds;
}

/**
 * Chain Lightning (ActionDef.chainHit, designer decision 2026-10-23): one impact of the action (an area that hit
 * someone, a projectile contact hit, a dash path hit) releases a bolt from `from` (the first target of the impact,
 * even if the impact killed it). The path is picked first, from mobs alive now: up to `hops` times the nearest living
 * mob within chain.range (+ its radius) of the previous point that is not in `excludeIds` (the impact's targets) and
 * not hit by the bolt yet (ties: lower id). One 'chain' event, then each bolt target is hit by the action at
 * chain.effectiveness × its rolled base damage, all converted to chain.damageType (it scales with skill level,
 * passives and damage modifiers like any hit of the action, and can crit, leech, gain resource and fill the stun
 * bar), without on-hit statuses, knockback, zones or further chains.
 */
// Designer decision: every impact chains, so each projectile of a fan and each Fireball split child releases its own bolt.
export function releaseChain(ctx: Ctx, action: ActionDef, from: MobState, excludeIds: readonly number[], castModifiers?: readonly Modifier[]): void {
  const chain = action.chainHit;
  if (!chain || !action.damage || chain.hops < 1) return;
  const { world } = ctx;
  const hit = new Set(excludeIds);
  hit.add(from.id);
  const path: MobState[] = [];
  let current = from.pos;
  for (let hop = 0; hop < Math.floor(chain.hops); hop++) {
    let best: { mob: MobState; dist: number } | undefined;
    for (const mob of world.mobs) {
      if (mob.life <= 0 || hit.has(mob.id)) continue;
      const dist = distance(current, mob.pos);
      if (dist > chain.range + mob.radius) continue;
      if (!best || dist < best.dist || (dist === best.dist && mob.id < best.mob.id)) best = { mob, dist };
    }
    if (!best) break;
    hit.add(best.mob.id);
    path.push(best.mob);
    current = best.mob.pos;
  }
  if (path.length === 0) return;
  ctx.events.push({
    type: 'chain',
    actionId: action.id,
    fromId: from.id,
    targetIds: path.map((m) => m.id),
    points: [from.pos, ...path.map((m) => m.pos)],
    damageType: chain.damageType,
  });
  const bolt = chainBoltAction(action, chain.damageType);
  for (const mob of path) damageMob(ctx, bolt, mob, castModifiers, chain.effectiveness);
}

/** The action a chain bolt hits with: same damage, tags and own modifiers, fully converted, without extras. */
function chainBoltAction(action: ActionDef, damageType: DamageType): ActionDef {
  const { onHit, knockback, chainHit, echo, zone, resourcePerHit, ...rest } = action;
  void resourcePerHit;
  void onHit;
  void knockback;
  void chainHit;
  void echo;
  void zone;
  return { ...rest, damageConversion: { to: damageType, fraction: 1 } };
}

/**
 * Knockback (ActionDef.knockback, designer decision 2026-10-23): pushes a living mob away from the hero (the hero's
 * facing if they overlap) by distance (× eliteMultiplier for elites) at speed. Bosses are never pushed (no draw).
 * With a chance: one draw per hit. A new push replaces a running one. Movement: updateMobs (moveKnockback).
 */
function applyKnockback(ctx: Ctx, mob: MobState, knockback: KnockbackDef): void {
  if (mob.life <= 0) return;
  const rank = mobRank(getMob(ctx.content, mob.defId), mob);
  if (rank === 'boss') return;
  if (knockback.chance !== undefined && !ctx.rng.chance(knockback.chance)) return;
  const dist = knockback.distance * (rank === 'elite' ? knockback.eliteMultiplier : 1);
  if (dist <= 0 || knockback.speed <= 0) return;
  const player = ctx.world.player;
  const away = normalize(sub(mob.pos, player.pos));
  const dir = away.x !== 0 || away.y !== 0 ? away : player.facing;
  mob.knockback = { dir, speed: knockback.speed, remaining: dist };
  ctx.events.push({ type: 'knockback', targetId: mob.id, pos: mob.pos, dir, distance: dist });
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
 * The action's resourcePerHit (uniques) is granted for every damage hit, after the onHit gain.
 * Support extras of the action: damageConversion before scaling, its own leech (ActionDef.leech) added to the
 * hero's, its stun bar fill bonus, and knockback last (applyKnockback).
 */
export function damageMob(ctx: Ctx, action: ActionDef, mob: MobState, castModifiers?: readonly Modifier[], effectiveness = 1): void {
  const { world, content, classDef, rng, events } = ctx;
  if (!action.damage && !(action.onHit && action.onHit.length > 0)) return;
  if (isImmune(mob)) {
    events.push({ type: 'immune', targetId: mob.id, pos: mob.pos });
    return;
  }
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
    const damage = computeDamage(rolled, mods, action.tags, action.damageConversion);
    const { critChance, critMultiplier } = critStats(world.player.mechanics, {
      critChance: computeStat(baseCrit, mods, 'critChance', action.tags),
      critMultiplier: computeStat(content.combat.critMultiplierBase, mods, 'critMultiplier', action.tags),
    });
    const hit = resolveHit(rng, { damage, critChance, critMultiplier }, mobDefences(def, mob), content.combat);
    // Leech counts only the life actually removed (overkill does not leech).
    removed = Math.max(0, Math.min(hit.total, mob.life));
    mob.life -= hit.total;
    events.push({ type: 'hit', targetId: mob.id, pos: mob.pos, amount: hit.total, isCrit: hit.isCrit });
    applyLeech(classDef, world.player, removed, action.leech ?? 0);
    resourceOnHeroHit(classDef, world.player, action);
    if (action.resourcePerHit) recoverResource(classDef, world.player, action.resourcePerHit);
    raw = hit.raw;
  }
  const hit = { mods, tags: action.tags, raw, before };
  for (const effect of action.onHit ?? []) applyStatus(ctx, mob, effect, hit);
  if (action.damage) {
    const bar = world.player.stunBarStats;
    if (bar) fillStunBar(ctx, mob, bar, removed, action.stunBarFillIncreased ?? 0);
  }
  if (action.knockback) applyKnockback(ctx, mob, action.knockback);
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

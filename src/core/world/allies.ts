// Raised allies (legendary Eye of the Abyss, docs/design/items.md; the raiseAllies PassiveMechanic; designer changes
// 2026-10-26 in docs/design/overnight-questions.md). Plain JSON entities on WorldState.allies; pure functions over the
// step context.
//
// - Raise (removeDeadMobs → onMobDeath): every non-boss mob death (minions included, whatever killed it, allies too)
//   raises an ally of the mechanic's mob def at the dead mob's position; past the cap the oldest crumbles first
//   ('allyExpire' cap, then 'allySpawn'). Strength: def life / attack × the mechanic's multipliers × the area's mob
//   scaling (WorldState.mobScale), so a skeleton grows with the map like the mobs it copies.
// - AI (updateAllies, after the hero, before the mobs): the living mob nearest to the ally among those within
//   leashRadius of the hero; it walks up to it and swings its def's attack (always melee, instant) when in reach and
//   its attack timer is ready. No such mob: it follows the hero up to followDistance. Allies push each other apart.
// - Ally hits (allyHitMob): rolled def damage × damageScale, the def's crit chance and the base crit multiplier,
//   against the mob's defences. None of the hero's modifiers, leech, resource gains, statuses, stun bar or
//   knockback. The hit that brings a mob to 0 marks it killedBy 'ally'.
// - Enemies hit allies (damageAlly): mobs target the nearest of hero and allies (mobTarget, bosses excepted); melee
//   swings, mob projectiles that touch an ally (they stop at the first ally in their way, like a body block),
//   novas and hostile zones damage allies with the same rolls as the hero (damage scale, elite conversion), against
//   the ally's armour and its def's resistances; no statuses. At 0 life the ally crumbles ('allyExpire' killed).
// - Ally kill (onMobDeath): + resourcePerKill × max class resource ('allyKill'); every other reward is the normal one.
// - Lifetime: world time, also during a time stop (allies are on the hero's side and keep acting). A new room of a
//   map run clears them (core/run enterRoom), like decoys and zones.

import { convertedDamage, rollBaseDamage, scaleDamage, type BaseDamage } from '../combat/damage';
import { resolveHit } from '../combat/hit';
import { add, distance, normalize, scale, sub, vec } from '../math';
import { eliteModifierDef } from './eliteModifiers';
import { findMechanic, type MechanicOf } from './passiveEffects';
import { maxResource, recoverResource } from './resource';
import { clampToArena, getMob, isImmune, MELEE_APPROACH, mobDefences, mobRank, type Ally, type Ctx, type MobState, type PlayerState, type WorldState } from './state';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

const NO_ALLIES: readonly Ally[] = [];


/** The hero's raiseAllies mechanic, or undefined without one (render: ally HUD / looks only then). */
export function raiseAlliesStats(player: Pick<PlayerState, 'mechanics'>): MechanicOf<'raiseAllies'> | undefined {
  return findMechanic(player.mechanics, 'raiseAllies');
}

/** Living allies (life > 0). */
export function livingAllies(world: Pick<WorldState, 'allies'>): Ally[] {
  return world.allies.filter((a) => a.life > 0);
}

/**
 * A mob died (removeDeadMobs, after its rewards): an ally's killing blow restores resource ('allyKill'), then a
 * non-boss death raises an ally (with the hero's raiseAllies mechanic).
 */
export function onMobDeath(ctx: Ctx, mob: MobState): void {
  const player = ctx.world.player;
  const stats = raiseAlliesStats(player);
  if (!stats || player.dead) return;
  if (mob.killedBy === 'ally') {
    const resource = recoverResource(ctx.classDef, player, stats.resourcePerKill * maxResource(ctx.classDef, player));
    ctx.events.push({ type: 'allyKill', mobId: mob.id, pos: mob.pos, resource });
  }
  if (mobRank(getMob(ctx.content, mob.defId), mob) === 'boss') return;
  raiseAlly(ctx, stats, mob);
}

/** Raises one ally from the dead `mob` (cap: the oldest living ally crumbles first). Returns it. */
export function raiseAlly(ctx: Ctx, stats: MechanicOf<'raiseAllies'>, mob: MobState): Ally | undefined {
  const { world, content, events } = ctx;
  if (stats.max < 1 || stats.duration <= 0) return undefined;
  removeDeadAllies(world);
  while (world.allies.length >= stats.max) {
    const oldest = world.allies.shift()!;
    oldest.life = 0;
    events.push({ type: 'allyExpire', allyId: oldest.id, pos: oldest.pos, reason: 'cap' });
  }
  const def = getMob(content, stats.mobId);
  const level = world.mobScale;
  const life = def.life * stats.lifeMultiplier * (level?.life ?? 1);
  const ally: Ally = {
    kind: 'ally',
    id: world.nextId++,
    defId: def.id,
    pos: clampToArena(vec(mob.pos.x, mob.pos.y), def.radius, world),
    facing: vec(mob.facing.x, mob.facing.y),
    radius: def.radius,
    life,
    maxLife: life,
    damageScale: stats.damageMultiplier * (level?.damage ?? 1),
    armour: def.armour * (level?.armour ?? 1),
    moveSpeed: def.moveSpeed * stats.moveSpeedMultiplier,
    leashRadius: stats.leashRadius,
    followDistance: stats.followDistance,
    remaining: stats.duration,
    duration: stats.duration,
    attackTimer: 0,
  };
  world.allies.push(ally);
  events.push({ type: 'allySpawn', allyId: ally.id, mobId: mob.id, defId: def.id, pos: ally.pos, duration: stats.duration, life });
  return ally;
}

/**
 * Every ally for one step (hero time: also during a time stop). Lifetime first (an ally raised at the end of step n
 * crumbles at the start of step n + duration / dt), then the AI (target / follow, attack), then allies push apart.
 */
export function updateAllies(ctx: Ctx, dt: number): void {
  const { world, events } = ctx;
  // A hero who died earlier this step (a burn) ends the fight: the allies stand still (step stops from the next one).
  if (world.allies.length === 0 || world.player.dead) return;
  for (const ally of world.allies) {
    if (ally.life <= 0) continue;
    ally.remaining = ally.remaining - dt > TIME_EPSILON ? ally.remaining - dt : 0;
    if (ally.remaining === 0) {
      ally.life = 0;
      events.push({ type: 'allyExpire', allyId: ally.id, pos: ally.pos, reason: 'timeout' });
      continue;
    }
    actAlly(ctx, ally, dt);
  }
  removeDeadAllies(world);
  separateAllies(world);
}

/** The ally's target: the living mob nearest to it among those within its leashRadius of the hero (ties: earlier mob). */
export function allyTarget(world: Pick<WorldState, 'mobs' | 'player'>, ally: Ally): MobState | undefined {
  let best: MobState | undefined;
  let bestDist = Infinity;
  for (const mob of world.mobs) {
    if (mob.life <= 0 || distance(mob.pos, world.player.pos) > ally.leashRadius) continue;
    const d = distance(mob.pos, ally.pos);
    if (d < bestDist) {
      best = mob;
      bestDist = d;
    }
  }
  return best;
}

function actAlly(ctx: Ctx, ally: Ally, dt: number): void {
  const { world, content, events } = ctx;
  const def = getMob(content, ally.defId);
  ally.attackTimer = ally.attackTimer - dt > TIME_EPSILON ? ally.attackTimer - dt : 0;
  const maxStep = ally.moveSpeed * dt;
  const target = allyTarget(world, ally);
  if (!target) {
    // Follow the hero, stopping followDistance away (centre to centre).
    const player = world.player;
    const d = distance(player.pos, ally.pos);
    if (d > ally.followDistance) {
      const dir = normalize(sub(player.pos, ally.pos));
      ally.facing = dir;
      ally.pos = clampToArena(add(ally.pos, scale(dir, Math.min(maxStep, d - ally.followDistance))), ally.radius, world);
    }
    return;
  }
  const toTarget = normalize(sub(target.pos, ally.pos));
  if (toTarget.x !== 0 || toTarget.y !== 0) ally.facing = toTarget;
  const gap = distance(target.pos, ally.pos) - target.radius - ally.radius;
  if (gap > def.attack.range * MELEE_APPROACH) {
    ally.pos = clampToArena(add(ally.pos, scale(toTarget, Math.min(maxStep, gap))), ally.radius, world);
  }
  if (gap <= def.attack.range && ally.attackTimer <= 0) {
    ally.attackTimer = def.attack.interval;
    events.push({ type: 'allyAttack', allyId: ally.id, targetId: target.id, facing: ally.facing });
    allyHitMob(ctx, ally, target);
  }
}

/**
 * An ally's hit on a mob: its def's attack damage rolled × damageScale, the def's crit chance, the base crit
 * multiplier, against the mob's defences ('hit' with source 'ally'). An immune mob takes nothing ('immune'). The hit
 * that brings the mob to 0 marks it killedBy 'ally'.
 */
export function allyHitMob(ctx: Ctx, ally: Ally, mob: MobState): void {
  const { content, rng, events } = ctx;
  if (mob.life <= 0) return;
  if (isImmune(mob)) {
    events.push({ type: 'immune', targetId: mob.id, pos: mob.pos });
    return;
  }
  const def = getMob(content, ally.defId);
  const rolled = rollBaseDamage(rng, def.attack.damage);
  const damage = ally.damageScale === 1 ? rolled : scaleDamage(rolled, ally.damageScale);
  const hit = resolveHit(
    rng,
    { damage, critChance: def.attack.critChance, critMultiplier: content.combat.critMultiplierBase },
    mobDefences(getMob(content, mob.defId), mob),
    content.combat,
  );
  mob.life -= hit.total;
  events.push({ type: 'hit', targetId: mob.id, pos: mob.pos, amount: hit.total, isCrit: hit.isCrit, source: 'ally', allyId: ally.id });
  if (mob.life <= 0) mob.killedBy = 'ally';
}

/** Where an enemy hit on an ally comes from (the same snapshots as a hit on the hero). */
export interface AllyHitSource {
  readonly damageScale?: number | undefined;
  readonly eliteModifier?: string | undefined;
}

/**
 * An enemy hit on an ally: `base` rolled × damageScale, converted by the source's elite modifier, crit with the base
 * multiplier, mitigated by the ally's armour and its def's resistances ('allyHit'). No statuses. At 0 life it crumbles
 * ('allyExpire' killed; removed later in the step). Returns false when nothing landed (ally already dead).
 */
export function damageAlly(ctx: Ctx, ally: Ally, base: BaseDamage, critChance: number, source: AllyHitSource = {}): boolean {
  const { content, rng, events } = ctx;
  if (ally.life <= 0) return false;
  const damageScale = source.damageScale ?? 1;
  const mod = eliteModifierDef(content, source.eliteModifier);
  const rolled = rollBaseDamage(rng, base);
  const scaled = damageScale === 1 ? rolled : scaleDamage(rolled, damageScale);
  const damage = mod?.damageConversion ? convertedDamage(scaled, mod.damageConversion) : scaled;
  const def = getMob(content, ally.defId);
  const hit = resolveHit(
    rng,
    { damage, critChance, critMultiplier: content.combat.critMultiplierBase },
    { armour: ally.armour, resistances: def.resistances },
    content.combat,
  );
  ally.life -= hit.total;
  events.push({ type: 'allyHit', allyId: ally.id, pos: ally.pos, amount: hit.total, isCrit: hit.isCrit });
  if (ally.life <= 0) {
    ally.life = 0;
    events.push({ type: 'allyExpire', allyId: ally.id, pos: ally.pos, reason: 'killed' });
  }
  return true;
}

/** The first living ally whose body a point-sized body of `radius` at `pos` touches (mob projectiles). */
export function allyAt(world: Pick<WorldState, 'allies'>, pos: { x: number; y: number }, radius: number): Ally | undefined {
  return world.allies.find((a) => a.life > 0 && distance(pos, a.pos) <= radius + a.radius);
}

/** Living allies whose body overlaps a circle (novas, hostile zones): centre within radius + ally radius. */
export function alliesInside(world: Pick<WorldState, 'allies'>, pos: { x: number; y: number }, radius: number): readonly Ally[] {
  if (world.allies.length === 0) return NO_ALLIES;
  return world.allies.filter((a) => a.life > 0 && distance(pos, a.pos) <= radius + a.radius);
}

/** Removes allies killed during the step (their 'allyExpire' was already sent); allocates only if one died. */
export function removeDeadAllies(world: Pick<WorldState, 'allies'>): void {
  if (world.allies.some((a) => a.life <= 0)) world.allies = livingAllies(world);
}

/** Pushes overlapping allies apart (half each way), then keeps them in the room. */
function separateAllies(world: WorldState): void {
  const allies = world.allies;
  for (let i = 0; i < allies.length; i++) {
    const a = allies[i]!;
    for (let j = i + 1; j < allies.length; j++) {
      const b = allies[j]!;
      const d = distance(a.pos, b.pos);
      const overlap = a.radius + b.radius - d;
      if (overlap <= 0) continue;
      const dir = d > 0 ? scale(sub(b.pos, a.pos), 1 / d) : vec(1, 0);
      a.pos = sub(a.pos, scale(dir, overlap / 2));
      b.pos = add(b.pos, scale(dir, overlap / 2));
    }
  }
  for (const a of allies) a.pos = clampToArena(a.pos, a.radius, world);
}

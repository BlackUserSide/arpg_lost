// Hero ground zones (GroundZoneDef: fire puddle, ice field) and decoys (SelfEffect 'decoy'), plus how mobs pick
// their target. Plain JSON entities on WorldState (zones, decoys); pure functions over the step context.

import { computeDamage, rollBaseDamage, totalDamage } from '../combat/damage';
import { mitigate } from '../combat/mitigation';
import { distance, type Vec2 } from '../math';
import type { Modifier } from '../stats/types';
import type { ActionDef, SelfEffect } from './content';
import { allModifiers, getMob, type Ctx, type Decoy, type GroundZone, type MobState, type WorldState } from './state';
import { applyStatus, conditionTarget, updateAuraSlows } from './statuses';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/**
 * Leaves the action's ground zone (ActionDef.zone) at `pos`; `areaRadius` is the radius of the area that left it
 * (used when the zone has no radius of its own). No-op for actions without a zone.
 */
export function spawnZone(ctx: Ctx, action: ActionDef, pos: Vec2, areaRadius: number, castModifiers: readonly Modifier[]): void {
  const def = action.zone;
  if (!def || def.duration <= 0) return;
  const { world, events } = ctx;
  const zone: GroundZone = {
    id: world.nextId++,
    actionId: action.id,
    kind: def.id,
    pos,
    radius: def.radius ?? areaRadius,
    remaining: def.duration,
    tickTimer: def.tick?.interval ?? 0,
    action,
    castModifiers,
  };
  world.zones.push(zone);
  events.push({ type: 'zoneSpawn', zoneId: zone.id, kind: zone.kind, actionId: zone.actionId, pos, radius: zone.radius, duration: def.duration });
}

/**
 * Advances every zone by dt: damage ticks that come due (one interval after the zone appeared, then every
 * interval; a tick due exactly at expiry still happens), then expiry ('zoneExpire'), then the area slows of
 * traps and zones are recomputed (updateAuraSlows). A zone created in this step already counts this step's dt.
 */
export function updateZones(ctx: Ctx, dt: number): void {
  const { world, events } = ctx;
  const expired: number[] = [];
  for (const zone of world.zones) {
    const tick = zone.action.zone?.tick;
    zone.remaining = snap(zone.remaining - dt);
    if (tick && tick.interval > 0) {
      zone.tickTimer = snap(zone.tickTimer - dt);
      while (zone.tickTimer <= 0 && zone.remaining > -TIME_EPSILON) {
        tickZone(ctx, zone);
        zone.tickTimer = snap(zone.tickTimer + tick.interval);
      }
    }
    if (zone.remaining <= 0) expired.push(zone.id);
  }
  if (expired.length > 0) {
    world.zones = world.zones.filter((z) => !expired.includes(z.id));
    for (const zoneId of expired) events.push({ type: 'zoneExpire', zoneId });
  }
  updateAuraSlows(ctx);
}

/** Values within float noise of 0 become 0, so timers made of fixed steps end on the intended step. */
function snap(t: number): number {
  return Math.abs(t) <= TIME_EPSILON ? 0 : t;
}

/**
 * One damage tick of a zone: the tick damage is rolled once, then for each living mob inside (+ its radius), in
 * mob order, scaled by the hero's increased / more modifiers (not flat added damage) (live, with the cast snapshot and target conditions, plus the
 * action's own modifiers) with the action's tags, mitigated, no crit. A damage over time: no leech, no resource,
 * no stun bar, no combat-idle reset. The action's ignite on-hit statuses (hero ignite sources) may apply with the
 * tick as their hit; other on-hit statuses do not.
 */
function tickZone(ctx: Ctx, zone: GroundZone): void {
  const { world, content, classDef, rng, events } = ctx;
  const tick = zone.action.zone?.tick;
  if (!tick) return;
  const targets = world.mobs.filter((mob) => mob.life > 0 && distance(mob.pos, zone.pos) <= zone.radius + mob.radius);
  if (targets.length === 0) return;
  const rolled = rollBaseDamage(rng, tick.damage);
  const action = zone.action;
  const ignites = (action.onHit ?? []).filter((e) => e.status === 'ignite');
  for (const mob of targets) {
    const def = getMob(content, mob.defId);
    const before = conditionTarget(mob);
    const heroMods = allModifiers(classDef, world.player, before, zone.castModifiers);
    const mods = action.modifiers && action.modifiers.length > 0 ? [...heroMods, ...action.modifiers] : heroMods;
    // Flat added damage is per hit, so it does not add to every tick; increased / more scale it.
    const raw = computeDamage(
      rolled,
      mods.filter((m) => m.kind !== 'flat'),
      action.tags,
    );
    const amount = totalDamage(mitigate(raw, { armour: def.armour, resistances: def.resistances }, content.combat));
    if (amount > 0) {
      mob.life -= amount;
      events.push({ type: 'hit', targetId: mob.id, pos: mob.pos, amount, isCrit: false, source: 'zone', zoneId: zone.id });
    }
    for (const effect of ignites) applyStatus(ctx, mob, effect, { mods, tags: action.tags, raw, before });
  }
}

/** Places a decoy (SelfEffect 'decoy') at `pos` with the hero's body radius. */
export function spawnDecoy(ctx: Ctx, effect: Extract<SelfEffect, { kind: 'decoy' }>, pos: Vec2, radius: number): void {
  if (effect.duration <= 0) return;
  const { world, events } = ctx;
  const decoy: Decoy = {
    id: world.nextId++,
    kind: effect.id,
    pos,
    radius,
    tauntRadius: effect.tauntRadius,
    remaining: effect.duration,
    bossTauntRemaining: Math.min(effect.duration, effect.bossTauntDuration ?? effect.duration),
  };
  world.decoys.push(decoy);
  events.push({ type: 'decoySpawn', decoyId: decoy.id, kind: decoy.kind, pos, radius, duration: effect.duration });
}

/** Decoy timers; expired decoys are removed ('decoyExpire'). A decoy created this step already counts this step's dt. */
export function updateDecoys(ctx: Ctx, dt: number): void {
  const { world, events } = ctx;
  if (world.decoys.length === 0) return;
  const expired: number[] = [];
  for (const decoy of world.decoys) {
    decoy.remaining = snap(decoy.remaining - dt);
    decoy.bossTauntRemaining = snap(decoy.bossTauntRemaining - dt);
    if (decoy.remaining <= 0) expired.push(decoy.id);
  }
  if (expired.length === 0) return;
  world.decoys = world.decoys.filter((d) => !expired.includes(d.id));
  for (const decoyId of expired) events.push({ type: 'decoyExpire', decoyId });
}

/** What a mob chases and attacks: the hero, or a decoy taunting it. */
export interface MobTarget {
  readonly pos: Vec2;
  readonly radius: number;
  /** Set when the target is a decoy. */
  readonly decoy?: Decoy;
}

/**
 * The mob's target: the closest decoy whose tauntRadius reaches the mob (centre distance; ties: lower id), else
 * the hero. Bosses (`isBoss`) are taunted only while the decoy's bossTauntRemaining > 0.
 */
// Bosses are taunted, but only for the first bossTauntDuration seconds (designer decision 2026-10-23).
export function mobTarget(world: WorldState, mob: MobState, isBoss = false): MobTarget {
  let best: Decoy | undefined;
  let bestDist = Infinity;
  for (const decoy of world.decoys) {
    if (isBoss && decoy.bossTauntRemaining <= 0) continue;
    const d = distance(decoy.pos, mob.pos);
    if (d > decoy.tauntRadius) continue;
    if (d < bestDist || (d === bestDist && best !== undefined && decoy.id < best.id)) {
      best = decoy;
      bestDist = d;
    }
  }
  if (best) return { pos: best.pos, radius: best.radius, decoy: best };
  // The hero itself (pos + radius), no per-step allocation.
  return world.player;
}

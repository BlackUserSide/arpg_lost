// Statuses on mobs (STATUS_IDS): application from hits and death explosions, damage over time.
// Pure functions over plain world state; every number comes from the status data or content.

import { totalDamage, type DamageByType } from '../combat/damage';
import { resistanceMultiplier } from '../combat/mitigation';
import { computeStat } from '../stats/modifiers';
import type { Modifier, Tag } from '../stats/types';
import type { StatusEffect } from './content';
import type { ConditionTarget } from './passiveEffects';
import { getMob, type Ctx, type MobState } from './state';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/**
 * The mob's statuses as seen by conditions (targetHasStatus, freeze-if-slowed, death explosions).
 * A boss is never frozen: while its freeze-slow runs it counts as frozen (and slowed); after that, a remaining
 * ordinary slow makes it just slowed (designer decision 2026-10-22).
 */
export function conditionTarget(mob: MobState): ConditionTarget {
  return {
    stun: mob.stun,
    slow: Math.max(mob.slow, mob.freezeSlow),
    ignite: mob.ignite,
    freeze: Math.max(mob.freeze, mob.freezeSlow),
  };
}

/** What a hit knows when it applies its statuses. */
export interface HitContext {
  /** Hero modifiers of this hit (status stats: igniteChance, igniteDamage, freezeDuration). */
  readonly mods: readonly Modifier[];
  /** Tags the status stats are computed with (the action tags). */
  readonly tags: readonly Tag[];
  /** Hit damage after crit, before defences; undefined for hits without damage. */
  readonly raw: DamageByType | undefined;
  /** The target's statuses before this hit (requiresStatus is checked against this). */
  readonly before: ConditionTarget;
}

/**
 * Applies one on-hit status. Order: requirements (status before the hit, damage type dealt), then the chance roll
 * (one rng draw, only when the effect has a chance), then the status. Statuses are recorded even on a mob the hit
 * just killed: "died ignited / frozen" includes the killing hit (death explosions read them).
 */
export function applyStatus(ctx: Ctx, mob: MobState, effect: StatusEffect, hit: HitContext): void {
  if (effect.requiresStatus !== undefined && !(hit.before[effect.requiresStatus] > 0)) return;
  if (effect.requiresDamageType !== undefined && !((hit.raw?.[effect.requiresDamageType] ?? 0) > 0)) return;
  if (effect.status === 'ignite' && hit.raw === undefined) return;
  if (effect.chance !== undefined) {
    const chance = effect.status === 'ignite' ? computeStat(effect.chance, hit.mods, 'igniteChance', hit.tags) : effect.chance;
    if (!ctx.rng.chance(chance)) return;
  }
  switch (effect.status) {
    case 'stun':
      // stunBonus is already folded into the action's stun durations (skillChangeSets), locked at cast time.
      setStun(ctx, mob, effect.duration);
      break;
    case 'slow':
      setSlow(ctx, mob, effect.magnitude ?? 0, effect.duration);
      break;
    case 'ignite':
      applyIgnite(ctx, mob, totalDamage(hit.raw ?? {}) * (effect.magnitude ?? 0), effect.duration, hit.mods, hit.tags);
      break;
    case 'freeze':
      applyFreeze(ctx, mob, effect.duration, effect.bossDuration ?? effect.duration, hit.mods, hit.tags);
      break;
  }
}

function statusEvent(ctx: Ctx, mob: MobState, status: StatusEffect['status'], duration: number): void {
  if (mob.life > 0) ctx.events.push({ type: 'status', targetId: mob.id, pos: mob.pos, status, duration });
}

function setStun(ctx: Ctx, mob: MobState, duration: number): void {
  if (duration <= 0) return;
  mob.stun = Math.max(mob.stun, duration);
  statusEvent(ctx, mob, 'stun', mob.stun);
}

/** A new slow keeps the stronger magnitude while the old one runs; duration is the longer of the two. */
function setSlow(ctx: Ctx, mob: MobState, magnitude: number, duration: number): void {
  if (duration <= 0) return;
  mob.slowMagnitude = mob.slow > 0 ? Math.max(mob.slowMagnitude, magnitude) : magnitude;
  mob.slow = Math.max(mob.slow, duration);
  statusEvent(ctx, mob, 'slow', mob.slow);
}

/**
 * Freeze for `duration` scaled by freezeDuration (base = duration). Bosses are not frozen: they get the
 * freeze-slow (CombatConfig.bossFreezeSlow, own slot MobState.freezeSlow) for `bossDuration` scaled the same way;
 * an ordinary slow they have keeps running untouched (designer decision 2026-10-22).
 */
export function applyFreeze(ctx: Ctx, mob: MobState, duration: number, bossDuration: number, mods: readonly Modifier[], tags: readonly Tag[]): void {
  const def = getMob(ctx.content, mob.defId);
  if (def.boss) {
    const time = computeStat(bossDuration, mods, 'freezeDuration', tags);
    if (time <= 0) return;
    mob.freezeSlow = Math.max(mob.freezeSlow, time);
    statusEvent(ctx, mob, 'freeze', mob.freezeSlow);
    return;
  }
  const time = computeStat(duration, mods, 'freezeDuration', tags);
  if (time <= 0) return;
  mob.freeze = Math.max(mob.freeze, time);
  statusEvent(ctx, mob, 'freeze', mob.freeze);
}

/**
 * Ignites the mob: `amount` (pre-mitigation damage of any type) scaled by igniteDamage, dealt as fire over
 * `duration`, reduced by the mob's fire resistance. Ignites do not stack: the new one replaces the current one
 * (and restarts its duration) if its damage per second is at least as high; a weaker one is ignored.
 */
export function applyIgnite(ctx: Ctx, mob: MobState, amount: number, duration: number, mods: readonly Modifier[], tags: readonly Tag[]): void {
  if (duration <= 0) return;
  const def = getMob(ctx.content, mob.defId);
  const total = computeStat(amount, mods, 'igniteDamage', tags) * resistanceMultiplier(def.resistances.fire, ctx.content.combat);
  if (total <= 0) return;
  const dps = total / duration;
  if (mob.ignite > 0 && dps < mob.igniteDps) return;
  mob.ignite = duration;
  mob.igniteDps = dps;
  statusEvent(ctx, mob, 'ignite', duration);
}

/**
 * Ignite damage for one fixed step: igniteDps × min(dt, remaining). No crit, no leech (designer decision 2026-10-22), kill credit
 * as usual (removeDeadMobs). A mob killed by its ignite keeps the ignite, so it dies ignited.
 * First tick by source: instant hero hits (updatePlayer, before updateMobs) tick in the same step; projectile / trap
 * hits and death-explosion ignites (after updateMobs) start ticking on the next step.
 */
export function tickIgnite(ctx: Ctx, mob: MobState, dt: number): void {
  if (mob.ignite <= 0 || mob.life <= 0) return;
  const time = Math.min(dt, mob.ignite);
  const amount = mob.igniteDps * time;
  mob.life -= amount;
  ctx.events.push({ type: 'dot', targetId: mob.id, pos: mob.pos, amount, status: 'ignite' });
  if (mob.life <= 0) return;
  // Snap float leftovers (e.g. 3 − 180 × 1/60) so an ignite ends on its last full step.
  mob.ignite = mob.ignite - time > TIME_EPSILON ? mob.ignite - time : 0;
  if (mob.ignite === 0) mob.igniteDps = 0;
}

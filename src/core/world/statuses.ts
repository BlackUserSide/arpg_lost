// Statuses on mobs (STATUS_IDS): application from hits and death explosions, damage over time.
// Pure functions over plain world state; every number comes from the status data or content.

import { totalDamage, type DamageByType } from '../combat/damage';
import { resistanceMultiplier } from '../combat/mitigation';
import { distance } from '../math';
import { computeStat } from '../stats/modifiers';
import type { Modifier, Tag } from '../stats/types';
import type { StatusEffect } from './content';
import { stunBarFill, type ConditionTarget, type StunBarStats } from './passiveEffects';
import { getMob, isBoss, type Ctx, type MobState } from './state';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/**
 * The mob's statuses as seen by conditions (targetHasStatus, freeze-if-slowed, death explosions).
 * A boss is never frozen: while its freeze-slow runs it counts as frozen (and slowed); after that, a remaining
 * ordinary slow makes it just slowed (designer decision 2026-10-22).
 * A boss is not stunned by ordinary stuns either; while the stun-slow that replaces them runs, it counts as
 * stunned (and slowed), by analogy with the freeze-slow.
 * It counts as stunned, so e.g. «Добити лежачого» +25% applies (designer decision 2026-10-22).
 * A trap aura slow (MobState.auraSlow, no duration) counts as slowed while active; `slow` is then at least its
 * magnitude (conditions only test > 0).
 */
export function conditionTarget(mob: MobState): ConditionTarget {
  return {
    stun: Math.max(mob.stun, mob.stunSlow),
    slow: Math.max(mob.slow, mob.freezeSlow, mob.stunSlow, mob.auraSlow),
    ignite: mob.ignite,
    freeze: Math.max(mob.freeze, mob.freezeSlow),
    bleed: mob.bleed ?? 0,
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
  if ((effect.status === 'ignite' || effect.status === 'bleed') && hit.raw === undefined) return;
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
    case 'bleed':
      applyBleed(ctx, mob, totalDamage(hit.raw ?? {}) * (effect.magnitude ?? 0), effect.duration, effect.maxStacks ?? 1);
      break;
  }
}

function statusEvent(ctx: Ctx, mob: MobState, status: StatusEffect['status'], duration: number, source?: 'stunBar', stacks?: number): void {
  if (mob.life <= 0) return;
  ctx.events.push({
    type: 'status',
    targetId: mob.id,
    pos: mob.pos,
    status,
    duration,
    ...(source ? { source } : {}),
    ...(stacks !== undefined ? { stacks } : {}),
  });
}

/**
 * Bleed (designer decision 2026-10-23): adds a stack dealing `amount` (pre-mitigation hit damage × magnitude) as
 * physical damage over `duration`, and restarts the shared timer to `duration`. At most `maxStacks` stacks: past the
 * cap the oldest stack is replaced. A damage over time: not reduced by armour, no crit, no leech. The 'status'
 * event carries the stack count.
 */
// Designer decision: bleed ignores armour; a new stack past the cap replaces the oldest.
export function applyBleed(ctx: Ctx, mob: MobState, amount: number, duration: number, maxStacks: number): void {
  if (duration <= 0 || amount <= 0) return;
  const cap = Math.max(1, Math.floor(maxStacks));
  const stacks = (mob.bleed ?? 0) > 0 ? [...(mob.bleedStacks ?? [])] : [];
  stacks.push(amount / duration);
  while (stacks.length > cap) stacks.shift();
  mob.bleedStacks = stacks;
  mob.bleed = duration;
  statusEvent(ctx, mob, 'bleed', duration, undefined, stacks.length);
}

/** Bleed damage per second of the mob now (sum of its stacks; 0 when not bleeding). */
export function bleedDps(mob: MobState): number {
  if (!((mob.bleed ?? 0) > 0)) return 0;
  return (mob.bleedStacks ?? []).reduce((sum, dps) => sum + dps, 0);
}

/**
 * Bleed damage for one fixed step: bleedDps × min(dt, remaining), one 'dot' event. Timing as for ignite (tickIgnite).
 * When the timer ends the stacks are cleared. A mob killed by its bleed keeps it (dies bleeding).
 */
export function tickBleed(ctx: Ctx, mob: MobState, dt: number): void {
  const remaining = mob.bleed ?? 0;
  if (remaining <= 0 || mob.life <= 0) return;
  const time = Math.min(dt, remaining);
  const amount = bleedDps(mob) * time;
  mob.life -= amount;
  ctx.events.push({ type: 'dot', targetId: mob.id, pos: mob.pos, amount, status: 'bleed' });
  if (mob.life <= 0) return;
  mob.bleed = remaining - time > TIME_EPSILON ? remaining - time : 0;
  if (mob.bleed === 0) mob.bleedStacks = [];
}

/**
 * Ordinary stun (from a hit). Bosses are not stunned (designer decision 2026-10-22): they get the stun-slow
 * (CombatConfig.bossStunSlow, own slot MobState.stunSlow) for the same duration; the event still says 'stun'
 * with the stun-slow's remaining time, like the boss freeze.
 * The boss stun-slow lasts as long as the stun would (no separate boss duration); magnitude is data (designer decision 2026-10-22).
 */
function setStun(ctx: Ctx, mob: MobState, duration: number): void {
  if (duration <= 0) return;
  if (isBoss(ctx.content, mob)) {
    mob.stunSlow = Math.max(mob.stunSlow, duration);
    statusEvent(ctx, mob, 'stun', mob.stunSlow);
    return;
  }
  mob.stun = Math.max(mob.stun, duration);
  statusEvent(ctx, mob, 'stun', mob.stun);
}

/**
 * Fills the mob's stun bar after a direct hero hit (stunBar mechanic; see stunBarFill). A full bar (≥ 1) stuns
 * for stunDuration × durationMultiplier (bosses: bossStunDuration × durationMultiplier, a real stun: the
 * exception to "bosses are not stunned") and resets to 0; the overflow is discarded. Emits a 'stunBar' event
 * with the new fill, and a 'status' event with source 'stunBar' when it stuns. No-op on a mob the hit killed.
 * Every fill restarts the decay delay (stunBarIdle = 0). The bar keeps filling while the mob is stunned and the
 * overflow is lost (designer decision 2026-10-22).
 */
export function fillStunBar(ctx: Ctx, mob: MobState, stats: StunBarStats, removed: number, extraFillIncreased = 0): void {
  if (mob.life <= 0) return;
  const boss = isBoss(ctx.content, mob);
  // The hit's own fill bonus (ActionDef.stunBarFillIncreased, Stun support for the Guardian) adds to stunBonus fill.
  const barStats = extraFillIncreased !== 0 ? { ...stats, fillMultiplier: Math.max(0, stats.fillMultiplier + extraFillIncreased) } : stats;
  const fill = mob.stunBar + stunBarFill(barStats, removed, mob.maxLife, boss);
  mob.stunBarIdle = 0;
  if (fill < 1) {
    mob.stunBar = fill;
    ctx.events.push({ type: 'stunBar', targetId: mob.id, value: fill });
    return;
  }
  mob.stunBar = 0;
  ctx.events.push({ type: 'stunBar', targetId: mob.id, value: 0 });
  const duration = (boss ? stats.bossStunDuration : stats.stunDuration) * stats.durationMultiplier;
  if (duration <= 0) return;
  mob.stun = Math.max(mob.stun, duration);
  statusEvent(ctx, mob, 'stun', mob.stun, 'stunBar');
}

/** A new slow keeps the stronger magnitude while the old one runs; duration is the longer of the two. */
function setSlow(ctx: Ctx, mob: MobState, magnitude: number, duration: number): void {
  if (duration <= 0) return;
  mob.slowMagnitude = mob.slow > 0 ? Math.max(mob.slowMagnitude, magnitude) : magnitude;
  mob.slow = Math.max(mob.slow, duration);
  statusEvent(ctx, mob, 'slow', mob.slow);
}

/**
 * Stun bar decay for one fixed step (designer decision 2026-10-22): once stunBarIdle has reached decayDelay, the bar
 * drains decayPerSecond × dt (floored at 0); then stunBarIdle grows by dt. A hit at step n (stunBarIdle = 0) is
 * first drained on the step decayDelay later. No events: render reads mob.stunBar.
 * Decay runs in updateMobs, so the start differs by one step with the hit's source (as for the first ignite tick):
 * instant hero hits (updatePlayer, before updateMobs) already count a full dt of idle time in their own step and
 * are first drained at step n + decayDelay / dt; projectile / trap hits (after updateMobs) start counting on the
 * next step and are first drained one step later, at n + decayDelay / dt + 1.
 */
export function decayStunBar(mob: MobState, stats: StunBarStats, dt: number): void {
  if (mob.stunBar > 0 && mob.stunBarIdle >= stats.decayDelay - TIME_EPSILON) {
    mob.stunBar = Math.max(0, mob.stunBar - stats.decayPerSecond * dt);
  }
  mob.stunBarIdle += dt;
}

/**
 * Freeze for `duration` scaled by freezeDuration (base = duration). Bosses are not frozen: they get the
 * freeze-slow (CombatConfig.bossFreezeSlow, own slot MobState.freezeSlow) for `bossDuration` scaled the same way;
 * an ordinary slow they have keeps running untouched (designer decision 2026-10-22).
 */
export function applyFreeze(ctx: Ctx, mob: MobState, duration: number, bossDuration: number, mods: readonly Modifier[], tags: readonly Tag[]): void {
  if (isBoss(ctx.content, mob)) {
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

/**
 * Area slows: each living mob gets auraSlow = the strongest slow of the armed trap auras and slowing ground zones
 * whose radius (+ the mob's radius) reaches it, else 0. Recomputed every step (after traps and zones update), so
 * the slow ends on the step after the mob leaves the range (or the trap explodes / the zone expires). A trap removed
 * by the active-trap cap drops its aura at once (placeTrap calls this). Movement reads it on the next step's mob update.
 */
export function updateAuraSlows(ctx: Ctx): void {
  const { world, content } = ctx;
  for (const mob of world.mobs) {
    let slow = 0;
    if (mob.life > 0) {
      const reach = getMob(content, mob.defId).radius;
      for (const trap of world.traps) {
        if (!trap.aura || trap.armTimer > 0) continue;
        if (distance(mob.pos, trap.pos) <= trap.aura.radius + reach) slow = Math.max(slow, trap.aura.slow);
      }
      for (const zone of world.zones) {
        const zoneSlow = zone.action.zone?.slow;
        if (zoneSlow === undefined || zone.remaining <= 0) continue;
        if (distance(mob.pos, zone.pos) <= zone.radius + reach) slow = Math.max(slow, zoneSlow);
      }
    }
    mob.auraSlow = slow;
  }
}

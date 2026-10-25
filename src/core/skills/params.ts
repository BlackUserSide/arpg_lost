// Effective skill definitions: base action data + skill changes (passive tree, then skill levels with their
// level-3 effects, then support modifiers: one SkillChangeSet list). Pure; the result is plain ActionDef data,
// computed once per loadout (see PlayerState.actions), never per hit.

import type { ActionDef, ClassDef, Delivery, SelfEffect, StatusEffect, StatusId } from '../world/content';
import { STATUS_IDS } from '../world/content';
import type { Modifier } from '../stats/types';
import type { AnySkillParam, SkillChangeSet, SkillGrants } from './types';

/** The hero's actions after changes; same shape as the class data. */
export interface ActionSet {
  readonly basicAttack: ActionDef;
  /** Bound to skill slots 1..3, in class order. */
  readonly skills: readonly ActionDef[];
}

/** True if the change set targets this action (see SkillChangeSet). */
export function skillMatches(action: ActionDef, set: Pick<SkillChangeSet, 'skillIds' | 'tags' | 'deliveries'>): boolean {
  if (set.skillIds && !set.skillIds.includes(action.id)) return false;
  if (set.deliveries && !set.deliveries.includes(action.delivery.kind)) return false;
  return (set.tags ?? []).every((t) => action.tags.includes(t));
}

interface ParamTotal {
  add: number;
  increased: number;
}

/**
 * (base + Σadd) × (1 + Σincreased), floored at 0.
 * Changes from every source (passives, later level-3 effects and supports) add up in one sum like increased
 * stats: two +25% sources give +50%, not ×1.5625 (designer decision 2026-10-22).
 */
function applyTotal(base: number, total: ParamTotal | undefined): number {
  if (!total) return base;
  return Math.max(0, (base + total.add) * (1 + total.increased));
}

/**
 * Which action fields each param changes:
 * - cooldown: the action cooldown (with charges: the recharge time of one charge).
 * - charges: stored uses (base: granted charges, else the action's, else 1; rounded down, at least 1).
 * - buffDuration: every buff the action applies to its user (not invulnerability).
 * - radius: arc radius (melee swings, novas), a dash landing's, a burst's and an origin blast's radius. Projectile hitboxes and dash hit widths
 *   are not "radius"; nor are ground zones and projectile splits (their own data).
 * - explodeRadius: projectile explosion, trap explosion.
 * - pierce: projectile pierce count (rounded down to a whole number of targets).
 * - range: projectile range, teleport range, trap throw range.
 * - projectileSpeed: projectile speed.
 * - armTime / triggerRadius: trap.
 * - statusDuration: every on-hit status of the action (including statuses added by change sets).
 * - angle: arc angle (capped at 360; an every-N-th angle is its own data). spread: projectile fan (capped at 360).
 * - projectileCount: projectiles per use (rounded down, at least 1). hitRadius: a dash's path hit width.
 */
function applyDelivery(d: Delivery, p: (param: AnySkillParam, base: number) => number, grants: SkillGrants): Delivery {
  switch (d.kind) {
    case 'arc': {
      const everyNth = d.everyNth ?? grants.everyNth;
      return { ...d, radius: p('radius', d.radius), angleDeg: Math.min(FULL_CIRCLE_DEG, p('angle', d.angleDeg)), ...(everyNth ? { everyNth } : {}) };
    }
    case 'projectile': {
      const explode = d.explodeRadius !== undefined ? { explodeRadius: p('explodeRadius', d.explodeRadius) } : {};
      const split = d.split ?? grants.projectileSplit;
      return {
        ...d,
        count: Math.max(1, Math.floor(p('projectileCount', d.count))),
        spreadDeg: Math.min(FULL_CIRCLE_DEG, p('spread', d.spreadDeg)),
        range: p('range', d.range),
        speed: p('projectileSpeed', d.speed),
        pierce: Math.floor(p('pierce', d.pierce)),
        ...explode,
        ...(split ? { split } : {}),
      };
    }
    case 'trap': {
      const maxActive = grants.maxActiveTraps !== undefined ? Math.min(grants.maxActiveTraps, d.maxActive ?? Infinity) : d.maxActive;
      const chain = d.chain ?? grants.trapChain;
      const aura = d.aura ?? grants.trapAura;
      const fan = d.fan ?? grants.trapFan;
      return {
        ...d,
        ...(maxActive !== undefined ? { maxActive } : {}),
        ...(chain ? { chain } : {}),
        ...(aura ? { aura } : {}),
        ...(fan ? { fan } : {}),
        throwRange: p('range', d.throwRange),
        armTime: p('armTime', d.armTime),
        triggerRadius: p('triggerRadius', d.triggerRadius),
        explodeRadius: p('explodeRadius', d.explodeRadius),
      };
    }
    case 'teleport':
      return { ...d, range: p('range', d.range) };
    case 'dash': {
      const landing = d.landing ?? grants.dashLanding;
      const hitRadius = p('hitRadius', d.hitRadius);
      return { ...d, hitRadius, ...(landing ? { landing: { ...landing, radius: p('radius', landing.radius) } } : {}) };
    }
    case 'self':
      return d;
  }
}

/** Degrees in a full circle: the cap of angle params (structural). */
const FULL_CIRCLE_DEG = 360;

const COMBAT_STATUSES: ReadonlySet<string> = new Set(STATUS_IDS);

function isCombatStatus(status: string): status is StatusId {
  return COMBAT_STATUSES.has(status);
}

/**
 * Combined grants of the matching sets: charges = highest, maxActiveTraps = lowest, every other rule = first source.
 */
function combineGrants(sets: readonly SkillChangeSet[]): SkillGrants {
  let charges: number | undefined;
  let maxActiveTraps: number | undefined;
  let trapChain: SkillGrants['trapChain'];
  let trapAura: SkillGrants['trapAura'];
  let everyNth: SkillGrants['everyNth'];
  let dashLanding: SkillGrants['dashLanding'];
  let projectileSplit: SkillGrants['projectileSplit'];
  let groundZone: SkillGrants['groundZone'];
  let chainHit: SkillGrants['chainHit'];
  let echo: SkillGrants['echo'];
  let knockback: SkillGrants['knockback'];
  let trapFan: SkillGrants['trapFan'];
  let burst: SkillGrants['burst'];
  let originBlast: SkillGrants['originBlast'];
  for (const { grants } of sets) {
    if (!grants) continue;
    if (grants.charges !== undefined) charges = Math.max(charges ?? 0, grants.charges);
    if (grants.maxActiveTraps !== undefined) maxActiveTraps = Math.min(maxActiveTraps ?? Infinity, grants.maxActiveTraps);
    trapChain ??= grants.trapChain;
    trapAura ??= grants.trapAura;
    everyNth ??= grants.everyNth;
    dashLanding ??= grants.dashLanding;
    projectileSplit ??= grants.projectileSplit;
    groundZone ??= grants.groundZone;
    chainHit ??= grants.chainHit;
    echo ??= grants.echo;
    knockback ??= grants.knockback;
    trapFan ??= grants.trapFan;
    burst ??= grants.burst;
    originBlast ??= grants.originBlast;
  }
  return {
    ...(charges !== undefined ? { charges } : {}),
    ...(maxActiveTraps !== undefined ? { maxActiveTraps } : {}),
    ...(trapChain ? { trapChain } : {}),
    ...(trapAura ? { trapAura } : {}),
    ...(everyNth ? { everyNth } : {}),
    ...(dashLanding ? { dashLanding } : {}),
    ...(projectileSplit ? { projectileSplit } : {}),
    ...(groundZone ? { groundZone } : {}),
    ...(chainHit ? { chainHit } : {}),
    ...(echo ? { echo } : {}),
    ...(knockback ? { knockback } : {}),
    ...(trapFan ? { trapFan } : {}),
    ...(burst ? { burst } : {}),
    ...(originBlast ? { originBlast } : {}),
  };
}

/**
 * The effective definition of one action under the change sets that match it. Order: statuses and buff
 * modifiers are added first, grants (SkillGrants) set their base values, then every param is recomputed from the
 * base value with all matching changes summed (add and increased combine like stats). Returns `action` itself when nothing matches.
 * Added statuses that combat does not implement are skipped. Duration changes also scale a freeze's bossDuration.
 * Stat modifiers of the sets (SkillChangeSet.modifiers) are appended to ActionDef.modifiers (the action's own).
 * Resource cost multipliers of the sets multiply (designer decision 2026-10-23); leech, resourcePerHit,
 * lifeCostFraction and stun bar fill add up;
 * damage conversions combine as described at SkillChangeSet.damageConversion (the action's own comes first).
 */
export function resolveAction(action: ActionDef, sets: readonly SkillChangeSet[]): ActionDef {
  const matching = sets.filter((s) => skillMatches(action, s));
  if (matching.length === 0) return action;

  const totals = new Map<AnySkillParam, ParamTotal>();
  const buffModifiers: Modifier[] = [];
  const ownModifiers: Modifier[] = [...(action.modifiers ?? [])];
  const addedSelfEffects: SelfEffect[] = [];
  const addedOnHit: StatusEffect[] = [];
  const perStatus = new Map<string, ParamTotal>();
  let costMultiplier = 1;
  let leech = action.leech ?? 0;
  let resourcePerHit = action.resourcePerHit ?? 0;
  let lifeCostFraction = action.lifeCostFraction ?? 0;
  let stunBarFill = action.stunBarFillIncreased ?? 0;
  let conversion = action.damageConversion;
  for (const set of matching) {
    costMultiplier *= set.resourceCostMultiplier ?? 1;
    leech += set.leech ?? 0;
    resourcePerHit += set.resourcePerHit ?? 0;
    lifeCostFraction += set.lifeCostFraction ?? 0;
    stunBarFill += set.stunBarFillIncreased ?? 0;
    const c = set.damageConversion;
    if (c && (!conversion || conversion.to === c.to)) {
      conversion = { to: c.to, fraction: Math.min(1, (conversion?.fraction ?? 0) + c.fraction) };
    }
    for (const c of set.changes ?? []) {
      const t = totals.get(c.param) ?? { add: 0, increased: 0 };
      t.add += c.add ?? 0;
      t.increased += c.increased ?? 0;
      totals.set(c.param, t);
    }
    for (const c of set.statusDurations ?? []) {
      const t = perStatus.get(c.status) ?? { add: 0, increased: 0 };
      t.add += c.add ?? 0;
      t.increased += c.increased ?? 0;
      perStatus.set(c.status, t);
    }
    buffModifiers.push(...(set.buffModifiers ?? []));
    ownModifiers.push(...(set.modifiers ?? []));
    addedSelfEffects.push(...(set.addSelfEffects ?? []));
    for (const s of set.addOnHit ?? []) {
      const status = s.status;
      if (!isCombatStatus(status)) continue;
      addedOnHit.push({
        status,
        duration: s.duration,
        ...(s.magnitude !== undefined ? { magnitude: s.magnitude } : {}),
        ...(s.chance !== undefined ? { chance: s.chance } : {}),
        ...(s.maxStacks !== undefined ? { maxStacks: s.maxStacks } : {}),
        ...(s.requiresStatus !== undefined ? { requiresStatus: s.requiresStatus } : {}),
        ...(s.requiresDamageType !== undefined ? { requiresDamageType: s.requiresDamageType } : {}),
        ...(s.bossDuration !== undefined ? { bossDuration: s.bossDuration } : {}),
      });
    }
  }
  const p = (param: AnySkillParam, base: number): number => applyTotal(base, totals.get(param));
  const grants = combineGrants(matching);
  // A granted charge count replaces the action's own (the higher of the two wins); `charges` changes add on top.
  const baseCharges = Math.max(grants.charges ?? 0, action.charges ?? 1);
  const charges = Math.max(1, Math.floor(p('charges', baseCharges)));

  const onHitBase = [...(action.onHit ?? []), ...addedOnHit];
  const statusTotal = totals.get('statusDuration');
  const onHit = onHitBase.map((e): StatusEffect => {
    // The generic statusDuration param and this status's own changes add up in one sum.
    const own = perStatus.get(e.status);
    const total = own || statusTotal ? { add: (statusTotal?.add ?? 0) + (own?.add ?? 0), increased: (statusTotal?.increased ?? 0) + (own?.increased ?? 0) } : undefined;
    const boss = e.bossDuration !== undefined ? { bossDuration: applyTotal(e.bossDuration, total) } : {};
    return { ...e, duration: applyTotal(e.duration, total), ...boss };
  });
  const scaledSelfEffects = action.selfEffects?.map((e): SelfEffect => {
    if (e.kind !== 'buff') return e;
    return { ...e, duration: p('buffDuration', e.duration), modifiers: [...e.modifiers, ...buffModifiers] };
  });
  const selfEffects = addedSelfEffects.length > 0 ? [...(scaledSelfEffects ?? []), ...addedSelfEffects] : scaledSelfEffects;
  const zone = action.zone ?? grants.groundZone;
  const chainHit = action.chainHit ?? grants.chainHit;
  const echo = action.echo ?? grants.echo;
  const knockback = action.knockback ?? grants.knockback;
  const burstDef = action.burst ?? grants.burst;
  const blastDef = action.originBlast ?? grants.originBlast;

  return {
    ...action,
    resourceCost: Math.max(0, action.resourceCost * costMultiplier),
    cooldown: p('cooldown', action.cooldown),
    ...(charges !== 1 || action.charges !== undefined ? { charges } : {}),
    delivery: applyDelivery(action.delivery, p, grants),
    ...(onHit.length > 0 ? { onHit } : {}),
    ...(selfEffects ? { selfEffects } : {}),
    ...(ownModifiers.length > 0 ? { modifiers: ownModifiers } : {}),
    ...(zone ? { zone } : {}),
    ...(leech !== 0 ? { leech } : {}),
    ...(resourcePerHit !== 0 ? { resourcePerHit } : {}),
    ...(stunBarFill !== 0 ? { stunBarFillIncreased: stunBarFill } : {}),
    ...(chainHit ? { chainHit } : {}),
    ...(echo ? { echo } : {}),
    ...(knockback ? { knockback } : {}),
    ...(conversion ? { damageConversion: conversion } : {}),
    ...(lifeCostFraction !== 0 ? { lifeCostFraction } : {}),
    ...(burstDef ? { burst: { ...burstDef, radius: p('radius', burstDef.radius) } } : {}),
    ...(blastDef ? { originBlast: { ...blastDef, radius: p('radius', blastDef.radius) } } : {}),
  };
}

/** Basic attack and skills of a class with the change sets applied. */
export function resolveActions(classDef: ClassDef, sets: readonly SkillChangeSet[]): ActionSet {
  return {
    basicAttack: resolveAction(classDef.basicAttack, sets),
    skills: classDef.skills.map((s) => resolveAction(s, sets)),
  };
}

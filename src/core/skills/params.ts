// Effective skill definitions: base action data + skill changes (passive tree now; skill level-3 effects and
// support modifiers later feed the same SkillChangeSet list). Pure; the result is plain ActionDef data,
// computed once per loadout (see PlayerState.actions), never per hit.

import type { ActionDef, ClassDef, Delivery, SelfEffect, StatusEffect, StatusId } from '../world/content';
import { STATUS_IDS } from '../world/content';
import type { Modifier } from '../stats/types';
import type { SkillChangeSet, SkillParam } from './types';

/** The hero's actions after changes; same shape as the class data. */
export interface ActionSet {
  readonly basicAttack: ActionDef;
  /** Bound to skill slots 1..3, in class order. */
  readonly skills: readonly ActionDef[];
}

/** True if the change set targets this action (see SkillChangeSet). */
export function skillMatches(action: ActionDef, set: Pick<SkillChangeSet, 'skillIds' | 'tags'>): boolean {
  if (set.skillIds && !set.skillIds.includes(action.id)) return false;
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
 * - cooldown: the action cooldown.
 * - buffDuration: every buff the action applies to its user (not invulnerability).
 * - radius: arc radius (melee swings, novas). Projectile hitboxes and dash hit widths are not "radius".
 * - explodeRadius: projectile explosion, trap explosion.
 * - pierce: projectile pierce count (rounded down to a whole number of targets).
 * - range: projectile range, teleport range, trap throw range.
 * - projectileSpeed: projectile speed.
 * - armTime / triggerRadius: trap.
 * - statusDuration: every on-hit status of the action (including statuses added by change sets).
 */
function applyDelivery(d: Delivery, p: (param: SkillParam, base: number) => number): Delivery {
  switch (d.kind) {
    case 'arc':
      return { ...d, radius: p('radius', d.radius) };
    case 'projectile': {
      const explode = d.explodeRadius !== undefined ? { explodeRadius: p('explodeRadius', d.explodeRadius) } : {};
      return { ...d, range: p('range', d.range), speed: p('projectileSpeed', d.speed), pierce: Math.floor(p('pierce', d.pierce)), ...explode };
    }
    case 'trap':
      return {
        ...d,
        throwRange: p('range', d.throwRange),
        armTime: p('armTime', d.armTime),
        triggerRadius: p('triggerRadius', d.triggerRadius),
        explodeRadius: p('explodeRadius', d.explodeRadius),
      };
    case 'teleport':
      return { ...d, range: p('range', d.range) };
    case 'dash':
    case 'self':
      return d;
  }
}

const COMBAT_STATUSES: ReadonlySet<string> = new Set(STATUS_IDS);

function isCombatStatus(status: string): status is StatusId {
  return COMBAT_STATUSES.has(status);
}

/**
 * The effective definition of one action under the change sets that match it. Order: statuses and buff
 * modifiers are added first, then every param is recomputed from the base value with all matching changes
 * summed (add and increased combine like stats). Returns `action` itself when nothing matches.
 * Added statuses that combat does not implement yet (ignite, freeze) are skipped.
 */
export function resolveAction(action: ActionDef, sets: readonly SkillChangeSet[]): ActionDef {
  const matching = sets.filter((s) => skillMatches(action, s));
  if (matching.length === 0) return action;

  const totals = new Map<SkillParam, ParamTotal>();
  const buffModifiers: Modifier[] = [];
  const addedOnHit: StatusEffect[] = [];
  const perStatus = new Map<string, ParamTotal>();
  for (const set of matching) {
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
    for (const s of set.addOnHit ?? []) {
      if (!isCombatStatus(s.status)) continue;
      addedOnHit.push({
        status: s.status,
        duration: s.duration,
        ...(s.magnitude !== undefined ? { magnitude: s.magnitude } : {}),
        ...(s.chance !== undefined ? { chance: s.chance } : {}),
      });
    }
  }
  const p = (param: SkillParam, base: number): number => applyTotal(base, totals.get(param));

  const onHitBase = [...(action.onHit ?? []), ...addedOnHit];
  const statusTotal = totals.get('statusDuration');
  const onHit = onHitBase.map((e): StatusEffect => {
    // The generic statusDuration param and this status's own changes add up in one sum.
    const own = perStatus.get(e.status);
    const total = own || statusTotal ? { add: (statusTotal?.add ?? 0) + (own?.add ?? 0), increased: (statusTotal?.increased ?? 0) + (own?.increased ?? 0) } : undefined;
    return { ...e, duration: applyTotal(e.duration, total) };
  });
  const selfEffects = action.selfEffects?.map((e): SelfEffect => {
    if (e.kind !== 'buff') return e;
    return { ...e, duration: p('buffDuration', e.duration), modifiers: [...e.modifiers, ...buffModifiers] };
  });

  return {
    ...action,
    cooldown: p('cooldown', action.cooldown),
    delivery: applyDelivery(action.delivery, p),
    ...(onHit.length > 0 ? { onHit } : {}),
    ...(selfEffects ? { selfEffects } : {}),
  };
}

/** Basic attack and skills of a class with the change sets applied. */
export function resolveActions(classDef: ClassDef, sets: readonly SkillChangeSet[]): ActionSet {
  return {
    basicAttack: resolveAction(classDef.basicAttack, sets),
    skills: classDef.skills.map((s) => resolveAction(s, sets)),
  };
}

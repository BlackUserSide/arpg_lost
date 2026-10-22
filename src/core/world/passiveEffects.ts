// Runtime implementation of passive tree mechanics (docs/design/passives-wheel.md, keystones).
// Pure functions over plain player data; the mechanics themselves are data (PassiveMechanic).
//
// Implemented here:
// - bloodMagic: skills cost life, max mana / mana regen are 0.
// - alwaysCrit: hits always crit with a fixed multiplier (see critStats).
// - lifeToEnergyShield: base life (class + levels) becomes flat ES, max life is fixed, life regen feeds ES.
// - conditionalModifiers: movedWithin / stationaryFor / lifeBelow / targetHasStatus (stun, slow).
// - lifeLeech: hits restore a fraction of damage dealt, capped per second (see leechStats, applyLeech).
// - lifePotionEffectiveness: data only until potions exist (see lifePotionMultiplier).
// Glass Cannon needs no mechanic: it is plain `more` damage / damageTaken modifiers.

import type { PassiveCondition, PassiveMechanic, PassiveMechanicKind } from '../passives/types';
import { computeStat } from '../stats/modifiers';
import type { Modifier, StatId, Tag } from '../stats/types';

type MechanicOf<K extends PassiveMechanicKind> = Extract<PassiveMechanic, { kind: K }>;

/** What stat derivation needs to know about the hero (PlayerState satisfies it; so can a hub character sheet). */
export interface StatSource {
  /** Class base stats. */
  readonly baseStats: Readonly<Partial<Record<StatId, number>>>;
  /** All permanent + temporary modifiers that apply (gear, passives, levels, buffs, active conditions). */
  readonly modifiers: readonly Modifier[];
  /** Level stats only (a subset of `modifiers`); they count as "base" life for lifeToEnergyShield. */
  readonly levelModifiers: readonly Modifier[];
  readonly mechanics: readonly PassiveMechanic[];
}

/** First mechanic of this kind, if any. */
export function findMechanic<K extends PassiveMechanicKind>(mechanics: readonly PassiveMechanic[], kind: K): MechanicOf<K> | undefined {
  return mechanics.find((m): m is MechanicOf<K> => m.kind === kind);
}

/**
 * A hero stat with pool-changing mechanics applied (blood magic, crystal shell).
 * Without such mechanics this is the plain formula `(base + flat) * (1 + Σinc) * Π(1 + more)`.
 */
export function deriveStat(source: StatSource, stat: StatId, tags: readonly Tag[] = []): number {
  const { baseStats, modifiers, mechanics } = source;
  const plain = (s: StatId): number => computeStat(baseStats[s] ?? 0, modifiers, s, tags);
  const blood = findMechanic(mechanics, 'bloodMagic');
  const crystal = findMechanic(mechanics, 'lifeToEnergyShield');
  switch (stat) {
    case 'mana':
    case 'manaRegen':
      if (blood) return 0;
      break;
    case 'life':
      if (crystal) return crystal.maxLife;
      break;
    case 'lifeRegen':
      if (crystal?.lifeRegenToShield) return 0;
      break;
    case 'energyShield':
      if (crystal) return computeStat((baseStats.energyShield ?? 0) + baseLife(source), modifiers, 'energyShield', tags);
      break;
    case 'energyShieldRegen':
      if (crystal?.lifeRegenToShield) return plain('energyShieldRegen') + plain('lifeRegen');
      break;
    default:
      break;
  }
  return plain(stat);
}

/** Class base life plus level life, before gear and % bonuses. */
export function baseLife(source: Pick<StatSource, 'baseStats' | 'levelModifiers'>): number {
  return computeStat(source.baseStats.life ?? 0, source.levelModifiers, 'life');
}

/** Hero state that conditions read. */
export interface ConditionState {
  /** Seconds since the hero last changed position (walk, dash, teleport). */
  readonly stillTime: number;
  readonly life: number;
  /** Max life computed without conditional modifiers (avoids self-reference). */
  readonly maxLife: number;
}

/** Target state for per-hit conditions; omitted for hero-wide stats. */
export interface ConditionTarget {
  readonly stun: number;
  readonly slow: number;
}

/**
 * True if the condition holds. `movedWithin` and `stationaryFor` with the same threshold are complementary.
 * `targetHasStatus` is false without a target, and for statuses combat does not have yet (ignite, freeze).
 */
export function conditionHolds(condition: PassiveCondition, state: ConditionState, target?: ConditionTarget): boolean {
  switch (condition.kind) {
    case 'movedWithin':
      return state.stillTime < condition.seconds;
    case 'stationaryFor':
      return state.stillTime >= condition.seconds;
    case 'lifeBelow':
      return state.life < condition.fraction * state.maxLife;
    case 'targetHasStatus':
      if (!target) return false;
      switch (condition.status) {
        case 'stun':
          return target.stun > 0;
        case 'slow':
          return target.slow > 0;
        default:
          return false;
      }
  }
}

/** True if the condition needs a hit target (evaluated per hit, not for hero-wide stats). */
export function isTargetCondition(condition: PassiveCondition): boolean {
  return condition.kind === 'targetHasStatus';
}

/**
 * Modifiers of conditionalModifiers mechanics whose condition holds.
 * Without a target only hero conditions are checked; with a target only target conditions are
 * (hero conditions are already part of the hero-wide modifier list).
 */
export function activeConditionalModifiers(
  mechanics: readonly PassiveMechanic[],
  state: ConditionState,
  target?: ConditionTarget,
): Modifier[] {
  const result: Modifier[] = [];
  for (const m of mechanics) {
    if (m.kind !== 'conditionalModifiers') continue;
    if (isTargetCondition(m.condition) !== (target !== undefined)) continue;
    if (conditionHolds(m.condition, state, target)) result.push(...m.modifiers);
  }
  return result;
}

/** Which pool pays for an action and how much. */
export interface ActionCost {
  readonly pool: 'mana' | 'life';
  readonly amount: number;
}

export function actionCost(mechanics: readonly PassiveMechanic[], manaCost: number): ActionCost {
  const blood = findMechanic(mechanics, 'bloodMagic');
  if (blood) return { pool: 'life', amount: manaCost * blood.lifePerMana };
  return { pool: 'mana', amount: manaCost };
}

/** Mana costs need enough mana; life costs need strictly more life than the cost (paying never kills). */
export function canPay(pools: { readonly life: number; readonly mana: number }, cost: ActionCost): boolean {
  return cost.pool === 'mana' ? pools.mana >= cost.amount : pools.life > cost.amount;
}

export interface CritStats {
  readonly critChance: number;
  readonly critMultiplier: number;
}

/** alwaysCrit replaces the computed chance with 1 and the multiplier with the fixed data value. */
export function critStats(mechanics: readonly PassiveMechanic[], computed: CritStats): CritStats {
  const always = findMechanic(mechanics, 'alwaysCrit');
  return always ? { critChance: 1, critMultiplier: always.critMultiplier } : computed;
}

/** Where life recovery (e.g. life potions) goes: energy shield under lifeToEnergyShield, otherwise life. */
export function lifeRecoveryPool(mechanics: readonly PassiveMechanic[]): 'life' | 'energyShield' {
  return findMechanic(mechanics, 'lifeToEnergyShield') ? 'energyShield' : 'life';
}

export interface LeechStats {
  /** Fraction of damage dealt restored. */
  readonly fraction: number;
  /** Cap per second as a fraction of the recovery pool's max; Infinity if uncapped. */
  readonly maxPerSecond: number;
}

/** Combined lifeLeech mechanics (fractions and caps add up; a leech without a cap removes the cap), or undefined. */
export function leechStats(mechanics: readonly PassiveMechanic[]): LeechStats | undefined {
  let found = false;
  let fraction = 0;
  let maxPerSecond = 0;
  for (const m of mechanics) {
    if (m.kind !== 'lifeLeech') continue;
    found = true;
    fraction += m.fraction;
    maxPerSecond += m.maxPerSecond ?? Infinity;
  }
  return found ? { fraction, maxPerSecond } : undefined;
}

/** Multiplier on life potion recovery (1 without lifePotionEffectiveness). For potions (0.4). */
export function lifePotionMultiplier(mechanics: readonly PassiveMechanic[]): number {
  let result = 1;
  for (const m of mechanics) if (m.kind === 'lifePotionEffectiveness') result *= m.multiplier;
  return Math.max(0, result);
}

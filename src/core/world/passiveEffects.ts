// Runtime implementation of passive tree mechanics (docs/design/passives-wheel.md, keystones).
// Pure functions over plain player data; the mechanics themselves are data (PassiveMechanic).
//
// Implemented here:
// - bloodMagic: skills cost life, max resource / resource regen are 0 (so no class gains resource, Rage included).
// - alwaysCrit: hits always crit with a fixed multiplier (see critStats).
// - lifeToEnergyShield: base life (class + levels) becomes flat ES, max life is fixed, life regen feeds ES.
// - conditionalModifiers: movedWithin / stationaryFor / lifeBelow / targetHasStatus (stun, slow, ignite, freeze).
// - moreDamagePerMissingLife: hero-state "more" damage from missing life (see missingLifeModifier).
// - skillParams: converted to SkillChangeSets (skillChangeSets) and resolved once per loadout (core/skills).
// - stunBonus: stun duration (skill stuns via skillChangeSets, the stun bar via stunDurationMultiplier) and stun bar fill.
// - stunBar: hero hits fill the target's bar, a full bar stuns (bosses too) and resets (stunBarStats; statuses.ts).
// - counterAttack: a survived melee hit is answered with the basic attack, with an internal cooldown (actions.ts).
// - lifeLeech: hits restore a fraction of damage dealt, capped per second (see leechStats, applyLeech).
// - lifePotionEffectiveness: data only until potions exist (see lifePotionMultiplier).
// - ignite / freezeSlowed: converted to on-hit statuses of the actions (skillChangeSets); combat in statuses.ts.
// - deathExplosion / deathExplosionRadius: see deathExplosions.ts (deathExplosionRadiusMultiplier).
// - distanceDamage: attack projectiles gain more damage by distance travelled (distanceDamageModifier; projectiles.ts).
// - trapCharges / trapAura: converted to skill grants of trap actions (skillChangeSets): charges, active-trap cap,
//   chain detonation and the armed-trap slow aura; runtime in actions.ts (charges, placeTrap) and projectiles.ts.
// Glass Cannon needs no mechanic: it is plain `more` damage / damageTaken modifiers.

import type { PassiveCondition, PassiveMechanic, PassiveMechanicKind, PassiveStatusId } from '../passives/types';
import { computeStat } from '../stats/modifiers';
import type { SkillChangeSet } from '../skills/types';
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
    case 'resource':
    case 'resourceRegen':
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
  readonly energyShield: number;
  /** Max energy shield computed without conditional modifiers. */
  readonly maxEnergyShield: number;
}

/**
 * Target state for per-hit conditions and death explosions; omitted for hero-wide stats. Remaining seconds
 * per status (> 0 = has it). `freeze` is "counts as frozen": a slowed boss counts as frozen (see conditionTarget).
 */
export interface ConditionTarget {
  readonly stun: number;
  readonly slow: number;
  readonly ignite: number;
  readonly freeze: number;
  readonly bleed: number;
}

/** True if the target has the status now. */
export function targetHasStatus(target: ConditionTarget, status: PassiveStatusId): boolean {
  return target[status] > 0;
}

/**
 * True if the condition holds. `movedWithin` and `stationaryFor` with the same threshold are complementary.
 * `targetHasStatus` is false without a target.
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
      return target ? targetHasStatus(target, condition.status) : false;
  }
}

/** True if the condition needs a hit target (evaluated per hit, not for hero-wide stats). */
export function isTargetCondition(condition: PassiveCondition): boolean {
  return condition.kind === 'targetHasStatus';
}

/** True if some mechanic adds modifiers that depend on live hero / target state (see activeConditionalModifiers). */
export function hasStateMechanics(mechanics: readonly PassiveMechanic[]): boolean {
  return mechanics.some((m) => m.kind === 'conditionalModifiers' || m.kind === 'moreDamagePerMissingLife');
}

/**
 * moreDamagePerMissingLife: more damage = min(max, missingFraction × perMissingLife), where life and energy
 * shield count as one pool (designer decision 2026-10-22): missingFraction = 1 − (life + ES) / (maxLife + maxES).
 * Undefined when the pool is full. Under lifeToEnergyShield (life fixed at 1) it therefore works off ES.
 * Under bloodMagic, paying skills with life raises the bonus (the designed combo).
 */
export function missingLifeModifier(m: MechanicOf<'moreDamagePerMissingLife'>, state: ConditionState): Modifier | undefined {
  const maxPool = state.maxLife + state.maxEnergyShield;
  if (maxPool <= 0) return undefined;
  const missing = Math.min(1, Math.max(0, 1 - (state.life + state.energyShield) / maxPool));
  const value = Math.min(m.max, missing * m.perMissingLife);
  return value > 0 ? { stat: 'damage', kind: 'more', value } : undefined;
}

/**
 * Modifiers of state-dependent mechanics that apply now: conditionalModifiers whose condition holds, and
 * moreDamagePerMissingLife. Without a target only hero state is checked; with a target only target conditions
 * are (hero state is already part of the hero-wide modifier list).
 */
export function activeConditionalModifiers(
  mechanics: readonly PassiveMechanic[],
  state: ConditionState,
  target?: ConditionTarget,
): Modifier[] {
  const result: Modifier[] = [];
  for (const m of mechanics) {
    if (m.kind === 'moreDamagePerMissingLife') {
      const mod = target === undefined ? missingLifeModifier(m, state) : undefined;
      if (mod) result.push(mod);
      continue;
    }
    if (m.kind !== 'conditionalModifiers') continue;
    if (isTargetCondition(m.condition) !== (target !== undefined)) continue;
    if (conditionHolds(m.condition, state, target)) result.push(...m.modifiers);
  }
  return result;
}

/** Which pool pays for an action and how much. */
export interface ActionCost {
  readonly pool: 'resource' | 'life';
  readonly amount: number;
}

export function actionCost(mechanics: readonly PassiveMechanic[], resourceCost: number): ActionCost {
  const blood = findMechanic(mechanics, 'bloodMagic');
  if (blood) return { pool: 'life', amount: resourceCost * blood.lifePerResource };
  return { pool: 'resource', amount: resourceCost };
}

/** Resource costs need enough resource; life costs need strictly more life than the cost (paying never kills). */
export function canPay(pools: { readonly life: number; readonly resource: number }, cost: ActionCost): boolean {
  return cost.pool === 'resource' ? pools.resource >= cost.amount : pools.life > cost.amount;
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

/**
 * Passive mechanics that change skills, as skill change sets for the effective-skill resolver (core/skills/params.ts):
 * - skillParams as is. Tag-matched nodes (Sniper projectile nodes) also change the basic attack, e.g. the
 *   ranger's bolt (designer decision 2026-10-22).
 * - stunBonus.durationIncreased as a stun duration change on every action. It adds to the skill's statusDuration
 *   in one sum, like increased (designer decision 2026-10-22), and is locked into the action at cast time.
 * - ignite as an on-hit ignite on every action that applies only to hits dealing its damage type.
 * - freezeSlowed as an on-hit freeze on its skills that applies only to targets slowed before the hit.
 * - trapCharges / trapAura as grants (SkillGrants) on every trap-delivery action: charges, maxActiveTraps,
 *   trapChain, trapAura. The cap counts every hero trap, whatever action threw it (fan of traps included).
 * Statuses added this way are part of the action snapshot of projectiles / traps / dashes (cast time).
 */
export function skillChangeSets(mechanics: readonly PassiveMechanic[]): SkillChangeSet[] {
  const sets: SkillChangeSet[] = [];
  for (const m of mechanics) {
    switch (m.kind) {
      case 'skillParams':
        sets.push(m);
        break;
      case 'stunBonus':
        if (m.durationIncreased !== 0) sets.push({ statusDurations: [{ status: 'stun', increased: m.durationIncreased }] });
        break;
      case 'ignite':
        sets.push({
          addOnHit: [{ status: 'ignite', duration: m.duration, magnitude: m.damageFraction, chance: m.chance, requiresDamageType: m.damageType }],
        });
        break;
      case 'freezeSlowed':
        sets.push({
          skillIds: m.skillIds,
          addOnHit: [{ status: 'freeze', duration: m.duration, bossDuration: m.bossDuration, requiresStatus: 'slow' }],
        });
        break;
      case 'trapCharges':
        sets.push({
          deliveries: ['trap'],
          grants: { charges: m.charges, maxActiveTraps: m.maxActive, trapChain: { delay: m.chainDelay, radius: m.chainRadius } },
        });
        break;
      case 'trapAura':
        sets.push({ deliveries: ['trap'], grants: { trapAura: { radius: m.radius, slow: m.slow } } });
        break;
      default:
        break;
    }
  }
  return sets;
}

/** Multiplier on death explosion radii: 1 + Σ deathExplosionRadius.increased (never below 0). */
export function deathExplosionRadiusMultiplier(mechanics: readonly PassiveMechanic[]): number {
  let increased = 0;
  for (const m of mechanics) if (m.kind === 'deathExplosionRadius') increased += m.increased;
  return Math.max(0, 1 + increased);
}

/**
 * Multiplier on stun durations from stunBonus: 1 + Σ durationIncreased (never below 0). Skill stuns get it via
 * skillChangeSets (same sum); this is for stuns that do not come from an action (the stun bar).
 */
export function stunDurationMultiplier(mechanics: readonly PassiveMechanic[]): number {
  let increased = 0;
  for (const m of mechanics) if (m.kind === 'stunBonus') increased += m.durationIncreased;
  return Math.max(0, 1 + increased);
}

/** The stun bar rules of the hero, with stunBonus fill / duration bonuses summed in. */
export interface StunBarStats {
  readonly baseFill: number;
  readonly damageFill: number;
  readonly stunDuration: number;
  readonly bossFillFactor: number;
  readonly bossStunDuration: number;
  /** Seconds without a hero hit before the bar starts to drain. */
  readonly decayDelay: number;
  /** Fraction of a full bar drained per second once decaying. */
  readonly decayPerSecond: number;
  /** 1 + Σ stunBonus.fillIncreased (never below 0); all sources add like increased. */
  readonly fillMultiplier: number;
  /** stunDurationMultiplier: the same additive sum skill stuns use. */
  readonly durationMultiplier: number;
}

/** Stun bar stats from the first stunBar mechanic (several do not stack), or undefined without one. */
export function stunBarStats(mechanics: readonly PassiveMechanic[]): StunBarStats | undefined {
  const bar = findMechanic(mechanics, 'stunBar');
  if (!bar) return undefined;
  let fillIncreased = 0;
  for (const m of mechanics) if (m.kind === 'stunBonus') fillIncreased += m.fillIncreased;
  return {
    baseFill: bar.baseFill,
    damageFill: bar.damageFill,
    stunDuration: bar.stunDuration,
    bossFillFactor: bar.bossFillFactor,
    bossStunDuration: bar.bossStunDuration,
    decayDelay: bar.decayDelay,
    decayPerSecond: bar.decayPerSecond,
    fillMultiplier: Math.max(0, 1 + fillIncreased),
    durationMultiplier: stunDurationMultiplier(mechanics),
  };
}

/**
 * Fill one hit adds to a stun bar: (baseFill + removed / maxLife × damageFill) × fillMultiplier, × bossFillFactor
 * on bosses. `removed` is the life the hit actually took (overkill excluded, as for leech).
 */
export function stunBarFill(stats: StunBarStats, removed: number, maxLife: number, boss: boolean): number {
  const damagePart = maxLife > 0 ? (removed / maxLife) * stats.damageFill : 0;
  return (stats.baseFill + damagePart) * stats.fillMultiplier * (boss ? stats.bossFillFactor : 1);
}

/**
 * distanceDamage: "more" damage of one projectile hit after travelling `travelled` units, for an action with `tags`.
 * Each mechanic whose tags the action has gives clamp((travelled − minDistance) / (maxDistance − minDistance), 0, 1)
 * × maxMore; several sources add up (like increased) into one more multiplier. 0 when none applies.
 */
export function distanceDamageMore(mechanics: readonly PassiveMechanic[], tags: readonly Tag[], travelled: number): number {
  let more = 0;
  for (const m of mechanics) {
    if (m.kind !== 'distanceDamage' || !m.tags.every((t) => tags.includes(t))) continue;
    const span = m.maxDistance - m.minDistance;
    const t = span > 0 ? (travelled - m.minDistance) / span : travelled >= m.maxDistance ? 1 : 0;
    more += Math.min(1, Math.max(0, t)) * m.maxMore;
  }
  return more;
}

/** distanceDamageMore as a damage modifier, or undefined when it is 0. */
export function distanceDamageModifier(mechanics: readonly PassiveMechanic[], tags: readonly Tag[], travelled: number): Modifier | undefined {
  const value = distanceDamageMore(mechanics, tags, travelled);
  return value > 0 ? { stat: 'damage', kind: 'more', value } : undefined;
}

/** Counter-attack rules from the first counterAttack mechanic (several do not stack), or undefined. */
export function counterAttackStats(mechanics: readonly PassiveMechanic[]): MechanicOf<'counterAttack'> | undefined {
  return findMechanic(mechanics, 'counterAttack');
}

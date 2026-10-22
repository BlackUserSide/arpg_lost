import type { Rng } from '../rng';
import type { CombatConfig } from './config';
import { scaleDamage, totalDamage, type DamageByType } from './damage';
import { mitigate, type Defences } from './mitigation';

export interface HitInput {
  /** Damage after attacker modifiers, before crit and defences. */
  readonly damage: DamageByType;
  /** Fraction, clamped to [0, 1]. */
  readonly critChance: number;
  readonly critMultiplier: number;
}

export interface HitResult {
  /** Damage after crit, before defences (base for damage over time such as ignite). */
  readonly raw: DamageByType;
  /** Damage after defences. */
  readonly damage: DamageByType;
  readonly total: number;
  readonly isCrit: boolean;
}

/** Crit is applied before defences, so armour is weaker against crits (bigger hit). */
export function resolveHit(rng: Rng, input: HitInput, defences: Defences, config: CombatConfig): HitResult {
  const isCrit = rng.chance(Math.min(1, Math.max(0, input.critChance)));
  const raw = isCrit ? scaleDamage(input.damage, input.critMultiplier) : input.damage;
  const damage = mitigate(raw, defences, config);
  return { raw, damage, total: totalDamage(damage), isCrit };
}

export interface Pools {
  readonly life: number;
  readonly energyShield: number;
}

export interface DamageApplication {
  readonly pools: Pools;
  readonly shieldLost: number;
  readonly lifeLost: number;
  readonly isDead: boolean;
}

/** Energy shield absorbs damage before life. */
export function applyDamage(pools: Pools, amount: number): DamageApplication {
  const incoming = Math.max(0, amount);
  const shieldLost = Math.min(pools.energyShield, incoming);
  const lifeLost = Math.min(pools.life, incoming - shieldLost);
  const life = pools.life - lifeLost;
  return {
    pools: { life, energyShield: pools.energyShield - shieldLost },
    shieldLost,
    lifeLost,
    isDead: life <= 0,
  };
}

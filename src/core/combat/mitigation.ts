import { DAMAGE_TYPES, type ElementalType } from '../stats/types';
import type { CombatConfig } from './config';
import type { DamageByType } from './damage';

export interface Defences {
  readonly armour: number;
  /** Fractions, uncapped; may be negative. */
  readonly resistances: Readonly<Record<ElementalType, number>>;
}

/** Fraction of physical damage prevented by armour for a single hit. Big hits are reduced less. */
export function armourReduction(armour: number, physicalDamage: number, config: CombatConfig): number {
  if (armour <= 0 || physicalDamage <= 0) return 0;
  const reduction = armour / (armour + config.armourK * physicalDamage);
  return Math.min(reduction, config.armourMaxReduction);
}

/** Multiplier for incoming elemental damage. Capped resistance reduces it; negative resistance increases it. */
export function resistanceMultiplier(resistance: number, config: CombatConfig): number {
  return 1 - Math.min(resistance, config.resistanceCap);
}

export function mitigate(damage: DamageByType, defences: Defences, config: CombatConfig): DamageByType {
  const result: DamageByType = {};
  for (const type of DAMAGE_TYPES) {
    const amount = damage[type];
    if (amount === undefined) continue;
    result[type] =
      type === 'physical'
        ? amount * (1 - armourReduction(defences.armour, amount, config))
        : amount * resistanceMultiplier(defences.resistances[type], config);
  }
  return result;
}

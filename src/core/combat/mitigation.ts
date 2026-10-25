import { DAMAGE_TYPES, type ElementalType } from '../stats/types';
import type { CombatConfig } from './config';
import type { DamageByType } from './damage';

export interface Defences {
  readonly armour: number;
  /** Fractions, uncapped; may be negative. */
  readonly resistances: Readonly<Record<ElementalType, number>>;
  /**
   * Armour that also works against elemental damage (hero with the elementalArmour mechanic: armour × effectiveness),
   * applied to each elemental part after its resistance. Absent / 0: elemental damage ignores armour.
   */
  readonly elementalArmour?: number;
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

/**
 * Damage after defences: physical through armour, elemental through resistance and then, with
 * Defences.elementalArmour, through that armour as well (per part, on the amount left after resistance).
 */
export function mitigate(damage: DamageByType, defences: Defences, config: CombatConfig): DamageByType {
  const result: DamageByType = {};
  const elementalArmour = defences.elementalArmour ?? 0;
  for (const type of DAMAGE_TYPES) {
    const amount = damage[type];
    if (amount === undefined) continue;
    if (type === 'physical') {
      result[type] = amount * (1 - armourReduction(defences.armour, amount, config));
      continue;
    }
    const resisted = amount * resistanceMultiplier(defences.resistances[type], config);
    result[type] = elementalArmour > 0 ? resisted * (1 - armourReduction(elementalArmour, resisted, config)) : resisted;
  }
  return result;
}

import type { Rng } from '../rng';
import { applyTotals, collectModifiers } from '../stats/modifiers';
import { DAMAGE_TYPES, type DamageType, type Modifier, type SkillTag, type Tag } from '../stats/types';

export type DamageByType = Partial<Record<DamageType, number>>;

export interface DamageRange {
  readonly min: number;
  readonly max: number;
}

export type BaseDamage = Partial<Record<DamageType, DamageRange>>;

/** Rolls each base damage range. Draws happen in DAMAGE_TYPES order to stay deterministic. */
export function rollBaseDamage(rng: Rng, base: BaseDamage): DamageByType {
  const result: DamageByType = {};
  for (const type of DAMAGE_TYPES) {
    const range = base[type];
    if (range) result[type] = rng.range(range.min, range.max);
  }
  return result;
}

/**
 * Applies damage modifiers to rolled base damage.
 * - Flat `damage` mods add damage of their `damageType` if the skill has all their tags.
 * - Increased/more `damage` mods apply to a damage portion if the skill tags plus that
 *   portion's damage type contain all their tags ("+20% fire damage" hits only the fire part).
 */
export function computeDamage(base: DamageByType, mods: readonly Modifier[], skillTags: readonly SkillTag[]): DamageByType {
  const skillContext = new Set<Tag>(skillTags);
  const flatByType: DamageByType = {};
  for (const mod of mods) {
    if (mod.stat !== 'damage' || mod.kind !== 'flat' || !mod.damageType) continue;
    if (!(mod.tags ?? []).every((tag) => skillContext.has(tag))) continue;
    flatByType[mod.damageType] = (flatByType[mod.damageType] ?? 0) + mod.value;
  }

  const scalingMods = mods.filter((mod) => mod.kind !== 'flat');
  const result: DamageByType = {};
  for (const type of DAMAGE_TYPES) {
    const amount = (base[type] ?? 0) + (flatByType[type] ?? 0);
    if (amount <= 0) continue;
    const totals = collectModifiers(scalingMods, 'damage', new Set<Tag>([...skillTags, type]));
    result[type] = applyTotals(amount, totals);
  }
  return result;
}

/**
 * Damage the defender actually takes: each portion × `damageTaken` (base 1) computed with that portion's
 * damage type as context. Applied after mitigation. The multiplier never goes below 0 (no healing from hits).
 */
export function applyDamageTaken(damage: DamageByType, defenderMods: readonly Modifier[]): DamageByType {
  const result: DamageByType = {};
  for (const type of DAMAGE_TYPES) {
    const amount = damage[type];
    if (amount === undefined) continue;
    result[type] = amount * Math.max(0, applyTotals(1, collectModifiers(defenderMods, 'damageTaken', new Set<Tag>([type]))));
  }
  return result;
}

export function totalDamage(damage: DamageByType): number {
  let sum = 0;
  for (const type of DAMAGE_TYPES) sum += damage[type] ?? 0;
  return sum;
}

export function scaleDamage(damage: DamageByType, factor: number): DamageByType {
  const result: DamageByType = {};
  for (const type of DAMAGE_TYPES) {
    const amount = damage[type];
    if (amount !== undefined) result[type] = amount * factor;
  }
  return result;
}

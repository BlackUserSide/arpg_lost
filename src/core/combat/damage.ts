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
 * - `conversion` moves a fraction of the other types (base + flat) into one type before the scaling step.
 */
export function computeDamage(
  base: DamageByType,
  mods: readonly Modifier[],
  skillTags: readonly SkillTag[],
  conversion?: { readonly to: DamageType; readonly fraction: number },
): DamageByType {
  const skillContext = new Set<Tag>(skillTags);
  const flatByType: DamageByType = {};
  for (const mod of mods) {
    if (mod.stat !== 'damage' || mod.kind !== 'flat' || !mod.damageType) continue;
    if (!(mod.tags ?? []).every((tag) => skillContext.has(tag))) continue;
    flatByType[mod.damageType] = (flatByType[mod.damageType] ?? 0) + mod.value;
  }

  const unscaled: DamageByType = {};
  for (const type of DAMAGE_TYPES) unscaled[type] = (base[type] ?? 0) + (flatByType[type] ?? 0);
  if (conversion && conversion.fraction > 0) convertDamage(unscaled, conversion.to, Math.min(1, conversion.fraction));

  const scalingMods = mods.filter((mod) => mod.kind !== 'flat');
  const result: DamageByType = {};
  for (const type of DAMAGE_TYPES) {
    const amount = unscaled[type] ?? 0;
    if (amount <= 0) continue;
    const totals = collectModifiers(scalingMods, 'damage', new Set<Tag>([...skillTags, type]));
    result[type] = applyTotals(amount, totals);
  }
  return result;
}

/** A copy of `damage` with `fraction` (clamped to 0..1) of every other type moved into `to` (e.g. mob hits of a fiery elite). */
export function convertedDamage(damage: DamageByType, conversion: { readonly to: DamageType; readonly fraction: number }): DamageByType {
  const result: DamageByType = { ...damage };
  const fraction = Math.min(1, Math.max(0, conversion.fraction));
  if (fraction > 0) convertDamage(result, conversion.to, fraction);
  // Fully converted types are dropped, so the result lists only the types the hit still deals.
  for (const type of DAMAGE_TYPES) if (result[type] === 0 && damage[type] !== undefined && type !== conversion.to) delete result[type];
  return result;
}

/** Moves `fraction` of every damage type other than `to` into `to` (in place). */
function convertDamage(damage: DamageByType, to: DamageType, fraction: number): void {
  for (const type of DAMAGE_TYPES) {
    if (type === to) continue;
    const moved = (damage[type] ?? 0) * fraction;
    if (moved <= 0) continue;
    damage[type] = (damage[type] ?? 0) - moved;
    damage[to] = (damage[to] ?? 0) + moved;
  }
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

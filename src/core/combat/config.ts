/** Global combat rules. Values live in src/data/combat.ts. */
export interface CombatConfig {
  /** Max effective elemental resistance (fraction). */
  readonly resistanceCap: number;
  /** Base crit damage multiplier before modifiers. */
  readonly critMultiplierBase: number;
  /** Armour formula: reduction = armour / (armour + armourK * physicalDamage). */
  readonly armourK: number;
  /** Upper bound for armour reduction (fraction). */
  readonly armourMaxReduction: number;
  /**
   * Bosses are never frozen (docs/design/passives-wheel.md, "Бос і контроль"): a freeze becomes a slow of this
   * magnitude (fraction of speed removed) for the source's boss duration.
   */
  readonly bossFreezeSlow: number;
  /**
   * Bosses are not stunned by ordinary stuns (same decision): a stun becomes a slow of this magnitude for the
   * stun's duration (own slot MobState.stunSlow). Exception: the full stun bar (stunBar mechanic) does stun a boss.
   */
  readonly bossStunSlow: number;
  /**
   * Cap on a skill's summed life cost fraction (ActionDef.lifeCostFraction, Rift Ring): several sources add up, but
   * one use never takes more than this fraction of the current life (or ES under lifeToEnergyShield). Below 1, so the
   * cost never drains the last point.
   */
  readonly maxLifeCostFraction: number;
}

export const DAMAGE_TYPES = ['physical', 'fire', 'cold', 'lightning'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

export const ELEMENTAL_TYPES = ['fire', 'cold', 'lightning'] as const;
export type ElementalType = (typeof ELEMENTAL_TYPES)[number];

/** `attack` / `spell` decide whether attack speed or cast speed applies. */
export const SKILL_TAGS = ['attack', 'spell', 'melee', 'projectile', 'area'] as const;
export type SkillTag = (typeof SKILL_TAGS)[number];

export type Tag = DamageType | SkillTag;

export const STAT_IDS = [
  'life',
  'lifeRegen',
  'energyShield',
  'energyShieldRegen',
  'mana',
  'manaRegen',
  'armour',
  'fireResistance',
  'coldResistance',
  'lightningResistance',
  'damage',
  'critChance',
  'critMultiplier',
  'attackSpeed',
  'castSpeed',
  'cooldownRecovery',
  'movementSpeed',
  /**
   * Multiplier on damage the hero takes, base 1 (applied after armour / resistances, before the
   * ES / life split). Tags: the damage type of each portion ("+20% fire damage taken").
   */
  'damageTaken',
  /**
   * Ignite chance of ignite sources (passive ignite, "ignite on hit" statuses); flat adds to the source's
   * base chance (0.2 = +20 percentage points). Has no effect without an ignite source.
   */
  'igniteChance',
  /** Ignite damage: scales the total damage an ignite deals (base = the source's fraction of the hit). */
  'igniteDamage',
  /** Freeze duration in seconds; base = the freeze source's duration. */
  'freezeDuration',
] as const;
export type StatId = (typeof STAT_IDS)[number];

export type ModifierKind = 'flat' | 'increased' | 'more';

/**
 * A single stat modifier. `value` for increased/more is a fraction (0.2 = +20%).
 * `tags` are conditions: the modifier applies only if the context has all of them.
 * `damageType` is used only by flat `damage` modifiers: "adds N damage of this type".
 */
export interface Modifier {
  readonly stat: StatId;
  readonly kind: ModifierKind;
  readonly value: number;
  readonly tags?: readonly Tag[];
  readonly damageType?: DamageType;
}

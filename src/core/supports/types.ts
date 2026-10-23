// Skill modifiers ("supports", docs/design/skill-modifiers.md): schema of the support data and of the support
// items a character owns. Plain data; the numbers live in src/data/supports.ts.

import type { PassiveMechanicKind } from '../passives/types';
import type { SkillBonus } from '../skills/types';
import type { SkillTag } from '../stats/types';
import type { Delivery } from '../world/content';

/**
 * Which skills a support can be socketed into: "a support that would do nothing can't be socketed" (design),
 * spelled out as data. Checked against the skill's class data (ActionDef), never against the resolved skill,
 * so compatibility only changes when data changes. Every given rule must hold.
 */
export interface SupportCompatibility {
  /** The skill has every tag of at least one of these sets (OR of ANDs). Omit: any tags. */
  readonly tags?: readonly (readonly SkillTag[])[];
  /** The skill's delivery is one of these kinds. Omit: any delivery. */
  readonly deliveries?: readonly Delivery['kind'][];
  /** The skill's delivery is none of these kinds (Echo: no movement skills or buffs). */
  readonly excludeDeliveries?: readonly Delivery['kind'][];
  /** True: the skill deals damage (has ActionDef.damage). */
  readonly damaging?: boolean;
  /** True: projectile skills that explode on impact do not qualify (Pierce would do nothing for them). */
  readonly nonExploding?: boolean;
}

/**
 * A tier's effect when the hero has a passive mechanic of `mechanic` kind: replaces the tier's `bonus` (the Stun
 * support fills the Guardian's stun bar instead of rolling a stun chance, designer decision 2026-10-23).
 */
export interface SupportVariant {
  readonly mechanic: PassiveMechanicKind;
  readonly bonus: SkillBonus;
}

export interface SupportTierDef {
  /** What the support gives the skill it is socketed into (a SkillChangeSet targeting that skill). */
  readonly bonus: SkillBonus;
  /** First variant whose mechanic the hero has replaces `bonus`. */
  readonly variants?: readonly SupportVariant[];
}

export interface SupportDef {
  readonly id: string;
  /** Display name (Ukrainian). */
  readonly name: string;
  /** One-line effect summary for tooltips (Ukrainian); exact numbers come from the tier's bonus. */
  readonly description: string;
  /** Design group (for UI sorting / filters). */
  readonly group: 'melee' | 'projectile' | 'spell' | 'general';
  readonly compatibility: SupportCompatibility;
  /** Multiplier on the skill's resource cost; two supports multiply (designer decision 2026-10-23). */
  readonly resourceCostMultiplier: number;
  /** Drop weight among the supports that can drop. */
  readonly weight: number;
  /** Index 0 = tier 1. Higher tiers are stronger. */
  readonly tiers: readonly SupportTierDef[];
}

/** Support drop chance per kill, by mob rank. */
export interface SupportDropChance {
  readonly normal: number;
  readonly elite: number;
  readonly boss: number;
}

export interface SupportRules {
  /** Support slots per skill (the basic attack has none). */
  readonly slotsPerSkill: number;
  /** Supports a character can own (the supports tab); drops past it are salvaged into shards. */
  readonly tabSize: number;
  /** Minimum area (map) level for each tier; index 0 = tier 1. Like affix tiers by item level. */
  readonly tierMinLevel: readonly number[];
  /** Drop weight of each available tier; index 0 = tier 1. */
  readonly tierWeights: readonly number[];
  readonly dropChance: SupportDropChance;
  /** Shards (SALVAGE_CURRENCY) for salvaging a support of each tier; index 0 = tier 1. */
  readonly salvage: readonly number[];
}

export interface SupportData {
  readonly rules: SupportRules;
  readonly supports: Readonly<Record<string, SupportDef>>;
}

/** What drops / what the world needs to apply a support: its def and tier. */
export interface SupportRef {
  readonly defId: string;
  /** 1..tiers.length. */
  readonly tier: number;
}

/** Where a support is socketed: a class skill and its slot (0-based, < slotsPerSkill). */
export interface SupportSocket {
  readonly skillId: string;
  readonly slot: number;
}

/**
 * A support a character owns (saved JSON in CharacterRecord.supports). Socketed supports stay in the same list
 * with `socket` set, so unsocketing never needs room; the tab size counts every owned support.
 */
export interface SupportItem extends SupportRef {
  readonly id: string;
  socket?: SupportSocket;
}

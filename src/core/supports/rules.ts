// Skill modifier rules (docs/design/skill-modifiers.md): which skills a support fits, and what socketed supports
// change, as SkillChangeSets for the skill resolver (core/skills/params, after the passive tree and skill levels).
// Pure functions over plain data.

import type { PassiveMechanic } from '../passives/types';
import type { SkillChangeSet } from '../skills/types';
import type { ActionDef, ClassDef } from '../world/content';
import type { SupportDef, SupportData, SupportRef, SupportTierDef } from './types';

/**
 * True if the support can be socketed into `skill` (the class data action, not the resolved one): every rule of
 * SupportDef.compatibility holds. "A support that would do nothing can't be socketed" is spelled out per support
 * in data (e.g. Pierce: projectile deliveries that do not explode).
 */
export function supportFits(def: SupportDef, skill: ActionDef): boolean {
  const c = def.compatibility;
  if (c.tags && !c.tags.some((set) => set.every((t) => skill.tags.includes(t)))) return false;
  if (c.deliveries && !c.deliveries.includes(skill.delivery.kind)) return false;
  if (c.excludeDeliveries?.includes(skill.delivery.kind)) return false;
  if (c.damaging && !skill.damage) return false;
  if (c.nonExploding && skill.delivery.kind === 'projectile' && skill.delivery.explodeRadius !== undefined) return false;
  return true;
}

/** The tier definition of a support ref (tier clamped to the def's tiers), or undefined for an unknown def. */
export function supportTier(ref: SupportRef, data: SupportData): { def: SupportDef; tier: SupportTierDef } | undefined {
  const def = data.supports[ref.defId];
  if (!def || def.tiers.length === 0) return undefined;
  const index = Math.min(def.tiers.length, Math.max(1, Math.floor(ref.tier))) - 1;
  const tier = def.tiers[index];
  return tier ? { def, tier } : undefined;
}

/**
 * The change set one socketed support gives its skill: the tier's bonus (or the first variant whose passive
 * mechanic the hero has, e.g. the Stun support filling the Guardian's stun bar) targeting that skill only, with
 * the support's resource cost multiplier (multiplied with the bonus's own, if any).
 */
export function supportChangeSet(skillId: string, ref: SupportRef, data: SupportData, mechanics: readonly PassiveMechanic[]): SkillChangeSet | undefined {
  const found = supportTier(ref, data);
  if (!found) return undefined;
  const { def, tier } = found;
  const variant = tier.variants?.find((v) => mechanics.some((m) => m.kind === v.mechanic));
  const bonus = variant ? variant.bonus : tier.bonus;
  return { ...bonus, skillIds: [skillId], resourceCostMultiplier: def.resourceCostMultiplier * (bonus.resourceCostMultiplier ?? 1) };
}

/**
 * Change sets of the hero's socketed supports, in class skill order then slot order. Supports socketed into a
 * skill the class does not have, into the basic attack, past the slot count, duplicates of a def already on that
 * skill, or that no longer fit the skill are ignored (the hub returns them to the tab, see validateSockets).
 */
export function supportChangeSets(
  classDef: ClassDef,
  socketed: Readonly<Record<string, readonly SupportRef[]>> | undefined,
  data: SupportData | undefined,
  mechanics: readonly PassiveMechanic[],
): SkillChangeSet[] {
  if (!data || !socketed) return [];
  const sets: SkillChangeSet[] = [];
  for (const skill of classDef.skills) {
    const seen = new Set<string>();
    for (const ref of (socketed[skill.id] ?? []).slice(0, data.rules.slotsPerSkill)) {
      const def = data.supports[ref.defId];
      if (!def || seen.has(ref.defId) || !supportFits(def, skill)) continue;
      seen.add(ref.defId);
      const set = supportChangeSet(skill.id, ref, data, mechanics);
      if (set) sets.push(set);
    }
  }
  return sets;
}

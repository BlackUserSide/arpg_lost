// Permanent hero modifiers outside of level stats: equipment + allocated passives.
// This is the one place the hero's "loadout modifiers" are assembled (run start, character screen).

import { equipmentModifiers, type Equipment } from '../items/equipment';
import type { ItemsData } from '../items/types';
import { passiveMechanics, passiveModifiers } from '../passives/allocation';
import type { PassiveAllocation, PassiveMechanic, PassiveTreeData } from '../passives/types';
import type { Modifier } from '../stats/types';

export interface HeroLoadoutSource {
  readonly equipment: Equipment;
  readonly passives: PassiveAllocation;
}

/**
 * Equipment and passive tree modifiers. Level stats are added by the world (levelModifiers).
 * Mechanic-only nodes (keystones, most spec nodes) contribute nothing here; see passiveMechanics().
 */
export function heroModifiers(hero: HeroLoadoutSource, items: ItemsData, tree: PassiveTreeData): Modifier[] {
  return [...equipmentModifiers(hero.equipment, items), ...passiveModifiers(tree, hero.passives)];
}

/** Passive tree mechanics the hero brings into a run (Loadout.mechanics / setLoadoutModifiers). */
export function heroMechanics(hero: Pick<HeroLoadoutSource, 'passives'>, tree: PassiveTreeData): PassiveMechanic[] {
  return passiveMechanics(tree, hero.passives);
}

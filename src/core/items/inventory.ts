import { findCharacter, type Profile } from '../progression/profile';
import type { Rng } from '../rng';
import { canEquip, equip, equipSlotsFor, slotOf, unequip, type EquipError } from './equipment';
import { generateItem, salvageValue, type GenerateOptions } from './generate';
import type { EquipSlot, Item, ItemsData, WeaponType } from './types';

// Account-level item operations: shared stash, equipping from it, salvaging. Mutates the profile.

export const SALVAGE_CURRENCY = 'shards';

export type InventoryError = EquipError | 'stash-full' | 'no-item' | 'no-character';

/** Creates a new item with the next profile item id (ids are never reused). */
export function rollItem(profile: Profile, rng: Rng, options: GenerateOptions, data: ItemsData): Item {
  return generateItem(rng, `i${profile.nextItemId++}`, options, data);
}

export function addToStash(profile: Profile, item: Item, data: ItemsData): InventoryError | null {
  if (profile.stash.items.length >= data.rules.stashSize) return 'stash-full';
  profile.stash.items.push(item);
  return null;
}

function takeFromStash(profile: Profile, itemId: string): Item | undefined {
  const index = profile.stash.items.findIndex((i) => i.id === itemId);
  if (index < 0) return undefined;
  return profile.stash.items.splice(index, 1)[0];
}

/**
 * Moves a stash item onto a character. The replaced item (if any) goes back to the stash.
 * `target` defaults to the natural slot (first free ring for rings).
 */
export function equipFromStash(
  profile: Profile,
  characterId: string,
  itemId: string,
  weaponType: WeaponType,
  data: ItemsData,
  target?: EquipSlot,
): InventoryError | null {
  const character = findCharacter(profile, characterId);
  if (!character) return 'no-character';
  const item = profile.stash.items.find((i) => i.id === itemId);
  if (!item) return 'no-item';
  const slot = slotOf(item, data);
  if (!slot) return 'unknown-base';
  const where = target ?? equipSlotsFor(slot, character.equipment)[0]!;
  const error = canEquip(item, where, { level: character.level, weaponType }, data);
  if (error) return error;
  takeFromStash(profile, itemId);
  const replaced = equip(character.equipment, where, item);
  if (replaced) profile.stash.items.push(replaced);
  return null;
}

export function unequipToStash(profile: Profile, characterId: string, slot: EquipSlot, data: ItemsData): InventoryError | null {
  const character = findCharacter(profile, characterId);
  if (!character) return 'no-character';
  if (!character.equipment[slot]) return 'no-item';
  if (profile.stash.items.length >= data.rules.stashSize) return 'stash-full';
  const item = unequip(character.equipment, slot);
  if (item) profile.stash.items.push(item);
  return null;
}

/** Destroys a stash item for crafting currency; returns the amount gained. */
export function salvageFromStash(profile: Profile, itemId: string, data: ItemsData): number {
  const item = takeFromStash(profile, itemId);
  if (!item) return 0;
  const amount = salvageValue(item, data);
  profile.currency[SALVAGE_CURRENCY] = (profile.currency[SALVAGE_CURRENCY] ?? 0) + amount;
  return amount;
}

export interface RunRewards {
  readonly items: Item[];
  /** Items that did not fit the stash were salvaged automatically. */
  readonly salvaged: number;
}

/** Temporary arena rewards: items by kills, item level by waves survived. Adds them to the stash. */
export function grantArenaRewards(profile: Profile, rng: Rng, run: { kills: number; wave: number }, data: ItemsData): RunRewards {
  const r = data.rules.arenaRewards;
  const count = Math.min(r.maxItems, Math.floor(run.kills / r.killsPerItem));
  const itemLevel = Math.min(r.maxItemLevel, 1 + Math.floor(run.wave / r.wavesPerItemLevel));
  const items: Item[] = [];
  let salvaged = 0;
  for (let i = 0; i < count; i++) {
    const item = rollItem(profile, rng, { itemLevel }, data);
    items.push(item);
    if (addToStash(profile, item, data)) {
      const amount = data.rules.salvage[item.rarity];
      profile.currency[SALVAGE_CURRENCY] = (profile.currency[SALVAGE_CURRENCY] ?? 0) + amount;
      salvaged += amount;
    }
  }
  return { items, salvaged };
}

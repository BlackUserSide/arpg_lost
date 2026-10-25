import { addCurrency, findCharacter, type Profile } from '../progression/profile';
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

/** Where storeLoot put an item; null: nowhere (the caller salvages it). */
export type LootPlace = 'stash' | 'overflow';

/**
 * Stores a newly found item: into the stash if there is room; otherwise, for a rarity in LootRules.overflow.rarities
 * (uniques and legendaries, designer decision 2026-10-26), at the end of the overflow if it holds fewer than
 * LootRules.overflow.size items; otherwise nowhere (null).
 */
export function storeLoot(profile: Profile, item: Item, data: ItemsData): LootPlace | null {
  if (!addToStash(profile, item, data)) return 'stash';
  const { size, rarities } = data.rules.overflow;
  if (!rarities.includes(item.rarity) || profile.stash.overflow.length >= size) return null;
  profile.stash.overflow.push(item);
  return 'overflow';
}

/** Moves one overflow item into the stash ('stash-full' if there is no room, 'no-item' for an unknown id). */
export function claimOverflow(profile: Profile, itemId: string, data: ItemsData): InventoryError | null {
  const index = profile.stash.overflow.findIndex((i) => i.id === itemId);
  if (index < 0) return 'no-item';
  if (profile.stash.items.length >= data.rules.stashSize) return 'stash-full';
  profile.stash.items.push(profile.stash.overflow.splice(index, 1)[0]!);
  return null;
}

/**
 * Moves overflow items into the stash, oldest first, while there is room; returns the ids moved (render: on hub /
 * inventory entry; finishRun: before the chest, so waiting items take freed space before new loot).
 */
export function fillStashFromOverflow(profile: Profile, data: ItemsData): string[] {
  const moved: string[] = [];
  while (profile.stash.overflow.length > 0 && profile.stash.items.length < data.rules.stashSize) {
    const item = profile.stash.overflow.shift()!;
    profile.stash.items.push(item);
    moved.push(item.id);
  }
  return moved;
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
  const where = target ?? equipSlotsFor(slot, character.equipment, item)[0]!;
  const error = canEquip(item, where, { level: character.level, weaponType, equipment: character.equipment }, data);
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
  addCurrency(profile, SALVAGE_CURRENCY, amount);
  return amount;
}

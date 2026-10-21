import type { WeaponDef } from '../world/content';
import { itemModifiers } from './generate';
import type { EquipSlot, Item, ItemsData, Slot, WeaponType } from './types';
import type { Modifier } from '../stats/types';

export type Equipment = Partial<Record<EquipSlot, Item>>;

export type EquipError = 'wrong-slot' | 'level' | 'weapon-type' | 'unknown-base';

export function slotOf(item: Item, data: ItemsData): Slot | undefined {
  return data.bases[item.baseId]?.slot;
}

/** Equip slots an item can go to, in preference order (first empty ring first). */
export function equipSlotsFor(slot: Slot, equipment: Equipment): EquipSlot[] {
  if (slot !== 'ring') return [slot];
  return equipment.ring1 && !equipment.ring2 ? ['ring2', 'ring1'] : ['ring1', 'ring2'];
}

export function canEquip(
  item: Item,
  target: EquipSlot,
  character: { level: number; weaponType: WeaponType },
  data: ItemsData,
): EquipError | null {
  const base = data.bases[item.baseId];
  if (!base) return 'unknown-base';
  const allowed: readonly EquipSlot[] = base.slot === 'ring' ? ['ring1', 'ring2'] : [base.slot];
  if (!allowed.includes(target)) return 'wrong-slot';
  // Requirement ≈ item level (docs/design/items.md).
  if (item.level > character.level) return 'level';
  if (base.weapon && base.weapon.type !== character.weaponType) return 'weapon-type';
  return null;
}

/** Puts the item into `target`; returns the item it replaced (if any). Does not validate. */
export function equip(equipment: Equipment, target: EquipSlot, item: Item): Item | undefined {
  const previous = equipment[target];
  equipment[target] = item;
  return previous;
}

export function unequip(equipment: Equipment, target: EquipSlot): Item | undefined {
  const previous = equipment[target];
  delete equipment[target];
  return previous;
}

export function equipmentModifiers(equipment: Equipment, data: ItemsData): Modifier[] {
  return Object.values(equipment).flatMap((item) => (item ? itemModifiers(item, data) : []));
}

/** Weapon stats from the equipped weapon, or the class default when unarmed. */
export function equippedWeapon(equipment: Equipment, data: ItemsData, fallback: WeaponDef): WeaponDef {
  const weapon = equipment.weapon && data.bases[equipment.weapon.baseId]?.weapon;
  return weapon ? { damage: weapon.damage, attacksPerSecond: weapon.attacksPerSecond, critChance: weapon.critChance } : fallback;
}

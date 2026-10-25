import type { WeaponDef } from '../world/content';
import { itemMechanics, itemModifiers } from './generate';
import { EQUIP_SLOTS, type EquipSlot, type Item, type ItemsData, type Slot, type WeaponType } from './types';
import type { PassiveMechanic } from '../passives/types';
import type { Modifier } from '../stats/types';

export type Equipment = Partial<Record<EquipSlot, Item>>;

export type EquipError = 'wrong-slot' | 'level' | 'weapon-type' | 'unknown-base' | 'unique-duplicate';

export function slotOf(item: Item, data: ItemsData): Slot | undefined {
  return data.bases[item.baseId]?.slot;
}

/** Equip slots an item can go to, in preference order (first empty ring first). */
export function equipSlotsFor(slot: Slot, equipment: Equipment): EquipSlot[] {
  if (slot !== 'ring') return [slot];
  return equipment.ring1 && !equipment.ring2 ? ['ring2', 'ring1'] : ['ring1', 'ring2'];
}

/**
 * Why `item` cannot go to `target`, or null. With the character's `equipment` given, the same unique / legendary
 * (same UniqueDef id) worn in another slot is refused ('unique-duplicate', designer default 2026-10-25: no two
 * identical rings); replacing the copy in `target` itself is fine.
 */
export function canEquip(
  item: Item,
  target: EquipSlot,
  character: { level: number; weaponType: WeaponType; equipment?: Equipment },
  data: ItemsData,
): EquipError | null {
  const base = data.bases[item.baseId];
  if (!base) return 'unknown-base';
  const allowed: readonly EquipSlot[] = base.slot === 'ring' ? ['ring1', 'ring2'] : [base.slot];
  if (!allowed.includes(target)) return 'wrong-slot';
  // Requirement ≈ item level (docs/design/items.md).
  if (data.rules.enforceLevelRequirement && item.level > character.level) return 'level';
  if (base.weapon && base.weapon.type !== character.weaponType) return 'weapon-type';
  const uniqueId = item.unique?.id;
  if (uniqueId !== undefined && character.equipment) {
    for (const slot of EQUIP_SLOTS) {
      const worn = character.equipment[slot];
      if (slot !== target && worn && worn.id !== item.id && worn.unique?.id === uniqueId) return 'unique-duplicate';
    }
  }
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

/** Mechanics of the equipped items (uniques / legendaries), in EQUIP_SLOTS order. */
export function equipmentMechanics(equipment: Equipment, data: ItemsData): PassiveMechanic[] {
  return EQUIP_SLOTS.flatMap((slot) => {
    const item = equipment[slot];
    return item ? itemMechanics(item, data) : [];
  });
}

/** Weapon stats from the equipped weapon, or the class default when unarmed. */
export function equippedWeapon(equipment: Equipment, data: ItemsData, fallback: WeaponDef): WeaponDef {
  const weapon = equipment.weapon && data.bases[equipment.weapon.baseId]?.weapon;
  return weapon ? { damage: weapon.damage, attacksPerSecond: weapon.attacksPerSecond, critChance: weapon.critChance } : fallback;
}

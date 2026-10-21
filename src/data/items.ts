import type { AffixDef, AffixTier, BaseDef, ItemsData, LootRules, Slot, StatLine } from '../core/items/types';

// See docs/design/items.md. All numbers are PROPOSAL until a balance pass.

const TIER_LEVELS = [1, 8, 15, 23, 30] as const;

/** Builds 5 tiers (worst → best) from value ranges. */
function tiers(ranges: ReadonlyArray<readonly [number, number]>, step: number): AffixTier[] {
  return ranges.map(([min, max], i) => ({ min, max, step, minLevel: TIER_LEVELS[i] ?? 1 }));
}

const ARMOUR_SLOTS: readonly Slot[] = ['helmet', 'armour', 'gloves', 'boots'];
const ALL_DEFENSIVE: readonly Slot[] = ['helmet', 'armour', 'gloves', 'boots', 'ring', 'amulet'];

function affix(
  id: string,
  kind: AffixDef['kind'],
  slots: readonly Slot[],
  weight: number,
  line: StatLine,
  t: AffixTier[],
  requires?: AffixDef['requires'],
): AffixDef {
  return { id, group: id, kind, slots, weight, line, tiers: t, ...(requires ? { requires } : {}) };
}

const pct = (...r: Array<[number, number]>): AffixTier[] => tiers(r, 0.01);
const int = (...r: Array<[number, number]>): AffixTier[] => tiers(r, 1);
const dec = (...r: Array<[number, number]>): AffixTier[] => tiers(r, 0.1);

const affixList: AffixDef[] = [
  // ── Prefixes: damage, life, energy shield, armour ──
  affix('life_flat', 'prefix', ALL_DEFENSIVE, 1000, { stat: 'life', kind: 'flat' }, int([8, 14], [15, 24], [25, 34], [35, 44], [45, 55])),
  affix('life_inc', 'prefix', ['armour', 'amulet'], 400, { stat: 'life', kind: 'increased' }, pct([0.04, 0.06], [0.07, 0.09], [0.1, 0.12], [0.13, 0.15], [0.16, 0.18])),
  affix('es_flat', 'prefix', ['helmet', 'armour', 'gloves', 'boots', 'amulet'], 600, { stat: 'energyShield', kind: 'flat' }, int([5, 9], [10, 16], [17, 24], [25, 33], [34, 42]), 'energyShield'),
  affix('es_inc', 'prefix', ARMOUR_SLOTS, 400, { stat: 'energyShield', kind: 'increased' }, pct([0.1, 0.15], [0.16, 0.22], [0.23, 0.3], [0.31, 0.38], [0.39, 0.46]), 'energyShield'),
  affix('armour_flat', 'prefix', ARMOUR_SLOTS, 600, { stat: 'armour', kind: 'flat' }, int([8, 15], [16, 30], [31, 50], [51, 75], [76, 100]), 'armour'),
  affix('armour_inc', 'prefix', ARMOUR_SLOTS, 400, { stat: 'armour', kind: 'increased' }, pct([0.1, 0.15], [0.16, 0.22], [0.23, 0.3], [0.31, 0.38], [0.39, 0.46]), 'armour'),
  affix('added_physical', 'prefix', ['weapon', 'ring', 'gloves', 'amulet'], 500, { stat: 'damage', kind: 'flat', damageType: 'physical' }, int([1, 3], [3, 5], [5, 8], [8, 12], [12, 16])),
  affix('added_fire', 'prefix', ['weapon', 'ring', 'gloves', 'amulet'], 500, { stat: 'damage', kind: 'flat', damageType: 'fire' }, int([2, 4], [4, 7], [7, 11], [11, 16], [16, 22])),
  affix('added_cold', 'prefix', ['weapon', 'ring', 'gloves', 'amulet'], 500, { stat: 'damage', kind: 'flat', damageType: 'cold' }, int([2, 4], [4, 7], [7, 11], [11, 16], [16, 22])),
  affix('added_lightning', 'prefix', ['weapon', 'ring', 'gloves', 'amulet'], 500, { stat: 'damage', kind: 'flat', damageType: 'lightning' }, int([1, 5], [3, 8], [5, 12], [8, 18], [12, 25])),
  affix('attack_damage_inc', 'prefix', ['weapon', 'amulet', 'gloves'], 500, { stat: 'damage', kind: 'increased', tags: ['attack'] }, pct([0.1, 0.15], [0.16, 0.24], [0.25, 0.34], [0.35, 0.44], [0.45, 0.55])),
  affix('spell_damage_inc', 'prefix', ['weapon', 'amulet', 'helmet'], 500, { stat: 'damage', kind: 'increased', tags: ['spell'] }, pct([0.1, 0.15], [0.16, 0.24], [0.25, 0.34], [0.35, 0.44], [0.45, 0.55])),

  // ── Suffixes: resistances, speeds, crit, regeneration ──
  affix('fire_res', 'suffix', ALL_DEFENSIVE, 800, { stat: 'fireResistance', kind: 'flat' }, pct([0.06, 0.11], [0.12, 0.17], [0.18, 0.23], [0.24, 0.29], [0.3, 0.36])),
  affix('cold_res', 'suffix', ALL_DEFENSIVE, 800, { stat: 'coldResistance', kind: 'flat' }, pct([0.06, 0.11], [0.12, 0.17], [0.18, 0.23], [0.24, 0.29], [0.3, 0.36])),
  affix('lightning_res', 'suffix', ALL_DEFENSIVE, 800, { stat: 'lightningResistance', kind: 'flat' }, pct([0.06, 0.11], [0.12, 0.17], [0.18, 0.23], [0.24, 0.29], [0.3, 0.36])),
  affix('attack_speed', 'suffix', ['weapon', 'gloves', 'ring'], 500, { stat: 'attackSpeed', kind: 'increased' }, pct([0.05, 0.07], [0.08, 0.1], [0.11, 0.13], [0.14, 0.16], [0.17, 0.2])),
  affix('cast_speed', 'suffix', ['weapon', 'amulet', 'ring'], 500, { stat: 'castSpeed', kind: 'increased' }, pct([0.05, 0.07], [0.08, 0.1], [0.11, 0.13], [0.14, 0.16], [0.17, 0.2])),
  affix('move_speed', 'suffix', ['boots'], 600, { stat: 'movementSpeed', kind: 'increased' }, pct([0.05, 0.08], [0.09, 0.12], [0.13, 0.16], [0.17, 0.2], [0.21, 0.25])),
  affix('crit_chance', 'suffix', ['weapon', 'amulet', 'ring'], 500, { stat: 'critChance', kind: 'increased' }, pct([0.1, 0.19], [0.2, 0.29], [0.3, 0.39], [0.4, 0.49], [0.5, 0.6])),
  affix('crit_multiplier', 'suffix', ['weapon', 'amulet'], 400, { stat: 'critMultiplier', kind: 'flat' }, pct([0.1, 0.14], [0.15, 0.19], [0.2, 0.24], [0.25, 0.29], [0.3, 0.35])),
  affix('life_regen', 'suffix', ['armour', 'amulet', 'ring'], 500, { stat: 'lifeRegen', kind: 'flat' }, dec([0.5, 1], [1.1, 2], [2.1, 3], [3.1, 4.5], [4.6, 6])),
  affix('mana_regen', 'suffix', ['helmet', 'amulet', 'ring'], 500, { stat: 'manaRegen', kind: 'flat' }, dec([0.5, 1], [1.1, 2], [2.1, 3], [3.1, 4.5], [4.6, 6])),
  affix('mana_flat', 'suffix', ['helmet', 'ring', 'amulet'], 500, { stat: 'mana', kind: 'flat' }, int([5, 9], [10, 15], [16, 22], [23, 30], [31, 40])),
  affix('cooldown_recovery', 'suffix', ['helmet', 'amulet', 'gloves'], 400, { stat: 'cooldownRecovery', kind: 'increased' }, pct([0.04, 0.06], [0.07, 0.09], [0.1, 0.12], [0.13, 0.15], [0.16, 0.18])),
];

const range = (min: number, max: number, step = 1): { min: number; max: number; step: number } => ({ min, max, step });

const baseList: BaseDef[] = [
  // Weapons: one type per class (docs/design/classes.md).
  { id: 'rusty_sword', name: 'Rusty Sword', slot: 'weapon', level: 1, weapon: { type: 'sword', damage: { physical: { min: 6, max: 11 } }, attacksPerSecond: 1.6, critChance: 0.05 }, implicit: { stat: 'critChance', kind: 'increased', range: range(0.1, 0.15, 0.01) } },
  { id: 'broadsword', name: 'Broadsword', slot: 'weapon', level: 10, weapon: { type: 'sword', damage: { physical: { min: 9, max: 16 } }, attacksPerSecond: 1.55, critChance: 0.05 }, implicit: { stat: 'critChance', kind: 'increased', range: range(0.15, 0.2, 0.01) } },
  { id: 'war_sword', name: 'War Sword', slot: 'weapon', level: 20, weapon: { type: 'sword', damage: { physical: { min: 13, max: 22 } }, attacksPerSecond: 1.5, critChance: 0.05 }, implicit: { stat: 'critChance', kind: 'increased', range: range(0.2, 0.25, 0.01) } },
  { id: 'light_crossbow', name: 'Light Crossbow', slot: 'weapon', level: 1, weapon: { type: 'crossbow', damage: { physical: { min: 6, max: 12 } }, attacksPerSecond: 1.4, critChance: 0.06 }, implicit: { stat: 'damage', kind: 'increased', tags: ['projectile'], range: range(0.06, 0.1, 0.01) } },
  { id: 'heavy_crossbow', name: 'Heavy Crossbow', slot: 'weapon', level: 10, weapon: { type: 'crossbow', damage: { physical: { min: 10, max: 18 } }, attacksPerSecond: 1.3, critChance: 0.06 }, implicit: { stat: 'damage', kind: 'increased', tags: ['projectile'], range: range(0.1, 0.14, 0.01) } },
  { id: 'arbalest', name: 'Arbalest', slot: 'weapon', level: 20, weapon: { type: 'crossbow', damage: { physical: { min: 14, max: 25 } }, attacksPerSecond: 1.3, critChance: 0.06 }, implicit: { stat: 'damage', kind: 'increased', tags: ['projectile'], range: range(0.14, 0.18, 0.01) } },
  { id: 'driftwood_wand', name: 'Driftwood Wand', slot: 'weapon', level: 1, weapon: { type: 'wand', damage: { lightning: { min: 4, max: 9 } }, attacksPerSecond: 1.5, critChance: 0.07 }, implicit: { stat: 'damage', kind: 'increased', tags: ['spell'], range: range(0.06, 0.1, 0.01) } },
  { id: 'bone_wand', name: 'Bone Wand', slot: 'weapon', level: 10, weapon: { type: 'wand', damage: { lightning: { min: 6, max: 13 } }, attacksPerSecond: 1.5, critChance: 0.07 }, implicit: { stat: 'damage', kind: 'increased', tags: ['spell'], range: range(0.1, 0.14, 0.01) } },
  { id: 'runed_wand', name: 'Runed Wand', slot: 'weapon', level: 20, weapon: { type: 'wand', damage: { lightning: { min: 9, max: 18 } }, attacksPerSecond: 1.45, critChance: 0.07 }, implicit: { stat: 'damage', kind: 'increased', tags: ['spell'], range: range(0.14, 0.18, 0.01) } },

  // Helmets: armour / energy shield / hybrid; implicit +mana.
  { id: 'iron_cap', name: 'Iron Cap', slot: 'helmet', level: 1, armour: range(8, 12), implicit: { stat: 'mana', kind: 'flat', range: range(5, 8) } },
  { id: 'hood', name: 'Hood', slot: 'helmet', level: 1, energyShield: range(6, 9), implicit: { stat: 'mana', kind: 'flat', range: range(5, 8) } },
  { id: 'leather_helm', name: 'Leather Helm', slot: 'helmet', level: 1, armour: range(4, 6), energyShield: range(3, 5), implicit: { stat: 'mana', kind: 'flat', range: range(5, 8) } },
  { id: 'great_helm', name: 'Great Helm', slot: 'helmet', level: 15, armour: range(25, 35), implicit: { stat: 'mana', kind: 'flat', range: range(9, 14) } },
  { id: 'sage_hood', name: 'Sage Hood', slot: 'helmet', level: 15, energyShield: range(18, 26), implicit: { stat: 'mana', kind: 'flat', range: range(9, 14) } },
  { id: 'warded_helm', name: 'Warded Helm', slot: 'helmet', level: 15, armour: range(12, 18), energyShield: range(9, 13), implicit: { stat: 'mana', kind: 'flat', range: range(9, 14) } },

  // Body armour; implicit +life.
  { id: 'chainmail', name: 'Chainmail', slot: 'armour', level: 1, armour: range(20, 30), implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'robe', name: 'Robe', slot: 'armour', level: 1, energyShield: range(15, 22), implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'brigandine', name: 'Brigandine', slot: 'armour', level: 1, armour: range(10, 15), energyShield: range(8, 11), implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'plate_armour', name: 'Plate Armour', slot: 'armour', level: 15, armour: range(60, 80), implicit: { stat: 'life', kind: 'flat', range: range(18, 25) } },
  { id: 'arcane_robe', name: 'Arcane Robe', slot: 'armour', level: 15, energyShield: range(45, 60), implicit: { stat: 'life', kind: 'flat', range: range(18, 25) } },
  { id: 'scale_robe', name: 'Scale Robe', slot: 'armour', level: 15, armour: range(30, 40), energyShield: range(22, 30), implicit: { stat: 'life', kind: 'flat', range: range(18, 25) } },

  // Gloves; implicit increased crit chance.
  { id: 'iron_gauntlets', name: 'Iron Gauntlets', slot: 'gloves', level: 1, armour: range(5, 8), implicit: { stat: 'critChance', kind: 'increased', range: range(0.05, 0.08, 0.01) } },
  { id: 'silk_gloves', name: 'Silk Gloves', slot: 'gloves', level: 1, energyShield: range(4, 6), implicit: { stat: 'critChance', kind: 'increased', range: range(0.05, 0.08, 0.01) } },
  { id: 'wrapped_mitts', name: 'Wrapped Mitts', slot: 'gloves', level: 1, armour: range(3, 4), energyShield: range(2, 3), implicit: { stat: 'critChance', kind: 'increased', range: range(0.05, 0.08, 0.01) } },
  { id: 'steel_gauntlets', name: 'Steel Gauntlets', slot: 'gloves', level: 15, armour: range(16, 22), implicit: { stat: 'critChance', kind: 'increased', range: range(0.09, 0.12, 0.01) } },
  { id: 'sorcerer_gloves', name: 'Sorcerer Gloves', slot: 'gloves', level: 15, energyShield: range(12, 16), implicit: { stat: 'critChance', kind: 'increased', range: range(0.09, 0.12, 0.01) } },
  { id: 'studded_gloves', name: 'Studded Gloves', slot: 'gloves', level: 15, armour: range(8, 11), energyShield: range(6, 8), implicit: { stat: 'critChance', kind: 'increased', range: range(0.09, 0.12, 0.01) } },

  // Boots; implicit increased movement speed.
  { id: 'iron_greaves', name: 'Iron Greaves', slot: 'boots', level: 1, armour: range(5, 8), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.03, 0.05, 0.01) } },
  { id: 'silk_slippers', name: 'Silk Slippers', slot: 'boots', level: 1, energyShield: range(4, 6), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.03, 0.05, 0.01) } },
  { id: 'leather_boots', name: 'Leather Boots', slot: 'boots', level: 1, armour: range(3, 4), energyShield: range(2, 3), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.03, 0.05, 0.01) } },
  { id: 'steel_greaves', name: 'Steel Greaves', slot: 'boots', level: 15, armour: range(16, 22), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.05, 0.07, 0.01) } },
  { id: 'mystic_slippers', name: 'Mystic Slippers', slot: 'boots', level: 15, energyShield: range(12, 16), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.05, 0.07, 0.01) } },
  { id: 'ranger_boots', name: 'Ranger Boots', slot: 'boots', level: 15, armour: range(8, 11), energyShield: range(6, 8), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.05, 0.07, 0.01) } },

  // Rings and amulets.
  { id: 'iron_ring', name: 'Iron Ring', slot: 'ring', level: 1, implicit: { stat: 'life', kind: 'flat', range: range(8, 12) } },
  { id: 'ruby_ring', name: 'Ruby Ring', slot: 'ring', level: 1, implicit: { stat: 'fireResistance', kind: 'flat', range: range(0.08, 0.12, 0.01) } },
  { id: 'sapphire_ring', name: 'Sapphire Ring', slot: 'ring', level: 1, implicit: { stat: 'coldResistance', kind: 'flat', range: range(0.08, 0.12, 0.01) } },
  { id: 'topaz_ring', name: 'Topaz Ring', slot: 'ring', level: 1, implicit: { stat: 'lightningResistance', kind: 'flat', range: range(0.08, 0.12, 0.01) } },
  { id: 'amber_amulet', name: 'Amber Amulet', slot: 'amulet', level: 1, implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'jade_amulet', name: 'Jade Amulet', slot: 'amulet', level: 1, implicit: { stat: 'lifeRegen', kind: 'flat', range: range(0.5, 1, 0.1) } },
  { id: 'lapis_amulet', name: 'Lapis Amulet', slot: 'amulet', level: 1, implicit: { stat: 'mana', kind: 'flat', range: range(10, 15) } },
];

const rules: LootRules = {
  rarityWeights: { normal: 55, magic: 33, rare: 11 },
  affixCount: { magic: { min: 1, max: 2 }, rare: { min: 3, max: 6 } },
  maxPrefixes: { magic: 1, rare: 3 },
  maxSuffixes: { magic: 1, rare: 3 },
  tierWeights: [10, 25, 50, 80, 100],
  salvage: { normal: 1, magic: 3, rare: 8, unique: 25, legendary: 100 },
  stashSize: 30,
  enforceLevelRequirement: true,
  arenaRewards: { killsPerItem: 20, maxItems: 3, wavesPerItemLevel: 3, maxItemLevel: 30 },
  rareNameWords: {
    first: ['Grim', 'Dusk', 'Ashen', 'Blood', 'Storm', 'Bone', 'Gloom', 'Rune', 'Iron', 'Hollow', 'Wraith', 'Ember'],
    second: ['Bane', 'Grasp', 'Ward', 'Veil', 'Fang', 'Song', 'Shroud', 'Mark', 'Coil', 'Crown', 'Stride', 'Whisper'],
  },
};

const byId = <T extends { id: string }>(list: readonly T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

export const itemsData: ItemsData = { bases: byId(baseList), affixes: byId(affixList), rules };

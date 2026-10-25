import type { AffixDef, AffixTier, BaseDef, ItemsData, LootRules, Slot, StatLine, UniqueDef, UniqueStatLine } from '../core/items/types';

// See docs/design/items.md. All numbers are PROPOSAL until a balance pass.
// Base names are keyed by id in src/i18n/locales (base.<id>.name); rare name words double as their keys.

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
  // PROPOSAL: resource regen tiers ×0.6 of life regen: 4 stacked best rolls at ilvl 20 (+10/s) made every class's skills free
  // (sustain 94-100%, tools/sim/resource.sim.ts); now +6/s.
  affix('resource_regen', 'suffix', ['helmet', 'amulet', 'ring'], 500, { stat: 'resourceRegen', kind: 'flat' }, dec([0.3, 0.6], [0.7, 1.2], [1.3, 1.8], [1.9, 2.7], [2.8, 3.6])),
  affix('resource_flat', 'suffix', ['helmet', 'ring', 'amulet'], 500, { stat: 'resource', kind: 'flat' }, int([5, 9], [10, 15], [16, 22], [23, 30], [31, 40])),
  affix('cooldown_recovery', 'suffix', ['helmet', 'amulet', 'gloves'], 400, { stat: 'cooldownRecovery', kind: 'increased' }, pct([0.04, 0.06], [0.07, 0.09], [0.1, 0.12], [0.13, 0.15], [0.16, 0.18])),
];

const range = (min: number, max: number, step = 1): { min: number; max: number; step: number } => ({ min, max, step });

const baseList: BaseDef[] = [
  // Weapons: one type per class (docs/design/classes.md).
  { id: 'rusty_sword', slot: 'weapon', level: 1, weapon: { type: 'sword', damage: { physical: { min: 6, max: 11 } }, attacksPerSecond: 1.6, critChance: 0.05 }, implicit: { stat: 'critChance', kind: 'increased', range: range(0.1, 0.15, 0.01) } },
  { id: 'broadsword', slot: 'weapon', level: 10, weapon: { type: 'sword', damage: { physical: { min: 9, max: 16 } }, attacksPerSecond: 1.55, critChance: 0.05 }, implicit: { stat: 'critChance', kind: 'increased', range: range(0.15, 0.2, 0.01) } },
  { id: 'war_sword', slot: 'weapon', level: 20, weapon: { type: 'sword', damage: { physical: { min: 13, max: 22 } }, attacksPerSecond: 1.5, critChance: 0.05 }, implicit: { stat: 'critChance', kind: 'increased', range: range(0.2, 0.25, 0.01) } },
  { id: 'light_crossbow', slot: 'weapon', level: 1, weapon: { type: 'crossbow', damage: { physical: { min: 6, max: 12 } }, attacksPerSecond: 1.4, critChance: 0.06 }, implicit: { stat: 'damage', kind: 'increased', tags: ['projectile'], range: range(0.06, 0.1, 0.01) } },
  { id: 'heavy_crossbow', slot: 'weapon', level: 10, weapon: { type: 'crossbow', damage: { physical: { min: 10, max: 18 } }, attacksPerSecond: 1.3, critChance: 0.06 }, implicit: { stat: 'damage', kind: 'increased', tags: ['projectile'], range: range(0.1, 0.14, 0.01) } },
  { id: 'arbalest', slot: 'weapon', level: 20, weapon: { type: 'crossbow', damage: { physical: { min: 14, max: 25 } }, attacksPerSecond: 1.3, critChance: 0.06 }, implicit: { stat: 'damage', kind: 'increased', tags: ['projectile'], range: range(0.14, 0.18, 0.01) } },
  { id: 'driftwood_wand', slot: 'weapon', level: 1, weapon: { type: 'wand', damage: { lightning: { min: 4, max: 9 } }, attacksPerSecond: 1.5, critChance: 0.07 }, implicit: { stat: 'damage', kind: 'increased', tags: ['spell'], range: range(0.06, 0.1, 0.01) } },
  { id: 'bone_wand', slot: 'weapon', level: 10, weapon: { type: 'wand', damage: { lightning: { min: 6, max: 13 } }, attacksPerSecond: 1.5, critChance: 0.07 }, implicit: { stat: 'damage', kind: 'increased', tags: ['spell'], range: range(0.1, 0.14, 0.01) } },
  { id: 'runed_wand', slot: 'weapon', level: 20, weapon: { type: 'wand', damage: { lightning: { min: 9, max: 18 } }, attacksPerSecond: 1.45, critChance: 0.07 }, implicit: { stat: 'damage', kind: 'increased', tags: ['spell'], range: range(0.14, 0.18, 0.01) } },

  // Helmets: armour / energy shield / hybrid; implicit +resource (max of the class resource).
  { id: 'iron_cap', slot: 'helmet', level: 1, armour: range(8, 12), implicit: { stat: 'resource', kind: 'flat', range: range(5, 8) } },
  { id: 'hood', slot: 'helmet', level: 1, energyShield: range(6, 9), implicit: { stat: 'resource', kind: 'flat', range: range(5, 8) } },
  { id: 'leather_helm', slot: 'helmet', level: 1, armour: range(4, 6), energyShield: range(3, 5), implicit: { stat: 'resource', kind: 'flat', range: range(5, 8) } },
  { id: 'great_helm', slot: 'helmet', level: 15, armour: range(25, 35), implicit: { stat: 'resource', kind: 'flat', range: range(9, 14) } },
  { id: 'sage_hood', slot: 'helmet', level: 15, energyShield: range(18, 26), implicit: { stat: 'resource', kind: 'flat', range: range(9, 14) } },
  { id: 'warded_helm', slot: 'helmet', level: 15, armour: range(12, 18), energyShield: range(9, 13), implicit: { stat: 'resource', kind: 'flat', range: range(9, 14) } },

  // Body armour; implicit +life.
  { id: 'chainmail', slot: 'armour', level: 1, armour: range(20, 30), implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'robe', slot: 'armour', level: 1, energyShield: range(15, 22), implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'brigandine', slot: 'armour', level: 1, armour: range(10, 15), energyShield: range(8, 11), implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'plate_armour', slot: 'armour', level: 15, armour: range(60, 80), implicit: { stat: 'life', kind: 'flat', range: range(18, 25) } },
  { id: 'arcane_robe', slot: 'armour', level: 15, energyShield: range(45, 60), implicit: { stat: 'life', kind: 'flat', range: range(18, 25) } },
  { id: 'scale_robe', slot: 'armour', level: 15, armour: range(30, 40), energyShield: range(22, 30), implicit: { stat: 'life', kind: 'flat', range: range(18, 25) } },

  // Gloves; implicit increased crit chance.
  { id: 'iron_gauntlets', slot: 'gloves', level: 1, armour: range(5, 8), implicit: { stat: 'critChance', kind: 'increased', range: range(0.05, 0.08, 0.01) } },
  { id: 'silk_gloves', slot: 'gloves', level: 1, energyShield: range(4, 6), implicit: { stat: 'critChance', kind: 'increased', range: range(0.05, 0.08, 0.01) } },
  { id: 'wrapped_mitts', slot: 'gloves', level: 1, armour: range(3, 4), energyShield: range(2, 3), implicit: { stat: 'critChance', kind: 'increased', range: range(0.05, 0.08, 0.01) } },
  { id: 'steel_gauntlets', slot: 'gloves', level: 15, armour: range(16, 22), implicit: { stat: 'critChance', kind: 'increased', range: range(0.09, 0.12, 0.01) } },
  { id: 'sorcerer_gloves', slot: 'gloves', level: 15, energyShield: range(12, 16), implicit: { stat: 'critChance', kind: 'increased', range: range(0.09, 0.12, 0.01) } },
  { id: 'studded_gloves', slot: 'gloves', level: 15, armour: range(8, 11), energyShield: range(6, 8), implicit: { stat: 'critChance', kind: 'increased', range: range(0.09, 0.12, 0.01) } },

  // Boots; implicit increased movement speed.
  { id: 'iron_greaves', slot: 'boots', level: 1, armour: range(5, 8), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.03, 0.05, 0.01) } },
  { id: 'silk_slippers', slot: 'boots', level: 1, energyShield: range(4, 6), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.03, 0.05, 0.01) } },
  { id: 'leather_boots', slot: 'boots', level: 1, armour: range(3, 4), energyShield: range(2, 3), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.03, 0.05, 0.01) } },
  { id: 'steel_greaves', slot: 'boots', level: 15, armour: range(16, 22), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.05, 0.07, 0.01) } },
  { id: 'mystic_slippers', slot: 'boots', level: 15, energyShield: range(12, 16), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.05, 0.07, 0.01) } },
  { id: 'ranger_boots', slot: 'boots', level: 15, armour: range(8, 11), energyShield: range(6, 8), implicit: { stat: 'movementSpeed', kind: 'increased', range: range(0.05, 0.07, 0.01) } },

  // Rings and amulets.
  { id: 'iron_ring', slot: 'ring', level: 1, implicit: { stat: 'life', kind: 'flat', range: range(8, 12) } },
  { id: 'ruby_ring', slot: 'ring', level: 1, implicit: { stat: 'fireResistance', kind: 'flat', range: range(0.08, 0.12, 0.01) } },
  { id: 'sapphire_ring', slot: 'ring', level: 1, implicit: { stat: 'coldResistance', kind: 'flat', range: range(0.08, 0.12, 0.01) } },
  { id: 'topaz_ring', slot: 'ring', level: 1, implicit: { stat: 'lightningResistance', kind: 'flat', range: range(0.08, 0.12, 0.01) } },
  { id: 'amber_amulet', slot: 'amulet', level: 1, implicit: { stat: 'life', kind: 'flat', range: range(10, 15) } },
  { id: 'jade_amulet', slot: 'amulet', level: 1, implicit: { stat: 'lifeRegen', kind: 'flat', range: range(0.5, 1, 0.1) } },
  { id: 'lapis_amulet', slot: 'amulet', level: 1, implicit: { stat: 'resource', kind: 'flat', range: range(10, 15) } },
];

// ── Uniques and legendaries (docs/design/items.md, decisions 2026-10-21 / 2026-10-25) ──
// Each has a fixed set of stat lines whose values roll inside the best tier unlocked at the item level (TIER_LEVELS),
// so the same unique stays useful up to map 30. PROPOSAL: line ranges are on par with the matching affix tiers;
// weapon uniques sit on the level-1 bases, so their added-damage line runs a little above the affix to keep up with
// the level-10 / 20 bases. Names and effect texts: unique.<id>.name / unique.<id>.effect in the locale files.
// Sub-package 6a: #10 #4 #7 #2; 6b: #1 #9 #3 #6 #5 #8; the legendaries come in 6c–6e.
// effectParams name where each number of the effect text comes from (render fills the placeholders).

const uline = (line: StatLine, t: AffixTier[]): UniqueStatLine => ({ ...line, tiers: t });
const ADDED_WEAPON_DAMAGE = int([2, 4], [4, 7], [7, 11], [11, 16], [16, 22]);
const DAMAGE_INC_25_55 = pct([0.1, 0.15], [0.16, 0.24], [0.25, 0.34], [0.35, 0.44], [0.45, 0.55]);
const SPEED_5_20 = pct([0.05, 0.07], [0.08, 0.1], [0.11, 0.13], [0.14, 0.16], [0.17, 0.2]);
const LIFE_8_55 = int([8, 14], [15, 24], [25, 34], [35, 44], [45, 55]);
const CRIT_INC_10_60 = pct([0.1, 0.19], [0.2, 0.29], [0.3, 0.39], [0.4, 0.49], [0.5, 0.6]);
const CRIT_MULTI_10_35 = pct([0.1, 0.14], [0.15, 0.19], [0.2, 0.24], [0.25, 0.29], [0.3, 0.35]);

const uniqueList: UniqueDef[] = [
  // #10 Glass Cannon Crown (helmet): +50% more damage; cost: 40% more damage taken.
  {
    id: 'glass_cannon_crown',
    rarity: 'unique',
    baseId: 'leather_helm',
    weight: 100,
    stats: [
      uline({ stat: 'damage', kind: 'increased' }, pct([0.08, 0.12], [0.13, 0.18], [0.19, 0.24], [0.25, 0.3], [0.31, 0.36])),
      uline({ stat: 'critChance', kind: 'increased' }, pct([0.1, 0.19], [0.2, 0.29], [0.3, 0.39], [0.4, 0.49], [0.5, 0.6])),
      uline({ stat: 'resource', kind: 'flat' }, int([5, 9], [10, 15], [16, 22], [23, 30], [31, 40])),
    ],
    effectModifiers: [{ stat: 'damage', kind: 'more', value: 0.5 }],
    costs: [{ stat: 'damageTaken', kind: 'more', value: 0.4 }],
    effectParams: { pct: { path: 'effectModifiers.0.value', format: 'percent' } },
  },
  // #4 Splitter (crossbow): bolts (attack projectiles, basic attack included) pierce 2 more targets; cost: 25% less damage.
  {
    id: 'splitter',
    rarity: 'unique',
    baseId: 'light_crossbow',
    weight: 100,
    stats: [
      uline({ stat: 'damage', kind: 'flat', damageType: 'physical' }, ADDED_WEAPON_DAMAGE),
      uline({ stat: 'damage', kind: 'increased', tags: ['attack'] }, DAMAGE_INC_25_55),
      uline({ stat: 'attackSpeed', kind: 'increased' }, SPEED_5_20),
    ],
    costs: [{ stat: 'damage', kind: 'more', value: -0.25 }],
    mechanics: [{ kind: 'skillParams', tags: ['attack', 'projectile'], changes: [{ param: 'pierce', add: 2 }] }],
    effectParams: { count: { path: 'mechanics.0.changes.0.add' } },
  },
  // #7 Heart of Winter (wand): Fireball deals cold instead of fire (its explosion, split fireballs and any fire zone it
  // leaves too) and slows (30% for 2 s, PROPOSAL: weaker than Frost Nova's 40% / 2.5 s).
  {
    id: 'heart_of_winter',
    rarity: 'unique',
    baseId: 'driftwood_wand',
    weight: 100,
    stats: [
      uline({ stat: 'damage', kind: 'increased', tags: ['spell'] }, DAMAGE_INC_25_55),
      uline({ stat: 'damage', kind: 'flat', damageType: 'cold' }, ADDED_WEAPON_DAMAGE),
      uline({ stat: 'castSpeed', kind: 'increased' }, SPEED_5_20),
    ],
    mechanics: [
      {
        kind: 'skillParams',
        skillIds: ['fireball'],
        damageConversion: { to: 'cold', fraction: 1 },
        addOnHit: [{ status: 'slow', duration: 2, magnitude: 0.3 }],
      },
    ],
    effectParams: { pct: { path: 'mechanics.0.addOnHit.0.magnitude', format: 'percent' }, seconds: { path: 'mechanics.0.addOnHit.0.duration' } },
  },
  // #2 Barrow Reaper (sword): Cleave grants 2 of the class resource per enemy hit (designer default 2026-10-25:
  // "mana" = the class resource; a sword, there are no axes).
  {
    id: 'barrow_reaper',
    rarity: 'unique',
    baseId: 'rusty_sword',
    weight: 100,
    stats: [
      uline({ stat: 'damage', kind: 'flat', damageType: 'physical' }, ADDED_WEAPON_DAMAGE),
      uline({ stat: 'damage', kind: 'increased', tags: ['attack'] }, DAMAGE_INC_25_55),
      uline({ stat: 'life', kind: 'flat' }, int([8, 14], [15, 24], [25, 34], [35, 44], [45, 55])),
    ],
    mechanics: [{ kind: 'skillParams', skillIds: ['cleave'], resourcePerHit: 2 }],
    effectParams: { amount: { path: 'mechanics.0.resourcePerHit' }, resGen: { resourceOf: 'mechanics.0.skillIds.0' } },
  },
  // #1 Iron Heart Oath (body armour): armour also works against elemental hits at 50% effectiveness (after resistance);
  // cost: 20% less movement speed.
  {
    id: 'iron_heart_oath',
    rarity: 'unique',
    baseId: 'chainmail',
    weight: 100,
    stats: [
      uline({ stat: 'armour', kind: 'increased' }, pct([0.15, 0.2], [0.21, 0.28], [0.29, 0.36], [0.37, 0.45], [0.46, 0.55])),
      uline({ stat: 'armour', kind: 'flat' }, int([8, 15], [16, 30], [31, 50], [51, 75], [76, 100])),
      uline({ stat: 'life', kind: 'flat' }, LIFE_8_55),
    ],
    costs: [{ stat: 'movementSpeed', kind: 'more', value: -0.2 }],
    mechanics: [{ kind: 'elementalArmour', effectiveness: 0.5 }],
    effectParams: { pct: { path: 'mechanics.0.effectiveness', format: 'percent' } },
  },
  // #9 Bloody Pupil (ring): crits heal 2% of max life, at most once per 0.2 s (designer default 2026-10-25, so Steady
  // Hand's every-hit crits do not heal 2% per hit); cost: 15% less max life.
  {
    id: 'bloody_pupil',
    rarity: 'unique',
    baseId: 'iron_ring',
    weight: 100,
    stats: [
      uline({ stat: 'critChance', kind: 'increased' }, CRIT_INC_10_60),
      uline({ stat: 'critMultiplier', kind: 'flat' }, CRIT_MULTI_10_35),
      uline({ stat: 'life', kind: 'flat' }, LIFE_8_55),
    ],
    costs: [{ stat: 'life', kind: 'more', value: -0.15 }],
    mechanics: [{ kind: 'lifeOnCrit', fraction: 0.02, interval: 0.2 }],
    effectParams: { pct: { path: 'mechanics.0.fraction', format: 'percent' }, seconds: { path: 'mechanics.0.interval' } },
  },
  // #3 Ancestral Horn (amulet): Battle Cry stuns the enemies around it (radius 180, PROPOSAL) for 1 s (bosses: the usual
  // stun → slow rule) and its cooldown is 50% shorter; cost: 10% less life.
  {
    id: 'ancestral_horn',
    rarity: 'unique',
    baseId: 'amber_amulet',
    weight: 100,
    stats: [
      uline({ stat: 'life', kind: 'flat' }, LIFE_8_55),
      uline({ stat: 'damage', kind: 'increased', tags: ['attack'] }, DAMAGE_INC_25_55),
      uline({ stat: 'cooldownRecovery', kind: 'increased' }, pct([0.04, 0.06], [0.07, 0.09], [0.1, 0.12], [0.13, 0.15], [0.16, 0.18])),
    ],
    costs: [{ stat: 'life', kind: 'more', value: -0.1 }],
    mechanics: [
      {
        kind: 'skillParams',
        skillIds: ['battle_cry'],
        changes: [{ param: 'cooldown', increased: -0.5 }],
        grants: { burst: { radius: 180 } },
        addOnHit: [{ status: 'stun', duration: 1 }],
      },
    ],
    effectParams: { seconds: { path: 'mechanics.0.addOnHit.0.duration' }, pct: { path: 'mechanics.0.changes.0.increased', format: 'percent' } },
  },
  // #6 Madman's Gloves (gloves): Explosive Trap throws 3 traps in a 40° fan (PROPOSAL); its cooldown is doubled
  // (+100% increased: adds with other cooldown changes). The traps share the active-trap cap with Minefield
  // (designer default 2026-10-25: cap 3, so the fan eats the cap).
  {
    id: 'madman_gloves',
    rarity: 'unique',
    baseId: 'wrapped_mitts',
    weight: 100,
    stats: [
      uline({ stat: 'damage', kind: 'increased', tags: ['area'] }, DAMAGE_INC_25_55),
      uline({ stat: 'critChance', kind: 'increased' }, CRIT_INC_10_60),
      uline({ stat: 'life', kind: 'flat' }, LIFE_8_55),
    ],
    mechanics: [
      {
        kind: 'skillParams',
        skillIds: ['explosive_trap'],
        changes: [{ param: 'cooldown', increased: 1 }],
        grants: { trapFan: { count: 3, spreadDeg: 40 } },
      },
    ],
    effectParams: { count: { path: 'mechanics.0.grants.trapFan.count' }, pct: { path: 'mechanics.0.changes.0.increased', format: 'percent' } },
  },
  // #5 Shadow Boots (boots): after a Roll the next attack is a guaranteed crit (designer default 2026-10-25: no time
  // limit, every hit of that attack). No cost.
  {
    id: 'shadow_boots',
    rarity: 'unique',
    baseId: 'leather_boots',
    weight: 100,
    stats: [
      uline({ stat: 'movementSpeed', kind: 'increased' }, pct([0.05, 0.08], [0.09, 0.12], [0.13, 0.16], [0.17, 0.2], [0.21, 0.25])),
      uline({ stat: 'critMultiplier', kind: 'flat' }, CRIT_MULTI_10_35),
      uline({ stat: 'life', kind: 'flat' }, LIFE_8_55),
    ],
    mechanics: [{ kind: 'critAfterSkill', skillIds: ['roll'] }],
  },
  // #8 Rift Ring (ring): Teleport has no cooldown and leaves a blast where it started (10–18 lightning, radius 100,
  // PROPOSAL; a spell + area hit, so spell / area modifiers scale it); cost: every teleport takes 15% of the current
  // life (designer default 2026-10-25: never lethal).
  {
    id: 'rift_ring',
    rarity: 'unique',
    baseId: 'topaz_ring',
    weight: 100,
    stats: [
      uline({ stat: 'damage', kind: 'increased', tags: ['spell'] }, pct([0.06, 0.1], [0.11, 0.15], [0.16, 0.2], [0.21, 0.25], [0.26, 0.3])),
      uline({ stat: 'castSpeed', kind: 'increased' }, SPEED_5_20),
      uline({ stat: 'energyShield', kind: 'flat' }, int([5, 9], [10, 16], [17, 24], [25, 33], [34, 42])),
    ],
    mechanics: [
      {
        kind: 'skillParams',
        skillIds: ['teleport'],
        changes: [{ param: 'cooldown', increased: -1 }],
        grants: { originBlast: { radius: 100, damage: { lightning: { min: 10, max: 18 } }, critChance: 0.05, tags: ['area'] } },
        lifeCostFraction: 0.15,
      },
    ],
    effectParams: {
      pct: { path: 'mechanics.0.lifeCostFraction', format: 'percent' },
      min: { path: 'mechanics.0.grants.originBlast.damage.lightning.min' },
      max: { path: 'mechanics.0.grants.originBlast.damage.lightning.max' },
    },
  },
  // Legendaries (6c–6e): bosses of map 30+ only (RunRewardRules.chest.legendary), so in practice they always roll at
  // item level 31+ (T1); the lower tiers only keep the lines consistent with the uniques. Stat lines are a step above
  // the uniques' (PROPOSAL, balance-analyst to confirm).
  // L1 Devourer's Crown (helmet): every kill (any source, minions excluded) is a soul, up to 30; at 30 the next attack /
  // damaging skill use (not movement, buffs or self skills; the basic attack counts) fires twice: a free echo after the
  // Echo support's delay (0.25 s), then the souls are spent. Cost: 30% less damage while holding no souls (souls start
  // at 0 every run, designer default 2026-10-25).
  {
    id: 'devourer_crown',
    rarity: 'legendary',
    baseId: 'warded_helm',
    // Equal weights for all legendaries (designer default).
    weight: 100,
    stats: [
      uline({ stat: 'damage', kind: 'increased' }, pct([0.12, 0.16], [0.17, 0.23], [0.24, 0.31], [0.32, 0.4], [0.41, 0.5])),
      uline({ stat: 'life', kind: 'flat' }, int([12, 20], [21, 32], [33, 46], [47, 60], [61, 75])),
      uline({ stat: 'critChance', kind: 'increased' }, pct([0.15, 0.24], [0.25, 0.36], [0.37, 0.49], [0.5, 0.62], [0.63, 0.75])),
    ],
    mechanics: [
      { kind: 'souls', max: 30, echoDelay: 0.25, echoFor: { damaging: true, excludeDeliveries: ['dash', 'teleport', 'self'] } },
      { kind: 'conditionalModifiers', condition: { kind: 'soulsAtMost', value: 0 }, modifiers: [{ stat: 'damage', kind: 'more', value: -0.3 }] },
    ],
    effectParams: { max: { path: 'mechanics.0.max' }, pct: { path: 'mechanics.1.modifiers.0.value', format: 'percent' } },
  },
  // L2 Clock of the Last Moment (amulet): a lethal hit or burn leaves the hero at 1 life (hero ignite cleared) and stops
  // the enemies' time for 3 s (mobs, their projectiles and zones, wave spawns; the hero acts, the map timer runs);
  // ready at run start, then once per 90 s. Cost: 20% more damage taken while it recharges (designer defaults
  // 2026-10-25). Level 15 like the crown's base, so both legendaries share one gate; equal weights.
  {
    id: 'clock_last_moment',
    rarity: 'legendary',
    baseId: 'amber_amulet',
    level: 15,
    weight: 100,
    stats: [
      uline({ stat: 'life', kind: 'flat' }, int([12, 20], [21, 32], [33, 46], [47, 60], [61, 75])),
      uline({ stat: 'damage', kind: 'increased' }, pct([0.12, 0.16], [0.17, 0.23], [0.24, 0.31], [0.32, 0.4], [0.41, 0.5])),
      uline({ stat: 'cooldownRecovery', kind: 'increased' }, pct([0.05, 0.07], [0.08, 0.11], [0.12, 0.15], [0.16, 0.19], [0.2, 0.24])),
    ],
    mechanics: [
      { kind: 'cheatDeath', life: 1, stopDuration: 3, cooldown: 90 },
      { kind: 'conditionalModifiers', condition: { kind: 'cheatDeathRecharging' }, modifiers: [{ stat: 'damageTaken', kind: 'more', value: 0.2 }] },
    ],
    effectParams: {
      life: { path: 'mechanics.0.life' },
      seconds: { path: 'mechanics.0.stopDuration' },
      cooldown: { path: 'mechanics.0.cooldown' },
      pct: { path: 'mechanics.1.modifiers.0.value', format: 'percent' },
    },
  },
];

const rules: LootRules = {
  // items.md PROPOSAL: 55 / 33 / 11 / 1 (unique 1% of chest items; boss loot ×3 on one item, RunRewardRules).
  rarityWeights: { normal: 55, magic: 33, rare: 11, unique: 1 },
  affixCount: { magic: { min: 1, max: 2 }, rare: { min: 3, max: 6 } },
  maxPrefixes: { magic: 1, rare: 3 },
  maxSuffixes: { magic: 1, rare: 3 },
  tierWeights: [10, 25, 50, 80, 100],
  salvage: { normal: 1, magic: 3, rare: 8, unique: 25, legendary: 100 },
  stashSize: 30,
  // Designer decision 2026-10-26: uniques and legendaries are never auto-salvaged on a full stash; they wait in the
  // overflow ("пошта"). PROPOSAL (agent): up to 20 waiting items.
  overflow: { size: 20, rarities: ['unique', 'legendary'] },
  enforceLevelRequirement: true,
  arenaRewards: { killsPerItem: 20, maxItems: 3, wavesPerItemLevel: 3, maxBonusLevels: 3 },
  rareNameWords: {
    first: ['Grim', 'Dusk', 'Ashen', 'Blood', 'Storm', 'Bone', 'Gloom', 'Rune', 'Iron', 'Hollow', 'Wraith', 'Ember'],
    second: ['Bane', 'Grasp', 'Ward', 'Veil', 'Fang', 'Song', 'Shroud', 'Mark', 'Coil', 'Crown', 'Stride', 'Whisper'],
  },
};

const byId = <T extends { id: string }>(list: readonly T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

export const itemsData: ItemsData = { bases: byId(baseList), affixes: byId(affixList), uniques: byId(uniqueList), rules };

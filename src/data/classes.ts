import type { ClassDef } from '../core/world/content';

// See docs/design/classes.md. All numbers are PROPOSAL until balance pass.
// Display text (class, skill names) is keyed by id in src/i18n/locales (class.<id>.*, skill.<id>.name).
// baseStats.resource / resourceRegen = max and regen of the class resource (Rage / Energy / Mana).
export const classes: Record<string, ClassDef> = {
  warrior: {
    id: 'warrior',
    radius: 18,
    weaponType: 'sword',
    baseStats: {
      life: 120,
      lifeRegen: 1.5,
      resource: 100,
      resourceRegen: 0,
      armour: 60,
      movementSpeed: 200,
    },
    // Rage (PROPOSAL): starts empty, +5 per basic-attack hit (max 3 hits per swing), +50 per full life+ES pool lost,
    // drains 10/s after 2.5 s without dealing or taking a hit; regen (gear / passives) only in combat, kept on level-up.
    // Sim (tools/sim/resource.sim.ts): first Cleave 1.3 s, Battle Cry ~3.8 s; basic attacks cover ~42% of the skill
    // rotation's Rage demand (~12/s), a full bar is ~8 s of skill spam, skills alone run dry.
    resource: {
      id: 'rage',
      startFraction: 0,
      refillOnLevelUp: false,
      onHit: { amount: 5, source: 'basicAttack', maxHitsPerUse: 3 },
      onDamageTaken: { perPoolFraction: 50 },
      decay: { delay: 2.5, perSecond: 10 },
      regenOnlyInCombat: true,
    },
    weapon: {
      damage: { physical: { min: 8, max: 13 } },
      attacksPerSecond: 1.6,
      critChance: 0.05,
    },
    basicAttack: {
      id: 'warrior_strike',
      tags: ['attack', 'melee'],
      resourceCost: 0,
      cooldown: 0,
      damage: { source: 'weapon', effectiveness: 1.3 },
      delivery: { kind: 'arc', radius: 70, angleDeg: 70, maxTargets: 1 },
    },
    skills: [
      {
        id: 'cleave',
        tags: ['attack', 'melee', 'area'],
        resourceCost: 6,
        cooldown: 0,
        damage: { source: 'weapon', effectiveness: 1.0 },
        delivery: { kind: 'arc', radius: 95, angleDeg: 150 },
      },
      {
        id: 'shield_charge',
        tags: ['attack', 'melee'],
        resourceCost: 10,
        cooldown: 4,
        damage: { source: 'weapon', effectiveness: 0.8 },
        delivery: { kind: 'dash', distance: 230, speed: 950, hitRadius: 30 },
        onHit: [{ status: 'stun', duration: 1.2 }],
      },
      {
        id: 'battle_cry',
        tags: [],
        resourceCost: 15,
        cooldown: 12,
        castTime: 0.4,
        delivery: { kind: 'self' },
        selfEffects: [{ kind: 'buff', id: 'battle_cry', duration: 6, modifiers: [{ stat: 'damage', kind: 'increased', value: 0.4 }] }],
      },
    ],
  },

  ranger: {
    id: 'ranger',
    radius: 16,
    weaponType: 'crossbow',
    baseStats: {
      life: 95,
      lifeRegen: 1,
      resource: 40,
      resourceRegen: 10,
      armour: 25,
      movementSpeed: 215,
    },
    // Energy (PROPOSAL): small pool, fast regen, starts full. With Volley 10 / Trap 14 / Roll 8: full bar = ~5 s of
    // skill spam, refills in 4 s, regen covers ~60% of demand (Volley at 7 was ~80-97%: Energy never mattered).
    resource: { id: 'energy', startFraction: 1, refillOnLevelUp: true },
    weapon: {
      damage: { physical: { min: 7, max: 12 } },
      attacksPerSecond: 1.4,
      critChance: 0.06,
    },
    basicAttack: {
      id: 'ranger_bolt',
      tags: ['attack', 'projectile'],
      resourceCost: 0,
      cooldown: 0,
      damage: { source: 'weapon', effectiveness: 1.0 },
      delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 750, range: 620, radius: 6, pierce: 0 },
    },
    skills: [
      {
        id: 'volley',
        tags: ['attack', 'projectile'],
        resourceCost: 10,
        cooldown: 0,
        damage: { source: 'weapon', effectiveness: 0.65 },
        delivery: { kind: 'projectile', count: 5, spreadDeg: 50, speed: 700, range: 520, radius: 6, pierce: 0 },
      },
      {
        id: 'explosive_trap',
        tags: ['area'],
        resourceCost: 14,
        cooldown: 5,
        castTime: 0.35,
        damage: { source: 'skill', base: { fire: { min: 22, max: 32 } }, critChance: 0.05 },
        delivery: { kind: 'trap', throwRange: 300, armTime: 0.5, triggerRadius: 40, explodeRadius: 110, lifetime: 8 },
      },
      {
        id: 'roll',
        tags: [],
        resourceCost: 8,
        cooldown: 3,
        castTime: 0,
        delivery: { kind: 'dash', distance: 200, speed: 800, hitRadius: 0 },
        selfEffects: [
          { kind: 'invulnerable', duration: 0.25 },
          { kind: 'buff', id: 'roll_haste', duration: 2, modifiers: [{ stat: 'movementSpeed', kind: 'increased', value: 0.3 }] },
        ],
      },
    ],
  },

  mage: {
    id: 'mage',
    radius: 16,
    weaponType: 'wand',
    baseStats: {
      life: 80,
      lifeRegen: 0.8,
      energyShield: 40,
      energyShieldRegen: 4,
      resource: 150,
      resourceRegen: 7.5,
      armour: 10,
      movementSpeed: 200,
    },
    // Mana (PROPOSAL): big pool, slow regen, starts full. Full bar = ~13 s of skill spam (a pack fight), refills in 20 s,
    // regen covers ~40% of demand (100 / 5 ran dry in ~7 s with ~27% sustain).
    resource: { id: 'mana', startFraction: 1, refillOnLevelUp: true },
    weapon: {
      damage: { lightning: { min: 5, max: 10 } },
      attacksPerSecond: 1.5,
      critChance: 0.06,
    },
    basicAttack: {
      id: 'wand_bolt',
      tags: ['attack', 'projectile'],
      resourceCost: 0,
      cooldown: 0,
      damage: { source: 'weapon', effectiveness: 1.0 },
      delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 650, range: 560, radius: 7, pierce: 0 },
    },
    skills: [
      {
        id: 'fireball',
        tags: ['spell', 'projectile', 'area'],
        resourceCost: 9,
        cooldown: 0,
        castTime: 0.6,
        damage: { source: 'skill', base: { fire: { min: 18, max: 26 } }, critChance: 0.06 },
        delivery: { kind: 'projectile', count: 1, spreadDeg: 0, speed: 520, range: 600, radius: 9, pierce: 0, explodeRadius: 80 },
      },
      {
        id: 'frost_nova',
        tags: ['spell', 'area'],
        resourceCost: 14,
        cooldown: 3,
        castTime: 0.4,
        damage: { source: 'skill', base: { cold: { min: 12, max: 18 } }, critChance: 0.05 },
        delivery: { kind: 'arc', radius: 150, angleDeg: 360 },
        onHit: [{ status: 'slow', duration: 2.5, magnitude: 0.4 }],
      },
      {
        id: 'teleport',
        tags: ['spell'],
        resourceCost: 12,
        cooldown: 4,
        castTime: 0.25,
        delivery: { kind: 'teleport', range: 350 },
        selfEffects: [{ kind: 'invulnerable', duration: 0.2 }],
      },
    ],
  },
};

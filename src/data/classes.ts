import type { ClassDef } from '../core/world/content';

// See docs/design/classes.md. All numbers are PROPOSAL until balance pass.
export const classes: Record<string, ClassDef> = {
  warrior: {
    id: 'warrior',
    radius: 18,
    baseStats: {
      life: 120,
      lifeRegen: 1.5,
      mana: 40,
      manaRegen: 4,
      armour: 60,
      movementSpeed: 200,
    },
    weapon: {
      damage: { physical: { min: 8, max: 13 } },
      attacksPerSecond: 1.6,
      critChance: 0.05,
    },
    basicAttack: {
      id: 'warrior_strike',
      tags: ['attack', 'melee'],
      damageEffectiveness: 1.3,
      shape: { kind: 'arc', radius: 70, angleDeg: 70, maxTargets: 1 },
      manaCost: 0,
      cooldown: 0,
    },
    skills: [
      {
        id: 'cleave',
        tags: ['attack', 'melee', 'area'],
        damageEffectiveness: 1.0,
        shape: { kind: 'arc', radius: 95, angleDeg: 150 },
        manaCost: 6,
        cooldown: 0,
      },
    ],
  },
};

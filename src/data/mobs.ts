import type { MobDef } from '../core/world/content';

// See docs/design/mobs.md. All numbers are PROPOSAL until balance pass.
export const mobs: Record<string, MobDef> = {
  // Slow melee: the bulk of the crowd.
  zombie: {
    id: 'zombie',
    radius: 15,
    life: 16,
    xp: 3,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 75,
    attack: { damage: { physical: { min: 4, max: 7 } }, range: 12, interval: 1.3, critChance: 0 },
  },
  // Fast and weak: punishes standing still.
  runner: {
    id: 'runner',
    radius: 11,
    life: 9,
    xp: 2,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 150,
    attack: { damage: { physical: { min: 2, max: 4 } }, range: 10, interval: 0.8, critChance: 0 },
  },
  // Ranged: keeps distance, slow dodgeable bolts.
  archer: {
    id: 'archer',
    radius: 13,
    life: 12,
    xp: 3,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 90,
    preferredRange: 280,
    attack: {
      damage: { physical: { min: 5, max: 8 } },
      range: 420,
      interval: 2.2,
      critChance: 0,
      projectile: { speed: 260, radius: 6 },
    },
  },
};

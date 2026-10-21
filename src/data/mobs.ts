import type { MobDef } from '../core/world/content';

// See docs/design/mobs.md. All numbers are PROPOSAL until balance pass.
export const mobs: Record<string, MobDef> = {
  zombie: {
    id: 'zombie',
    radius: 15,
    life: 16,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 75,
    attack: { damage: { physical: { min: 4, max: 7 } }, range: 12, interval: 1.3, critChance: 0 },
  },
  runner: {
    id: 'runner',
    radius: 11,
    life: 9,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 150,
    attack: { damage: { physical: { min: 2, max: 4 } }, range: 10, interval: 0.8, critChance: 0 },
  },
};

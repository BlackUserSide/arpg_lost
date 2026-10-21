import { describe, expect, it } from 'vitest';
import { content } from './index';

describe('data validation', () => {
  it('class, action and mob ids are unique and match their keys', () => {
    const actionIds = new Set<string>();
    for (const [key, cls] of Object.entries(content.classes)) {
      expect(cls.id).toBe(key);
      for (const action of [cls.basicAttack, ...cls.skills]) {
        expect(actionIds.has(action.id)).toBe(false);
        actionIds.add(action.id);
      }
    }
    for (const [key, mob] of Object.entries(content.mobs)) expect(mob.id).toBe(key);
  });

  it('classes have at most 3 skills and sane numbers', () => {
    for (const cls of Object.values(content.classes)) {
      expect(cls.skills.length).toBeLessThanOrEqual(3);
      expect(cls.weapon.attacksPerSecond).toBeGreaterThan(0);
      for (const range of Object.values(cls.weapon.damage)) expect(range.min).toBeLessThanOrEqual(range.max);
      for (const action of [cls.basicAttack, ...cls.skills]) {
        expect(action.manaCost).toBeGreaterThanOrEqual(0);
        expect(action.cooldown).toBeGreaterThanOrEqual(0);
        expect(action.shape.radius).toBeGreaterThan(0);
      }
      expect(cls.basicAttack.manaCost).toBe(0);
      expect(cls.basicAttack.cooldown).toBe(0);
    }
  });

  it('arena spawn list references existing mobs', () => {
    expect(content.arena.spawn.mobIds.length).toBeGreaterThan(0);
    for (const id of content.arena.spawn.mobIds) expect(content.mobs[id]).toBeDefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { ActionDef } from '../core/world/content';
import { SLOTS } from '../core/items/types';
import { content } from './index';
import { itemsData } from './items';

const allActions = (): ActionDef[] => Object.values(content.classes).flatMap((c) => [c.basicAttack, ...c.skills]);

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

  it('has the three MVP classes with exactly 3 skills each', () => {
    expect(Object.keys(content.classes).sort()).toEqual(['mage', 'ranger', 'warrior']);
    for (const cls of Object.values(content.classes)) expect(cls.skills).toHaveLength(3);
  });

  it('weapons and basic attacks are sane', () => {
    for (const cls of Object.values(content.classes)) {
      expect(cls.weapon.attacksPerSecond).toBeGreaterThan(0);
      for (const range of Object.values(cls.weapon.damage)) expect(range.min).toBeLessThanOrEqual(range.max);
      expect(cls.basicAttack.manaCost).toBe(0);
      expect(cls.basicAttack.cooldown).toBe(0);
      expect(cls.basicAttack.tags).toContain('attack');
    }
  });

  it('actions are consistent', () => {
    for (const action of allActions()) {
      expect(action.manaCost).toBeGreaterThanOrEqual(0);
      expect(action.cooldown).toBeGreaterThanOrEqual(0);
      // Non-attacks need an explicit use time; attacks use weapon speed.
      if (!action.tags.includes('attack')) expect(action.castTime).toBeDefined();
      if (action.damage?.source === 'skill') {
        for (const range of Object.values(action.damage.base)) expect(range.min).toBeLessThanOrEqual(range.max);
      }
      const d = action.delivery;
      if (d.kind === 'projectile') {
        expect(d.count).toBeGreaterThan(0);
        expect(d.speed).toBeGreaterThan(0);
      }
      if (d.kind === 'arc') expect(d.radius).toBeGreaterThan(0);
    }
  });

  it('ranged mobs have a projectile and a preferred range inside attack range', () => {
    for (const mob of Object.values(content.mobs)) {
      if (mob.preferredRange === undefined) continue;
      expect(mob.attack.projectile).toBeDefined();
      expect(mob.preferredRange).toBeLessThan(mob.attack.range);
    }
  });

  it('arena spawn list references existing mobs', () => {
    expect(content.arena.spawn.mobIds.length).toBeGreaterThan(0);
    for (const id of content.arena.spawn.mobIds) expect(content.mobs[id]).toBeDefined();
  });
});

describe('item data validation', () => {
  it('every slot has a level-1 base and weapon bases cover every class weapon type', () => {
    for (const slot of SLOTS) {
      expect(Object.values(itemsData.bases).some((b) => b.slot === slot && b.level === 1)).toBe(true);
    }
    for (const cls of Object.values(content.classes)) {
      expect(Object.values(itemsData.bases).some((b) => b.weapon?.type === cls.weaponType && b.level === 1)).toBe(true);
    }
  });

  it('bases are consistent', () => {
    for (const [key, base] of Object.entries(itemsData.bases)) {
      expect(base.id).toBe(key);
      expect(Boolean(base.weapon)).toBe(base.slot === 'weapon');
      for (const r of [base.armour, base.energyShield, base.implicit?.range]) if (r) expect(r.min).toBeLessThanOrEqual(r.max);
    }
  });

  it('has 12 prefixes and 12 suffixes with 5 ordered tiers each', () => {
    const affixes = Object.values(itemsData.affixes);
    expect(affixes.filter((a) => a.kind === 'prefix')).toHaveLength(12);
    expect(affixes.filter((a) => a.kind === 'suffix')).toHaveLength(12);
    for (const [key, a] of Object.entries(itemsData.affixes)) {
      expect(a.id).toBe(key);
      expect(a.weight).toBeGreaterThan(0);
      expect(a.slots.length).toBeGreaterThan(0);
      expect(a.tiers).toHaveLength(5);
      for (let i = 0; i < a.tiers.length; i++) {
        const t = a.tiers[i]!;
        expect(t.min).toBeLessThanOrEqual(t.max);
        if (i > 0) {
          expect(t.minLevel).toBeGreaterThan(a.tiers[i - 1]!.minLevel);
          expect(t.max).toBeGreaterThanOrEqual(a.tiers[i - 1]!.max);
        }
      }
    }
  });

  it('every slot can roll at least one prefix and one suffix', () => {
    for (const slot of SLOTS) {
      const affixes = Object.values(itemsData.affixes).filter((a) => a.slots.includes(slot));
      expect(affixes.some((a) => a.kind === 'prefix')).toBe(true);
      expect(affixes.some((a) => a.kind === 'suffix')).toBe(true);
    }
  });
});

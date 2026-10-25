import { describe, expect, it } from 'vitest';
import { MOB_ABILITY_KINDS, type ActionDef } from '../core/world/content';
import { generateItem } from '../core/items/generate';
import { SLOTS } from '../core/items/types';
import { createRng } from '../core/rng';
import { content } from './index';
import { itemsData } from './items';
import { arena } from './arena';
import { mapsData } from './maps';
import { skillLevels } from './skillLevels';

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
      expect(cls.basicAttack.resourceCost).toBe(0);
      expect(cls.basicAttack.cooldown).toBe(0);
      expect(cls.basicAttack.tags).toContain('attack');
    }
  });

  it('class resources are sane and every skill is affordable from the base pool', () => {
    const ids = new Set<string>();
    for (const cls of Object.values(content.classes)) {
      const r = cls.resource;
      const max = cls.baseStats.resource ?? 0;
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      expect(max).toBeGreaterThan(0);
      expect(cls.baseStats.resourceRegen ?? 0).toBeGreaterThanOrEqual(0);
      expect(r.startFraction).toBeGreaterThanOrEqual(0);
      expect(r.startFraction).toBeLessThanOrEqual(1);
      for (const skill of cls.skills) expect(skill.resourceCost, `${cls.id}/${skill.id}`).toBeLessThanOrEqual(max);
      if (r.onHit) {
        expect(r.onHit.amount).toBeGreaterThan(0);
        expect(r.onHit.maxHitsPerUse).toBeGreaterThanOrEqual(1);
      }
      if (r.onDamageTaken) expect(r.onDamageTaken.perPoolFraction).toBeGreaterThan(0);
      if (r.decay) {
        expect(r.decay.delay).toBeGreaterThanOrEqual(0);
        expect(r.decay.perSecond).toBeGreaterThan(0);
      }
      // A class without regeneration must have a way to gain its resource, or its skills are unusable.
      if ((cls.baseStats.resourceRegen ?? 0) <= 0) expect(r.onHit ?? r.onDamageTaken).toBeDefined();
    }
  });

  it('actions are consistent', () => {
    for (const action of allActions()) {
      expect(action.resourceCost).toBeGreaterThanOrEqual(0);
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

describe('unique data validation', () => {
  it('uniques are sane: ids match keys, known base, 5 ordered tiers per line on the affix tier levels, weights ≥ 0', () => {
    for (const [key, u] of Object.entries(itemsData.uniques)) {
      expect(u.id).toBe(key);
      expect(itemsData.bases[u.baseId], u.id).toBeDefined();
      expect(u.weight).toBeGreaterThanOrEqual(0);
      expect(u.stats.length).toBeGreaterThanOrEqual(2);
      for (const line of u.stats) {
        expect(line.tiers.map((t) => t.minLevel)).toEqual([1, 8, 15, 23, 30]);
        for (const t of line.tiers) expect(t.max).toBeGreaterThanOrEqual(t.min);
        // Worst → best: each tier at least as good as the previous one.
        for (let i = 1; i < line.tiers.length; i++) expect(line.tiers[i]!.min).toBeGreaterThanOrEqual(line.tiers[i - 1]!.min);
      }
    }
  });

  it('uniques: the designed slots / weapon types, and their mechanics name real skills', () => {
    const slotOf = (id: string): string | undefined => {
      const base = itemsData.bases[itemsData.uniques[id]!.baseId]!;
      return base.weapon?.type ?? base.slot;
    };
    expect(Object.fromEntries(Object.keys(itemsData.uniques).map((id) => [id, slotOf(id)]))).toEqual({
      glass_cannon_crown: 'helmet',
      splitter: 'crossbow',
      heart_of_winter: 'wand',
      barrow_reaper: 'sword',
      iron_heart_oath: 'armour',
      bloody_pupil: 'ring',
      ancestral_horn: 'amulet',
      madman_gloves: 'gloves',
      shadow_boots: 'boots',
      rift_ring: 'ring',
      devourer_crown: 'helmet',
      clock_last_moment: 'amulet',
    });
    const legendaries = new Set(['devourer_crown', 'clock_last_moment']);
    // Legendaries share one weight (designer default 2026-10-25) and one level gate.
    const legendDefs = Object.values(itemsData.uniques).filter((u) => u.rarity === 'legendary');
    expect(new Set(legendDefs.map((u) => u.weight)).size).toBe(1);
    const skillIds = new Set(allActions().map((a) => a.id));
    for (const u of Object.values(itemsData.uniques)) {
      expect(u.rarity).toBe(legendaries.has(u.id) ? 'legendary' : 'unique');
      for (const m of u.mechanics ?? []) {
        if (m.kind !== 'souls') continue;
        expect(m.max).toBeGreaterThan(0);
        expect(m.echoDelay).toBeGreaterThanOrEqual(0);
        // A souls echo of a movement / buff skill would move the hero again or do nothing (designer default 2026-10-25).
        expect(m.echoFor.damaging).toBe(true);
        expect(m.echoFor.excludeDeliveries).toEqual(expect.arrayContaining(['dash', 'teleport', 'self']));
      }
      for (const m of u.mechanics ?? []) {
        if (m.kind !== 'cheatDeath') continue;
        // It must leave the hero alive, stop time for a while and recharge for longer than the stop.
        expect(m.life).toBeGreaterThan(0);
        expect(m.stopDuration).toBeGreaterThan(0);
        expect(m.cooldown).toBeGreaterThan(m.stopDuration);
      }
      for (const m of u.mechanics ?? []) {
        if (m.kind !== 'skillParams' && m.kind !== 'critAfterSkill') continue;
        for (const id of m.skillIds ?? []) expect(skillIds.has(id), `${u.id}: ${id}`).toBe(true);
        // A life cost of 1 or more would never be paid (it must leave life).
        if (m.kind === 'skillParams' && m.lifeCostFraction !== undefined) expect(m.lifeCostFraction).toBeLessThan(1);
      }
    }
  });

  it('chest rules: unique weight 1 of 100, boss ×3, legendaries from map 30 at 1 / 500', () => {
    expect(itemsData.rules.rarityWeights).toEqual({ normal: 55, magic: 33, rare: 11, unique: 1 });
    expect(mapsData.rewards.chest.bossUniqueWeightMultiplier).toBe(3);
    expect(mapsData.rewards.chest.legendary).toEqual({ minMapLevel: 30, chance: 0.002 });
  });
});

describe('item generation with real data', () => {
  it('defence affixes only roll on bases with that defence', () => {
    const rng = createRng(11);
    for (let i = 0; i < 400; i++) {
      for (const slot of ['armour', 'helmet', 'gloves', 'boots'] as const) {
        const item = generateItem(rng, `t${i}`, { itemLevel: 30, rarity: 'rare', slot }, itemsData);
        const base = itemsData.bases[item.baseId]!;
        for (const a of item.affixes) {
          const req = itemsData.affixes[a.affixId]!.requires;
          if (req) expect(base[req], `${a.affixId} on ${base.id}`).toBeDefined();
        }
      }
    }
  });

  it('skill levels: every class skill has a table sized to the max level, thresholds grow', () => {
    const { rules, skills } = skillLevels;
    expect(content.skillLevels).toBe(skillLevels);
    expect(rules.xpToNext).toHaveLength(rules.maxLevel - 1);
    rules.xpToNext.forEach((xp, i) => expect(xp).toBeGreaterThan(i === 0 ? 0 : rules.xpToNext[i - 1]!));
    const skillIds = Object.values(content.classes).flatMap((c) => c.skills.map((s) => s.id));
    expect(Object.keys(skills).sort()).toEqual([...skillIds].sort());
    for (const table of Object.values(skills)) {
      expect(table.perLevel).toHaveLength(rules.maxLevel - 1);
      expect(table.effect?.level).toBe(rules.maxLevel);
    }
  });

  it('skill level pace: level 2 in 3–5 runs and level 3 in 10–15 runs at ~280 arena kills per run', () => {
    // See the pace math in skillLevels.ts.
    const xpPerKill = arena.spawn.mobIds.reduce((sum, id) => sum + content.mobs[id]!.xp, 0) / arena.spawn.mobIds.length;
    const perRun = 280 * xpPerKill * skillLevels.rules.killXpMultiplier;
    expect(xpPerKill).toBeCloseTo(16 / 6, 10);
    const [toL2, toL3] = skillLevels.rules.xpToNext as [number, number];
    const runsToL2 = toL2 / perRun;
    const runsToL3 = (toL2 + toL3) / perRun;
    expect(runsToL2).toBeGreaterThanOrEqual(3);
    expect(runsToL2).toBeLessThanOrEqual(5);
    expect(runsToL3).toBeGreaterThanOrEqual(10);
    expect(runsToL3).toBeLessThanOrEqual(15);
  });
});

describe('mob abilities (the boss and the map casters)', () => {
  const casters = Object.values(content.mobs).filter((m) => m.abilities);
  const heroes = Object.values(content.classes);
  const widestHero = Math.max(...heroes.map((c) => c.radius));
  const slowestHero = Math.min(...heroes.map((c) => c.baseStats.movementSpeed ?? 0));

  it('the map boss is the necromancer, a real boss def with abilities and rank scaling 1', () => {
    const { boss } = mapsData.rules;
    expect(boss.mobId).toBe('necromancer');
    const def = content.mobs[boss.mobId]!;
    expect(def.boss).toBe(true);
    expect(def.abilities).toBeDefined();
    expect(boss.scaling).toEqual({ life: 1, damage: 1, xp: 1, radius: 1 });
    expect(arena.spawn.mobIds).not.toContain('necromancer');
  });

  it('the necromancer has the designed abilities: spears, raise dead, nova; grave circles from phase 2 at 50% life', () => {
    const set = content.mobs.necromancer!.abilities!;
    const byId = Object.fromEntries(set.list.map((a) => [a.id, a]));
    expect(byId.boneSpears?.kind).toBe('projectileFan');
    expect(byId.raiseDead?.kind).toBe('summon');
    expect(byId.darkNova?.kind).toBe('nova');
    expect(byId.graveCircles).toMatchObject({ kind: 'groundZones', minPhase: 2 });
    expect(set.phases).toHaveLength(1);
    expect(set.phases[0]!.lifeBelow).toBe(0.5);
    expect(set.phases[0]!.cooldownMultiplier).toBeLessThan(1);
  });

  it('ability data is consistent', () => {
    for (const mob of casters) {
      const set = mob.abilities!;
      const ids = set.list.map((a) => a.id);
      expect(new Set(ids).size, mob.id).toBe(ids.length);
      expect(set.recovery).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < set.phases.length; i++) {
        const p = set.phases[i]!;
        expect(p.lifeBelow).toBeGreaterThan(0);
        expect(p.lifeBelow).toBeLessThan(1);
        if (i > 0) expect(p.lifeBelow).toBeLessThan(set.phases[i - 1]!.lifeBelow);
        expect(p.cooldownMultiplier).toBeGreaterThan(0);
      }
      for (const a of set.list) {
        const label = `${mob.id}/${a.id}`;
        expect(MOB_ABILITY_KINDS, label).toContain(a.kind);
        expect(a.cooldown, label).toBeGreaterThan(0);
        expect(a.windUp, label).toBeGreaterThanOrEqual(0);
        expect(a.minPhase ?? 1, label).toBeLessThanOrEqual(set.phases.length + 1);
        if (a.kind === 'summon') {
          expect(a.count, label).toBeGreaterThan(0);
          expect(a.maxAlive, label).toBeGreaterThanOrEqual(a.count);
          for (const e of a.pool) {
            const minion = content.mobs[e.mobId];
            expect(minion, `${label} ${e.mobId}`).toBeDefined();
            // Minions are ordinary mobs: no bosses, no casters (no summon chains).
            expect(minion!.boss, label).toBeFalsy();
            expect(minion!.abilities, label).toBeUndefined();
            expect(e.weight).toBeGreaterThan(0);
          }
        } else {
          // Every damaging ability is telegraphed.
          for (const range of Object.values(a.damage)) expect(range.min, label).toBeLessThanOrEqual(range.max);
          if (a.kind === 'groundZones') expect(a.delay, label).toBeGreaterThan(0);
          else expect(a.windUp, label).toBeGreaterThan(0);
        }
      }
    }
  });

  it('every telegraphed hit can be dodged by the slowest hero (base speed)', () => {
    for (const mob of casters) {
      for (const a of mob.abilities!.list) {
        const label = `${mob.id}/${a.id}`;
        if (a.kind === 'nova') {
          // From touching the body to outside radius + hero radius within the wind-up.
          const walk = a.radius - mob.radius;
          expect(walk / slowestHero, label).toBeLessThanOrEqual(a.windUp);
        }
        if (a.kind === 'groundZones') expect((a.radius + widestHero) / slowestHero, label).toBeLessThanOrEqual(a.delay);
        if (a.kind === 'projectileFan' && a.count > 1) {
          // At the caster's preferred distance the free gap between two neighbouring spears fits the widest hero.
          const d = (mob.preferredRange ?? 0) + mob.radius + widestHero;
          const step = ((a.spreadDeg / (a.count - 1)) * Math.PI) / 180;
          const gap = 2 * d * Math.sin(step / 2) - 2 * a.radius;
          expect(gap, label).toBeGreaterThan(2 * widestHero);
          expect(a.speed, label).toBeLessThan(slowestHero * 1.5);
        }
      }
    }
  });
});

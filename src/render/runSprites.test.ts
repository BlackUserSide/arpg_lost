import { describe, expect, it } from 'vitest';
import { content } from '../data';
import { mapsData } from '../data/maps';
import { runSpriteSets, withMinions } from './runSprites';
import { MOB_SPRITES, SPRITE_SETS } from './sprites';

describe('run sprite sets', () => {
  it('map 1 loads the hero and the starting skeletons only; the boss comes later', () => {
    const sets = runSpriteSets(content, mapsData.rules, 1, 'knight');
    expect([...sets.start].sort()).toEqual(['knight', 'skeleton_archer', 'skeleton_minion', 'skeleton_warrior']);
    expect(sets.boss).toEqual(['necromancer']);
  });

  it('later maps add their new mobs and their minions', () => {
    const sets = runSpriteSets(content, mapsData.rules, 20, 'mage');
    for (const set of ['shieldbearer', 'bone_thrower', 'gravedigger', 'cultist']) expect(sets.start).toContain(set);
    expect(sets.boss).toEqual(['necromancer']);
  });

  it('summons are followed transitively and raised allies are included', () => {
    expect([...withMinions(content, ['necromancer'])].sort()).toEqual(['archer', 'necromancer', 'runner', 'zombie']);
    expect(runSpriteSets(content, mapsData.rules, 1, 'ranger', ['cultist']).start).toContain('cultist');
  });

  it('every mob of the pool and the boss has a baked set', () => {
    const ids = withMinions(content, [...mapsData.rules.waves.mobPool.map((e) => e.mobId), mapsData.rules.boss.mobId]);
    for (const id of ids) expect(SPRITE_SETS[MOB_SPRITES[id]!], id).toBeDefined();
  });
});

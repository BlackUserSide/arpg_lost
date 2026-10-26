import { describe, expect, it } from 'vitest';
import { vec } from '../core/math';
import type { Delivery } from '../core/world/content';
import { autoAimRange, deliveryReach, forwardDir, idleAim, isAimed, manualAim, nearestEnemy, stickDirection, tapAim, tapStyle } from './touchAim';

const TUNING = { autoAimRadius: 400 };
const ARC: Delivery = { kind: 'arc', radius: 95, angleDeg: 150 };
const NOVA: Delivery = { kind: 'arc', radius: 150, angleDeg: 360 };
const BOLT: Delivery = { kind: 'projectile', count: 1, spreadDeg: 0, speed: 700, range: 620, radius: 6, pierce: 0 };
const CHARGE: Delivery = { kind: 'dash', distance: 230, speed: 950, hitRadius: 30 };
const ROLL: Delivery = { kind: 'dash', distance: 200, speed: 800, hitRadius: 0 };
const TELEPORT: Delivery = { kind: 'teleport', range: 350 };
const TRAP: Delivery = { kind: 'trap', throwRange: 300, armTime: 0.5, triggerRadius: 40, explodeRadius: 110, lifetime: 8 };
const SELF: Delivery = { kind: 'self' };

const hero = { pos: vec(100, 100), facing: vec(0, 1) };
const mob = (x: number, y: number, radius = 10, life = 10) => ({ pos: vec(x, y), radius, life });

describe('tapStyle / deliveryReach', () => {
  it('classifies the class skills like docs/design/controls.md', () => {
    expect(tapStyle(ARC)).toBe('target');
    expect(tapStyle(BOLT)).toBe('target');
    expect(tapStyle(TRAP)).toBe('target');
    expect(tapStyle(CHARGE)).toBe('charge');
    expect(tapStyle(ROLL)).toBe('forward');
    expect(tapStyle(TELEPORT)).toBe('forward');
    expect(tapStyle(NOVA)).toBe('none');
    expect(tapStyle(SELF)).toBe('none');
  });

  it('reads the reach of each delivery; unaimed ones reach 0', () => {
    expect(deliveryReach(ARC)).toBe(95);
    expect(deliveryReach(BOLT)).toBe(620);
    expect(deliveryReach(CHARGE)).toBe(230);
    expect(deliveryReach(TELEPORT)).toBe(350);
    expect(deliveryReach(TRAP)).toBe(300);
    expect(deliveryReach(NOVA)).toBe(0);
    expect(deliveryReach(SELF)).toBe(0);
    expect(isAimed(NOVA)).toBe(false);
    expect(isAimed(TRAP)).toBe(true);
  });

  it('searches the nearby radius or the reach if longer', () => {
    expect(autoAimRange(ARC, TUNING)).toBe(400);
    expect(autoAimRange(BOLT, TUNING)).toBe(620);
  });
});

describe('nearestEnemy', () => {
  it('picks the closest living enemy by body edge within range', () => {
    const near = mob(150, 100);
    const far = mob(300, 100);
    expect(nearestEnemy([far, near], hero.pos, 400)).toBe(near);
    // A big body counts by its edge: centre 220 away, edge 120 away, beats a small one 150 away.
    const big = mob(320, 100, 100);
    const small = mob(100, 250, 0);
    expect(nearestEnemy([small, big], hero.pos, 400)).toBe(big);
  });

  it('ignores dead enemies and those out of range', () => {
    expect(nearestEnemy([mob(120, 100, 10, 0)], hero.pos, 400)).toBeUndefined();
    expect(nearestEnemy([mob(600, 100)], hero.pos, 400)).toBeUndefined();
    expect(nearestEnemy([], hero.pos, 400)).toBeUndefined();
  });
});

describe('tapAim', () => {
  const enemy = mob(300, 100);

  it('aims targeted skills at the nearest enemy', () => {
    expect(tapAim(ARC, hero, [enemy], undefined, TUNING)).toEqual(vec(300, 100));
    expect(tapAim(BOLT, hero, [enemy], vec(-1, 0), TUNING)).toEqual(vec(300, 100));
  });

  it('with no enemy nearby aims forward: movement while moving, else facing, at full reach', () => {
    const away = mob(5000, 100);
    expect(tapAim(BOLT, hero, [away], undefined, TUNING)).toEqual(vec(100, 720));
    expect(tapAim(TRAP, hero, [], vec(1, 0), TUNING)).toEqual(vec(400, 100));
  });

  it('charges at the nearest enemy only while standing; moving it follows the stick', () => {
    expect(tapAim(CHARGE, hero, [enemy], undefined, TUNING)).toEqual(vec(300, 100));
    expect(tapAim(CHARGE, hero, [enemy], vec(0, -1), TUNING)).toEqual(vec(100, -130));
    expect(tapAim(CHARGE, hero, [], undefined, TUNING)).toEqual(vec(100, 330));
  });

  it('rolls / teleports forward and never at an enemy', () => {
    expect(tapAim(ROLL, hero, [enemy], undefined, TUNING)).toEqual(vec(100, 300));
    expect(tapAim(TELEPORT, hero, [enemy], vec(-1, 0), TUNING)).toEqual(vec(-250, 100));
  });

  it('leaves the facing alone for skills that are not aimed', () => {
    expect(tapAim(SELF, hero, [enemy], undefined, TUNING)).toEqual(vec(100, 1100));
    expect(tapAim(NOVA, hero, [enemy], vec(1, 0), TUNING)).toEqual(vec(1100, 100));
  });
});

describe('manual and idle aim', () => {
  it('drags aim at full reach along the drag direction', () => {
    expect(manualAim(TELEPORT, hero, vec(3, 4))).toEqual(vec(100 + 210, 100 + 280));
  });

  it('idle aim keeps the facing or follows the movement', () => {
    expect(idleAim(hero, undefined)).toEqual(vec(100, 1100));
    expect(idleAim(hero, vec(-2, 0))).toEqual(vec(-900, 100));
  });

  it('forward falls back to east for a degenerate facing', () => {
    expect(forwardDir({ pos: vec(0, 0), facing: vec(0, 0) }, undefined)).toEqual(vec(1, 0));
  });
});

describe('stickDirection', () => {
  it('is zero inside the dead zone and a unit direction outside', () => {
    expect(stickDirection(5, 0, 60, 0.2)).toEqual(vec(0, 0));
    expect(stickDirection(0, 0, 60, 0.2)).toEqual(vec(0, 0));
    const d = stickDirection(30, 40, 60, 0.2);
    expect(d.x).toBeCloseTo(0.6);
    expect(d.y).toBeCloseTo(0.8);
  });
});

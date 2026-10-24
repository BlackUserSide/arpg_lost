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
  // The 0.4 boss (mobs.md «Бос», decisions 2026-10-23): a caster that keeps some distance; all its strong attacks
  // are telegraphed (MobState.casting / hostile zones). Map rules spawn it with scaling 1 (maps.ts), so these are its
  // real numbers. All PROPOSAL / BALANCE-TBD; growth with map level comes with package 3 (numbers only).
  // Ballpark: the placeholder boss was zombie × 40 life (640), × 2.5 damage (10–17.5 melee every 1.3 s), × 30 XP
  // (90), × 1.75 radius (26). Life is a bit lower (600) because the fight now has downtime (dodging, minions,
  // a kiting target), aiming at the same ~40–70 s fight; XP and size are kept.
  necromancer: {
    id: 'necromancer',
    boss: true,
    radius: 26,
    life: 600,
    xp: 90,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    // Slower than every hero (200+), so melee can catch it; it backs off below 0.6 × preferredRange.
    moveSpeed: 80,
    preferredRange: 240,
    // Weak dark bolt between abilities so standing far away is not free (~1/3 of the placeholder's melee DPS).
    attack: {
      damage: { physical: { min: 6, max: 10 } },
      range: 480,
      interval: 2,
      critChance: 0,
      projectile: { speed: 280, radius: 7 },
    },
    abilities: {
      recovery: 1.2,
      // Phase 2 at 50% life: grave circles unlock, every cooldown and the recovery × 0.75 ("трохи частіше").
      // Designer decision 2026-10-24: a ~1 s immune roar at the phase change.
      phases: [{ lifeBelow: 0.5, cooldownMultiplier: 0.75, transition: { duration: 1 } }],
      // List order = priority when several are ready.
      list: [
        {
          // Dark Nova: punishes standing close. Fires only when the hero is within 90 of the body; the 150 circle
          // (+ hero radius) shows for 1 s, enough to walk out at 200 speed. Cold: the hardest single hit (~25% of a
          // level-1 hero's life), so cold resistance matters.
          id: 'darkNova',
          kind: 'nova',
          windUp: 1,
          cooldown: 8,
          initialCooldown: 3,
          range: 90,
          radius: 150,
          damage: { cold: { min: 22, max: 30 } },
        },
        {
          // Raise Dead: zombies and skeletons (the ordinary pool's 3 : 2 : 1 mix); at most 6 alive at once.
          id: 'raiseDead',
          kind: 'summon',
          windUp: 1.2,
          cooldown: 15,
          initialCooldown: 4,
          count: 4,
          maxAlive: 6,
          ringRadius: 80,
          pool: [
            { mobId: 'zombie', weight: 3 },
            { mobId: 'runner', weight: 2 },
            { mobId: 'archer', weight: 1 },
          ],
        },
        {
          // Grave Circles (phase 2): 3 circles under / around the hero erupt 1 s after they appear.
          id: 'graveCircles',
          kind: 'groundZones',
          minPhase: 2,
          windUp: 0.5,
          cooldown: 7,
          initialCooldown: 1,
          range: 700,
          count: 3,
          radius: 65,
          delay: 1,
          scatter: 150,
          damage: { physical: { min: 18, max: 26 } },
        },
        {
          // Bone Spears: 5 slow spears over 60° (15° apart): at the preferred range the gap between two spears is
          // ~50 units, wider than any hero (≤ 36), so the hero can slip through (checked in data.test.ts).
          id: 'boneSpears',
          kind: 'projectileFan',
          windUp: 0.8,
          cooldown: 5,
          initialCooldown: 1.5,
          range: 650,
          count: 5,
          spreadDeg: 60,
          speed: 230,
          radius: 8,
          flightRange: 750,
          damage: { physical: { min: 10, max: 14 } },
        },
      ],
    },
  },
};

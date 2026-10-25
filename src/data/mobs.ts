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
  // New mob types every 5 map levels (mobs.md, decision 2026-10-25; maps.ts mobPool minMapLevel). Numbers are their
  // map-1 base, like every def: the map level growth (maps.ts mobScaling) multiplies life and damage, so they are set
  // relative to the zombie / archer at the same level. All PROPOSAL / BALANCE-TBD.
  //
  // Map 5 — Bone Shieldbearer: a slow melee wall with high armour. Armour reduces physical hits by
  // armour / (armour + armourK × hit) (combat.ts armourK 5), elements ignore it. Armour grows with the map level
  // (maps.ts mobScaling.armour, designer decision 2026-10-25: ×1.7 at map 5 → 77, ×8 at 40 → 360), about as fast as
  // a hero's physical hit, so it cuts ~40–55% of an average physical hit on every map (tools/sim/mobScaling.sim.ts;
  // base 80 cut 65–70% at map 5 and made it a 5-swing wall for an average warrior). Life 22 (zombie × ~1.4): about
  // 1.9× a zombie's hits for a half-physical build, 1.4× for an elemental one. PROPOSAL / BALANCE-TBD.
  shieldbearer: {
    id: 'shieldbearer',
    radius: 17,
    life: 22,
    xp: 5,
    armour: 45,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    // Slower than the zombie (75).
    moveSpeed: 60,
    attack: { damage: { physical: { min: 6, max: 10 } }, range: 14, interval: 1.6, critChance: 0 },
  },
  // Map 10 — Bone Thrower: keeps distance like the archer, throws a weak single bone, and every few seconds winds up a
  // fan of 3 slow bones. At its preferred range the gap between two bones is ~60 units, wider than any hero (≤ 36),
  // so the hero can slip through (checked in data.test.ts).
  boneThrower: {
    id: 'boneThrower',
    radius: 13,
    life: 14,
    xp: 4,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 85,
    preferredRange: 260,
    attack: {
      damage: { physical: { min: 3, max: 5 } },
      range: 420,
      interval: 2.6,
      critChance: 0,
      projectile: { speed: 240, radius: 6 },
    },
    abilities: {
      recovery: 1,
      phases: [],
      list: [
        {
          id: 'boneFan',
          kind: 'projectileFan',
          windUp: 0.6,
          cooldown: 4.5,
          initialCooldown: 1.5,
          range: 480,
          count: 3,
          spreadDeg: 30,
          speed: 220,
          radius: 8,
          flightRange: 600,
          damage: { physical: { min: 6, max: 9 } },
        },
      ],
    },
  },
  // Map 15 — Gravedigger: ranged, marks the ground under the hero; 1 s later the circle erupts. Walking out takes
  // (radius 55 + hero radius) / 200 ≈ 0.37 s, so standing still is what it punishes.
  gravedigger: {
    id: 'gravedigger',
    radius: 14,
    life: 18,
    xp: 4,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 85,
    preferredRange: 300,
    attack: {
      damage: { physical: { min: 3, max: 5 } },
      range: 420,
      interval: 2.6,
      critChance: 0,
      projectile: { speed: 240, radius: 6 },
    },
    abilities: {
      recovery: 1,
      phases: [],
      list: [
        {
          id: 'graveMark',
          kind: 'groundZones',
          windUp: 0.4,
          cooldown: 5,
          initialCooldown: 2,
          range: 520,
          count: 1,
          radius: 55,
          delay: 1,
          scatter: 0,
          damage: { physical: { min: 12, max: 18 } },
        },
      ],
    },
  },
  // Map 20 — Cultist: keeps far away and raises 2 zombies every 6 s, at most 4 of its own alive. Its zombies give
  // nothing and crumble when it dies (like the necromancer's minions), so it cannot be farmed and is the priority
  // target. Life 18 (zombie × 1.125; 20 was 2.3–3 casts for an average hero at map 20): it flees, so reaching it
  // should be the hard part, not killing it.
  cultist: {
    id: 'cultist',
    radius: 13,
    life: 18,
    xp: 5,
    armour: 0,
    resistances: { fire: 0, cold: 0, lightning: 0 },
    moveSpeed: 80,
    preferredRange: 340,
    attack: {
      damage: { physical: { min: 3, max: 5 } },
      range: 450,
      interval: 2.8,
      critChance: 0,
      projectile: { speed: 250, radius: 6 },
    },
    abilities: {
      recovery: 1,
      phases: [],
      list: [
        {
          id: 'raiseZombies',
          kind: 'summon',
          windUp: 1,
          cooldown: 6,
          initialCooldown: 2,
          range: 600,
          count: 2,
          maxAlive: 4,
          ringRadius: 50,
          pool: [{ mobId: 'zombie', weight: 1 }],
        },
      ],
    },
  },
  // The 0.4 boss (mobs.md «Бос», decisions 2026-10-23): a caster that keeps some distance; all its strong attacks
  // are telegraphed (MobState.casting / hostile zones). Map rules spawn it with scaling 1 (maps.ts), so these are its
  // map-1 numbers. All PROPOSAL / BALANCE-TBD; it grows with the map level by maps.ts mobScaling (numbers only).
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

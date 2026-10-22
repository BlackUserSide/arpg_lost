import type { SkillLevelBonus, SkillLevelData } from '../core/skills/levels';

// Skill levels (docs/design/classes.md «Рівні скілів», «Ефекти 3-го рівня»). All numbers are PROPOSAL until the
// balance pass (balance-analyst): thresholds and kill XP in `rules`, per-level bonuses and level-3 effects in `skills`.
//
// Pace math (design: level 2 after ~3–5 runs, level 3 after ~10–15 runs; every class skill gets XP from every kill):
// - Skill XP per kill = the mob's base XP (MobDef.xp, killXpMultiplier 1), not scaled by area level, so the pace
//   in runs does not speed up as the hero levels (hero XP per mob grows +15% per area level).
// - Arena mix (arena.ts mobIds: 3 zombie × 3 XP, 2 runner × 2, 1 archer × 3) = 16 / 6 ≈ 2.67 XP per kill.
// - Kills per run: the hero curve (progression.ts) reaches level 10 after Σ_{L=1..9} 180·L^1.2 / 2.67 ≈ 4300 kills,
//   which docs/design/progression.md puts at ~15 runs → ~280 kills per run → ~750 skill XP per run.
// - Level 2 at 2900 XP ≈ 3.9 runs (3 runs needs ≥ 970 XP / run, 5 runs ≤ 580).
// - Level 3 at 2900 + 6100 = 9000 XP ≈ 12 runs (10 runs ↔ 900 XP / run, 15 runs ↔ 600).
//   Both targets hold for any 600–900 XP per run (≈ 225–340 kills per run).
// Re-check when maps (0.4) replace the arena: their kill counts and mob XP set the real XP per run.

/** "+N% more damage" of the skill's own hits, the default per-level boost of damaging skills. */
const moreDamage = (value: number): SkillLevelBonus => ({ modifiers: [{ stat: 'damage', kind: 'more', value }] });

export const skillLevels: SkillLevelData = {
  rules: {
    maxLevel: 3,
    xpToNext: [2900, 6100],
    killXpMultiplier: 1,
  },
  skills: {
    // Warrior
    cleave: {
      perLevel: [moreDamage(0.2), moreDamage(0.2)],
      // Every 3rd swing is a 360° circle (counted over the whole run).
      effect: { level: 3, grants: { everyNth: { every: 3, angleDeg: 360 } } },
    },
    shield_charge: {
      perLevel: [moreDamage(0.2), moreDamage(0.2)],
      // Landing hits everyone within 90 at 60% of the charge's damage and stuns them (the charge's own 1.2 s stun).
      effect: { level: 3, grants: { dashLanding: { radius: 90, effectiveness: 0.6 } } },
    },
    battle_cry: {
      // Buff 40% → 50% → 60% increased damage.
      perLevel: [
        { buffModifiers: [{ stat: 'damage', kind: 'increased', value: 0.1 }] },
        { buffModifiers: [{ stat: 'damage', kind: 'increased', value: 0.1 }] },
      ],
      // The buff also grants attack speed.
      effect: { level: 3, buffModifiers: [{ stat: 'attackSpeed', kind: 'increased', value: 0.2 }] },
    },
    // Ranger
    volley: {
      perLevel: [moreDamage(0.2), moreDamage(0.2)],
      // Bolts pierce 1 enemy (adds up with the Pierce support).
      effect: { level: 3, changes: [{ param: 'pierce', add: 1 }] },
    },
    explosive_trap: {
      perLevel: [moreDamage(0.2), moreDamage(0.2)],
      // A fire puddle (radius 70) stays for 3 s: 4–6 fire every 0.5 s (6 ticks ≈ 30, about one more explosion if
      // a mob stands in it the whole time). Scales with the trap's damage modifiers and level.
      effect: {
        level: 3,
        grants: { groundZone: { id: 'fire_puddle', duration: 3, radius: 70, tick: { interval: 0.5, damage: { fire: { min: 4, max: 6 } } } } },
      },
    },
    roll: {
      // Cooldown 3 → 2.7 → 2.4 s; haste 30% → 40% → 50%.
      perLevel: [
        { changes: [{ param: 'cooldown', increased: -0.1 }], buffModifiers: [{ stat: 'movementSpeed', kind: 'increased', value: 0.1 }] },
        { changes: [{ param: 'cooldown', increased: -0.1 }], buffModifiers: [{ stat: 'movementSpeed', kind: 'increased', value: 0.1 }] },
      ],
      // A decoy stays at the start point for 2 s; mobs within 300 of it attack it instead of the hero, bosses only
      // for the first 1 s.
      effect: { level: 3, addSelfEffects: [{ kind: 'decoy', id: 'roll_decoy', duration: 2, tauntRadius: 300, bossTauntDuration: 1 }] },
    },
    // Mage
    fireball: {
      perLevel: [moreDamage(0.2), moreDamage(0.2)],
      // The explosion scatters 3 small fireballs over 90° ahead: 35% damage each, explosion radius 40, range 160.
      effect: {
        level: 3,
        grants: { projectileSplit: { count: 3, spreadDeg: 90, speed: 420, range: 160, radius: 6, explodeRadius: 40, damageMultiplier: 0.35 } },
      },
    },
    frost_nova: {
      perLevel: [moreDamage(0.2), moreDamage(0.2)],
      // Leaves an ice field (radius 150, the nova's base radius) for 3 s that slows enemies inside by 30%. Its own
      // radius: "larger area" changes do not grow it (design). Slow only: freezing stays with the Cryomancer
      // passive (it needs a nova hit).
      effect: { level: 3, grants: { groundZone: { id: 'ice_field', duration: 3, radius: 150, slow: 0.3 } } },
    },
    teleport: {
      // Cooldown 4 → 3.6 → 3.2 s; range 350 → 385 → 420.
      perLevel: [
        { changes: [{ param: 'cooldown', increased: -0.1 }, { param: 'range', increased: 0.1 }] },
        { changes: [{ param: 'cooldown', increased: -0.1 }, { param: 'range', increased: 0.1 }] },
      ],
      // 2 charges.
      effect: { level: 3, grants: { charges: 2 } },
    },
  },
};

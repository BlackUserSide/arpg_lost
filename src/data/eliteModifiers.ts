import type { EliteModifierDef } from '../core/world/content';

// Elite modifiers: docs/design/mobs.md «Еліти» (decisions 2026-10-25). Every elite of a map run gets exactly one, by
// weight from maps.ts rules.elites.modifiers; it applies on top of the elite rank scaling (maps.ts elites.scaling:
// life ×4, damage ×1.5, XP ×5, radius ×1.3) and the map level growth. Render colours: fast yellow, fat green, fiery
// orange, explosive red (mobs.md). All numbers PROPOSAL / BALANCE-TBD.
const list: EliteModifierDef[] = [
  // «Швидкий»: walks and attacks / casts 30% faster. Heroes walk 200–215: a fast runner (150 → 195) still cannot
  // outrun them, a fast zombie (75 → 98) closes in noticeably quicker. Wind-ups keep their length (telegraphs stay
  // readable).
  { id: 'fast', moveSpeed: 1.3, actionSpeed: 1.3 },
  // «Товстий»: ×3 life on top of the rank's ×4 (designer decision).
  { id: 'fat', life: 3 },
  // «Вогняний»: all its damage becomes fire; a landed hit ignites the hero 25% of the time for half the hit's damage
  // as fire over 3 s (fire resistance reduces it). A fiery elite zombie at map 1 hits 6–10.5 → a burn of ~1–1.8 / s.
  {
    id: 'fiery',
    damageConversion: { to: 'fire', fraction: 1 },
    onHitHero: [{ status: 'ignite', chance: 0.25, magnitude: 0.5, duration: 3 }],
  },
  // «Вибуховий»: on death a circle of radius 90 appears and erupts 1 s later for 12–18 fire × the elite's damage scale
  // (×1.5 rank × map level growth): 18–27 at map 1, ~20–30% of a starting hero's life — punishing but avoidable
  // (a hero walks ~200 units in that second; leaving the circle takes ≤ 0.5 s).
  { id: 'explosive', deathZone: { radius: 90, delay: 1, damage: { fire: { min: 12, max: 18 } } } },
];

export const eliteModifiers: Record<string, EliteModifierDef> = Object.fromEntries(list.map((m) => [m.id, m]));

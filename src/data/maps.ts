import type { MapsData, RoomTemplate } from '../core/run/types';

// Map runs: docs/design/maps.md (rooms, altar, timer, rewards), mobs.md (elites, boss), items.md (chest), crafting.md
// (essence), progression.md (map completion XP: progression.mapClearBonus). All numbers are PROPOSAL / BALANCE-TBD
// until the balance pass. Coordinates are world units of each room (the arena is 1600 × 1100).

const p = (x: number, y: number): { x: number; y: number } => ({ x, y });

// Combat rooms: the hero enters on one side, the door to the next room is on the far side; spawn points stay
// ≥ ~400 units from the entry so a wave never lands on the hero.
const templateList: RoomTemplate[] = [
  {
    id: 'hall',
    kind: 'combat',
    width: 1200,
    height: 800,
    entry: p(100, 400),
    exit: p(1120, 400),
    spawnPoints: [p(900, 150), p(900, 650), p(1050, 400), p(600, 120), p(600, 680)],
  },
  {
    id: 'pillars',
    kind: 'combat',
    width: 1200,
    height: 900,
    entry: p(100, 450),
    exit: p(1120, 450),
    spawnPoints: [p(600, 100), p(600, 800), p(1000, 150), p(1000, 750), p(600, 450)],
    obstacles: [
      { pos: p(450, 300), radius: 40 },
      { pos: p(450, 600), radius: 40 },
      { pos: p(750, 300), radius: 40 },
      { pos: p(750, 600), radius: 40 },
    ],
  },
  {
    id: 'crossing',
    kind: 'combat',
    width: 1000,
    height: 1000,
    entry: p(500, 920),
    exit: p(500, 80),
    spawnPoints: [p(150, 150), p(850, 150), p(150, 500), p(850, 500), p(500, 250)],
    obstacles: [{ pos: p(500, 520), radius: 70 }],
  },
  {
    id: 'gallery',
    kind: 'combat',
    width: 1400,
    height: 700,
    entry: p(100, 350),
    exit: p(1320, 350),
    spawnPoints: [p(1150, 120), p(1150, 580), p(700, 350), p(550, 110), p(550, 590)],
    obstacles: [
      { pos: p(800, 190), radius: 50 },
      { pos: p(800, 510), radius: 50 },
    ],
  },
  // Boss room: the altar stands at the far wall, the boss rises behind it; spawn points are for the boss's minions
  // (package 2).
  {
    id: 'crypt',
    kind: 'boss',
    width: 1300,
    height: 1000,
    entry: p(650, 920),
    altar: p(650, 320),
    bossSpawn: p(650, 200),
    spawnPoints: [p(350, 250), p(950, 250), p(650, 500)],
    obstacles: [
      { pos: p(300, 620), radius: 45 },
      { pos: p(1000, 620), radius: 45 },
    ],
  },
];

export const mapsData: MapsData = {
  rules: {
    // PROPOSAL (maps.md): 3 rooms + the boss room, ~40–60 s per room.
    combatRooms: 3,
    // Designer decision: hard limit 5:00.
    timeLimit: 300,
    timeWarnings: [60, 30, 10],
    // Designer decision 2026-10-23: maps 1..40 are linear; keys come after (endgame.md).
    maxLinearMap: 40,
    doorRadius: 60,
    altarRadius: 90,
    waves: {
      // Designer decision: 2–3 waves per room. BALANCE-TBD: 8–12 mobs a wave (the arena peaks at ~45 alive).
      count: { min: 2, max: 3 },
      mobs: { min: 8, max: 12 },
      firstDelay: 1,
      nextDelay: 1.5,
      spawnJitter: 60,
      // Maps 1–4: the arena mix (3 : 2 : 1). Designer decision 2026-10-23 / 2026-10-25: a new mob type every 5 map
      // levels (mobs.md table; which mob comes at which level is PROPOSAL). Weights BALANCE-TBD: the shieldbearer is
      // part of the melee wall (2), the casters are spice (1 each) — at map 20 a wave of 10 has ~1 cultist.
      mobPool: [
        { mobId: 'zombie', weight: 3 },
        { mobId: 'runner', weight: 2 },
        { mobId: 'archer', weight: 1 },
        { mobId: 'shieldbearer', weight: 2, minMapLevel: 5 },
        { mobId: 'boneThrower', weight: 1, minMapLevel: 10 },
        { mobId: 'gravedigger', weight: 1, minMapLevel: 15 },
        { mobId: 'cultist', weight: 1, minMapLevel: 20 },
      ],
    },
    elites: {
      // Designer decision: 1–2 elites per room, each with exactly 1 modifier on top of this rank scaling. BALANCE-TBD.
      count: { min: 1, max: 2 },
      // radius: matches the size render drew elites at before the body radius lived in core.
      scaling: { life: 4, damage: 1.5, xp: 5, radius: 1.3 },
      // Modifier pool (defs: eliteModifiers.ts). PROPOSAL / BALANCE-TBD: all four equally likely from map 1;
      // minMapLevel is there for later modifiers.
      modifiers: [
        { id: 'fast', weight: 1 },
        { id: 'fat', weight: 1 },
        { id: 'fiery', weight: 1 },
        { id: 'explosive', weight: 1 },
      ],
    },
    boss: {
      // The necromancer (mobs.md «Бос»): its def holds its real numbers, so the rank scaling is 1. It grows with the
      // map level through mobScaling below (numbers only, designer decision 2026-10-24).
      mobId: 'necromancer',
      scaling: { life: 1, damage: 1, xp: 1, radius: 1 },
      spawnDelay: 1.5,
    },
    // Designer decision 2026-10-25 (mobs.md): growth "noticeably harder" — mobs outgrow an average hero, so every ~10
    // maps the hero has to catch up with gear and passives. Applies to every mob of a run (waves, elites on top of
    // their rank scaling, the boss, minions); XP grows separately (progression.mobXpGrowth), speed does not grow.
    // Multiplier at map L = (1 + linear × (L − 1)) × (1 + compound)^(L − 1); map 1 is always × 1.
    // PROPOSAL / BALANCE-TBD (balance-analyst, tools/sim/mobScaling.sim.ts; final numbers in the end-of-0.5 rebalance).
    // Hero power (hero level = map level, gear of map level) grows fast early (×5–8 DPS by map 10: first real gear,
    // tier 2 affixes at item level 8, new bases at 10, skill level 3) and flattens after 30 (no affix tier or base
    // above item level 30), so life is mostly linear with a small compound part. Casts of the main skill per zombie:
    //   average hero: ~1 at map 1, 1–1.8 at 5, ~1 at 10, 1.5–2 at 20, 2–2.5 at 30, 3–4 at 40;
    //   geared (crafted rares, item level map + 3): ≤ 1 up to ~25, ≤ 1.7 at 40;
    //   gear of 10 maps ago: 2–4 → runs over the 5:00 limit, i.e. "upgrade or get stuck".
    // Life ×2.9 at map 5, ×6.0 at 10, ×15 at 20, ×30 at 30, ×53 at 40.
    // Damage ×1.5 / ×2.2 / ×4.0 / ×6.8 / ×10.8 (maps 5 / 10 / 20 / 30 / 40): an average hero's zombie hit goes from
    // ~1% to ~7–9% of life + ES at map 40 (armour eats most of small hits), the boss's Dark Nova from ~13% to ~25–35%.
    mobScaling: {
      life: { linear: 0.4, compound: 0.03 },
      damage: { linear: 0.08, compound: 0.025 },
      // Designer decision 2026-10-25: armour grows too, so the shieldbearer stays armoured on any map (ranks do not
      // change armour). Linear, close to the growth of a hero's physical hit (×4–6 from map 5 to 40): ×1.7 at 5,
      // ×2.6 at 10, ×4.4 at 20, ×8 at 40; the shieldbearer then cuts ~40–55% of an average physical hit on any map.
      armour: { linear: 0.18, compound: 0 },
    },
  },
  rewards: {
    chest: {
      // items.md: 2–4 items; a faster clear gives more and better ones. Speed thresholds follow the key thresholds
      // proposed in endgame.md (≥ 20% / ≥ 40% of the time left). BALANCE-TBD.
      items: 2,
      bossItemLevelBonus: 1,
      // Designer decision 2026-10-23: item level ≤ map level + 3, every bonus included.
      maxItemLevelBonus: 3,
      speedTiers: [
        { minTimeLeft: 0.2, extraItems: 1, itemLevelBonus: 1, luck: 0.15 },
        { minTimeLeft: 0.4, extraItems: 2, itemLevelBonus: 2, luck: 0.3 },
      ],
    },
    // Designer decision 2026-10-23: a failed run gets shards per room cleared. BALANCE-TBD: 2 per room (a salvaged
    // magic item is 3).
    shardsPerRoom: 2,
    // Designer decision 2026-10-23: reaching the boss adds 1 item of map level.
    bossRoomConsolationItems: 1,
    // Designer decision 2026-10-23 (crafting.md): 0.1 per elite + 0.5 per boss (~1 per map).
    essence: { perElite: 0.1, perBoss: 0.5 },
  },
  templates: Object.fromEntries(templateList.map((t) => [t.id, t])),
};

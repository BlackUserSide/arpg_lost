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
      // Same mix as the arena (3 : 2 : 1). New mob types every 5 map levels go here with minMapLevel (package 3).
      mobPool: [
        { mobId: 'zombie', weight: 3 },
        { mobId: 'runner', weight: 2 },
        { mobId: 'archer', weight: 1 },
      ],
    },
    elites: {
      // Designer decision: 1–2 elites per room. Their modifiers (fast / fat / fiery / explosive) are package 4;
      // until then an elite is its mob with more life, damage and XP. BALANCE-TBD.
      count: { min: 1, max: 2 },
      // radius: matches the size render drew elites at before the body radius lived in core.
      scaling: { life: 4, damage: 1.5, xp: 5, radius: 1.3 },
    },
    boss: {
      // PLACEHOLDER until the necromancer (package 2): a big zombie. Then mobId 'necromancer' and scaling 1.
      mobId: 'zombie',
      scaling: { life: 40, damage: 2.5, xp: 30, radius: 1.75 },
      spawnDelay: 1.5,
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

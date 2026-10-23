import type { Modifier } from '../core/stats/types';
import type { SupportData, SupportDef, SupportRules } from '../core/supports/types';

// Skill modifiers ("supports"), docs/design/skill-modifiers.md: 14 supports, 3 tiers each (index 0 = tier 1).
// Structure (slots, tab size, compatibility, which mechanic each support uses) follows the design and the
// designer's decisions of 2026-10-23. Every number marked BALANCE-TBD is a placeholder for balance-analyst.

const rules: SupportRules = {
  // Design: 2 slots per skill, the basic attack has none.
  slotsPerSkill: 2,
  // Design (2026-10-23): the tab holds 30, overflow is salvaged into shards.
  tabSize: 30,
  // BALANCE-TBD: area level at which each tier starts dropping (affix tiers use 1 / 8 / 15 / 23 / 30).
  tierMinLevel: [1, 8, 15],
  // BALANCE-TBD: higher tiers are rarer among the tiers available.
  tierWeights: [100, 45, 20],
  // BALANCE-TBD: design target ~1 support per run. The arena run is ~280 kills (src/data/skillLevels.ts), so normal
  // 0.3% ≈ 0.84 per run; on maps elites (3%, 3–6 per run) and the boss (20%) add ~0.3 more.
  dropChance: { normal: 0.003, elite: 0.03, boss: 0.2 },
  // BALANCE-TBD: shards per salvaged support by tier (items: normal 1, magic 3, rare 8).
  salvage: [3, 5, 10],
};

const moreDamage = (value: number): Modifier[] => [{ stat: 'damage', kind: 'more', value }];

const supportList: SupportDef[] = [
  // ── Melee ──
  {
    id: 'wider_swing',
    name: 'Ширший замах',
    description: 'Ширша дуга й більша зона удару, трохи менше урону.',
    group: 'melee',
    // Arcs grow (angle, radius), a charge widens its path; nothing to widen on other deliveries.
    // Designer decision: Wider Swing also fits Shield Charge (wider path).
    compatibility: { tags: [['melee']], deliveries: ['arc', 'dash'] },
    resourceCostMultiplier: 1.2, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { changes: [{ param: 'angle', increased: 0.2 }, { param: 'radius', increased: 0.1 }, { param: 'hitRadius', increased: 0.3 }], modifiers: moreDamage(-0.1) } },
      { bonus: { changes: [{ param: 'angle', increased: 0.3 }, { param: 'radius', increased: 0.15 }, { param: 'hitRadius', increased: 0.45 }], modifiers: moreDamage(-0.1) } },
      { bonus: { changes: [{ param: 'angle', increased: 0.4 }, { param: 'radius', increased: 0.2 }, { param: 'hitRadius', increased: 0.6 }], modifiers: moreDamage(-0.1) } },
    ],
  },
  {
    id: 'stun',
    name: 'Оглушення',
    description: 'Шанс оглушити при ударі. У героя зі шкалою оглушення (Страж) — сильніше наповнює шкалу.',
    group: 'melee',
    compatibility: { tags: [['melee']], damaging: true },
    resourceCostMultiplier: 1.2, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    // Designer decision: with the stun bar mechanic (Guardian) the support fills the bar more instead of rolling stuns.
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { addOnHit: [{ status: 'stun', duration: 1, chance: 0.25 }] }, variants: [{ mechanic: 'stunBar', bonus: { stunBarFillIncreased: 0.5 } }] },
      { bonus: { addOnHit: [{ status: 'stun', duration: 1, chance: 0.35 }] }, variants: [{ mechanic: 'stunBar', bonus: { stunBarFillIncreased: 0.75 } }] },
      { bonus: { addOnHit: [{ status: 'stun', duration: 1, chance: 0.45 }] }, variants: [{ mechanic: 'stunBar', bonus: { stunBarFillIncreased: 1 } }] },
    ],
  },
  {
    id: 'bleed',
    name: 'Кровотеча',
    description: 'Удар накладає кровотечу: фізичний урон з часом, до 3 стаків.',
    group: 'melee',
    compatibility: { tags: [['melee']], damaging: true },
    resourceCostMultiplier: 1.25, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    // Designer decision 2026-10-23: up to 3 stacks, every hit adds a stack and refreshes the timer.
    tiers: [
      // BALANCE-TBD: magnitude = fraction of the hit dealt per stack over the duration.
      { bonus: { addOnHit: [{ status: 'bleed', duration: 3, magnitude: 0.35, maxStacks: 3 }] } },
      { bonus: { addOnHit: [{ status: 'bleed', duration: 3, magnitude: 0.45, maxStacks: 3 }] } },
      { bonus: { addOnHit: [{ status: 'bleed', duration: 3, magnitude: 0.55, maxStacks: 3 }] } },
    ],
  },
  {
    id: 'knockback',
    name: 'Відкидання',
    description: 'Вороги відлітають від удару. Бос не відлітає, еліти — слабше.',
    group: 'melee',
    compatibility: { tags: [['melee']], damaging: true },
    resourceCostMultiplier: 1.2, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    // Designer decision 2026-10-23: bosses are never pushed, elites less (eliteMultiplier).
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { grants: { knockback: { distance: 35, speed: 600, eliteMultiplier: 0.5 } } } },
      { bonus: { grants: { knockback: { distance: 45, speed: 600, eliteMultiplier: 0.5 } } } },
      { bonus: { grants: { knockback: { distance: 55, speed: 600, eliteMultiplier: 0.5 } } } },
    ],
  },

  // ── Projectiles ──
  {
    id: 'extra_projectiles',
    name: 'Додаткові снаряди',
    description: 'Більше снарядів (віяло +2, одиночний +1), кожен слабший.',
    group: 'projectile',
    compatibility: { tags: [['projectile']], deliveries: ['projectile'] },
    resourceCostMultiplier: 1.3, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    // Designer decision 2026-10-23: Volley +2, Fireball +1. Count = (base + 1) × 1.2 rounded down (core
    // projectileCount): Volley 5 -> 7, Fireball 1 -> 2, so one penalty fits both. Spread +10°: a single projectile
    // becomes a pair 10° apart.
    tiers: [
      // BALANCE-TBD: the damage penalty (designer accepted -25 / -20 / -15%).
      { bonus: { changes: [{ param: 'projectileCount', add: 1, increased: 0.2 }, { param: 'spread', add: 10 }], modifiers: moreDamage(-0.25) } },
      { bonus: { changes: [{ param: 'projectileCount', add: 1, increased: 0.2 }, { param: 'spread', add: 10 }], modifiers: moreDamage(-0.2) } },
      { bonus: { changes: [{ param: 'projectileCount', add: 1, increased: 0.2 }, { param: 'spread', add: 10 }], modifiers: moreDamage(-0.15) } },
    ],
  },
  {
    id: 'pierce',
    name: 'Пробиття',
    description: 'Снаряд пролітає крізь ще 1 ворога.',
    group: 'projectile',
    // A projectile that explodes on its first hit cannot pierce: Fireball does not qualify.
    compatibility: { tags: [['projectile']], deliveries: ['projectile'], nonExploding: true },
    resourceCostMultiplier: 1.25, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // Designer decision 2026-10-23: pierce 1 (was 2: Volley's pack damage tripled). BALANCE-TBD: higher-tier damage.
      { bonus: { changes: [{ param: 'pierce', add: 1 }] } },
      { bonus: { changes: [{ param: 'pierce', add: 1 }], modifiers: moreDamage(0.1) } },
      { bonus: { changes: [{ param: 'pierce', add: 1 }], modifiers: moreDamage(0.2) } },
    ],
  },
  {
    id: 'fast_projectiles',
    name: 'Швидкі снаряди',
    description: 'Вища швидкість польоту й дальність, більше урону.',
    group: 'projectile',
    compatibility: { tags: [['projectile']], deliveries: ['projectile'] },
    resourceCostMultiplier: 1.2, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { changes: [{ param: 'projectileSpeed', increased: 0.3 }, { param: 'range', increased: 0.2 }], modifiers: moreDamage(0.1) } },
      { bonus: { changes: [{ param: 'projectileSpeed', increased: 0.4 }, { param: 'range', increased: 0.25 }], modifiers: moreDamage(0.15) } },
      { bonus: { changes: [{ param: 'projectileSpeed', increased: 0.5 }, { param: 'range', increased: 0.3 }], modifiers: moreDamage(0.2) } },
    ],
  },

  // ── Spells ──
  {
    id: 'increased_area',
    name: 'Збільшена область',
    description: 'Більший радіус вибуху, нови чи пастки.',
    group: 'spell',
    // Ground zones keep their own radius (classes.md decision): only the area that hits grows.
    compatibility: { tags: [['area']] },
    resourceCostMultiplier: 1.25, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { changes: [{ param: 'radius', increased: 0.15 }, { param: 'explodeRadius', increased: 0.15 }] } },
      { bonus: { changes: [{ param: 'radius', increased: 0.22 }, { param: 'explodeRadius', increased: 0.22 }] } },
      { bonus: { changes: [{ param: 'radius', increased: 0.3 }, { param: 'explodeRadius', increased: 0.3 }] } },
    ],
  },
  {
    id: 'ignite_on_hit',
    name: 'Підпал при попаданні',
    description: 'Шанс підпалити; частина урону стає вогняною.',
    group: 'spell',
    // Designer decision 2026-10-23: any skill that hits (attacks, spells and the trap).
    // Designer decision: «частина урону → вогонь» is conversion of part of the hit to fire (not extra fire damage).
    compatibility: { damaging: true },
    resourceCostMultiplier: 1.2, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // BALANCE-TBD (all tiers): ignite chance / strength and the converted fraction.
      { bonus: { addOnHit: [{ status: 'ignite', duration: 3, magnitude: 0.5, chance: 0.3 }], damageConversion: { to: 'fire', fraction: 0.3 } } },
      { bonus: { addOnHit: [{ status: 'ignite', duration: 3, magnitude: 0.6, chance: 0.4 }], damageConversion: { to: 'fire', fraction: 0.4 } } },
      { bonus: { addOnHit: [{ status: 'ignite', duration: 3, magnitude: 0.7, chance: 0.5 }], damageConversion: { to: 'fire', fraction: 0.5 } } },
    ],
  },
  {
    id: 'chain_lightning',
    name: 'Ланцюгова блискавка',
    description: 'Попадання випускає блискавку, що стрибає по 2–3 ворогах.',
    group: 'spell',
    compatibility: { tags: [['spell']], damaging: true },
    resourceCostMultiplier: 1.3, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    // Designer decision 2026-10-23: the bolt deals a fraction of the skill's hit, as lightning.
    tiers: [
      // Hops 2–3 are the design numbers; BALANCE-TBD: range and effectiveness.
      { bonus: { grants: { chainHit: { hops: 2, range: 160, effectiveness: 0.35, damageType: 'lightning' } } } },
      { bonus: { grants: { chainHit: { hops: 3, range: 160, effectiveness: 0.35, damageType: 'lightning' } } } },
      { bonus: { grants: { chainHit: { hops: 3, range: 180, effectiveness: 0.42, damageType: 'lightning' } } } },
    ],
  },
  {
    id: 'cast_speed',
    name: 'Прискорення касту',
    description: 'Швидше застосування цього скіла (каст або атака).',
    group: 'spell',
    // Designer decision 2026-10-23: spells and attacks.
    // Designer decision 2026-10-23: not on cooldown-gated skills (Shield Charge, Frost Nova, Teleport), where a faster
    // use changes nothing; Explosive Trap is neither a spell nor an attack.
    compatibility: { tags: [['spell'], ['attack']], noCooldown: true },
    resourceCostMultiplier: 1.2, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { modifiers: [{ stat: 'castSpeed', kind: 'increased', value: 0.2 }, { stat: 'attackSpeed', kind: 'increased', value: 0.2 }] } },
      { bonus: { modifiers: [{ stat: 'castSpeed', kind: 'increased', value: 0.25 }, { stat: 'attackSpeed', kind: 'increased', value: 0.25 }] } },
      { bonus: { modifiers: [{ stat: 'castSpeed', kind: 'increased', value: 0.3 }, { stat: 'attackSpeed', kind: 'increased', value: 0.3 }] } },
    ],
  },

  // ── General ──
  {
    id: 'pure_power',
    name: 'Чиста сила',
    description: 'Значно більше урону, дорога мана.',
    group: 'general',
    compatibility: { damaging: true },
    resourceCostMultiplier: 1.4, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { modifiers: moreDamage(0.3) } },
      { bonus: { modifiers: moreDamage(0.38) } },
      { bonus: { modifiers: moreDamage(0.45) } },
    ],
  },
  {
    id: 'vampirism',
    name: 'Вампіризм',
    description: 'Частина урону цим скілом лікує.',
    group: 'general',
    compatibility: { damaging: true },
    resourceCostMultiplier: 1.2, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    tiers: [
      // BALANCE-TBD: fraction of the life removed that is leeched.
      { bonus: { leech: 0.03 } },
      { bonus: { leech: 0.04 } },
      { bonus: { leech: 0.05 } },
    ],
  },
  {
    id: 'echo',
    name: 'Луна',
    description: 'Шанс, що скіл спрацює двічі.',
    group: 'general',
    // Designer decision 2026-10-23: not for movement skills (dash, roll, teleport) or buffs.
    compatibility: { excludeDeliveries: ['dash', 'teleport', 'self'] },
    resourceCostMultiplier: 1.25, // BALANCE-TBD
    weight: 100, // BALANCE-TBD
    // The repeat is free and comes after a short pause (designer decision 2026-10-23).
    tiers: [
      // BALANCE-TBD (all tiers)
      { bonus: { grants: { echo: { chance: 0.22, delay: 0.25 } } } },
      { bonus: { grants: { echo: { chance: 0.28, delay: 0.25 } } } },
      { bonus: { grants: { echo: { chance: 0.33, delay: 0.25 } } } },
    ],
  },
];

export const supportsData: SupportData = { rules, supports: Object.fromEntries(supportList.map((s) => [s.id, s])) };

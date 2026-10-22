import { clamp } from '../math';
import type { PassiveMechanic } from '../passives/types';
import { areaXpMultiplier, grantXp, levelModifiers, mobXp, type ProgressionRules } from '../progression/levels';
import type { Modifier } from '../stats/types';
import type { ClassDef, Content } from './content';
import { resolveActions } from '../skills/params';
import { leechStats, lifeRecoveryPool, skillChangeSets } from './passiveEffects';
import { getClass, playerStat, type Ctx, type PlayerState, type WorldState } from './state';

export function refillPools(classDef: ClassDef, player: PlayerState): void {
  player.life = playerStat(classDef, player, 'life');
  player.energyShield = playerStat(classDef, player, 'energyShield');
  player.mana = playerStat(classDef, player, 'mana');
}

/** Permanent modifiers = loadout (gear, passives) + level stats. */
function rebuildModifiers(player: PlayerState, rules: ProgressionRules): void {
  player.levelModifiers = levelModifiers(player.level, rules);
  player.modifiers = [...player.gearModifiers, ...player.levelModifiers];
}

type Pool = 'life' | 'energyShield' | 'mana';

/** Current fill of each pool as a fraction of its max, taken before a loadout / mechanic change. */
interface PoolSnapshot {
  readonly main: Pool;
  /** Fraction of the main pool (life, or ES under lifeToEnergyShield). */
  readonly mainFraction: number;
  /** Under lifeToEnergyShield: (ES + life) / (maxES + maxLife); otherwise the life fraction. */
  readonly survivalFraction: number;
  readonly energyShield: number;
  readonly mana: number;
}

/** Fraction of a pool; a pool with max 0 counts as `ifEmpty` (it starts there and regenerates). */
function fraction(value: number, max: number, ifEmpty: number): number {
  return max > 0 ? clamp(value / max, 0, 1) : ifEmpty;
}

function snapshotPools(classDef: ClassDef, player: PlayerState): PoolSnapshot {
  const main = lifeRecoveryPool(player.mechanics);
  const maxLife = playerStat(classDef, player, 'life');
  const maxShield = playerStat(classDef, player, 'energyShield');
  const maxMana = playerStat(classDef, player, 'mana');
  const lifeFraction = fraction(player.life, maxLife, 1);
  return {
    main,
    // The main pool keeps the hero alive: a 0-max main pool counts as full rather than killing on the swap.
    mainFraction: main === 'life' ? lifeFraction : fraction(player.energyShield, maxShield, 1),
    survivalFraction: main === 'life' ? lifeFraction : fraction(player.energyShield + player.life, maxShield + maxLife, 1),
    energyShield: fraction(player.energyShield, maxShield, 0),
    mana: fraction(player.mana, maxMana, 0),
  };
}

/**
 * Re-applies pool fractions after the maximums changed (designer decision: fill fractions are kept).
 * - The main pool gets the old main pool's fraction, even if the main pool itself switched
 *   (taking Crystal Shell at 40% life gives 40% ES; removing it at 40% ES gives 40% life).
 * - Leaving lifeToEnergyShield, the fixed life counts as part of the old pool: (ES + life) / (maxES + maxLife).
 *   Otherwise a hero alive at 0 ES / 1 life would get 0 life without dying.
 * - Under lifeToEnergyShield life is always at its fixed max.
 * - Secondary ES (no lifeToEnergyShield) and mana keep their own fractions. A pool whose old max was 0
 *   (no ES before; mana under bloodMagic) starts at 0 and regenerates, so a swap never refills a pool.
 */
function restorePools(classDef: ClassDef, player: PlayerState, before: PoolSnapshot): void {
  const maxLife = playerStat(classDef, player, 'life');
  const maxShield = playerStat(classDef, player, 'energyShield');
  const maxMana = playerStat(classDef, player, 'mana');
  if (lifeRecoveryPool(player.mechanics) === 'energyShield') {
    player.life = maxLife;
    player.energyShield = before.mainFraction * maxShield;
  } else {
    player.life = before.survivalFraction * maxLife;
    player.energyShield = before.energyShield * maxShield;
  }
  player.mana = before.mana * maxMana;
}

/** Grants XP for a kill; each level-up rebuilds level stats and fully restores life, shield and mana. */
export function gainKillXp(ctx: Ctx, baseXp: number): void {
  const { world, content, classDef, events } = ctx;
  const player = world.player;
  const rules = content.progression;
  if (player.level >= rules.maxLevel) return;
  const amount = mobXp(baseXp, world.areaLevel, rules) * areaXpMultiplier(player.level, world.areaLevel, rules);
  world.xpGained += amount;
  if (grantXp(player, amount, rules) === 0) return;
  rebuildModifiers(player, rules);
  refillPools(classDef, player);
  events.push({ type: 'levelUp', level: player.level });
}

/**
 * Replaces the loadout mid-run (e.g. passives allocated while the tree is open in combat).
 * `mechanics` (passive tree mechanics, see heroMechanics) are replaced only when given.
 * Life / shield / mana keep their fill fractions of the new maximums (see restorePools); this never refills.
 * Level-ups do not go through here: they fully restore the pools (gainKillXp, docs/design/progression.md).
 */
export function setLoadoutModifiers(
  world: WorldState,
  content: Content,
  modifiers: readonly Modifier[],
  mechanics?: readonly PassiveMechanic[],
): void {
  const player = world.player;
  const classDef = getClass(content, player.classId);
  const before = snapshotPools(classDef, player);
  player.gearModifiers = [...modifiers];
  if (mechanics) {
    player.mechanics = [...mechanics];
    // Effective skills follow the mechanics from the next use. Running cooldowns keep their remaining time
    // (designer decision 2026-10-22). Flying projectiles, thrown traps and a running dash keep the action
    // snapshot they were created with (geometry, tags, crit, on-hit statuses and their durations).
    // Stat modifiers (gear, passives) still apply live to their hits.
    player.actions = resolveActions(classDef, skillChangeSets(player.mechanics));
  }
  rebuildModifiers(player, content.progression);
  if (!player.dead) restorePools(classDef, player, before);
}

/**
 * Restores life (life potions, life gain effects). Under lifeToEnergyShield it restores energy shield instead.
 * Returns the amount actually restored.
 */
export function recoverLife(classDef: ClassDef, player: PlayerState, amount: number): number {
  if (player.dead || amount <= 0) return 0;
  const pool = lifeRecoveryPool(player.mechanics);
  const max = playerStat(classDef, player, pool);
  const before = player[pool];
  player[pool] = clamp(before + amount, 0, Math.max(before, max));
  return player[pool] - before;
}

/** Leech cap in pool points per second (max of the recovery pool × maxPerSecond); Infinity if uncapped. */
function leechCap(classDef: ClassDef, player: PlayerState, maxPerSecond: number): number {
  if (maxPerSecond === Infinity) return Infinity;
  return maxPerSecond * playerStat(classDef, player, lifeRecoveryPool(player.mechanics));
}

/**
 * lifeLeech: restores a fraction of `damage` (a hit the hero dealt) to the life recovery pool (ES under
 * lifeToEnergyShield), limited by the per-second cap (see PlayerState.leechRecent). Returns the amount restored.
 * `damage` is the life actually removed from the target (no overkill; designer decision 2026-10-22).
 */
export function applyLeech(classDef: ClassDef, player: PlayerState, damage: number): number {
  const leech = leechStats(player.mechanics);
  if (!leech || player.dead || damage <= 0) return 0;
  const room = Math.max(0, leechCap(classDef, player, leech.maxPerSecond) - player.leechRecent);
  const restored = recoverLife(classDef, player, Math.min(damage * leech.fraction, room));
  player.leechRecent += restored;
  return restored;
}

/** Drains the leech cap window by one tick. */
export function decayLeech(classDef: ClassDef, player: PlayerState, dt: number): void {
  if (player.leechRecent <= 0) return;
  const leech = leechStats(player.mechanics);
  const cap = leech ? leechCap(classDef, player, leech.maxPerSecond) : Infinity;
  player.leechRecent = cap === Infinity ? 0 : Math.max(0, player.leechRecent - cap * dt);
}

/** Restores mana (mana potions). Does nothing under bloodMagic (max mana is 0). Returns the amount restored. */
export function recoverMana(classDef: ClassDef, player: PlayerState, amount: number): number {
  if (player.dead || amount <= 0) return 0;
  const before = player.mana;
  player.mana = clamp(before + amount, 0, Math.max(before, playerStat(classDef, player, 'mana')));
  return player.mana - before;
}

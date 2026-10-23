import { clamp } from '../math';
import type { PassiveMechanic } from '../passives/types';
import { areaXpMultiplier, grantXp, levelModifiers, mobXp, type ProgressionRules } from '../progression/levels';
import type { Modifier } from '../stats/types';
import { grantSkillXp, newSkillProgress, skillKillXp } from '../skills/levels';
import type { ClassDef, Content } from './content';
import { syncCharges } from './charges';
import { levelUpResource, spawnResource } from './resource';
import { leechStats, lifeRecoveryPool } from './passiveEffects';
import { deriveFromMechanics, getClass, playerStat, type Ctx, type PlayerState, type WorldState } from './state';

function refillLifePools(classDef: ClassDef, player: PlayerState): void {
  player.life = playerStat(classDef, player, 'life');
  player.energyShield = playerStat(classDef, player, 'energyShield');
}

/** Run start: full life and shield; the class resource starts at its startFraction (Rage empty). */
export function spawnPools(classDef: ClassDef, player: PlayerState): void {
  refillLifePools(classDef, player);
  player.resource = spawnResource(classDef, player);
}

/** Level-up: full life and shield; the resource refills or keeps its amount (ResourceDef.refillOnLevelUp). */
function levelUpPools(classDef: ClassDef, player: PlayerState): void {
  refillLifePools(classDef, player);
  player.resource = levelUpResource(classDef, player);
}

/** Permanent modifiers = loadout (gear, passives) + level stats. */
function rebuildModifiers(player: PlayerState, rules: ProgressionRules): void {
  player.levelModifiers = levelModifiers(player.level, rules);
  player.modifiers = [...player.gearModifiers, ...player.levelModifiers];
}

type Pool = 'life' | 'energyShield';

/** Current fill of each pool as a fraction of its max, taken before a loadout / mechanic change. */
interface PoolSnapshot {
  readonly main: Pool;
  /** Fraction of the main pool (life, or ES under lifeToEnergyShield). */
  readonly mainFraction: number;
  /** Under lifeToEnergyShield: (ES + life) / (maxES + maxLife); otherwise the life fraction. */
  readonly survivalFraction: number;
  readonly energyShield: number;
  readonly resource: number;
}

/** Fraction of a pool; a pool with max 0 counts as `ifEmpty` (it starts there and regenerates). */
function fraction(value: number, max: number, ifEmpty: number): number {
  return max > 0 ? clamp(value / max, 0, 1) : ifEmpty;
}

function snapshotPools(classDef: ClassDef, player: PlayerState): PoolSnapshot {
  const main = lifeRecoveryPool(player.mechanics);
  const maxLife = playerStat(classDef, player, 'life');
  const maxShield = playerStat(classDef, player, 'energyShield');
  const maxResource = playerStat(classDef, player, 'resource');
  const lifeFraction = fraction(player.life, maxLife, 1);
  return {
    main,
    // The main pool keeps the hero alive: a 0-max main pool counts as full rather than killing on the swap.
    mainFraction: main === 'life' ? lifeFraction : fraction(player.energyShield, maxShield, 1),
    survivalFraction: main === 'life' ? lifeFraction : fraction(player.energyShield + player.life, maxShield + maxLife, 1),
    energyShield: fraction(player.energyShield, maxShield, 0),
    resource: fraction(player.resource, maxResource, 0),
  };
}

/**
 * Re-applies pool fractions after the maximums changed (designer decision: fill fractions are kept).
 * - The main pool gets the old main pool's fraction, even if the main pool itself switched
 *   (taking Crystal Shell at 40% life gives 40% ES; removing it at 40% ES gives 40% life).
 * - Leaving lifeToEnergyShield, the fixed life counts as part of the old pool: (ES + life) / (maxES + maxLife).
 *   Otherwise a hero alive at 0 ES / 1 life would get 0 life without dying.
 * - Under lifeToEnergyShield life is always at its fixed max.
 * - Secondary ES (no lifeToEnergyShield) and the class resource keep their own fractions (Rage too; designer decision
 *   2026-10-22). A pool whose old max was 0
 *   (no ES before; resource under bloodMagic) starts at 0 and regenerates, so a swap never refills a pool.
 */
function restorePools(classDef: ClassDef, player: PlayerState, before: PoolSnapshot): void {
  const maxLife = playerStat(classDef, player, 'life');
  const maxShield = playerStat(classDef, player, 'energyShield');
  const maxResource = playerStat(classDef, player, 'resource');
  if (lifeRecoveryPool(player.mechanics) === 'energyShield') {
    player.life = maxLife;
    player.energyShield = before.mainFraction * maxShield;
  } else {
    player.life = before.survivalFraction * maxLife;
    player.energyShield = before.energyShield * maxShield;
  }
  player.resource = before.resource * maxResource;
}

/**
 * Grants XP for a kill (mob base XP): hero XP (each level-up rebuilds level stats, fully restores life and shield
 * and applies the resource level-up rule) and skill XP (gainSkillXp).
 */
export function gainKillXp(ctx: Ctx, baseXp: number): void {
  gainSkillXp(ctx, baseXp);
  gainHeroXp(ctx, baseXp);
}

/**
 * Skill XP for a kill: every class skill (all are on the bar) gets skillKillXp(baseXp), whatever killed the mob
 * (basic attack included; the basic attack itself has no level). Each skill level gained emits 'skillLevelUp';
 * the effective actions are then rebuilt from the next use, like a passive change mid-run (running cooldowns keep
 * their time, charges follow via syncCharges, flying projectiles / traps / a running dash keep their snapshot).
 * Pools are not touched.
 */
function gainSkillXp(ctx: Ctx, baseXp: number): void {
  const { world, content, classDef, events } = ctx;
  const data = content.skillLevels;
  if (!data) return;
  const amount = skillKillXp(baseXp, data.rules);
  if (amount <= 0) return;
  const player = world.player;
  world.skillXpGained += amount;
  let changed = false;
  for (const skill of classDef.skills) {
    const progress = (player.skillProgress[skill.id] ??= newSkillProgress());
    const before = progress.level;
    if (grantSkillXp(progress, amount, data.rules) === 0) continue;
    changed = true;
    for (let level = before + 1; level <= progress.level; level++) events.push({ type: 'skillLevelUp', skillId: skill.id, level });
  }
  if (!changed) return;
  Object.assign(player, deriveFromMechanics(content, classDef, player));
  syncCharges(player, false);
}

function gainHeroXp(ctx: Ctx, baseXp: number): void {
  const { world, content, classDef, events } = ctx;
  const player = world.player;
  const rules = content.progression;
  if (player.level >= rules.maxLevel) return;
  const amount = mobXp(baseXp, world.areaLevel, rules) * areaXpMultiplier(player.level, world.areaLevel, rules);
  world.xpGained += amount;
  if (grantXp(player, amount, rules) === 0) return;
  rebuildModifiers(player, rules);
  levelUpPools(classDef, player);
  events.push({ type: 'levelUp', level: player.level });
}

/**
 * Replaces the loadout mid-run (e.g. passives allocated while the tree is open in combat).
 * `mechanics` (passive tree mechanics, see heroMechanics) are replaced only when given.
 * Life / shield / resource keep their fill fractions of the new maximums (see restorePools); this never refills.
 * Level-ups do not go through here: they restore the pools (levelUpPools) (gainKillXp, docs/design/progression.md).
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
    // Charges follow too (syncCharges: stored charges are kept / capped, running recharges keep their time).
    Object.assign(player, deriveFromMechanics(content, classDef, player));
    syncCharges(player, false);
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
 * `actionLeech`: the hit's own leech fraction (ActionDef.leech, Vampirism support), added to the mechanics' fraction.
 * The per-second cap comes from the lifeLeech mechanics only; without one, action leech is uncapped.
 */
// Designer decision: Vampirism (support) leech is uncapped without the lifeLeech keystone; with it, shares its cap.
export function applyLeech(classDef: ClassDef, player: PlayerState, damage: number, actionLeech = 0): number {
  const mechanic = leechStats(player.mechanics);
  const fraction = (mechanic?.fraction ?? 0) + Math.max(0, actionLeech);
  if (fraction <= 0 || player.dead || damage <= 0) return 0;
  const room = Math.max(0, leechCap(classDef, player, mechanic?.maxPerSecond ?? Infinity) - player.leechRecent);
  const restored = recoverLife(classDef, player, Math.min(damage * fraction, room));
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

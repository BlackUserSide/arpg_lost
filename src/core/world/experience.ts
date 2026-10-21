import { clamp } from '../math';
import { areaXpMultiplier, grantXp, levelModifiers, mobXp, type ProgressionRules } from '../progression/levels';
import type { Modifier } from '../stats/types';
import type { ClassDef, Content } from './content';
import { getClass, playerStat, type Ctx, type PlayerState, type WorldState } from './state';

export function refillPools(classDef: ClassDef, player: PlayerState): void {
  player.life = playerStat(classDef, player, 'life');
  player.energyShield = playerStat(classDef, player, 'energyShield');
  player.mana = playerStat(classDef, player, 'mana');
}

/** Permanent modifiers = loadout (gear, passives) + level stats. */
function rebuildModifiers(player: PlayerState, rules: ProgressionRules): void {
  player.modifiers = [...player.gearModifiers, ...levelModifiers(player.level, rules)];
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
 * Replaces the loadout modifiers mid-run (e.g. passives allocated while the tree is open in combat).
 * Current life / shield / mana keep their values, clamped to the new maximums.
 */
export function setLoadoutModifiers(world: WorldState, content: Content, modifiers: readonly Modifier[]): void {
  const player = world.player;
  const classDef = getClass(content, player.classId);
  player.gearModifiers = [...modifiers];
  rebuildModifiers(player, content.progression);
  player.life = clamp(player.life, 0, playerStat(classDef, player, 'life'));
  player.energyShield = clamp(player.energyShield, 0, playerStat(classDef, player, 'energyShield'));
  player.mana = clamp(player.mana, 0, playerStat(classDef, player, 'mana'));
}

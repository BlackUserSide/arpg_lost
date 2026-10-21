import { areaXpMultiplier, grantXp, levelModifiers, mobXp } from '../progression/levels';
import type { ClassDef } from './content';
import { playerStat, type Ctx, type PlayerState } from './state';

export function refillPools(classDef: ClassDef, player: PlayerState): void {
  player.life = playerStat(classDef, player, 'life');
  player.energyShield = playerStat(classDef, player, 'energyShield');
  player.mana = playerStat(classDef, player, 'mana');
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
  player.modifiers = [...player.gearModifiers, ...levelModifiers(player.level, rules)];
  refillPools(classDef, player);
  events.push({ type: 'levelUp', level: player.level });
}

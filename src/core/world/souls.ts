// Souls (legendary Devourer's Crown, docs/design/items.md; the souls PassiveMechanic): kills fill a counter, a full
// counter gives the next fitting skill use a guaranteed free echo. Pure functions over plain world data.
//
// - gainSoul (removeDeadMobs): +1 per non-minion death, whatever killed it (hero hit, ignite, explosion, zone).
// - soulEchoDelay (performAction): at the cap, a use fitting the mechanic's echoFor queues a PendingEcho with
//   `souls` set; while one is queued no other use takes the souls.
// - spendSouls (updateEchoes): firing that echo resets the counter to 0.
// The "no souls" cost is a plain conditionalModifiers mechanic (condition soulsAtMost) in the item data.

import { fitsCompatibility } from '../supports/rules';
import type { ActionDef } from './content';
import { findMechanic } from './passiveEffects';
import type { Ctx, MobState, PlayerState } from './state';

/** A dead mob gives a soul: only with the souls mechanic, never for minions, never above its max ('soulGain'). */
export function gainSoul(ctx: Ctx, mob: MobState): void {
  if (mob.summonerId !== undefined) return;
  const player = ctx.world.player;
  const souls = findMechanic(player.mechanics, 'souls');
  if (!souls || player.souls >= souls.max) return;
  player.souls = Math.min(souls.max, player.souls + 1);
  ctx.events.push({ type: 'soulGain', mobId: mob.id, pos: mob.pos, souls: player.souls });
}

/**
 * The delay of the guaranteed souls echo this use of `action` takes, or undefined: the hero has the souls mechanic,
 * holds its max, no souls echo is already queued, and the effective action fits the mechanic's echoFor rules.
 */
export function soulEchoDelay(player: PlayerState, action: ActionDef): number | undefined {
  const souls = findMechanic(player.mechanics, 'souls');
  if (!souls || player.souls < souls.max) return undefined;
  if (player.echoes.some((e) => e.souls === true)) return undefined;
  return fitsCompatibility(souls.echoFor, action) ? souls.echoDelay : undefined;
}

/** The souls echo fired: the souls are spent. */
export function spendSouls(player: PlayerState): void {
  player.souls = 0;
}

/** Max souls of the hero's souls mechanic, or undefined without one (render: show the souls counter only then). */
export function soulsMax(player: Pick<PlayerState, 'mechanics'>): number | undefined {
  return findMechanic(player.mechanics, 'souls')?.max;
}

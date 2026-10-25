// Hero death and cheat death (legendary Clock of the Last Moment, docs/design/items.md; the cheatDeath PassiveMechanic;
// designer defaults in docs/design/overnight-questions.md «Пакет 6»). Pure functions over plain world data.
//
// - killHero: every place where the hero's life + ES pool reaches 0 (damagePlayer, tickHeroIgnite) calls it. With a
//   ready cheatDeath the hero lives on at its `life` (ES stays as the hit left it: empty), the hero's ignite is
//   cleared, time stops for the enemies (WorldState.timeStop) and the mechanic recharges; otherwise the hero dies.
//   Under Crystal Shell (max life 1) the pool is ES + 1 life, so the same rule holds: the hero keeps 1 life, 0 ES.
// - timeStopped: the systems that freeze during a stop check it live (updateMobs, mob projectiles, hostile zones,
//   spawners), so a stop that starts mid-step already freezes the rest of that step (no second hit in the same step).
// - advanceTimeStop / tickCheatDeathCooldown: the two timers, on world time (cooldown recovery does not apply).

import { findMechanic, type MechanicOf } from './passiveEffects';
import { playerStat, type Ctx, type PlayerState, type WorldState } from './state';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** True while the enemies' time stands still (a cheatDeath time stop is running). */
export function timeStopped(world: Pick<WorldState, 'timeStop'>): boolean {
  return world.timeStop > 0;
}

/** The hero's cheatDeath mechanic, or undefined without one (render: show the clock on the HUD only then). */
export function cheatDeathStats(player: Pick<PlayerState, 'mechanics'>): MechanicOf<'cheatDeath'> | undefined {
  return findMechanic(player.mechanics, 'cheatDeath');
}

/** True if cheatDeath would save the hero from a lethal hit right now. */
export function cheatDeathReady(player: Pick<PlayerState, 'mechanics' | 'cheatDeathCooldown'>): boolean {
  return cheatDeathStats(player) !== undefined && player.cheatDeathCooldown <= 0;
}

/**
 * The hero's life + ES pool reached 0 (the caller already applied the damage and pushed its 'hit' / 'dot' event).
 * The hero's ignite is cleared either way. A ready cheatDeath: life = min(its life, max life), time stop
 * (max of a running one and its stopDuration), cooldown restarts, 'cheatDeath' event; returns false (alive).
 * Otherwise: the hero dies (motion cancelled, 'playerDeath'); returns true.
 */
export function killHero(ctx: Ctx): boolean {
  const { world, events, classDef } = ctx;
  const player = world.player;
  player.ignite = 0;
  player.igniteDps = 0;
  const cheat = cheatDeathStats(player);
  if (cheat && player.cheatDeathCooldown <= 0) {
    const life = Math.min(cheat.life, playerStat(classDef, player, 'life'));
    if (life > 0) {
      player.life = life;
      world.timeStop = Math.max(world.timeStop, cheat.stopDuration);
      player.cheatDeathCooldown = cheat.cooldown;
      events.push({ type: 'cheatDeath', pos: player.pos, stopDuration: cheat.stopDuration, cooldown: cheat.cooldown });
      return false;
    }
  }
  player.dead = true;
  player.motion = undefined;
  events.push({ type: 'playerDeath' });
  return true;
}

/** Runs the time stop down by dt at the start of a step; 'timeStopEnd' in the step it runs out (enemies act again). */
export function advanceTimeStop(ctx: Ctx, dt: number): void {
  const world = ctx.world;
  if (world.timeStop <= 0) return;
  world.timeStop = world.timeStop - dt > TIME_EPSILON ? world.timeStop - dt : 0;
  if (world.timeStop === 0) ctx.events.push({ type: 'timeStopEnd' });
}

/** Runs the cheatDeath recharge down by dt (plain world time, also during a time stop). */
export function tickCheatDeathCooldown(player: PlayerState, dt: number): void {
  if (player.cheatDeathCooldown <= 0) return;
  player.cheatDeathCooldown = player.cheatDeathCooldown - dt > TIME_EPSILON ? player.cheatDeathCooldown - dt : 0;
}

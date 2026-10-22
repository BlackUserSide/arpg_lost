// Skill charges (generic; first user: «Мінне поле», trap charges). An action with charges > 1 stores up to that
// many uses; each use spends one; while not full, charges recharge one at a time (sequentially, the standard ARPG
// rule), each over the action's effective cooldown, scaled by cooldown recovery like any cooldown.
// Single-charge actions keep the plain cooldown model (PlayerState.cooldowns only).
// State is plain JSON on PlayerState: charges[id] (stored) and cooldowns[id] (time to the next charge).

import type { ActionDef } from './content';
import type { PlayerState } from './state';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** Max stored uses of the action: ActionDef.charges (whole, at least 1); 1 for actions without a cooldown. */
export function maxCharges(action: ActionDef): number {
  if (action.cooldown <= 0) return 1;
  return Math.max(1, Math.floor(action.charges ?? 1));
}

/** Charges the hero can spend now (0 or 1 for single-charge actions). */
export function availableCharges(player: PlayerState, action: ActionDef): number {
  const max = maxCharges(action);
  if (max > 1) return player.charges[action.id] ?? max;
  return (player.cooldowns[action.id] ?? 0) > 0 ? 0 : 1;
}

/** True if the action is off cooldown / has a charge (cost is checked separately, see canAfford). */
export function actionReady(player: PlayerState, action: ActionDef): boolean {
  return availableCharges(player, action) > 0;
}

/** For the HUD: stored / max charges and the time until the next one (cooldowns[id]; 0 when full or ready). */
export interface ChargeInfo {
  readonly charges: number;
  readonly max: number;
  readonly recharge: number;
}

export function chargeInfo(player: PlayerState, action: ActionDef): ChargeInfo {
  return { charges: availableCharges(player, action), max: maxCharges(action), recharge: player.cooldowns[action.id] ?? 0 };
}

/**
 * Spends one use. Single charge: the cooldown starts. Several charges: one is spent and, if no recharge was
 * running (the action was full), the recharge of the next charge starts; a running recharge is not reset.
 */
export function spendCharge(player: PlayerState, action: ActionDef): void {
  if (action.cooldown <= 0) return;
  const max = maxCharges(action);
  if (max <= 1) {
    player.cooldowns[action.id] = action.cooldown;
    return;
  }
  player.charges[action.id] = Math.max(0, (player.charges[action.id] ?? max) - 1);
  if ((player.cooldowns[action.id] ?? 0) <= 0) player.cooldowns[action.id] = action.cooldown;
}

/**
 * Advances every running cooldown by dt × recovery. A multi-charge recharge that ends restores one charge and the
 * next recharge (current effective cooldown) starts with the leftover time carried over, so recharging is exact
 * and frame-rate independent; at full charges the timer stays 0.
 */
export function tickCooldowns(player: PlayerState, dt: number, recovery: number): void {
  const { basicAttack, skills } = player.actions;
  for (const id of Object.keys(player.cooldowns)) {
    const remaining = player.cooldowns[id] ?? 0;
    const action = basicAttack.id === id ? basicAttack : skills.find((a) => a.id === id);
    const max = action ? maxCharges(action) : 1;
    if (!action || max <= 1) {
      player.cooldowns[id] = Math.max(0, remaining - dt * recovery);
      continue;
    }
    let charges = player.charges[id] ?? max;
    if (charges >= max) {
      player.cooldowns[id] = 0;
      continue;
    }
    let t = remaining - dt * recovery;
    while (charges < max && t <= TIME_EPSILON) {
      charges++;
      t = charges < max ? t + action.cooldown : 0;
    }
    player.charges[id] = charges;
    player.cooldowns[id] = Math.max(0, t);
  }
}

/**
 * Brings charge state in line with the effective actions (spawn, loadout change). `spawn`: every multi-charge
 * action starts full. Mid-run (passives changed in combat), running timers keep their remaining time (designer
 * decision 2026-10-22 for cooldowns):
 * - gaining charges: the hero keeps what they had (a ready skill = 1 charge, one on cooldown = 0) and the recharge
 *   of the next charge starts now if none was running;
 * - fewer max charges: stored charges are capped;
 * - back to a single charge: a stored charge makes the skill ready, otherwise the running timer continues.
 * Mid-run gain of charges keeps current charges and starts recharging, no instant refill (designer decision 2026-10-22).
 */
export function syncCharges(player: PlayerState, spawn: boolean): void {
  const { basicAttack, skills } = player.actions;
  for (const action of [basicAttack, ...skills]) {
    const id = action.id;
    const max = maxCharges(action);
    const stored = player.charges[id];
    if (max <= 1) {
      if (stored === undefined) continue;
      if (stored >= 1) player.cooldowns[id] = 0;
      delete player.charges[id];
      continue;
    }
    const running = (player.cooldowns[id] ?? 0) > 0;
    const charges = stored !== undefined ? Math.min(stored, max) : spawn ? max : running ? 0 : 1;
    player.charges[id] = charges;
    if (charges >= max) player.cooldowns[id] = 0;
    else if (!running) player.cooldowns[id] = action.cooldown;
  }
}

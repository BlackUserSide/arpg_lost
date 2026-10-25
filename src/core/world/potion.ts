// Life potion (docs/design/combat.md, decision 2026-10-26; numbers in Content.lifePotion). Pure functions over plain
// world data.
//
// - newPotion (createWorld): every run / arena starts with full charges. The state lives in the world, so it carries
//   across the rooms of a map run and is gone with the run.
// - updatePotion (updatePlayer, every step the hero is alive, also during a time stop): a potion press (edge, see
//   PotionState.held) drinks one charge; then the running heals restore their share of this step.
//   Heal = healFraction × max of the life recovery pool (ES under lifeToEnergyShield) × lifePotionMultiplier
//   (Bloodsucker), fixed at the drink and spread evenly over `duration`; it goes through recoverLife.
// - gainPotionPoints (removeDeadMobs): non-minion kills give points by rank, every pointsPerCharge points a charge.

import { recoverLife } from './experience';
import { lifePotionMultiplier, lifeRecoveryPool } from './passiveEffects';
import { playerStat, type Ctx, type PlayerState, type PotionState } from './state';
import type { ClassDef, Content, MobRank } from './content';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** Potion state at run start: full charges (0 without Content.lifePotion). */
export function newPotion(content: Content): PotionState {
  return { charges: content.lifePotion?.maxCharges ?? 0, points: 0, heals: [], held: false };
}

/**
 * The heal one drink would give now (pool points; life, or ES under lifeToEnergyShield), or 0 without a potion.
 * Render: the potion tooltip.
 */
export function potionHealAmount(content: Content, classDef: ClassDef, player: PlayerState): number {
  const def = content.lifePotion;
  if (!def) return 0;
  const max = playerStat(classDef, player, lifeRecoveryPool(player.mechanics));
  return def.healFraction * max * lifePotionMultiplier(player.mechanics);
}

/**
 * The potion's step: drink on a press, then tick the running heals by `dt`.
 * Drinking needs a charge ('potionDenied' empty) and a recovery pool that is not full ('potionDenied' full); a drink
 * while another heal runs adds a new heal next to it (the amounts add up, each over its own duration).
 * Drinking takes no action time: it works while attacking, casting or dashing.
 */
export function updatePotion(ctx: Ctx, dt: number): void {
  const { world, content, classDef, events, input } = ctx;
  const player = world.player;
  const potion = player.potion;
  const pressed = input.potion === true;
  const press = pressed && !potion.held;
  potion.held = pressed;
  const def = content.lifePotion;
  if (press && def) {
    const pool = lifeRecoveryPool(player.mechanics);
    if (potion.charges <= 0) events.push({ type: 'potionDenied', reason: 'empty' });
    else if (player[pool] >= playerStat(classDef, player, pool)) events.push({ type: 'potionDenied', reason: 'full' });
    else {
      potion.charges--;
      const amount = potionHealAmount(content, classDef, player);
      potion.heals.push({ amount, time: def.duration });
      events.push({ type: 'potionDrink', amount, duration: def.duration, charges: potion.charges, pos: player.pos });
    }
  }
  tickPotionHeals(ctx, dt);
}

/** Restores this step's share of every running heal (the last step of a heal gives exactly what is left). */
function tickPotionHeals(ctx: Ctx, dt: number): void {
  const player = ctx.world.player;
  const potion = player.potion;
  if (potion.heals.length === 0) return;
  let total = 0;
  for (const heal of potion.heals) {
    const share = heal.time - dt <= TIME_EPSILON ? heal.amount : (heal.amount * dt) / heal.time;
    total += share;
    heal.amount -= share;
    heal.time -= dt;
  }
  potion.heals = potion.heals.filter((h) => h.time > TIME_EPSILON);
  // Heal over the pool max is lost (like regeneration).
  recoverLife(ctx.classDef, player, total);
}

/**
 * A non-minion kill of `rank`: its kill points (LifePotionDef.killPoints) go towards charges. Every pointsPerCharge
 * points make a charge ('potionCharge'); leftover points carry over; at max charges points are dropped (none banked).
 */
export function gainPotionPoints(ctx: Ctx, rank: MobRank): void {
  const def = ctx.content.lifePotion;
  if (!def) return;
  const potion = ctx.world.player.potion;
  if (potion.charges >= def.maxCharges) return;
  potion.points += def.killPoints[rank];
  while (potion.points >= def.pointsPerCharge && potion.charges < def.maxCharges) {
    potion.points -= def.pointsPerCharge;
    potion.charges++;
    ctx.events.push({ type: 'potionCharge', charges: potion.charges });
  }
  if (potion.charges >= def.maxCharges) potion.points = 0;
}

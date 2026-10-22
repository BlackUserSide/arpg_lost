// Class resource runtime (docs/design/classes.md, «Ресурс класу»): Rage / Energy / Mana, all driven by
// ClassDef.resource (ResourceDef) plus the `resource` / `resourceRegen` stats. Pure functions over plain player data.
//
// - Spawn fill: startFraction × max (Rage starts empty, Energy / Mana full).
// - Level-up: refill to max, or keep the current amount (refillOnLevelUp).
// - Regeneration: resourceRegen per second; with regenOnlyInCombat only while in combat (Rage: base regen 0).
// - onHit: + amount per enemy hit by counting actions, at most maxHitsPerUse hits per use.
// - onDamageTaken: + perPoolFraction × (life + ES lost) / (max life + max ES).
// - decay: − perSecond once the hero has neither dealt nor taken a hit for `delay` seconds (combatIdle).
// Under bloodMagic max resource is 0, so gains and regen do nothing (the warrior gains no Rage).

import { clamp } from '../math';
import type { ActionDef, ClassDef, ResourceHitGain } from './content';
import { playerStat, type PlayerState } from './state';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** Max resource of the hero now (0 under bloodMagic). */
export function maxResource(classDef: ClassDef, player: PlayerState): number {
  return playerStat(classDef, player, 'resource');
}

/**
 * Adds resource (gains, resource potions), capped at max; a pool above max (max just dropped) is never lowered.
 * Does nothing for a dead hero or under bloodMagic (max 0). Returns the amount actually added.
 */
export function recoverResource(classDef: ClassDef, player: PlayerState, amount: number): number {
  if (player.dead || amount <= 0) return 0;
  const before = player.resource;
  player.resource = clamp(before + amount, 0, Math.max(before, maxResource(classDef, player)));
  return player.resource - before;
}

/** Resource at run start: startFraction of max. */
export function spawnResource(classDef: ClassDef, player: PlayerState): number {
  return clamp(classDef.resource.startFraction, 0, 1) * maxResource(classDef, player);
}

/** Resource right after a level-up (the new max is already in place): max, or the current amount capped at max. */
export function levelUpResource(classDef: ClassDef, player: PlayerState): number {
  const max = maxResource(classDef, player);
  return classDef.resource.refillOnLevelUp ? max : clamp(player.resource, 0, max);
}

/**
 * True while the hero counts as in combat: a hit was dealt or taken less than decay.delay seconds ago
 * (combatIdle). A resource without decay has no out-of-combat state and is always "in combat".
 */
export function inCombat(classDef: ClassDef, player: PlayerState): boolean {
  const decay = classDef.resource.decay;
  return !decay || player.combatIdle + TIME_EPSILON < decay.delay;
}

/** combatIdle at run start: out of combat (the decay delay has already passed), so nothing regenerates in combat only. */
export function spawnCombatIdle(classDef: ClassDef): number {
  return combatIdleCap(classDef);
}

/**
 * combatIdle never grows past this: the decay delay (0 without decay). Past the delay its exact value no longer
 * matters (out of combat either way), and the cap keeps the number bounded in long runs and saves.
 */
export function combatIdleCap(classDef: ClassDef): number {
  return classDef.resource.decay?.delay ?? 0;
}

/** Advances combatIdle by one step, capped at combatIdleCap. */
export function advanceCombatIdle(classDef: ClassDef, player: PlayerState, dt: number): void {
  player.combatIdle = Math.min(player.combatIdle + dt, combatIdleCap(classDef));
}

/**
 * One step of regeneration and decay. Call after combatIdle has advanced by `dt`.
 * - In combat: resourceRegen applies.
 * - Out of combat (combatIdle reached decay.delay): decay drains; regen applies too unless regenOnlyInCombat.
 * The result stays within [0, max].
 */
// Designer decision 2026-10-22: Rage regenerates (resourceRegen from gear / passives) only in combat; out of
// combat it only decays. Rage max is fixed at 100 (no per-level resource).
export function tickResource(classDef: ClassDef, player: PlayerState, dt: number): void {
  const def = classDef.resource;
  const fighting = inCombat(classDef, player);
  let value = player.resource;
  if (fighting || !def.regenOnlyInCombat) value += playerStat(classDef, player, 'resourceRegen') * dt;
  if (def.decay && !fighting) value -= def.decay.perSecond * dt;
  player.resource = clamp(value, 0, maxResource(classDef, player));
}

function countsForHitGain(gain: ResourceHitGain, player: PlayerState, action: ActionDef): boolean {
  return gain.source === 'anyAction' || action.id === player.actions.basicAttack.id;
}

/** The hero starts using `action` (a cast, or a counter-attack): a counting action restarts the per-use hit cap. */
export function startResourceUse(classDef: ClassDef, player: PlayerState, action: ActionDef): void {
  const gain = classDef.resource.onHit;
  if (gain && countsForHitGain(gain, player, action)) player.resourceHits = 0;
}

/**
 * The hero dealt a damage hit with `action`: the hero is in combat again (combatIdle = 0) and a counting action
 * grants onHit resource while the per-use cap allows. Returns the resource gained.
 */
// Designer decision 2026-10-22: Rage per hit counts each target, capped per swing (maxHitsPerUse); counter-attacks
// (they reuse the basic attack) generate Rage too.
// Designer decision 2026-10-22: the per-use count restarts on the next use of a counting action; a slow projectile
// that lands after the next basic attack started counts towards the new use.
export function resourceOnHeroHit(classDef: ClassDef, player: PlayerState, action: ActionDef): number {
  player.combatIdle = 0;
  const gain = classDef.resource.onHit;
  if (!gain || !countsForHitGain(gain, player, action) || player.resourceHits >= gain.maxHitsPerUse) return 0;
  player.resourceHits += 1;
  return recoverResource(classDef, player, gain.amount);
}

/**
 * A mob hit landed on the hero (also when the shield absorbed it all) and the hero survived: combatIdle = 0 and
 * onDamageTaken grants resource for `lost` (life + energy shield removed by the hit). Returns the resource gained.
 */
// Designer decision 2026-10-22: Rage from damage taken is proportional to the share of (max life + max ES) lost, the same
// with or without Crystal Shell.
export function resourceOnHeroHitTaken(classDef: ClassDef, player: PlayerState, lost: number): number {
  player.combatIdle = 0;
  const gain = classDef.resource.onDamageTaken;
  if (!gain || lost <= 0) return 0;
  const maxPool = playerStat(classDef, player, 'life') + playerStat(classDef, player, 'energyShield');
  if (maxPool <= 0) return 0;
  return recoverResource(classDef, player, (lost / maxPool) * gain.perPoolFraction);
}

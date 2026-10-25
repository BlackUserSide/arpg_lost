// Elite modifiers (docs/design/mobs.md «Еліти», decisions 2026-10-25): every elite of a map run carries exactly one
// (MobState.eliteModifier), rolled by the run from RunRules.elites.modifiers; the def (EliteModifierDef in
// Content.eliteModifiers) combines generic effects, so new modifiers are data:
// - life: × life at spawn (spawnMob), on top of the rank and area level scaling («Товстий»).
// - moveSpeed / actionSpeed: faster walking, basic attack timer, ability cooldowns and recovery; wind-ups (telegraphs)
//   keep their length («Швидкий»).
// - damageConversion + onHitHero: every hostile hit of the mob (melee, projectiles, ability projectiles / novas / its
//   hostile zones) is converted after rolling and may put a status on the hero; hero ignite lives here («Вогняний»).
// - deathZone: a telegraphed hostile zone where it died that erupts after a delay («Вибуховий»).
// Bosses and minions never carry a modifier; a summoner's modifier is not passed to its minions.

import { applyDamageTaken, totalDamage, type DamageByType } from '../combat/damage';
import { applyDamage } from '../combat/hit';
import { resistanceMultiplier } from '../combat/mitigation';
import type { Content, EliteModifierDef, MobDef } from './content';
import { allModifiers, playerStat, PLAYER_ID, type Ctx, type HostileZone, type MobState } from './state';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** The def of an elite modifier id; undefined for no id. Throws on an id the content does not define. */
export function eliteModifierDef(content: Content, id: string | undefined): EliteModifierDef | undefined {
  if (id === undefined) return undefined;
  const def = content.eliteModifiers?.[id];
  if (!def) throw new Error(`Unknown elite modifier: ${id}`);
  return def;
}

/** Multiplier on the mob's movement speed from its elite modifier (1 without one). */
export function mobMoveSpeedMultiplier(content: Content, mob: Pick<MobState, 'eliteModifier'>): number {
  return eliteModifierDef(content, mob.eliteModifier)?.moveSpeed ?? 1;
}

/**
 * Multiplier on how fast the mob's basic attack timer, ability cooldowns and ability recovery run (1 without a
 * modifier). Wind-ups are not affected.
 */
export function mobActionSpeedMultiplier(content: Content, mob: Pick<MobState, 'eliteModifier'>): number {
  return eliteModifierDef(content, mob.eliteModifier)?.actionSpeed ?? 1;
}

/** Movement speed of a mob now, before slows: MobDef.moveSpeed × its elite modifier's moveSpeed. */
export function mobMoveSpeed(content: Content, def: MobDef, mob: Pick<MobState, 'eliteModifier'>): number {
  return def.moveSpeed * mobMoveSpeedMultiplier(content, mob);
}

/**
 * After a hostile hit landed on the hero (and they survived it): the source's onHitHero statuses, in data order.
 * `raw`: the hit's damage after crit and conversion, before the hero's defences. A status with a chance draws one
 * rng number; guaranteed ones draw none (mobs without a modifier never draw).
 */
export function applyHeroStatuses(ctx: Ctx, def: EliteModifierDef, raw: DamageByType): void {
  for (const effect of def.onHitHero ?? []) {
    if (effect.chance !== undefined && !ctx.rng.chance(effect.chance)) continue;
    switch (effect.status) {
      case 'ignite':
        applyHeroIgnite(ctx, totalDamage(raw) * effect.magnitude, effect.duration);
        break;
    }
  }
}

/**
 * Ignites the hero (mirror of mob ignite, applyIgnite in statuses.ts): `amount` is dealt as fire over `duration`,
 * reduced by the hero's fire resistance and then by their damage taken modifiers (fire), both locked now. No
 * stacking: a new ignite replaces the current one (restarting its duration) if its damage per second is at least as
 * high; a weaker one is ignored. 'status' event with targetId PLAYER_ID.
 */
export function applyHeroIgnite(ctx: Ctx, amount: number, duration: number): void {
  const { world, content, classDef, events } = ctx;
  const player = world.player;
  if (duration <= 0 || player.dead) return;
  const resisted = amount * resistanceMultiplier(playerStat(classDef, player, 'fireResistance'), content.combat);
  const total = totalDamage(applyDamageTaken({ fire: resisted }, allModifiers(classDef, player)));
  if (total <= 0) return;
  const dps = total / duration;
  if (player.ignite > 0 && dps < player.igniteDps) return;
  player.ignite = duration;
  player.igniteDps = dps;
  events.push({ type: 'status', targetId: PLAYER_ID, pos: player.pos, status: 'ignite', duration });
}

/**
 * The hero's ignite for one fixed step: igniteDps × min(dt, remaining), energy shield first like every hero damage
 * (applyDamage), one 'dot' event (targetId PLAYER_ID). A damage over time: no crit, no resource from damage taken, no
 * combat-idle reset, no counter-attack. While invulnerable (roll) it keeps running out but deals nothing (like an
 * immune mob). Killing the hero: 'playerDeath'. Runs in updatePlayer after regeneration, so a burn applied by a
 * hit in step n first ticks in step n + 1.
 */
export function tickHeroIgnite(ctx: Ctx, dt: number): void {
  const { world, events } = ctx;
  const player = world.player;
  if (player.ignite <= 0 || player.dead) return;
  const time = Math.min(dt, player.ignite);
  if (player.invulnerable <= 0) {
    const amount = player.igniteDps * time;
    const result = applyDamage({ life: player.life, energyShield: player.energyShield }, amount);
    player.life = result.pools.life;
    player.energyShield = result.pools.energyShield;
    events.push({ type: 'dot', targetId: PLAYER_ID, pos: player.pos, amount, status: 'ignite' });
    if (result.isDead) {
      player.dead = true;
      player.motion = undefined;
      player.ignite = 0;
      player.igniteDps = 0;
      events.push({ type: 'playerDeath' });
      return;
    }
  }
  player.ignite = player.ignite - time > TIME_EPSILON ? player.ignite - time : 0;
  if (player.ignite === 0) player.igniteDps = 0;
}

/**
 * A dead mob's death zone (its elite modifier's deathZone), if any: a hostile zone at its position ('hostileZoneSpawn'
 * with source 'eliteDeath', abilityId = the modifier id) that erupts deathZone.delay seconds later for its damage ×
 * the mob's damageScale. Placed by removeDeadMobs, after this step's hostile zone update, so its timer first runs
 * next step: placed in step n, it erupts in step n + delay / dt. Returns the zone, or undefined.
 */
export function spawnDeathZone(ctx: Ctx, dead: MobState): HostileZone | undefined {
  const mod = eliteModifierDef(ctx.content, dead.eliteModifier);
  const spec = mod?.deathZone;
  if (!mod || !spec) return undefined;
  const { world, events } = ctx;
  const zone: HostileZone = {
    id: world.nextId++,
    sourceId: dead.id,
    sourceDefId: dead.defId,
    abilityId: mod.id,
    pos: dead.pos,
    radius: spec.radius,
    remaining: spec.delay,
    total: spec.delay,
    ...(dead.damageScale !== undefined ? { damageScale: dead.damageScale } : {}),
    eliteModifier: mod.id,
    source: 'eliteDeath',
    damage: spec.damage,
    critChance: spec.critChance ?? 0,
  };
  world.hostileZones.push(zone);
  events.push({
    type: 'hostileZoneSpawn',
    zoneId: zone.id,
    sourceId: dead.id,
    abilityId: mod.id,
    pos: zone.pos,
    radius: zone.radius,
    delay: spec.delay,
    source: 'eliteDeath',
    eliteModifier: mod.id,
  });
  return zone;
}

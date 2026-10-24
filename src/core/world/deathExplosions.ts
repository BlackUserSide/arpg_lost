// Death explosions (docs/design/passives-wheel.md: Погребальне вогнище, Розбиття). Hero-side only: the explosion
// hits mobs. The elite «Вибуховий» (0.4) will need a hostile-side variant (target: the hero) and an ignite strength
// owned by the explosion def instead of the hero's ignite mechanic; not implemented yet.
// Processed by removeDeadMobs: every mob that dies explodes at most once, explosion kills are queued and
// processed in the same step, so chains are deterministic and always terminate (each mob dies once).

import { mitigate } from '../combat/mitigation';
import { distance, vec } from '../math';
import type { DeathExplosionDef } from './content';
import { deathExplosionRadiusMultiplier, findMechanic, targetHasStatus } from './passiveEffects';
import { allModifiers, getMob, isImmune, type Ctx, type MobState } from './state';
import { applyIgnite, conditionTarget } from './statuses';

/**
 * Passive death explosions of a mob that just died: one per deathExplosion mechanic whose status the mob had at
 * death (statuses from the killing hit count). Radius × deathExplosionRadiusMultiplier. Returns the mobs these
 * explosions killed, in hit order.
 */
export function heroDeathExplosions(ctx: Ctx, dead: MobState): MobState[] {
  const mechanics = ctx.world.player.mechanics;
  const target = conditionTarget(dead);
  const killed: MobState[] = [];
  for (const m of mechanics) {
    if (m.kind !== 'deathExplosion' || !targetHasStatus(target, m.status)) continue;
    const radius = m.radius * deathExplosionRadiusMultiplier(mechanics);
    killed.push(...explodeOnDeath(ctx, dead, m, radius));
  }
  return killed;
}

/**
 * One death explosion centred on `dead`: lifeFraction × its max life (MobState.maxLife) as `damageType` damage to every living mob
 * within `radius` (+ their radius), closest first. Mitigated by armour / resistances; no crit, no hero damage
 * modifiers, no leech (designer decision 2026-10-22). `applyStatus` ignite uses the hero's ignite mechanic (fraction, duration,
 * igniteDamage), guaranteed; other statuses are not supported yet. Returns the mobs it killed.
 */
export function explodeOnDeath(ctx: Ctx, dead: MobState, spec: DeathExplosionDef, radius: number): MobState[] {
  const { world, content, events } = ctx;
  events.push({
    type: 'area',
    actionId: 'deathExplosion',
    origin: dead.pos,
    facing: vec(1, 0),
    radius,
    angleDeg: 360,
    source: 'deathExplosion',
    damageType: spec.damageType,
    sourceMobId: dead.id,
  });
  const amount = spec.lifeFraction * dead.maxLife;
  const targets = world.mobs
    .filter((mob) => mob.life > 0 && mob.id !== dead.id && !isImmune(mob))
    .map((mob) => ({ mob, def: getMob(content, mob.defId), dist: distance(dead.pos, mob.pos) }))
    .filter(({ mob, dist }) => dist <= radius + mob.radius)
    .sort((a, b) => a.dist - b.dist || a.mob.id - b.mob.id);

  // Only ignite can be applied by explosions; its strength comes from the hero's ignite (designer decision 2026-10-22).
  const ignite = spec.applyStatus === 'ignite' ? findMechanic(world.player.mechanics, 'ignite') : undefined;
  const mods = ignite ? allModifiers(ctx.classDef, world.player) : [];

  const killed: MobState[] = [];
  for (const { mob, def } of targets) {
    const damage = mitigate({ [spec.damageType]: amount }, { armour: def.armour, resistances: def.resistances }, content.combat);
    const total = damage[spec.damageType] ?? 0;
    if (total > 0) {
      mob.life -= total;
      events.push({ type: 'hit', targetId: mob.id, pos: mob.pos, amount: total, isCrit: false });
    }
    // igniteDamage modifiers tagged with the explosion's damage type apply (e.g. "fire").
    if (ignite) applyIgnite(ctx, mob, amount * ignite.damageFraction, ignite.duration, mods, [spec.damageType]);
    if (mob.life <= 0) killed.push(mob);
  }
  return killed;
}

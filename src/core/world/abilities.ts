// Mob abilities (MobDef.abilities): telegraphed special attacks and phases, used by the necromancer boss
// (docs/design/mobs.md «Бос») and open to any mob through data. Plain state on MobState (phase, abilityTimers,
// castRecovery, casting) and WorldState.hostileZones; pure functions over the step context.
//
// Rules:
// - A ready ability (its timer and the shared recovery at 0, unlocked by the phase, target in range, usable) starts a
//   wind-up (MobState.casting, 'mobCast'); the mob stands still and does not attack. Its cooldown starts right away.
// - The mob is busy with the ability on every step from the start through the resolve step (updateMobAbilities
//   returns true): it neither moves nor uses its basic attack, and its basic attack timer does not count down (it
//   resumes after the resolve step, during the recovery).
// - The wind-up, the cooldowns and the recovery run at the mob's speed factor (slows stretch them, like the basic
//   attack timer) and stop while the mob is disabled.
// - Stunned, frozen or pushed during a wind-up: the cast is cancelled ('mobCastInterrupted'), the cooldown stays
//   spent (designer decision 2026-10-24). For a boss only a full stun bar does this (ordinary stuns / freezes are
//   slows for bosses).
// - When the wind-up ends the ability resolves ('mobAbility') and the recovery starts. A fan flies along the direction
//   locked at the start; zones go on the target's position at resolve (designer decision 2026-10-24).
// - Phases: when life / maxLife falls to a phase's lifeBelow, the next phase starts ('mobPhase'); its abilities unlock
//   (timer = initialCooldown) and every cooldown / recovery set from then on is × its cooldownMultiplier.
//   A phase with a transition pauses the mob for exactly ceil(duration / dt) steps, the start step included, also
//   when it starts during another phase's pause (the new pause replaces the old one).

import { weightedPick } from '../items/generate';
import { add, distance, fanOffsets, normalize, rotate, scale, sub, vec, type Vec2 } from '../math';
import type { BaseDamage } from '../combat/damage';
import type { MobAbilitiesDef, MobAbilityDef, MobDef } from './content';
import { damagePlayer, spawnMob } from './mobs';
import { mobActionSpeedMultiplier } from './eliteModifiers';
import { timeStopped } from './cheatDeath';
import { alliesInside, damageAlly } from './allies';
import { clampToArena, getMob, type Ctx, type HostileZone, type MobState, type WorldState } from './state';
import type { MobTarget } from './zones';

/** Seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

const snap = (t: number): number => (t <= TIME_EPSILON ? 0 : t);

/** Ability state of a fresh mob of `def` (empty for mobs without abilities): phase 1, phase-1 timers at initialCooldown. */
export function initialAbilityState(def: MobDef): Partial<Pick<MobState, 'phase' | 'abilityTimers' | 'castRecovery'>> {
  const set = def.abilities;
  if (!set) return {};
  const abilityTimers: Record<string, number> = {};
  for (const a of set.list) if ((a.minPhase ?? 1) <= 1) abilityTimers[a.id] = a.initialCooldown ?? 0;
  return { phase: 1, abilityTimers, castRecovery: 0 };
}

export function findAbility(def: MobDef, abilityId: string): MobAbilityDef {
  const ability = def.abilities?.list.find((a) => a.id === abilityId);
  if (!ability) throw new Error(`Unknown ability ${abilityId} of mob ${def.id}`);
  return ability;
}

/** Damage of an ability's hit (abilities without damage, e.g. summons, deal none). */
export function abilityHit(def: MobDef, abilityId: string): { damage: BaseDamage; critChance: number } {
  const a = findAbility(def, abilityId);
  if (a.kind === 'summon') return { damage: {}, critChance: 0 };
  return { damage: a.damage, critChance: a.critChance ?? 0 };
}

/** Cooldown multiplier of the mob's current phase (1 in phase 1). */
export function phaseCooldownMultiplier(set: MobAbilitiesDef, phase: number): number {
  return phase > 1 ? (set.phases[phase - 2]?.cooldownMultiplier ?? 1) : 1;
}

/** Living minions raised by `summonerId`. */
export function minionCount(world: WorldState, summonerId: number): number {
  let n = 0;
  for (const m of world.mobs) if (m.summonerId === summonerId && m.life > 0) n++;
  return n;
}

/** Advances the mob's phase while its life is at or below the next threshold ('mobPhase' per phase). */
export function updateMobPhase(ctx: Ctx, mob: MobState, def: MobDef): void {
  const set = def.abilities;
  if (!set || mob.phase === undefined || mob.maxLife <= 0) return;
  const timers = (mob.abilityTimers ??= {});
  while (mob.phase - 1 < set.phases.length && mob.life / mob.maxLife <= set.phases[mob.phase - 1]!.lifeBelow) {
    const phaseDef = set.phases[mob.phase - 1]!;
    mob.phase++;
    for (const a of set.list) if ((a.minPhase ?? 1) === mob.phase) timers[a.id] = a.initialCooldown ?? 0;
    const pause = phaseDef.transition?.duration ?? 0;
    ctx.events.push({ type: 'mobPhase', id: mob.id, phase: mob.phase, pos: mob.pos, ...(pause > 0 ? { transition: pause } : {}) });
    if (pause > 0) {
      interruptCast(ctx, mob);
      mob.phaseTransition = { remaining: pause, total: pause };
    }
  }
}

/**
 * Runs the phase change pause for one step (world time). Returns true while it lasts (the mob does nothing else
 * this step); the step it ends in, the mob acts again. `started`: updateMobPhase (re)started the pause this step (a
 * new MobState.phaseTransition object); that step is its first and does not count down, also when the new pause
 * replaced one that was still running.
 */
export function updatePhaseTransition(mob: MobState, dt: number, started: boolean): boolean {
  const pause = mob.phaseTransition;
  if (!pause) return false;
  if (started) return true;
  pause.remaining = snap(pause.remaining - dt);
  if (pause.remaining > 0) return true;
  delete mob.phaseTransition;
  return false;
}

/** Cancels the mob's wind-up, if any ('mobCastInterrupted'); the cooldown stays spent. */
export function interruptCast(ctx: Ctx, mob: MobState): void {
  if (!mob.casting) return;
  ctx.events.push({ type: 'mobCastInterrupted', id: mob.id, abilityId: mob.casting.abilityId });
  delete mob.casting;
}

/**
 * One step of the mob's ability AI (the mob is able to act this step). Returns true when the mob is busy with an
 * ability this step (a wind-up started, ran or resolved): it then neither moves nor uses its basic attack, and its
 * basic attack timer does not run.
 */
export function updateMobAbilities(ctx: Ctx, mob: MobState, def: MobDef, target: MobTarget, speedFactor: number, dt: number): boolean {
  const set = def.abilities;
  if (!set) return false;
  const timers = (mob.abilityTimers ??= {});
  const tick = dt * speedFactor;
  // Fast elites (actionSpeed) cool down and recover faster; the wind-up (telegraph) keeps its length.
  const cooldownTick = tick * mobActionSpeedMultiplier(ctx.content, mob);
  for (const id of Object.keys(timers)) timers[id] = snap(timers[id]! - cooldownTick);
  mob.castRecovery = snap((mob.castRecovery ?? 0) - cooldownTick);

  const cast = mob.casting;
  if (cast) {
    cast.remaining = snap(cast.remaining - tick);
    if (cast.remaining > 0) return true;
    delete mob.casting;
    resolveAbility(ctx, mob, def, findAbility(def, cast.abilityId), cast.dir, target);
    mob.castRecovery = set.recovery * phaseCooldownMultiplier(set, mob.phase ?? 1);
    return true;
  }

  if (mob.castRecovery > 0 || ctx.world.player.dead) return false;
  const phase = mob.phase ?? 1;
  const gap = distance(target.pos, mob.pos) - target.radius - mob.radius;
  for (const a of set.list) {
    if ((a.minPhase ?? 1) > phase || (timers[a.id] ?? Infinity) > 0) continue;
    if (a.range !== undefined && gap > a.range) continue;
    if (a.kind === 'summon' && minionCount(ctx.world, mob.id) >= a.maxAlive) continue;
    startCast(ctx, mob, set, a, target);
    return true;
  }
  return false;
}

function startCast(ctx: Ctx, mob: MobState, set: MobAbilitiesDef, a: MobAbilityDef, target: MobTarget): void {
  const toTarget = normalize(sub(target.pos, mob.pos));
  const dir = toTarget.x !== 0 || toTarget.y !== 0 ? toTarget : mob.facing;
  mob.facing = dir;
  mob.abilityTimers![a.id] = a.cooldown * phaseCooldownMultiplier(set, mob.phase ?? 1);
  const radius = a.kind === 'nova' ? a.radius : undefined;
  mob.casting = {
    abilityId: a.id,
    kind: a.kind,
    remaining: a.windUp,
    total: a.windUp,
    dir,
    ...(radius !== undefined ? { radius } : {}),
  };
  ctx.events.push({
    type: 'mobCast',
    id: mob.id,
    abilityId: a.id,
    kind: a.kind,
    pos: mob.pos,
    dir,
    duration: a.windUp,
    ...(radius !== undefined ? { radius } : {}),
  });
}

function resolveAbility(ctx: Ctx, mob: MobState, def: MobDef, a: MobAbilityDef, dir: Vec2, target: MobTarget): void {
  const { world, events } = ctx;
  const base = { type: 'mobAbility' as const, id: mob.id, abilityId: a.id, kind: a.kind, pos: mob.pos };
  switch (a.kind) {
    case 'projectileFan': {
      const projectileIds: number[] = [];
      for (const offset of fanOffsets(Math.max(1, Math.floor(a.count)), a.spreadDeg)) {
        const d = rotate(dir, offset);
        const id = world.nextId++;
        projectileIds.push(id);
        world.projectiles.push({
          id,
          owner: 'mob',
          sourceId: def.id,
          abilityId: a.id,
          pos: add(mob.pos, scale(d, mob.radius)),
          dir: d,
          speed: a.speed,
          radius: a.radius,
          remaining: a.flightRange,
          travelled: 0,
          pierceLeft: 0,
          explodeRadius: 0,
          hitIds: [],
          castModifiers: [],
          ...(mob.damageScale !== undefined ? { damageScale: mob.damageScale } : {}),
          ...(mob.eliteModifier !== undefined ? { eliteModifier: mob.eliteModifier } : {}),
        });
      }
      events.push({ ...base, projectileIds });
      return;
    }
    case 'nova': {
      const player = world.player;
      const inside = !player.dead && distance(player.pos, mob.pos) <= a.radius + player.radius;
      const hit = inside && damagePlayer(ctx, a.damage, a.critChance ?? 0, { damageScale: mob.damageScale, eliteModifier: mob.eliteModifier });
      // Raised allies caught in it are hit too (own rolls, after the hero), bosses' novas included.
      for (const ally of alliesInside(world, mob.pos, a.radius)) {
        damageAlly(ctx, ally, a.damage, a.critChance ?? 0, { damageScale: mob.damageScale, eliteModifier: mob.eliteModifier });
      }
      events.push({ ...base, radius: a.radius, hit });
      return;
    }
    case 'summon': {
      const n = Math.min(Math.floor(a.count), a.maxAlive - minionCount(world, mob.id));
      const spawnedIds: number[] = [];
      if (n > 0) {
        const start = ctx.rng.next() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
          const mobId = weightedPick(ctx.rng, a.pool, (e) => e.weight)?.mobId;
          if (mobId === undefined) break;
          const angle = start + (i * Math.PI * 2) / n;
          const radius = getMob(ctx.content, mobId).radius;
          const pos = clampToArena(add(mob.pos, vec(Math.cos(angle) * a.ringRadius, Math.sin(angle) * a.ringRadius)), radius, world);
          spawnedIds.push(spawnMob(world, ctx.content, { defId: mobId, summonerId: mob.id }, pos, events).id);
        }
      }
      events.push({ ...base, spawnedIds });
      return;
    }
    case 'groundZones': {
      const zoneIds: number[] = [];
      const count = Math.max(1, Math.floor(a.count));
      for (let i = 0; i < count; i++) {
        // The target's position now, at resolve (designer decision 2026-10-24: where the hero is at the end of the
        // wind-up), not where it was when the wind-up started.
        let pos = vec(target.pos.x, target.pos.y);
        if (i > 0) {
          const angle = ctx.rng.next() * Math.PI * 2;
          const dist = ctx.rng.next() * a.scatter;
          pos = add(pos, vec(Math.cos(angle) * dist, Math.sin(angle) * dist));
        }
        // The whole circle inside the room and off the obstacles, like summoned minions.
        pos = clampToArena(pos, a.radius, world);
        const zone: HostileZone = {
          id: world.nextId++,
          sourceId: mob.id,
          sourceDefId: def.id,
          abilityId: a.id,
          pos,
          radius: a.radius,
          remaining: a.delay,
          total: a.delay,
          ...(mob.damageScale !== undefined ? { damageScale: mob.damageScale } : {}),
          ...(mob.eliteModifier !== undefined ? { eliteModifier: mob.eliteModifier } : {}),
        };
        world.hostileZones.push(zone);
        zoneIds.push(zone.id);
        events.push({
          type: 'hostileZoneSpawn',
          zoneId: zone.id,
          sourceId: mob.id,
          abilityId: a.id,
          pos,
          radius: a.radius,
          delay: a.delay,
          ...(mob.eliteModifier !== undefined ? { eliteModifier: mob.eliteModifier } : {}),
        });
      }
      events.push({ ...base, zoneIds });
      return;
    }
  }
}

/**
 * Hostile zone timers: a zone erupts when its delay has run out (a zone placed this step already counts this step's
 * dt), hitting the hero if inside (radius + hero radius), then disappears ('hostileZoneErupt'). Runs on world time:
 * neither the caster's slows nor its death or stun change it.
 */
export function updateHostileZones(ctx: Ctx, dt: number): void {
  const { world, content, events } = ctx;
  if (world.hostileZones.length === 0) return;
  const erupted: number[] = [];
  for (const zone of world.hostileZones) {
    // Time stop (cheatDeath): the zones wait; a stop started by an earlier zone this step holds the rest at once.
    if (timeStopped(world)) break;
    zone.remaining = snap(zone.remaining - dt);
    if (zone.remaining > 0) continue;
    erupted.push(zone.id);
    const player = world.player;
    const inside = !player.dead && distance(player.pos, zone.pos) <= zone.radius + player.radius;
    let hit = false;
    const allies = alliesInside(world, zone.pos, zone.radius);
    if (inside || allies.length > 0) {
      // Death zones (source 'eliteDeath') carry their own hit; ability zones use their ability's.
      const { damage, critChance } = zone.damage
        ? { damage: zone.damage, critChance: zone.critChance ?? 0 }
        : abilityHit(getMob(content, zone.sourceDefId), zone.abilityId);
      const source = { damageScale: zone.damageScale, eliteModifier: zone.eliteModifier };
      if (inside) hit = damagePlayer(ctx, damage, critChance, source);
      // Raised allies inside are hit too (own rolls, after the hero).
      for (const ally of allies) damageAlly(ctx, ally, damage, critChance, source);
    }
    events.push({
      type: 'hostileZoneErupt',
      zoneId: zone.id,
      abilityId: zone.abilityId,
      pos: zone.pos,
      radius: zone.radius,
      hit,
      ...(zone.source !== undefined ? { source: zone.source } : {}),
      ...(zone.eliteModifier !== undefined ? { eliteModifier: zone.eliteModifier } : {}),
    });
  }
  world.hostileZones = world.hostileZones.filter((z) => !erupted.includes(z.id));
}

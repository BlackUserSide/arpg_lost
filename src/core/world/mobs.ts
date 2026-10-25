import { applyDamageTaken, convertedDamage, rollBaseDamage, scaleDamage, totalDamage, type BaseDamage } from '../combat/damage';
import { initialAbilityState, interruptCast, updateMobAbilities, updateMobPhase, updatePhaseTransition } from './abilities';
import { applyDamage, resolveHit } from '../combat/hit';
import type { Defences } from '../combat/mitigation';
import { add, distance, normalize, scale, sub, vec, type Vec2 } from '../math';
import { createRng, type Rng } from '../rng';
import { rollSupportDrop } from '../supports/drops';
import type { SupportData } from '../supports/types';
import type { Content, MobDef, MobRank } from './content';
import { counterAttack } from './actions';
import { heroDeathExplosions } from './deathExplosions';
import { applyHeroStatuses, eliteModifierDef, mobActionSpeedMultiplier, mobMoveSpeed, spawnDeathZone } from './eliteModifiers';
import { gainKillXp } from './experience';
import { decayStunBar, tickBleed, tickIgnite } from './statuses';
import { resourceOnHeroHitTaken } from './resource';
import { elementalArmourEffectiveness } from './passiveEffects';
import { gainSoul } from './souls';
import { gainPotionPoints } from './potion';
import { killHero, timeStopped } from './cheatDeath';
import { mobTarget } from './zones';
import { allModifiers, clampToArena, getMob, mobRank, playerStat, type Ctx, type MobState, type WorldEvent, type WorldState } from './state';

/**
 * Every living mob for one step. During a time stop (cheatDeath, timeStopped) nothing of a mob runs: no movement,
 * attacks, casts, ability / phase timers, statuses or DoTs, no separation. A stop that starts during this loop (a mob's
 * lethal hit was cheated) freezes the mobs after it at once, so no second hit lands in the same step.
 */
export function updateMobs(ctx: Ctx, dt: number): void {
  const { world, content, events } = ctx;
  const player = world.player;
  const barStats = player.stunBarStats;
  // Index loop over the mobs alive at the start: minions raised during this step first act on the next one.
  for (let i = 0, n = world.mobs.length; i < n; i++) {
    if (timeStopped(world)) return;
    const mob = world.mobs[i]!;
    // Mobs killed earlier this step neither act nor tick: their statuses at death stay as they were.
    if (mob.life <= 0) continue;
    tickIgnite(ctx, mob, dt);
    if (mob.life <= 0) continue;
    tickBleed(ctx, mob, dt);
    if (mob.life <= 0) continue;
    const def = getMob(content, mob.defId);
    mob.slow = Math.max(0, mob.slow - dt);
    mob.freezeSlow = Math.max(0, mob.freezeSlow - dt);
    mob.stunSlow = Math.max(0, mob.stunSlow - dt);
    if (barStats) decayStunBar(mob, barStats, dt);
    const speedFactor = 1 - slowFraction(mob, content);
    // Stunned or frozen: cannot move or attack (the attack timer does not run either).
    const disabled = mob.stun > 0 || mob.freeze > 0;
    mob.stun = Math.max(0, mob.stun - dt);
    mob.freeze = Math.max(0, mob.freeze - dt);
    // Being pushed (Knockback support): the push moves the mob even while stunned; it neither walks nor attacks.
    const pushed = moveKnockback(mob, world, dt);
    if (def.abilities) {
      const pauseBefore = mob.phaseTransition;
      updateMobPhase(ctx, mob, def);
      // Phase change pause (roar): immune, no movement, attacks or casts; its first step is the one it (re)starts in
      // (a new pause object, also when it replaced a running one).
      if (updatePhaseTransition(mob, dt, mob.phaseTransition !== pauseBefore)) continue;
    }
    if (disabled || pushed) {
      // A full stun bar (bosses) or any stun / freeze / push (other mobs) cancels a wind-up; its cooldown stays spent.
      interruptCast(ctx, mob);
      continue;
    }

    // The hero, or a decoy taunting this mob (mobTarget): the mob chases and attacks it the same way.
    const target = mobTarget(world, mob, mobRank(def, mob) === 'boss');
    // Busy with an ability (its start, wind-up or resolve step): the mob stands still, does not use its basic attack,
    // and the basic attack timer waits.
    if (def.abilities && updateMobAbilities(ctx, mob, def, target, speedFactor, dt)) continue;
    // Fast elites (actionSpeed) attack more often.
    mob.attackTimer = Math.max(0, mob.attackTimer - dt * speedFactor * mobActionSpeedMultiplier(content, mob));
    const toTarget = normalize(sub(target.pos, mob.pos));
    if (toTarget.x !== 0 || toTarget.y !== 0) mob.facing = toTarget;
    const gap = distance(target.pos, mob.pos) - target.radius - mob.radius;
    const maxStep = mobMoveSpeed(content, def, mob) * speedFactor * dt;

    if (def.preferredRange !== undefined) {
      // Ranged: close in to preferred range, back off if the player gets too close.
      if (gap > def.preferredRange) mob.pos = add(mob.pos, scale(toTarget, Math.min(maxStep, gap - def.preferredRange)));
      else if (gap < def.preferredRange * 0.6) mob.pos = add(mob.pos, scale(toTarget, -maxStep));
    } else if (gap > def.attack.range * 0.8) {
      mob.pos = add(mob.pos, scale(toTarget, Math.min(maxStep, gap)));
    }

    if (gap <= def.attack.range && mob.attackTimer <= 0 && !player.dead) {
      mob.attackTimer = def.attack.interval;
      events.push({ type: 'mobAttack', id: mob.id, ...(target.decoy ? { decoyId: target.decoy.id } : {}) });
      if (def.attack.projectile) {
        world.projectiles.push({
          id: world.nextId++,
          owner: 'mob',
          sourceId: def.id,
          pos: add(mob.pos, scale(toTarget, mob.radius)),
          dir: toTarget,
          speed: def.attack.projectile.speed,
          radius: def.attack.projectile.radius,
          remaining: def.attack.range + target.radius + mob.radius,
          travelled: 0,
          pierceLeft: 0,
          explodeRadius: 0,
          hitIds: [],
          castModifiers: [],
          ...(mob.damageScale !== undefined ? { damageScale: mob.damageScale } : {}),
          ...(mob.eliteModifier !== undefined ? { eliteModifier: mob.eliteModifier } : {}),
        });
      } else if (!target.decoy) {
        // A melee swing at a decoy does nothing (it has no life): the mob just wastes its attack.
        hitPlayer(ctx, def, { damageScale: mob.damageScale, meleeAttacker: mob, eliteModifier: mob.eliteModifier });
      }
    }
  }
  if (!timeStopped(world)) separateMobs(world);
}

/** Advances a mob's knockback by one step (clamped to the arena). Returns true if it was being pushed this step. */
function moveKnockback(mob: MobState, world: WorldState, dt: number): boolean {
  const push = mob.knockback;
  if (!push) return false;
  const len = Math.min(push.speed * dt, push.remaining);
  mob.pos = clampToArena(add(mob.pos, scale(push.dir, len)), mob.radius, world);
  push.remaining -= len;
  if (push.remaining <= TIME_EPSILON) delete mob.knockback;
  return true;
}

/** Distances / seconds below this count as zero (float rounding of fixed steps); structural, not balance. */
const TIME_EPSILON = 1e-9;

/** Fraction of speed removed now: the strongest of the active slow, the trap aura slow and the boss freeze- / stun-slows (0..1). */
export function slowFraction(mob: MobState, content: Content): number {
  const slow = mob.slow > 0 ? mob.slowMagnitude : 0;
  const freezeSlow = mob.freezeSlow > 0 ? content.combat.bossFreezeSlow : 0;
  const stunSlow = mob.stunSlow > 0 ? content.combat.bossStunSlow : 0;
  return Math.min(1, Math.max(0, slow, mob.auraSlow, freezeSlow, stunSlow));
}

/** Where a hostile hit comes from (see damagePlayer). */
export interface HostileHitSource {
  /** The source's rank × area level scaling (MobState.damageScale / its snapshot); absent = 1. */
  readonly damageScale?: number | undefined;
  /** The attacking mob, for melee hits only: a melee hit the hero survives may trigger counterAttack against it. */
  readonly meleeAttacker?: MobState | undefined;
  /** The source's elite modifier (MobState.eliteModifier / its snapshot): damage conversion and hero statuses. */
  readonly eliteModifier?: string | undefined;
}

/** A mob's basic attack lands on the hero (melee, or its projectile: pass the projectile's snapshots). */
export function hitPlayer(ctx: Ctx, mobDef: MobDef, source: HostileHitSource = {}): void {
  damagePlayer(ctx, mobDef.attack.damage, mobDef.attack.critChance, source);
}

/**
 * A hostile hit on the hero: `base` rolled, × damageScale, converted by the source's elite modifier (fiery: all fire),
 * crit, mitigated by the hero's defences, then damage taken modifiers. If the hero survives: the modifier's hero
 * statuses (onHitHero, chance rolled after the hit), resource from damage taken, then counterAttack (melee).
 * Returns false when nothing landed (hero dead or invulnerable).
 */
export function damagePlayer(ctx: Ctx, base: BaseDamage, critChance: number, source: HostileHitSource = {}): boolean {
  const { world, content, classDef, rng, events } = ctx;
  const player = world.player;
  if (player.dead || player.invulnerable > 0) return false;
  const damageScale = source.damageScale ?? 1;
  const mod = eliteModifierDef(content, source.eliteModifier);
  const armour = playerStat(classDef, player, 'armour');
  const defences: Defences = {
    armour,
    elementalArmour: armour * elementalArmourEffectiveness(player.mechanics),
    resistances: {
      fire: playerStat(classDef, player, 'fireResistance'),
      cold: playerStat(classDef, player, 'coldResistance'),
      lightning: playerStat(classDef, player, 'lightningResistance'),
    },
  };
  const rolled = rollBaseDamage(rng, base);
  const scaled = damageScale === 1 ? rolled : scaleDamage(rolled, damageScale);
  // Converted after rolling, so a fiery elite draws the same numbers as its plain version.
  const damage = mod?.damageConversion ? convertedDamage(scaled, mod.damageConversion) : scaled;
  const hit = resolveHit(
    rng,
    { damage, critChance, critMultiplier: content.combat.critMultiplierBase },
    defences,
    content.combat,
  );
  // Damage taken modifiers (e.g. Glass Cannon) apply after mitigation, before the ES / life split.
  const taken = totalDamage(applyDamageTaken(hit.damage, allModifiers(classDef, player)));
  const result = applyDamage({ life: player.life, energyShield: player.energyShield }, taken);
  player.life = result.pools.life;
  player.energyShield = result.pools.energyShield;
  events.push({ type: 'hit', targetId: player.id, pos: player.pos, amount: taken, isCrit: hit.isCrit });
  if (result.isDead) {
    // Death, or a cheatDeath save (killHero). Either way the lethal hit has no after-effects: no hero statuses from
    // it (a saved hero is not set on fire again), no resource from damage taken, no counter-attack.
    killHero(ctx);
    return true;
  }
  if (mod) applyHeroStatuses(ctx, mod, hit.raw);
  resourceOnHeroHitTaken(classDef, player, result.shieldLost + result.lifeLost);
  if (source.meleeAttacker) counterAttack(ctx, source.meleeAttacker);
  return true;
}

/** Pushes overlapping mobs apart and out of the player, so crowds surround instead of stacking. */
function separateMobs(world: WorldState): void {
  const { mobs, player } = world;
  for (let i = 0; i < mobs.length; i++) {
    const a = mobs[i]!;
    const ra = a.radius;
    for (let j = i + 1; j < mobs.length; j++) {
      const b = mobs[j]!;
      const rb = b.radius;
      const d = distance(a.pos, b.pos);
      const overlap = ra + rb - d;
      if (overlap <= 0) continue;
      const dir = d > 0 ? scale(sub(b.pos, a.pos), 1 / d) : vec(1, 0);
      a.pos = sub(a.pos, scale(dir, overlap / 2));
      b.pos = add(b.pos, scale(dir, overlap / 2));
    }
    const d = distance(a.pos, player.pos);
    const overlap = ra + player.radius - d;
    if (overlap > 0) {
      const dir = d > 0 ? scale(sub(a.pos, player.pos), 1 / d) : vec(1, 0);
      a.pos = add(a.pos, scale(dir, overlap));
    }
    a.pos = clampToArena(a.pos, ra, world);
  }
}

/**
 * Removes dead mobs: kill count, death event, XP, then death explosions. Mobs killed by an explosion are queued
 * and processed in the same call (their own explosions included); every mob dies once, so chains terminate. A dead
 * summoner's living minions die with it, in the same call.
 */
export function removeDeadMobs(ctx: Ctx): void {
  const { world, events, content } = ctx;
  const queue = world.mobs.filter((mob) => mob.life <= 0);
  if (queue.length === 0) return;
  // Loot has its own seeded stream (WorldState.lootRngState): drops never shift combat rolls.
  const loot = content.supports ? createRng(world.lootRngState) : undefined;
  for (let i = 0; i < queue.length; i++) {
    const mob = queue[i]!;
    const def = getMob(content, mob.defId);
    events.push({ type: 'death', id: mob.id, pos: mob.pos });
    // Minions (summonerId) give nothing: no kill count, XP or supports (designer decision 2026-10-24). Death
    // explosions are combat, not a reward: they still happen.
    if (mob.summonerId === undefined) {
      world.kills++;
      gainKillXp(ctx, def.xp * (mob.xpScale ?? 1));
      if (loot && content.supports) dropSupport(ctx, loot, content.supports, mob, def);
      // Souls mechanic: any non-minion death counts, whatever killed it (designer default 2026-10-25).
      gainSoul(ctx, mob);
      // Life potion: kill points by rank (decision 2026-10-26; minions give nothing like every other reward).
      gainPotionPoints(ctx, mobRank(def, mob));
    }
    queue.push(...heroDeathExplosions(ctx, mob));
    // An exploding elite («Вибуховий») leaves its telegraphed death zone (hits the hero ~1 s later).
    spawnDeathZone(ctx, mob);
    // Its minions die with it (designer decision 2026-10-24): ordinary deaths, still giving nothing.
    for (const minion of world.mobs) {
      if (minion.summonerId !== mob.id || minion.life <= 0) continue;
      minion.life = 0;
      queue.push(minion);
    }
  }
  if (loot) world.lootRngState = loot.getState();
  world.mobs = world.mobs.filter((mob) => mob.life > 0);
}

/**
 * A kill's support drop (docs/design/skill-modifiers.md «Випадіння»): chance by rank (boss / elite / normal), tier by
 * area level (rollSupportDrop). Recorded in WorldState.supportDrops with a 'supportDrop' event.
 */
function dropSupport(ctx: Ctx, loot: Rng, data: SupportData, mob: MobState, def: MobDef): void {
  const rank = mobRank(def, mob);
  const drop = rollSupportDrop(loot, data, rank, ctx.world.areaLevel);
  if (!drop) return;
  ctx.world.supportDrops.push(drop);
  ctx.events.push({ type: 'supportDrop', mobId: mob.id, pos: mob.pos, defId: drop.defId, tier: drop.tier });
}

/** What to spawn: a mob def, optionally as another rank with scaled life / damage / XP (map runs). */
export interface MobSpawn {
  readonly defId: string;
  readonly rank?: MobRank;
  /** Multipliers over the def; absent = 1. */
  readonly lifeScale?: number;
  readonly damageScale?: number;
  readonly xpScale?: number;
  /** Multiplier on the def's body radius (MobState.radius); absent = 1. */
  readonly radiusScale?: number;
  /** A minion raised by this mob (MobState.summonerId): it gives no rewards. */
  readonly summonerId?: number;
  /**
   * Elite modifier id (Content.eliteModifiers, rolled by the map run for elites only): MobState.eliteModifier; its
   * life multiplier applies at spawn.
   */
  readonly eliteModifier?: string;
}

/** Body radius a spawn will have (MobDef.radius × MobSpawn.radiusScale); use it to place the spawn. */
export function spawnRadius(content: Content, spawn: MobSpawn): number {
  return getMob(content, spawn.defId).radius * (spawn.radiusScale ?? 1);
}

/**
 * Adds a fresh mob at `pos` (full life, no statuses) with a 'spawn' event. Returns it. Life and damage are the def's
 * × the spawn's rank scaling × the world's area level scaling (WorldState.mobScale), armour the def's × the area
 * level scaling, so waves, elites, the boss and minions raised by any mob all grow with the map level. An elite
 * modifier (MobSpawn.eliteModifier) multiplies life too (fat).
 */
export function spawnMob(world: WorldState, content: Content, spawn: MobSpawn, pos: Vec2, events: { push(event: WorldEvent): unknown }): MobState {
  const def = getMob(content, spawn.defId);
  const level = world.mobScale;
  const modifier = eliteModifierDef(content, spawn.eliteModifier);
  const life = def.life * (spawn.lifeScale ?? 1) * (modifier?.life ?? 1) * (level?.life ?? 1);
  const damageScale = (spawn.damageScale ?? 1) * (level?.damage ?? 1);
  // Armour grows with the area level only (designer decision 2026-10-25); ranks do not change it.
  const armourScale = level?.armour ?? 1;
  const mob: MobState = {
    id: world.nextId++,
    defId: def.id,
    pos,
    facing: vec(0, 1),
    life,
    maxLife: life,
    attackTimer: 0,
    stun: 0,
    slow: 0,
    slowMagnitude: 0,
    ignite: 0,
    igniteDps: 0,
    freeze: 0,
    freezeSlow: 0,
    stunSlow: 0,
    stunBar: 0,
    stunBarIdle: 0,
    auraSlow: 0,
    radius: def.radius * (spawn.radiusScale ?? 1),
    ...(spawn.rank !== undefined ? { rank: spawn.rank } : {}),
    ...(spawn.damageScale !== undefined || damageScale !== 1 ? { damageScale } : {}),
    ...(armourScale !== 1 ? { armour: def.armour * armourScale } : {}),
    ...(spawn.xpScale !== undefined ? { xpScale: spawn.xpScale } : {}),
    ...(spawn.summonerId !== undefined ? { summonerId: spawn.summonerId } : {}),
    ...(modifier ? { eliteModifier: modifier.id } : {}),
    ...initialAbilityState(def),
  };
  world.mobs.push(mob);
  events.push({ type: 'spawn', id: mob.id });
  return mob;
}

/**
 * The endless arena spawner (Content.arena.spawn); does nothing outside the arena (WorldState.endless false).
 * The game plays map runs (core/run); the endless arena is kept only as a test harness, because many world and data
 * tests rely on it (createWorld's default place). Do not build new gameplay on it.
 */
export function updateSpawner(ctx: Ctx, dt: number): void {
  const { world, content, rng, events } = ctx;
  // Time stop (cheatDeath): the arena spawner waits.
  if (!world.endless || timeStopped(world)) return;
  const spawn = content.arena.spawn;
  world.spawn.timer -= dt;
  if (world.spawn.timer > 0) return;
  world.spawn.timer += spawn.interval;
  world.spawn.wave++;
  const count = spawn.batchStart + Math.floor((world.spawn.wave - 1) * spawn.batchGrowth);
  for (let i = 0; i < count && world.mobs.length < spawn.maxAlive; i++) {
    const defId = spawn.mobIds[rng.int(0, spawn.mobIds.length - 1)];
    if (defId === undefined) return;
    spawnMob(world, content, { defId }, randomEdgePoint(rng, getMob(content, defId).radius, world), events);
  }
}

function randomEdgePoint(rng: Rng, radius: number, world: WorldState): Vec2 {
  const { width, height } = world.bounds;
  const side = rng.int(0, 3);
  const t = rng.next();
  switch (side) {
    case 0:
      return vec(radius + t * (width - 2 * radius), radius);
    case 1:
      return vec(width - radius, radius + t * (height - 2 * radius));
    case 2:
      return vec(radius + t * (width - 2 * radius), height - radius);
    default:
      return vec(radius, radius + t * (height - 2 * radius));
  }
}

import { clamp, distance, scale, sub, vec, type Vec2 } from '../math';
import type { Rng } from '../rng';
import type { Defences } from '../combat/mitigation';
import type { PassiveMechanic } from '../passives/types';
import type { BaseDamage } from '../combat/damage';
import type { DamageType, Modifier, StatId, Tag } from '../stats/types';
import type { ActionDef, ClassDef, Content, MobAbilityKind, MobDef, MobRank, StatusId, TrapAura, TrapChain, WeaponDef } from './content';
import { resolveActions, type ActionSet } from '../skills/params';
import { skillLevelChangeSets, type SkillProgress } from '../skills/levels';
import { supportChangeSets } from '../supports/rules';
import type { SupportRef } from '../supports/types';
import {
  activeConditionalModifiers,
  deriveStat,
  hasStateMechanics,
  skillChangeSets,
  stunBarStats,
  type ConditionState,
  type ConditionTarget,
  type StunBarStats,
} from './passiveEffects';

export const PLAYER_ID = 0;

export interface Buff {
  readonly id: string;
  readonly modifiers: readonly Modifier[];
  remaining: number;
}

/**
 * A free repeat of an action waiting to fire (Echo support, ActionDef.echo). Fires when `timer` reaches 0, from the
 * hero's position at that moment with the locked facing / aim (see updateEchoes in actions.ts).
 */
export interface PendingEcho {
  readonly actionId: string;
  /** The effective action when it was used (snapshot, like Projectile.action). */
  readonly action: ActionDef;
  timer: number;
  readonly facing: Vec2;
  readonly aim: Vec2;
  /** Arc actions: the use it repeats was an every-N-th special swing (the echo swings the same angle). */
  readonly special?: boolean;
}

/** A mob being pushed (Knockback support): it moves `remaining` more units along `dir` at `speed`. */
export interface KnockbackState {
  readonly dir: Vec2;
  readonly speed: number;
  remaining: number;
}

/** Forced movement from a dash-like action. */
export interface Motion {
  readonly actionId: string;
  /** The effective action as it was when the dash started; its hits use this (see Projectile.action). */
  readonly action: ActionDef;
  readonly dir: Vec2;
  readonly speed: number;
  readonly hitRadius: number;
  remaining: number;
  hitIds: number[];
}

export interface PlayerState {
  readonly id: 0;
  readonly classId: string;
  pos: Vec2;
  facing: Vec2;
  radius: number;
  life: number;
  energyShield: number;
  /**
   * Current class resource (ClassDef.resource: Rage / Energy / Mana); max = playerStat(…, 'resource').
   * Skills spend it (resourceCost), or life under bloodMagic.
   */
  resource: number;
  /**
   * Seconds since the hero last dealt or took a hit (resource decay delay, ResourceDef.decay).
   * Direct damage hits count both ways; ignite ticks and death explosions do not. Starts at the decay delay
   * (out of combat, see spawnCombatIdle) and never grows past it (combatIdleCap); inCombat() tells whether the hero
   * is in combat.
   */
  combatIdle: number;
  /** Hits that granted resource during the current use of a counting action (ResourceHitGain.maxHitsPerUse). */
  resourceHits: number;
  /** Time until the next basic attack or skill can start. */
  actionTimer: number;
  /**
   * Per action id: seconds until the action is ready again. For actions with charges > 1 (see `charges`): seconds
   * until the next charge is restored (0 while all charges are stored).
   */
  cooldowns: Record<string, number>;
  /**
   * Stored charges per action id, only for actions with charges > 1 (ActionDef.charges after skill changes);
   * full at spawn. HUD: available = charges[id], max = actions' charges, next charge in cooldowns[id]
   * (see chargeInfo in charges.ts).
   */
  charges: Record<string, number>;
  /**
   * Uses so far this run per action id, counted only for actions with a use rhythm (arc everyNth); never reset
   * during the run. The n-th use is the special one when n % every === 0.
   */
  useCounts: Record<string, number>;
  level: number;
  /** XP towards the next level. */
  xp: number;
  /**
   * Level and XP of every class skill (all of them are on the bar), keyed by skill id; filled at spawn from
   * Loadout.skills. Kills add skill XP (gainKillXp); a skill level-up rebuilds `actions`. Saved via RunResult.skills.
   */
  skillProgress: Record<string, SkillProgress>;
  /**
   * Supports socketed per class skill id, in slot order (Loadout.supports; docs/design/skill-modifiers.md). Fixed for
   * the run (supports change only in the hub); their change sets are part of `actions`.
   */
  supports: Record<string, SupportRef[]>;
  /** Echo repeats waiting to fire, in order of use. */
  echoes: PendingEcho[];
  /** Modifiers brought into the run (items, passives); level stats are added on top. */
  gearModifiers: readonly Modifier[];
  /** Permanent modifiers: gear + level. Rebuilt on level-up. */
  modifiers: Modifier[];
  /** Level stats only (a subset of `modifiers`); "base life" for lifeToEnergyShield. */
  levelModifiers: Modifier[];
  /** Passive tree mechanics brought into the run (keystones, spec effects); see passiveEffects.ts. */
  mechanics: readonly PassiveMechanic[];
  /**
   * Effective basic attack and skills: class data with the skill changes of `mechanics` and then of the skill
   * levels (`skillProgress`) applied (core/skills/params). Derived plain data, rebuilt whenever either changes
   * (createWorld, setLoadoutModifiers, skill level-up). The simulation reads actions from here, never from the
   * class data.
   */
  actions: ActionSet;
  /** Stun bar rules of `mechanics` (stunBarStats), cached with `actions`; undefined without a stunBar mechanic. */
  stunBarStats: StunBarStats | undefined;
  /** Seconds since the player last changed position (walk, dash, teleport). 0 at spawn. */
  stillTime: number;
  /**
   * Leech restored "recently" for the lifeLeech per-second cap: grows by each leech, drains by the cap per
   * second. Leech is allowed while it is below one second's worth of cap. 0 at spawn.
   */
  leechRecent: number;
  /** Seconds until counterAttack can trigger again (its internal cooldown); 0 = ready. */
  counterCooldown: number;
  /** Equipped weapon, or the class default. */
  weapon: WeaponDef;
  buffs: Buff[];
  invulnerable: number;
  /**
   * Hero ignite (a fiery elite's hits, EliteModifierDef.onHitHero): remaining seconds (0 = not burning) and fire
   * damage per second after the hero's fire resistance and damage taken modifiers (0 when not burning). Like mob
   * ignite: strongest only, no stacking. See applyHeroIgnite / tickHeroIgnite (eliteModifiers.ts).
   */
  ignite: number;
  igniteDps: number;
  motion: Motion | undefined;
  dead: boolean;
}

export interface MobState {
  readonly id: number;
  readonly defId: string;
  pos: Vec2;
  facing: Vec2;
  life: number;
  /**
   * Max life, set at spawn: MobDef.life × the spawn's life scale (elite / boss rank) × the world's area level scale
   * (WorldState.mobScale). Death explosions use it.
   */
  readonly maxLife: number;
  /**
   * Rank of this mob when it differs from its def (a map run spawns elites and the placeholder boss from ordinary mob
   * data, docs/design/maps.md). Absent: the def's rank (MobDef.boss / MobDef.elite). Read through mobRank().
   */
  readonly rank?: MobRank;
  /** Multiplier on the damage of this mob's attacks and abilities (rank scaling × WorldState.mobScale); absent = 1. */
  readonly damageScale?: number;
  /**
   * Armour against hero hits: MobDef.armour × the world's area level scale (WorldState.mobScale), set at spawn when
   * that scale is not 1. Absent: MobDef.armour. Read through mobDefences().
   */
  readonly armour?: number;
  /** Multiplier on the XP this mob gives (rank scaling); absent = 1. */
  readonly xpScale?: number;
  /**
   * Collision / body radius in world units, set at spawn (MobDef.radius × the spawn's radius scale: elite / boss
   * rank). Every hit, reach, clamp and separation check uses it, never MobDef.radius. Render draws the body from it.
   */
  readonly radius: number;
  attackTimer: number;
  /** Remaining seconds of each status (0 = none); see STATUS_IDS. */
  stun: number;
  slow: number;
  slowMagnitude: number;
  ignite: number;
  /** Fire damage per second of the current ignite, after the mob's fire resistance (0 when not ignited). */
  igniteDps: number;
  freeze: number;
  /**
   * Bosses only: the short strong slow that replaces a freeze (CombatConfig.bossFreezeSlow). A separate slot,
   * so it never overwrites a longer, weaker `slow`; the stronger of the two active slows applies.
   * While it runs the boss counts as frozen (and as slowed).
   */
  freezeSlow: number;
  /**
   * Bosses only: the strong slow that replaces an ordinary stun (CombatConfig.bossStunSlow), own slot like
   * `freezeSlow`. While it runs the boss counts as stunned (and as slowed). The stun bar's stun is a real stun.
   */
  stunSlow: number;
  /**
   * Stun bar fill (stunBar mechanic), 0..1 where 1 = full; a full bar stuns and resets to 0. Decays after
   * stunBarIdle reaches the mechanic's decayDelay (no events while decaying). Render may read it directly (max is 1).
   */
  stunBar: number;
  /** Seconds since the last hero hit that filled the stun bar (stunBar decay delay). */
  stunBarIdle: number;
  /**
   * Slow from armed trap auras (TrapAura) and slowing ground zones, as a magnitude (0 = none). Recomputed every
   * step (updateAuraSlows) from the traps and zones around the mob, so it lasts exactly while the mob stays in
   * range (applied to movement on the next step's mob update). Own slot like freezeSlow: never merges into `slow`; the strongest active slow applies,
   * and while it is > 0 the mob counts as slowed (conditions, freeze-if-slowed). Render may read it directly.
   */
  auraSlow: number;
  /**
   * Bleed (Bleed support): remaining seconds of the shared timer; absent or 0 = not bleeding. Every bleeding hit adds
   * a stack and restarts the timer (designer decision 2026-10-23).
   */
  bleed?: number;
  /**
   * Physical damage per second of each bleed stack, oldest first (at most the effect's maxStacks; a new stack past
   * the cap replaces the oldest). Their sum is the bleed damage per second. Render: stack count = length.
   */
  bleedStacks?: number[];
  /** Active push (Knockback support); while set the mob neither moves on its own nor attacks. */
  knockback?: KnockbackState;
  /**
   * Mobs with abilities (MobDef.abilities) only: current phase, 1-based (1 at spawn; see MobPhaseDef). Render: a
   * 'mobPhase' event marks each change.
   */
  phase?: number;
  /**
   * Phase change pause (MobPhaseDef.transition), set when the phase starts ('mobPhase' fires then): `remaining` /
   * `total` seconds (world time, not slowed). While set the mob is immune (isImmune) and neither moves, attacks nor
   * casts; absent = no pause. Render: roar animation, immunity look.
   */
  phaseTransition?: { remaining: number; readonly total: number };
  /**
   * Mobs with abilities only: seconds until each ability (by MobAbilityDef.id) is ready. Abilities of a later phase
   * get their timer when that phase starts.
   */
  abilityTimers?: Record<string, number>;
  /** Mobs with abilities only: seconds until any ability may start again (MobAbilitiesDef.recovery). */
  castRecovery?: number;
  /** The telegraphed ability being wound up; absent = not casting. While set the mob neither moves nor attacks. */
  casting?: MobCast;
  /**
   * Minions only: id of the mob that raised them (summon ability). Minions give nothing on death: no XP, no
   * supports, no kill count (designer decision 2026-10-24).
   */
  readonly summonerId?: number;
  /**
   * Elites only: id of their elite modifier (EliteModifierDef, Content.eliteModifiers; docs/design/mobs.md «Еліти»),
   * rolled by the map run. Render: outline colour and the modifier name (`eliteModifier.<id>.name`) over the life bar.
   * Never set on bosses or minions.
   */
  readonly eliteModifier?: string;
}

/**
 * A mob winding up an ability (telegraph for render). The mob stands at its position for the whole wind-up; the
 * ability resolves when `remaining` reaches 0, or is cancelled if the mob gets stunned / frozen / pushed
 * ('mobCastInterrupted'; its cooldown stays spent, designer decision 2026-10-24).
 */
export interface MobCast {
  /** MobAbilityDef.id. */
  readonly abilityId: string;
  readonly kind: MobAbilityKind;
  /** Seconds of wind-up left (runs at the mob's speed factor, so a slowed caster takes longer). */
  remaining: number;
  /** Full wind-up, seconds (MobAbilityDef.windUp); progress = 1 − remaining / total. */
  readonly total: number;
  /**
   * Unit direction from the mob to its target when the wind-up started; a projectile fan flies along it. (Ground
   * zones do not use it: they go where the target is at resolve, see GroundZonesAbilityDef.)
   */
  readonly dir: Vec2;
  /** Nova: radius of the coming explosion around the mob (draw the danger circle at the mob's position). */
  readonly radius?: number;
}

/**
 * A hostile ground zone (grave circle): it does nothing until `remaining` reaches 0, then erupts once
 * ('hostileZoneErupt'), hitting the hero if their centre is within radius + hero radius, and disappears. It
 * outlives its caster's stun (it is already on the ground). Render: draw a warning circle filling up over `total`.
 */
export interface HostileZone {
  readonly id: number;
  /** Mob that placed it, its def and ability (damage: that ability's damage × damageScale). */
  readonly sourceId: number;
  readonly sourceDefId: string;
  readonly abilityId: string;
  /** Centre, world units. */
  readonly pos: Vec2;
  readonly radius: number;
  /** Seconds to the eruption. */
  remaining: number;
  /** Full delay, seconds (GroundZonesAbilityDef.delay). */
  readonly total: number;
  /** The caster's MobState.damageScale when placed (absent = 1). */
  readonly damageScale?: number;
  /** The caster's MobState.eliteModifier when placed: its damage conversion and hero statuses apply to the eruption. */
  readonly eliteModifier?: string;
  /**
   * 'eliteDeath': left where an elite with a death zone died (EliteModifierDef.deathZone, «Вибуховий»); `abilityId`
   * is then the modifier id and `damage` / `critChance` its own. Absent: placed by a groundZones ability.
   */
  readonly source?: 'eliteDeath';
  /** Own hit (death zones); absent: the source ability's damage (abilityHit). */
  readonly damage?: BaseDamage;
  readonly critChance?: number;
}

export interface Projectile {
  readonly id: number;
  readonly owner: 'player' | 'mob';
  /** Action id (player) or mob def id (mob). */
  readonly sourceId: string;
  /**
   * Player projectiles: the effective action (plain data) as it was when fired. Its hits use this snapshot, so
   * damage, tags, crit and on-hit statuses (incl. durations) come from cast time even if the loadout changes
   * mid-flight. Omitted for mob projectiles.
   */
  readonly action?: ActionDef;
  pos: Vec2;
  readonly dir: Vec2;
  readonly speed: number;
  readonly radius: number;
  remaining: number;
  /** Distance flown since it was fired (distanceDamage); keeps growing through pierced targets. */
  travelled: number;
  pierceLeft: number;
  readonly explodeRadius: number;
  hitIds: number[];
  /**
   * Hero-wide conditional modifiers (moving / standing / low life) locked when the action fired; used for
   * its hits instead of re-evaluating at impact. Empty for mob projectiles. See heroConditionalModifiers.
   */
  readonly castModifiers: readonly Modifier[];
  /** Mob projectiles: the shooter's MobState.damageScale when fired (absent = 1). */
  readonly damageScale?: number;
  /**
   * Mob projectiles from an ability (projectileFan, e.g. 'boneSpears'): its MobAbilityDef.id; the hit uses that
   * ability's damage instead of the basic attack's. Render may pick the projectile's look by it.
   */
  readonly abilityId?: string;
  /** Mob projectiles: the shooter's MobState.eliteModifier when fired (fiery: the hit is fire and may ignite the hero). */
  readonly eliteModifier?: string;
}

export interface Trap {
  readonly id: number;
  readonly actionId: string;
  /** The effective action as it was when thrown (see Projectile.action). */
  readonly action: ActionDef;
  readonly pos: Vec2;
  armTimer: number;
  lifetime: number;
  /** Trigger and explosion radii locked when the trap was thrown (effective skill params at that moment). */
  readonly triggerRadius: number;
  readonly explodeRadius: number;
  /** Chain detonation rules locked when thrown (trap Delivery.chain), or null. */
  readonly chain: TrapChain | null;
  /** Slow aura locked when thrown (trap Delivery.aura), or null; active only while armed. Render: aura.radius. */
  readonly aura: TrapAura | null;
  /** Seconds until a chain detonation set off by another trap explodes this one; null when not chained. */
  chainTimer: number | null;
  /** Hero-wide conditional modifiers locked when the trap was thrown (see Projectile.castModifiers). */
  readonly castModifiers: readonly Modifier[];
}

/** A hero ground zone on the floor (GroundZoneDef): damages and / or slows mobs inside. */
export interface GroundZone {
  readonly id: number;
  /** Action that left it (its snapshot below). */
  readonly actionId: string;
  /** GroundZoneDef.id: what render draws ('fire_puddle', 'ice_field'). */
  readonly kind: string;
  readonly pos: Vec2;
  readonly radius: number;
  /** Seconds left. */
  remaining: number;
  /** Seconds until the next damage tick (unused without a tick). */
  tickTimer: number;
  /** The effective action when the zone appeared (damage tags, own modifiers, ignite sources, zone def). */
  readonly action: ActionDef;
  /** Hero conditional modifiers locked at cast time (see Projectile.castModifiers). */
  readonly castModifiers: readonly Modifier[];
}

/**
 * A hero decoy (SelfEffect 'decoy'): mobs within tauntRadius target it instead of the hero. It has no life: hits
 * on it do nothing, it lasts its duration. Mob projectiles that touch it are absorbed.
 */
export interface Decoy {
  readonly id: number;
  /** SelfEffect id: what render draws. */
  readonly kind: string;
  readonly pos: Vec2;
  readonly radius: number;
  readonly tauntRadius: number;
  remaining: number;
  /** Seconds bosses are still taunted (counts down with `remaining`; ≤ 0: bosses ignore the decoy). */
  bossTauntRemaining: number;
}

/** The walkable rectangle of the world, from (0, 0) to (width, height). */
export interface Bounds {
  readonly width: number;
  readonly height: number;
}

/** A round obstacle (pillar, rock): the hero and mobs cannot stand inside it. Projectiles fly over it. */
export interface Obstacle {
  readonly pos: Vec2;
  readonly radius: number;
}

/** Multipliers on mob life, damage and armour from the area level (core/run mobLevelScaling). Plain JSON. */
export interface MobScale {
  readonly life: number;
  readonly damage: number;
  readonly armour: number;
}

export interface WorldState {
  time: number;
  /**
   * Current walkable area: the arena (Content.arena) or the current room of a map run (core/run), which swaps it
   * when the hero walks into the next room.
   */
  bounds: Bounds;
  /** Obstacles of the current room (none in the arena). */
  obstacles: Obstacle[];
  /** True: the endless arena spawner (Content.arena.spawn) runs. False: a map run spawns the mobs (room waves). */
  readonly endless: boolean;
  rngState: number;
  /**
   * Separate seeded stream for loot rolls (support drops), so loot never shifts combat randomness and vice versa.
   * Derived from the world seed (see createWorld).
   */
  lootRngState: number;
  /** Supports dropped this run, in drop order; granted to the character's tab at the end (grantSupportDrops). */
  supportDrops: SupportRef[];
  nextId: number;
  player: PlayerState;
  mobs: MobState[];
  projectiles: Projectile[];
  traps: Trap[];
  zones: GroundZone[];
  decoys: Decoy[];
  /** Hostile ground zones waiting to erupt (mob abilities), in placement order. */
  hostileZones: HostileZone[];
  spawn: { timer: number; wave: number };
  kills: number;
  /** Level of the area (map level); scales mob XP. */
  readonly areaLevel: number;
  /**
   * Area level scaling of every mob spawned in this world (waves, elites, the boss, minions of any mob), on top of the
   * spawn's own rank scaling; set by a map run (core/run mobLevelScaling). Absent: × 1 (the endless arena harness).
   */
  readonly mobScale?: MobScale;
  /** Total XP earned this run. */
  xpGained: number;
  /** Skill XP each class skill was offered this run (the same amount goes to every skill; max-level skills drop it). */
  skillXpGained: number;
}

export interface PlayerInput {
  /** Desired move direction; normalized internally. */
  readonly move: Vec2;
  /** World point to aim at. */
  readonly aim: Vec2;
  readonly basicAttack: boolean;
  /** Skill slots 1..3. */
  readonly skills: readonly boolean[];
}

export type WorldEvent =
  | { type: 'action'; actionId: string; facing: Vec2 }
  /**
   * A damage zone resolved this tick (arc swing, nova, explosion) — for visuals. Death explosions have
   * actionId 'deathExplosion', `source` 'deathExplosion', their damage type and the id of the mob that exploded.
   */
  | {
      type: 'area';
      actionId: string;
      origin: Vec2;
      facing: Vec2;
      radius: number;
      angleDeg: number;
      source?: 'deathExplosion';
      damageType?: DamageType;
      sourceMobId?: number;
      /** A trap set off by another trap's explosion (chain detonation). */
      chain?: true;
      /** What set off this area: the special N-th swing of an arc (Cleave circle), or a dash landing. */
      trigger?: 'everyNth' | 'dashLanding';
    }
  /** A hero trap vanished without exploding: the oldest one, removed because the active-trap cap was reached. */
  | { type: 'trapRemoved'; trapId: number; pos: Vec2; reason: 'limit' }
  /**
   * A status was applied to (or refreshed on) a living mob, or (targetId PLAYER_ID, 'ignite' only) to the hero;`duration` is its new remaining time. `source`
   * 'stunBar': the stun of a full stun bar (omitted for statuses from hits).
   */
  | { type: 'status'; targetId: number; pos: Vec2; status: StatusId; duration: number; source?: 'stunBar'; stacks?: number }
  /** A hero hit changed a living mob's stun bar; `value` is the new fill (0..1; 0 after a full bar stunned and reset). */
  | { type: 'stunBar'; targetId: number; value: number }
  /** The hero retaliated (counterAttack) with `actionId` (the basic attack) at `targetId`; `facing` points at it. */
  | { type: 'counter'; actionId: string; targetId: number; facing: Vec2 }
  /**
   * Damage over time dealt this step (one event per mob per step; aggregate for damage numbers). targetId PLAYER_ID:
   * the hero's own ignite (fiery elites).
   */
  | { type: 'dot'; targetId: number; pos: Vec2; amount: number; status: StatusId }
  | { type: 'teleport'; from: Vec2; to: Vec2 }
  /** Mob `id` attacked; `decoyId` is set when its target was a decoy (not the hero). */
  | { type: 'mobAttack'; id: number; decoyId?: number }
  /** `source` 'zone': a ground zone damage tick (`zoneId`); omitted for ordinary hits. */
  | { type: 'hit'; targetId: number; pos: Vec2; amount: number; isCrit: boolean; source?: 'zone'; zoneId?: number }
  /** A ground zone appeared; it lasts `duration` seconds (see GroundZone). */
  | { type: 'zoneSpawn'; zoneId: number; kind: string; actionId: string; pos: Vec2; radius: number; duration: number }
  | { type: 'zoneExpire'; zoneId: number }
  | { type: 'decoySpawn'; decoyId: number; kind: string; pos: Vec2; radius: number; duration: number }
  | { type: 'decoyExpire'; decoyId: number }
  /** A hero projectile split (ProjectileSplit) at `pos` into the child projectiles `childIds`. */
  | { type: 'projectileSplit'; projectileId: number; actionId: string; pos: Vec2; childIds: number[] }
  | { type: 'spawn'; id: number }
  | { type: 'death'; id: number; pos: Vec2 }
  | { type: 'levelUp'; level: number }
  /** An Echo repeat of `actionId` fired now (free); its delivery events follow. `pos`: the hero. */
  | { type: 'echo'; actionId: string; pos: Vec2; facing: Vec2 }
  /**
   * A Chain Lightning bolt (ActionDef.chainHit) of `actionId`: it started at the impact target `fromId` and hopped
   * through `targetIds` in order; `points` are the positions from the start target through every hop (bolt line).
   */
  | { type: 'chain'; actionId: string; fromId: number; targetIds: number[]; points: Vec2[]; damageType: DamageType }
  /** A hero hit pushed mob `targetId` from `pos` along `dir` by `distance` (Knockback support). */
  | { type: 'knockback'; targetId: number; pos: Vec2; dir: Vec2; distance: number }
  /** Mob `mobId` dropped a support (skill modifier) `defId` of `tier` at `pos`. */
  | { type: 'supportDrop'; mobId: number; pos: Vec2; defId: string; tier: number }
  /** A class skill reached `level` (one event per level gained); its effective action has already changed. */
  | { type: 'skillLevelUp'; skillId: string; level: number }
  /** Mob `id` started winding up ability `abilityId` (see MobState.casting) for `duration` seconds. */
  | { type: 'mobCast'; id: number; abilityId: string; kind: MobAbilityKind; pos: Vec2; dir: Vec2; duration: number; radius?: number }
  /** Mob `id`'s wind-up was cancelled (stunned / frozen / pushed); the ability did not resolve. */
  | { type: 'mobCastInterrupted'; id: number; abilityId: string }
  /**
   * Mob `id`'s ability resolved at `pos` (the mob): nova exploded (`radius`; `hit`: the hero was hit), fan fired
   * (`projectileIds`), minions raised (`spawnedIds`), zones placed (`zoneIds`).
   */
  | {
      type: 'mobAbility';
      id: number;
      abilityId: string;
      kind: MobAbilityKind;
      pos: Vec2;
      radius?: number;
      hit?: boolean;
      projectileIds?: number[];
      spawnedIds?: number[];
      zoneIds?: number[];
    }
  /**
   * Mob `id` entered phase `phase` (2, 3…) at `pos`; `transition`: seconds of its immune pause (see
   * MobState.phaseTransition), omitted without one.
   */
  | { type: 'mobPhase'; id: number; phase: number; pos: Vec2; transition?: number }
  /** A hero hit reached an immune mob (isImmune) and did nothing. */
  | { type: 'immune'; targetId: number; pos: Vec2 }
  /** A hostile zone appeared; it erupts `delay` seconds later. */
  | {
      type: 'hostileZoneSpawn';
      zoneId: number;
      sourceId: number;
      abilityId: string;
      pos: Vec2;
      radius: number;
      delay: number;
      /** 'eliteDeath': an exploding elite's death zone (abilityId = its modifier id). */
      source?: 'eliteDeath';
      /** The source mob's elite modifier, if any. */
      eliteModifier?: string;
    }
  /** A hostile zone erupted and is gone; `hit`: the hero was inside and was hit. */
  | { type: 'hostileZoneErupt'; zoneId: number; abilityId: string; pos: Vec2; radius: number; hit: boolean; source?: 'eliteDeath'; eliteModifier?: string }
  | { type: 'playerDeath' };

/** Everything a system needs during one step. */
export interface Ctx {
  readonly world: WorldState;
  readonly content: Content;
  readonly classDef: ClassDef;
  readonly rng: Rng;
  readonly events: WorldEvent[];
  readonly input: PlayerInput;
}

export function getClass(content: Content, id: string): ClassDef {
  const def = content.classes[id];
  if (!def) throw new Error(`Unknown class: ${id}`);
  return def;
}

export function getMob(content: Content, id: string): MobDef {
  const def = content.mobs[id];
  if (!def) throw new Error(`Unknown mob: ${id}`);
  return def;
}

/**
 * What the hero's passive mechanics, skill levels and socketed supports derive once per loadout (PlayerState.actions,
 * PlayerState.stunBarStats). Change sets: passive tree first, then skill levels (incl. level effects), then supports.
 */
export function deriveFromMechanics(
  content: Content,
  classDef: ClassDef,
  player: Pick<PlayerState, 'mechanics' | 'skillProgress' | 'supports'>,
): Pick<PlayerState, 'actions' | 'stunBarStats'> {
  const sets = [
    ...skillChangeSets(player.mechanics),
    ...skillLevelChangeSets(classDef, player.skillProgress, content.skillLevels),
    ...supportChangeSets(classDef, player.supports, content.supports, player.mechanics),
  ];
  return { actions: resolveActions(classDef, sets), stunBarStats: stunBarStats(player.mechanics) };
}

/** Permanent modifiers and buffs, without conditional (passive mechanic) modifiers. */
export function baseModifiers(player: PlayerState): readonly Modifier[] {
  if (player.buffs.length === 0) return player.modifiers;
  return [...player.modifiers, ...player.buffs.flatMap((b) => b.modifiers)];
}

function hasConditionalMechanics(player: PlayerState): boolean {
  return hasStateMechanics(player.mechanics);
}

/** Hero state for conditions; pool maximums (full stat derivations) are computed only if a mechanic asks. */
function conditionState(classDef: ClassDef, player: PlayerState, base: readonly Modifier[]): ConditionState {
  const source = { baseStats: classDef.baseStats, modifiers: base, levelModifiers: player.levelModifiers, mechanics: player.mechanics };
  return {
    stillTime: player.stillTime,
    life: player.life,
    energyShield: player.energyShield,
    get maxLife(): number {
      return deriveStat(source, 'life');
    },
    get maxEnergyShield(): number {
      return deriveStat(source, 'energyShield');
    },
  };
}

/**
 * Conditional modifiers whose hero-wide condition (moving, standing, low life) holds right now.
 * Delayed hits (projectiles, traps) snapshot this when the action fires (Projectile.castModifiers).
 */
export function heroConditionalModifiers(classDef: ClassDef, player: PlayerState): Modifier[] {
  if (!hasConditionalMechanics(player)) return [];
  return activeConditionalModifiers(player.mechanics, conditionState(classDef, player, baseModifiers(player)));
}

/**
 * Every modifier that applies to the player right now: permanent, buffs and conditional modifiers whose
 * hero condition holds (moving, standing, low life). With `target`, per-hit target conditions are added too.
 * `castModifiers` replaces the live hero conditions with a snapshot taken at cast time (delayed hits);
 * target conditions are still evaluated now, against the target being hit.
 */
export function allModifiers(
  classDef: ClassDef,
  player: PlayerState,
  target?: ConditionTarget,
  castModifiers?: readonly Modifier[],
): readonly Modifier[] {
  const base = baseModifiers(player);
  if (!hasConditionalMechanics(player)) return castModifiers && castModifiers.length > 0 ? [...base, ...castModifiers] : base;
  const state = conditionState(classDef, player, base);
  const extra = castModifiers ? [...castModifiers] : activeConditionalModifiers(player.mechanics, state);
  if (target) extra.push(...activeConditionalModifiers(player.mechanics, state, target));
  return extra.length === 0 ? base : [...base, ...extra];
}

/** A player stat with all modifiers and pool mechanics (blood magic, crystal shell) applied. */
export function playerStat(classDef: ClassDef, player: PlayerState, stat: StatId, tags: readonly Tag[] = []): number {
  return deriveStat(
    { baseStats: classDef.baseStats, modifiers: allModifiers(classDef, player), levelModifiers: player.levelModifiers, mechanics: player.mechanics },
    stat,
    tags,
  );
}

/** Moves the player; any actual change of position counts as movement for movement conditions. */
export function movePlayer(player: PlayerState, pos: Vec2): void {
  if (pos.x !== player.pos.x || pos.y !== player.pos.y) player.stillTime = 0;
  player.pos = pos;
}

/** A mob's defences against hero damage: its armour (MobState.armour, grown with the area level) and its def's resistances. */
export function mobDefences(def: MobDef, mob: Pick<MobState, 'armour'>): Defences {
  return { armour: mob.armour ?? def.armour, resistances: def.resistances };
}

/** Rank of a mob: its spawn rank (MobState.rank) or its def's (MobDef.boss / MobDef.elite). */
export function mobRank(def: MobDef, mob: Pick<MobState, 'rank'>): MobRank {
  return mob.rank ?? (def.boss ? 'boss' : def.elite ? 'elite' : 'normal');
}

/**
 * Immune mob (phase change pause, MobState.phaseTransition). Rule: hero hits still reach it (a projectile is used
 * up, an arc counts it as a target) but do nothing: no damage, statuses, leech, resource, stun bar or knockback (an
 * 'immune' event instead). Ignite / bleed already on it keep running out but deal no damage; ground zone ticks and
 * death explosions deal no damage and apply nothing.
 */
export function isImmune(mob: MobState): boolean {
  return mob.phaseTransition !== undefined;
}

export function isBoss(content: Content, mob: MobState): boolean {
  return mobRank(getMob(content, mob.defId), mob) === 'boss';
}

/**
 * Keeps a body of `radius` inside the world bounds and out of the obstacles: pushed out of each obstacle it
 * overlaps (in order; a body exactly at an obstacle's centre goes along +x), then clamped to the bounds.
 */
export function clampToArena(pos: Vec2, radius: number, world: Pick<WorldState, 'bounds' | 'obstacles'>): Vec2 {
  let p = pos;
  for (const o of world.obstacles) {
    const d = distance(p, o.pos);
    const min = o.radius + radius;
    if (d >= min) continue;
    const dir = d > 0 ? scale(sub(p, o.pos), 1 / d) : vec(1, 0);
    p = vec(o.pos.x + dir.x * min, o.pos.y + dir.y * min);
  }
  const { width, height } = world.bounds;
  return vec(clamp(p.x, radius, width - radius), clamp(p.y, radius, height - radius));
}

export function insideArena(pos: Vec2, world: Pick<WorldState, 'bounds'>): boolean {
  return pos.x >= 0 && pos.y >= 0 && pos.x <= world.bounds.width && pos.y <= world.bounds.height;
}

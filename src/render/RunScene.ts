import * as Phaser from 'phaser';
import { distance, normalize, vec, type Vec2 } from '../core/math';
import type { Content, MobRank } from '../core/world/content';
import {
  actionReady,
  canAfford,
  clampToArena,
  distanceDamageMore,
  eliteModifierDef,
  getClass,
  getMob,
  maxResource,
  mobMoveSpeed,
  mobRank,
  PLAYER_ID,
  setLoadoutModifiers,
  timeStopped,
  type WorldEvent,
  type WorldState,
} from '../core/world/world';
import { unspentPoints } from '../core/passives/allocation';
import { equippedWeapon } from '../core/items/equipment';
import { heroMechanics, heroModifiers } from '../core/progression/hero';
import { findCharacter } from '../core/progression/profile';
import { finishRun, keepsSupportDrops, type RunSummary } from '../core/run/finish';
import { canEnterMap, unlockedMap } from '../core/run/progress';
import { abandonRun, canActivateAltar, createRun, currentTemplate, openDoor, stepRun } from '../core/run/run';
import type { RunEvent, RunInput, RunState, RunStepEvent } from '../core/run/types';
import { socketedSupports } from '../core/supports/tab';
import { itemsData } from '../data/items';
import { mapsData } from '../data/maps';
import { content } from '../data';
import { passiveTree } from '../data/passives';
import { getApp } from './app';
import { CombatFx, STUN_BAR_FLASH, statusLook } from './combatFx';
import { Hud } from './hud';
import { RoomView, type AltarLook } from './roomView';
import { environmentAt } from './environment';
import type { EnvironmentLook } from '../data/environments';
import { RunHud } from './runHud';
import { formatCountdown, formatElapsed } from './runText';
import { SkillFx } from './skillFx';
import { SupportFx } from './supportFx';
import { supportIcon, tierColor, tierColorNum } from './supportIcons';
import { supportsWord, supportTitle } from './supportText';
import { shardsWord } from './passiveText';
import { resourceText } from './resourceText';
import { baseName, eliteModifierName, itemName, mobName } from './contentText';
import { currencyWord } from './craftText';
import { ESSENCE_CURRENCY } from '../core/items/craft';
import { SALVAGE_CURRENCY } from '../core/items/inventory';
import { t, upper } from '../i18n';
import { softDotTexture } from './fxTextures';
import { PointsBadge } from './passiveBanner';
import type { PassiveTreeSceneData, RunTreeHooks } from './PassiveTreeScene';
import { SOLO_MODE, type RunMode } from './runMode';
import { confirmDialog, densityOf, heading, label, makeButton, makeFrame, makeIconButton, pinToScreen, TOUCH_MIN, UI } from './ui';
import { ISO_K, screenDirToWorld, stickyDirectionRow, toScreen, toWorld } from './iso';
import { mobSprite, runSpriteSets, type RunSpriteSets } from './runSprites';
import { ACTION_ANIMS, ATTACK_ANIMS, CAST_ANIMS, CLASS_LOOKS, loadedSpriteKeys, loadSprites, ORIGIN_Y, ROAR_ANIM, SPRITE_SETS, spriteLayout, spritesLoaded, spriteSetOf, textureKey, unloadSprites } from './sprites';
import { BossFx } from './bossFx';
import { EliteFx, eliteLook } from './eliteFx';
import { UniqueFx } from './uniqueFx';
import { PotionFx } from './potionFx';
import { SOUL_GREEN, SOUL_VIOLET, SoulFx } from './soulFx';
import { ClockFx, ENEMY_FX_DEPTH, HERO_STOP_DEPTH } from './clockFx';
import { soulsMax } from '../core/world/souls';
import { AllyFx } from './allyFx';
import { phoneLayout, touchControls as touchTuning, type TouchControlsTuning } from '../data/controls';
import { ZoomedWorldView } from './worldCamera';
import { makeFullscreenButton } from './fullscreen';
import { TouchControls } from './touchControls';
import { ORIENTATION_BLOCKED, orientationBlocked } from './orientationGate';
import { isPhone, safeInsets, touchControlsOn } from './touchMode';
import { deliveryReach, dragFraction, firstUsableSkill, idleAim, isAimed, isDistanceAimed, manualAim, onScreen, tapAim, type AimTarget } from './touchAim';

// A map run (docs/design/maps.md) on screen: combat rooms one after another, then the boss room with its altar.
// Flare floor tiles, characters baked from KayKit 3D models (tools/sprite-baker). Core (core/run) owns every rule:
// this scene sends the player's input into stepRun and draws the state it returns.

const DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

const CORPSE_TIME = 2.5;
const AREA_TTL = 0.18;
const LIGHT_RADIUS = 520;
/** Light falloff texture side; must exceed 2 × LIGHT_RADIUS. */
const LIGHT_TEXTURE = 1200;
/** Ground shadow under bodies (environments with actorShadow): ellipse size in body radii. */
const ACTOR_SHADOW_W = 2.4;
const ACTOR_SHADOW_H = 1.1;
/** Visual height of projectiles above the ground, in screen pixels. */
const PROJECTILE_HEIGHT = 34;
/** Seconds a skill key press stays queued while the hero is busy. */
const INPUT_BUFFER = 0.35;
/** Larger jumps between sim steps (teleport, spawn) are not interpolated. */
const SNAP_DISTANCE = 80;
/** Mob display positions ease towards the simulation to hide crowd-separation jitter. */
const MOB_SMOOTHING = 22;
/** Below this speed (world units/s) an actor is considered standing. */
const MOVING_SPEED = 8;
/** A background sprite sheet whose download failed is requested again after this many ms. */
const SPRITE_RETRY_MS = 3000;

/** Sprite textures already switched to nearest filtering (a sheet loaded again is a new texture object). */
const sharpened = new WeakSet<Phaser.Textures.Texture>();

/** Nearest filtering (pixel look) on a sprite sheet, once per texture: set on first use, so late sheets get it too. */
function sharpen(texture: Phaser.Textures.Texture): void {
  if (sharpened.has(texture)) return;
  sharpened.add(texture);
  texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
}
/** How fast the displayed stun bar catches up with the core fill (1/s, exponential). */
const STUN_BAR_SMOOTHING = 18;
/** Ignite damage is summed per mob and shown as one number this often (seconds). */
const DOT_NUMBER_INTERVAL = 0.5;
/** Seconds between the boss falling and the chest screen (its death animation and the chest burst play first). */
const WIN_SCREEN_DELAY = 1.6;
/** Room change: fade in from black (ms). */
const ROOM_FADE = 380;
/** Screen entrance / exit fades (ms), as render/ui.ts fadeIn; on phones the HUD camera fades with the world. */
const SCREEN_FADE = 250;
const SCREEN_EXIT = 200;
/** Touch drag-aim indicator on the floor (visual only): colours, shortest arrow (screen px). */
const AIM_ARROW = 0xff9a3c;
const AIM_ARROW_RIM = 0x2a1206;
const AIM_ARROW_MIN = 70;
/** Aim indicator: ring radius (world units) round the hero for self skills without an area; Teleport landing ring. */
const SELF_AIM_RING = 60;
const TELEPORT_LANDING_RING = 30;
/** Screen px the run timer and its info line need between the top corner buttons; less moves them under the buttons. */
const MIN_HEADER_WIDTH = 150;

/** Visual-only colors per action / damage flavour. */
const AREA_COLORS: Record<string, number> = { cleave: 0xff9a3c, fireball: 0xff6a1a, explosive_trap: 0xff8a2a, frost_nova: 0x8fd3ff };
const PROJECTILE_COLORS: Record<string, number> = { ranger_bolt: 0xe8e2cf, volley: 0xe8e2cf, wand_bolt: 0xb58cff, fireball: 0xff7a1a };
/** Fireball (projectile and explosion) converted to cold (Heart of Winter): icy instead of fire. */
const COLD_PROJECTILE_COLOR = 0xa8e4ff;
const COLD_AREA_COLOR = 0x8fd3ff;
/** Legendary drop on the chest screen: screen flash colour (RGB) and duration, burst size. */
const LEGENDARY_FLASH: readonly [number, number, number] = [255, 95, 210];
const LEGENDARY_FLASH_MS = 520;
const LEGENDARY_PARTICLES = 48;
const MOB_PROJECTILE_COLOR = 0xff4b4b;
/** Area tint of a trap explosion set off by another trap. */
const CHAIN_AREA_COLOR = 0xffd23a;
/** Area tint of a burst round the hero (Ancestral Horn stun) and of a teleport's origin blast (Rift Ring). */
const BURST_AREA_COLOR = 0xffcf5a;
const RIFT_AREA_COLOR = 0xb58cff;
/** Far Shot (distanceDamage) glow around bolts. */
const FAR_SHOT_GLOW = 0xfff0a0;
/** Mob basic attack projectiles with their own look (by mob def id); others are the plain red streak. */
const DARK_BOLT_MOBS: ReadonlySet<string> = new Set(['necromancer', 'cultist']);
const EARTH_CLOD_MOBS: ReadonlySet<string> = new Set(['gravedigger']);
/** Ability projectiles drawn as bone spears (Projectile.abilityId). */
const BONE_SPEAR_ABILITIES: ReadonlySet<string> = new Set(['boneSpears']);
/** Tumbling thrown bones: ability projectiles (abilityId) and mob basic attacks (mob def id). */
const THROWN_BONE_ABILITIES: ReadonlySet<string> = new Set(['boneFan']);
const THROWN_BONE_MOBS: ReadonlySet<string> = new Set(['boneThrower']);
/** Turns per second of a thrown bone. */
const THROWN_BONE_SPIN = 2.2;
/** Sprite height of a normal-sized character in screen px (actor.scale multiplies it); for overhead effects. */
const BODY_PX = 62;
/** Minions crumbling with their summoner: a short corpse, a grey dusty tint, deaths staggered a little. */
const CRUMBLE_CORPSE_TIME = 1.3;
const CRUMBLE_TINT = 0x8a8478;
const CRUMBLE_STAGGER = 0.3;
/** Seconds between two "Immune" labels over the same mob (every hit sends an event). */
const IMMUNE_TEXT_INTERVAL = 0.45;
/** Immune roar: the boss flickers violet. */
const IMMUNE_TINTS = [0x6a3aaa, 0x9a6ae0] as const;

type FloatTextKind = 'interrupt' | 'immune' | 'lastMoment' | 'allyResource';
const FLOAT_TEXT_STYLES: Record<FloatTextKind, { color: string; size: number; rise: number; duration: number }> = {
  interrupt: { color: '#e8d4ff', size: 20, rise: 34, duration: 900 },
  immune: { color: '#c8b0ff', size: 18, rise: 24, duration: 650 },
  lastMoment: { color: '#bfeaff', size: 26, rise: 46, duration: 1300 },
  /** Resource restored by a skeleton's kill (Eye of the Abyss): small, in the class resource colour (set per use). */
  allyResource: { color: '#9dffe0', size: 17, rise: 26, duration: 800 },
};
/** Class resource colours of the ally-kill popup (the HUD orb text colours). */
const RESOURCE_POPUP_COLORS: Readonly<Record<string, string>> = { rage: '#ffb45a', energy: '#e6f07a', mana: '#8fb3ff' };
/** Raised allies: how long their remains show after crumbling (timeout / cap) or shattering (killed). */
const ALLY_CRUMBLE_TIME = 1.0;
const ALLY_SHATTER_TIME = 0.45;
const ALLY_CRUMBLE_TINT = 0x5a7a70;
/** Seconds of the pale flash on an ally hit by an enemy. */
const ALLY_STRUCK = 0.15;
/** The mob corpse an ally rises from fades out this fast (the skeleton takes its place). */
const RAISED_CORPSE_TIME = 0.45;

/**
 * How ranked mobs stand out (visual only; their strength is core rank scaling). Their size is not here: the sprite
 * scales with the core body radius (MobState.radius / MobDef.radius), so what is drawn is what gets hit.
 */
const RANK_LOOKS: Readonly<Record<Exclude<MobRank, 'normal'>, { ring: number; tint: number }>> = {
  elite: { ring: 0xffc23a, tint: 0xfff0d0 },
  boss: { ring: 0xff3a2a, tint: 0xffd0c8 },
};

type Mechanics = Parameters<typeof distanceDamageMore>[0];
type Tags = Parameters<typeof distanceDamageMore>[1];

/** 0..1: share of the full distanceDamage bonus a projectile has built up (0 when the hero has none). Read from core. */
function farShotGlow(mechanics: Mechanics, tags: Tags, travelled: number): number {
  if (!mechanics.some((m) => m.kind === 'distanceDamage')) return 0;
  const full = distanceDamageMore(mechanics, tags, Number.POSITIVE_INFINITY);
  return full > 0 ? Math.min(1, distanceDamageMore(mechanics, tags, travelled) / full) : 0;
}

interface Actor {
  sprite: Phaser.GameObjects.Sprite;
  set: string;
  /** Interpolated (and for mobs smoothed) world position used for drawing. */
  display: Vec2;
  facing: Vec2;
  /** Sprite direction row, with hysteresis. */
  row: number;
  time: number;
  /** Run cycle phase, advanced proportionally to actual movement speed. */
  runPhase: number;
  moving: boolean;
  /** One-shot animation playing on top of idle/run. */
  oneShot: { anim: string; elapsed: number } | undefined;
  /** Frozen as of the last synced frame (mobs only): holds its pose, no hit reaction. */
  frozen: boolean;
  /** Displayed stun bar fill (mobs only), easing towards MobState.stunBar. */
  stunBarShown: number;
  /** Remaining full-bar flash after the stun bar stunned this mob (seconds, visual only). */
  stunBarFlash: number;
  /** Mob rank (core mobRank); 'normal' for the hero. */
  rank: MobRank;
  /** Drawn size relative to a normal mob: core body radius scale × the set's native scale; 1 for the hero. */
  scale: number;
  /**
   * Pose driven by core state every frame (ability wind-up, phase roar): `anim` shown at `progress` 0..1 of its
   * frames, so the release lands when the ability resolves. Overrides idle / run and one-shots except death.
   */
  pose: { anim: string; progress: number } | undefined;
  /** Minions: the mob that raised them (MobState.summonerId). */
  summonerId: number | undefined;
  /** Elites with a modifier (MobState.eliteModifier): its name over the life bar and the coloured glow outline. */
  elite: EliteMark | undefined;
}

interface EliteMark {
  readonly modifier: string;
  /** Its def converts damage to fire (fiery visuals) / makes it walk faster (speed streaks). */
  readonly fire: boolean;
  readonly fast: boolean;
  readonly label: Phaser.GameObjects.Text;
  readonly glow: Phaser.Filters.Glow | undefined;
}

interface Corpse {
  actor: Actor;
  ttl: number;
  /** Mob id it was (an ally may rise from it); undefined for allies' remains. */
  id?: number;
  /** Opacity it starts its fade from (translucent allies); default 1. */
  alpha?: number;
}

/** A raised ally on screen (Eye of the Abyss): an actor with the spectral look. */
interface AllyView {
  actor: Actor;
  glow: Phaser.Filters.Glow | undefined;
  /** Seconds left of the pale flash after an enemy hit. */
  struck: number;
}

interface AreaFx {
  origin: Vec2;
  facing: Vec2;
  radius: number;
  angleDeg: number;
  color: number;
  ttl: number;
}

/** Ignite damage dealt to one mob since its last damage number. */
interface DotTally {
  amount: number;
  timer: number;
  pos: Vec2;
  /** The last tick came from bleeding (red number) rather than ignite / ground zones. */
  bleed: boolean;
}

type OverlayKind = 'pause' | 'end';

/** How a touch skill press is aimed (RunScene.touchAims). */
interface TouchSkillAim {
  manual: boolean;
  /** Manual: world direction (unit). */
  readonly dir: Vec2;
  /** Manual, traps / Teleport: share of the reach (dragFraction). */
  fraction: number;
}

/** Lift of Chain Lightning bolts above the floor (screen px): roughly mid-body. */
const CHAIN_HEIGHT = 30;

type DamageNumberKind = 'hit' | 'crit' | 'player' | 'dot' | 'playerDot' | 'bleed' | 'heal' | 'lifeCost' | 'ally' | 'allyCrit' | 'allyHurt';

/** Visual-only damage number looks. */
const DAMAGE_NUMBER_STYLES: Record<DamageNumberKind, { color: string; size: number; rise: number; duration: number }> = {
  hit: { color: '#ffffff', size: 18, rise: 30, duration: 600 },
  crit: { color: '#ffd23f', size: 26, rise: 30, duration: 600 },
  player: { color: '#ff5050', size: 18, rise: 30, duration: 600 },
  dot: { color: '#ff9a3c', size: 14, rise: 20, duration: 700 },
  /** Damage over time on the hero (a fiery elite's burn): the incoming red, small like other DoT numbers. */
  playerDot: { color: '#ff5050', size: 14, rise: 20, duration: 700 },
  bleed: { color: '#ff6a6a', size: 14, rise: 20, duration: 700 },
  /** Life restored by a crit (Bloody Pupil): green, shown with a plus. */
  heal: { color: '#5cff8a', size: 16, rise: 34, duration: 700 },
  /** Life paid for a skill use (Rift Ring): a small red number with a minus, apart from hits taken. */
  lifeCost: { color: '#ff7070', size: 15, rise: 22, duration: 650 },
  /** A raised skeleton's hit on a mob: muted teal, a bit smaller than the hero's, so his own damage stays the loud one. */
  ally: { color: '#8fcfbf', size: 15, rise: 24, duration: 550 },
  allyCrit: { color: '#b8ffe8', size: 19, rise: 26, duration: 600 },
  /** Damage an enemy dealt to a skeleton: small and dusky, apart from the hero's red. */
  allyHurt: { color: '#b89a9a', size: 13, rise: 18, duration: 550 },
};

/** F wakes the altar: LMB / RMB / Q / E are the skills (CLAUDE.md), 1 drinks the life potion, R restarts, P opens the talents. */
type Keys = Record<'W' | 'A' | 'S' | 'D' | 'Q' | 'E' | 'R' | 'P' | 'F' | 'ESC' | 'ONE', Phaser.Input.Keyboard.Key>;

const NO_MOVE = vec(0, 0);
const NO_SKILLS: readonly boolean[] = [false, false, false];
const HUD_UI_DEPTH = 10010;

export interface RunSceneData {
  readonly characterId?: string;
  readonly mode?: RunMode;
  /** Map to enter; default (or a locked map): the hero's highest unlocked map. */
  readonly mapLevel?: number;
}

export class RunScene extends Phaser.Scene {
  private readonly content: Content = content;
  private characterId = '';
  private classId = 'warrior';
  private requestedMap: number | undefined;
  private run!: RunState;
  private world!: WorldState;
  /** finishRun result once the run is recorded (null: recorded without a hero, nothing granted). */
  private summary: RunSummary | null | undefined;
  /** The legendary drop flash / burst played for this run's chest (not again on an overlay rebuild). */
  private legendaryCelebrated = false;
  private overlayKind: OverlayKind | undefined;
  /** Support modifier visuals (chain bolts, echo ghost, knockback, bleed, support drops). */
  private supportFx!: SupportFx;
  private readonly chainXs: number[] = [];
  private readonly chainYs: number[] = [];
  private accumulator = 0;
  private alpha = 1;
  private prevPositions = new Map<number, Vec2>();
  private keys!: Keys;
  private hero!: Actor;
  private mobs = new Map<number, Actor>();
  /** Raised allies (Eye of the Abyss) by core ally id. */
  private allies = new Map<number, AllyView>();
  private allyFx!: AllyFx;
  private corpses: Corpse[] = [];
  private areas: AreaFx[] = [];
  private fx!: Phaser.GameObjects.Graphics;
  private fxTop!: Phaser.GameObjects.Graphics;
  /** Screen-edge arrow towards an open door out of view. */
  private pointer!: Phaser.GameObjects.Graphics;
  private light!: Phaser.GameObjects.Container;
  private room!: RoomView;
  /** Look of this run's zone (floor, walls, light), from the map level. */
  private env!: EnvironmentLook;
  private hud!: Hud;
  private runHud!: RunHud;
  private overlay: Phaser.GameObjects.GameObject[] | undefined;
  private paused = false;
  /** Sprite sets of this run: loaded with the scene (start) and in the background (boss). */
  private spriteSets: RunSpriteSets = { start: [], boss: [] };
  /** The boss's sheets were asked for (loadBossSprites); from then on they are re-requested until they land. */
  private bossSpritesWanted = false;
  /** Sets requested in the background whose load has not finished yet. */
  private loadingSets = new Set<string>();
  /** Scene time (ms) before which a set whose download failed is not requested again. */
  private spriteRetryAt = new Map<string, number>();
  /** Sets already reported missing (dev warning once per set). */
  private warnedSets = new Set<string>();
  private textPool: Phaser.GameObjects.Text[] = [];
  private combatFx!: CombatFx;
  /** Level-3 skill effect visuals (ground zones, decoy ghost, split / whirl / slam bursts). */
  private skillFx!: SkillFx;
  /** Boss / mob ability visuals (wind-up telegraphs, grave circles, nova, roar, crumbling minions). */
  private bossFx!: BossFx;
  /** Elite modifier visuals (glow, death circle and blast, fiery projectiles, hero burn, fast streaks). */
  private eliteFx!: EliteFx;
  private uniqueFx!: UniqueFx;
  private potionFx!: PotionFx;
  private soulFx!: SoulFx;
  /** Clock of the Last Moment: cheat-death trigger and the time-stop tint / dial. */
  private clockFx!: ClockFx;
  /** Mob marks and mob projectiles: under the time-stop tint (fxTop with the hero's effects stays above it). */
  private fxEnemy!: Phaser.GameObjects.Graphics;
  /** Ally ground rings while the time-stop tint is on: over the tint, just under the lifted ally sprites. */
  private fxAllyStop!: Phaser.GameObjects.Graphics;
  /**
   * Render clock of the enemies' looks (pulses, flicker, spins): runs with frame time, holds still while core time is
   * stopped (timeStopped), so frozen mobs, their projectiles and zones do not shimmer.
   */
  private enemyTime = 0;
  /** The hero sprite carries the burning tint (cleared once when the burn ends). */
  private heroTinted = false;
  /** Mob id → world time of its last "Immune" label. */
  private readonly immuneShown = new Map<number, number>();
  /** Ground zones and decoys alive in core (a room change drops them without expire events). */
  private readonly liveZones = new Set<number>();
  private readonly liveDecoys = new Set<number>();
  private dotTallies = new Map<number, DotTally>();
  private skillWasDown: boolean[] = [];
  private skillBuffer: number[] = [];
  /** The altar button was tapped: sent as RunInput.interact with the next step. */
  private interactQueued = false;
  /**
   * A potion press (key 1 pressed between steps, or a tap on the potion slot): sent as RunInput.potion with the next
   * step, so a tap shorter than a step is not lost (core drinks on the press edge).
   */
  private potionQueued = false;
  private mode: RunMode = SOLO_MODE;
  /** The passive tree is open over the run (the run keeps going only if the mode does not pause on menus). */
  private treeOpen = false;
  /** The tab lost focus or was hidden while the tree was open. */
  private pauseAfterTree = false;
  private treeButton: Phaser.GameObjects.Container | undefined;
  private pauseButton: Phaser.GameObjects.Container | undefined;
  /** Unspent talent points: a badge on the Talents button (the full banner is the hub's; in a run it would cover the fight). */
  private badge!: PointsBadge;
  /** The current mouse/touch press started on a HUD control, so it must not attack. */
  private uiPress = false;
  /** The hero's counter-attack animation and the direction it faces while it plays (core keeps the hero's facing). */
  private counterShot: Actor['oneShot'];
  private counterFacing: Vec2 = vec(1, 0);
  /** Center-screen announcement (room cleared, level up, …): one at a time, a new one replaces it. */
  private announcement: Phaser.GameObjects.Text[] = [];
  /** Where the boss died (the chest burst plays there). */
  private bossFall: Vec2 | undefined;
  /** Touch controls are on (phones / tablets, or ?touch=1): stick + buttons instead of mouse aim. */
  private touch = false;
  private touchControls: TouchControls | undefined;
  /** World camera zoom (phones: phoneLayout.runZoom) with the unzoomed HUD camera beside it. */
  private zoomView!: ZoomedWorldView;
  /** Touch auto-aim tuning at the current zoom: the "nearby" radius covers the same share of the screen. */
  private aimTuning: TouchControlsTuning = touchTuning;
  /** Scale of world-space text (damage numbers, names) that keeps its screen size under the zoom (1 / zoom). */
  private textScale = 1;
  /** Floor indicator of a drag-aimed skill. */
  private aimGfx!: Phaser.GameObjects.Graphics;
  /**
   * Per skill (0..2): how its last press is aimed (a drag: world direction + share of the reach; else auto-aim). Each
   * buffered press keeps its own aim; the step's aim is the one of the skill core will fire first (firstUsableSkill).
   */
  private readonly touchAims: TouchSkillAim[] = [0, 1, 2].map(() => ({ manual: false, dir: vec(1, 0), fraction: 1 }));
  /** Preallocated per-step arrays of the touch input (no allocations in the fixed step). */
  private readonly touchKeys: boolean[] = [false, false, false];
  private readonly touchSkills: boolean[] = [false, false, false];
  private readonly touchUsable: boolean[] = [false, false, false];
  /** Q / E held at the last step in touch mode (keyboards on tablets): their presses auto-aim like taps. */
  private readonly touchKeysWereDown: boolean[] = [false, false, false];
  /** Auto-aim only picks enemies on screen (designer decision 2026-10-26). */
  private readonly aimFilter = (target: AimTarget): boolean => onScreen(target, this.cameras.main.worldView);
  /** Skill buttons released since the last step: sent as one-step presses (then buffered like key taps). */
  private readonly touchTaps: boolean[] = [false, false, false];

  constructor() {
    super('run');
  }

  init(data: RunSceneData): void {
    if (data.characterId) this.characterId = data.characterId;
    this.mode = data.mode ?? SOLO_MODE;
    this.requestedMap = data.mapLevel;
    this.classId = findCharacter(getApp(this).profile, this.characterId)?.classId ?? 'warrior';
    this.summary = undefined;
  }

  preload(): void {
    getApp(this).platform.loadingStart();
    const character = findCharacter(getApp(this).profile, this.characterId);
    // Only the floor of this map's zone (the other zone's tiles are not downloaded until it is played).
    const floor = environmentAt(this.resolveMapLevel(character)).floor;
    if (!this.textures.exists(floor.texture)) this.load.spritesheet(floor.texture, floor.path, { frameWidth: 192, frameHeight: 96 });
    // Only what this map can show before the boss; the boss's sheets load in the background later (loadBossSprites).
    const allies = character ? heroMechanics(character, passiveTree, itemsData).flatMap((m) => (m.kind === 'raiseAllies' ? [m.mobId] : [])) : [];
    this.spriteSets = runSpriteSets(this.content, mapsData.rules, this.resolveMapLevel(character), this.heroSet(), allies);
    this.bossSpritesWanted = false;
    this.loadingSets.clear();
    this.spriteRetryAt.clear();
    // The other heroes (menus) and mobs of an earlier, harder map are not drawn here: free their GPU memory.
    unloadSprites(this, [...this.spriteSets.start, ...this.spriteSets.boss]);
    loadSprites(this, this.spriteSets.start);
  }

  private heroSet(): string {
    return CLASS_LOOKS.find((l) => l.classId === this.classId)?.sprite ?? 'knight';
  }

  /** The requested map if the hero may enter it, else their highest unlocked one (map 1 without a hero). */
  private resolveMapLevel(character: ReturnType<typeof findCharacter>): number {
    const requested = this.requestedMap;
    return character ? (requested !== undefined && canEnterMap(character, requested) ? requested : unlockedMap(character)) : 1;
  }

  /** Nearest filtering on every loaded sprite sheet of `sets` (pixel look). */
  private sharpenSprites(sets: readonly string[]): void {
    for (const set of sets) for (const key of loadedSpriteKeys(this, set)) sharpen(this.textures.get(key));
  }

  /**
   * Loads the sheets of `sets` in the background (missing ones only). A set already loading is not queued twice; one
   * whose download failed is asked for again after SPRITE_RETRY_MS (onSpriteLoadError).
   */
  private requestSprites(sets: readonly string[]): void {
    const now = this.time.now;
    const missing = sets.filter((set) => !spritesLoaded(this, set) && !this.loadingSets.has(set) && (this.spriteRetryAt.get(set) ?? 0) <= now);
    if (missing.length === 0) return;
    for (const set of missing) this.loadingSets.add(set);
    if (loadSprites(this, missing) > 0) this.load.start();
  }

  /** Background loads: every finished batch is sharpened; a failed sheet frees its set for a retry later. */
  private listenToSpriteLoads(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      const set = spriteSetOf(file.key);
      if (set === undefined) return;
      // One report per set and attempt (an atlas fails as image and JSON, a set has several sheets).
      const first = (this.spriteRetryAt.get(set) ?? 0) <= this.time.now;
      this.spriteRetryAt.set(set, this.time.now + SPRITE_RETRY_MS);
      if (import.meta.env.DEV && first) console.warn(`Sprite set ${set} failed to load (${file.key}); retrying in ${SPRITE_RETRY_MS / 1000} s`);
    });
    this.load.on(Phaser.Loader.Events.COMPLETE, () => {
      this.sharpenSprites([...this.loadingSets]);
      this.loadingSets.clear();
    });
  }

  /**
   * Asks for the boss's sheets once the first room is cleared (a calm moment; the downloads, decoding and GPU uploads
   * then never compete with the opening fight), or on entering the boss room at the latest; re-asks until they land.
   */
  private loadBossSprites(): void {
    if (!this.bossSpritesWanted && this.run.phase === 'waves' && currentTemplate(this.run, mapsData).kind !== 'boss') return;
    this.bossSpritesWanted = true;
    this.requestSprites(this.spriteSets.boss);
  }

  /**
   * The boss can be shown: the altar only wakes when its sheets are in (a slow or failed download holds the summoning
   * with a loading mark at the altar instead of letting an invisible boss fight).
   */
  private bossReady(): boolean {
    return this.spriteSets.boss.every((set) => spritesLoaded(this, set));
  }

  /** `set` is drawable; otherwise it is requested on demand (it should have been loaded up front: dev warning). */
  private ensureSprites(set: string): boolean {
    if (spritesLoaded(this, set)) return true;
    if (import.meta.env.DEV && !this.warnedSets.has(set) && !this.spriteSets.boss.includes(set)) {
      this.warnedSets.add(set);
      console.warn(`Sprite set ${set} was not preloaded for this run; loading it on demand`);
    }
    this.requestSprites([set]);
    return false;
  }

  create(): void {
    getApp(this).platform.loadingStop();
    const character = findCharacter(getApp(this).profile, this.characterId);
    const classDef = getClass(this.content, this.classId);
    // Equipment and passives enter the run as modifiers, plus the equipped weapon.
    const loadout = character
      ? {
          level: character.level,
          xp: character.xp,
          modifiers: heroModifiers(character, itemsData, passiveTree),
          mechanics: heroMechanics(character, passiveTree, itemsData),
          weapon: equippedWeapon(character.equipment, itemsData, classDef.weapon),
          skills: character.skills,
          // Socketed skill modifiers change the skills for the whole run (they are swapped only in the hub).
          supports: socketedSupports(character),
        }
      : {};
    this.run = createRun(this.content, mapsData, this.classId, (Math.random() * 2 ** 32) >>> 0, loadout, this.resolveMapLevel(character));
    this.world = this.run.world;
    this.summary = undefined;
    this.legendaryCelebrated = false;
    this.overlayKind = undefined;
    // Dev-only handles for debugging and automated checks from the console.
    if (import.meta.env.DEV) Object.assign(window as object, { __world: this.world, __run: this.run });
    this.accumulator = 0;
    this.alpha = 1;
    this.prevPositions.clear();
    this.mobs.clear();
    this.allies.clear();
    this.corpses = [];
    this.areas = [];
    this.textPool = [];
    this.dotTallies.clear();
    this.liveZones.clear();
    this.liveDecoys.clear();
    this.skillWasDown = [];
    this.skillBuffer = [];
    this.interactQueued = false;
    this.potionQueued = false;
    this.counterShot = undefined;
    this.announcement = [];
    this.bossFall = undefined;
    this.touch = touchControlsOn(this.game);
    for (const a of this.touchAims) a.manual = false;
    this.touchTaps.fill(false);
    this.touchKeysWereDown.fill(false);

    this.sharpenSprites(Object.keys(SPRITE_SETS));
    this.listenToSpriteLoads();

    this.input.mouse?.disableContextMenu();
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,Q,E,R,P,F,ESC,ONE') as Keys;
    this.input.on('pointerdown', (_p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => (this.uiPress = over.length > 0));
    this.input.on('pointerup', () => (this.uiPress = false));

    this.room = new RoomView(this);
    this.fx = this.add.graphics().setDepth(-1000);
    this.fxTop = this.add.graphics().setDepth(4000);
    this.fxEnemy = this.add.graphics().setDepth(ENEMY_FX_DEPTH);
    this.fxAllyStop = this.add.graphics().setDepth(HERO_STOP_DEPTH - 2);
    this.enemyTime = 0;
    this.combatFx = new CombatFx(this);
    this.skillFx = new SkillFx(this);
    this.bossFx = new BossFx(this);
    this.eliteFx = new EliteFx(this);
    this.uniqueFx = new UniqueFx(this);
    this.potionFx = new PotionFx(this);
    this.soulFx = new SoulFx(this);
    this.clockFx = new ClockFx(this);
    this.allyFx = new AllyFx(this);
    this.heroTinted = false;
    this.immuneShown.clear();
    this.supportFx = new SupportFx(this);
    this.hero = this.createActor(this.heroSet(), this.world.player.pos);
    this.env = environmentAt(this.run.mapLevel);
    this.light = this.createLight(this.env);
    this.cameras.main.setBackgroundColor(this.env.light.background);
    this.buildRoom();

    this.hud = new Hud(this, getClass(this.content, this.classId), this.content.progression, this.content.skillLevels, this.content, () => {
      // Tap / click on the potion slot (the mobile hook until the touch controls of 0.5).
      if (!this.paused && !this.treeOpen && !this.ended()) this.potionQueued = true;
    });
    this.runHud = new RunHud(this, mapsData, () => (this.interactQueued = true), this.content);
    this.aimGfx = this.add.graphics().setDepth(-999);
    this.touchControls = this.touch
      ? new TouchControls(
          this,
          () => this.hud.touchButtons(),
          touchTuning,
          (slot, state) => this.hud.setSlotState(slot, state),
          (slot) => {
            const action = this.world.player.actions.skills[slot - 1];
            return action !== undefined && isDistanceAimed(action.delivery);
          },
        )
      : undefined;
    this.pointer = pinToScreen(this.add.graphics(), HUD_UI_DEPTH - 2);
    this.overlay = undefined;
    this.paused = false;
    this.treeOpen = false;
    this.pauseAfterTree = false;
    this.uiPress = false;
    this.treeButton = undefined;
    this.pauseButton = undefined;
    this.badge = new PointsBadge(this, HUD_UI_DEPTH + 2);
    this.zoomView = new ZoomedWorldView(this);
    this.layoutUi();
    this.refreshBanner();
    const relayout = (): void => {
      // Rotation / resize mid-press: the buttons moved, so drop every finger (no casts) instead of keeping stale spots.
      this.touchControls?.reset();
      this.layoutUi();
      // Paused (pause menu, tree): update() draws nothing, so redraw the view for the new size once now (the full
      // screen toggle in the pause menu resizes while paused). Visual only, no simulation step.
      this.redrawStill();
      if (this.overlay && this.overlayKind) this.showOverlay(this.overlayKind);
    };
    this.scale.on('resize', relayout);
    // Leaving the tab pauses the run (and tells the portal gameplay stopped).
    const autoPause = (): void => {
      // With the tree open, remember it: closing the tree must not resume a run nobody is watching.
      if (this.treeOpen) this.pauseAfterTree = true;
      else if (!this.paused && !this.ended()) this.setPaused(true);
    };
    const back = (): void => {
      this.pauseAfterTree = false;
    };
    this.game.events.on(Phaser.Core.Events.BLUR, autoPause);
    this.game.events.on(Phaser.Core.Events.HIDDEN, autoPause);
    this.game.events.on(Phaser.Core.Events.FOCUS, back);
    this.game.events.on(Phaser.Core.Events.VISIBLE, back);
    // A phone turned upright gets the portrait cover (orientationGate.ts): pause like leaving the tab; turning back
    // keeps the pause menu open (the player resumes when ready).
    const turned = (portrait: boolean): void => {
      if (portrait) autoPause();
    };
    this.game.events.on(ORIENTATION_BLOCKED, turned);

    this.setGameplay(true);
    // Started while the cover is up (it went up during the scene switch): begin paused.
    if (orientationBlocked()) autoPause();
    this.zoomView.fadeIn(SCREEN_FADE, 10, 9, 12);
    this.events.once('shutdown', () => {
      this.scale.off('resize', relayout);
      this.game.events.off(Phaser.Core.Events.BLUR, autoPause);
      this.game.events.off(Phaser.Core.Events.HIDDEN, autoPause);
      this.game.events.off(Phaser.Core.Events.FOCUS, back);
      this.game.events.off(Phaser.Core.Events.VISIBLE, back);
      this.game.events.off(ORIENTATION_BLOCKED, turned);
      if (this.treeOpen) this.scene.stop('passive-tree');
      this.treeOpen = false;
      // Leaving mid-run (closing the screen) records it as abandoned.
      this.recordRun();
    });
  }

  /** The run is over (won or failed); only its end screen is left. */
  private ended(): boolean {
    return this.run.status !== 'active';
  }

  /** Draws the room the hero is in and fits the camera to it. */
  private buildRoom(): void {
    const t = currentTemplate(this.run, mapsData);
    this.room.build(t, mapsData.rules.doorRadius, mapsData.rules.altarRadius, this.env);
    const b = this.room.cameraBounds();
    this.cameras.main.setBounds(b.x, b.y, b.width, b.height);
    this.hero.display = this.world.player.pos;
    const s = toScreen(this.hero.display);
    this.cameras.main.centerOn(s.x, s.y - 30);
    this.fitRoomView();
  }

  /** Sizes the ground beyond the room to the view at the current zoom (on build and on resize). */
  private fitRoomView(): void {
    const cam = this.cameras.main;
    this.room.fitView(this.scale.width / cam.zoom, this.scale.height / cam.zoom);
  }

  /** Everything of the previous room is gone in core: drop its sprites and effects too, without interpolation. */
  private enterRoom(): void {
    for (const actor of this.mobs.values()) {
      actor.elite?.label.destroy();
      actor.sprite.destroy();
    }
    this.mobs.clear();
    // Raised allies stay behind (core clears WorldState.allies without expire events).
    for (const view of this.allies.values()) view.actor.sprite.destroy();
    this.allies.clear();
    this.allyFx.clear();
    for (const corpse of this.corpses) corpse.actor.sprite.destroy();
    this.corpses = [];
    this.areas = [];
    this.dotTallies.clear();
    this.prevPositions.clear();
    for (const id of this.liveZones) this.skillFx.zoneExpired(id);
    for (const id of this.liveDecoys) this.skillFx.decoyExpired(id);
    this.liveZones.clear();
    this.liveDecoys.clear();
    this.counterShot = undefined;
    this.supportFx.clearRoom();
    this.bossFx.clear();
    this.eliteFx.clear();
    this.uniqueFx.clear();
    this.potionFx.clear();
    this.soulFx.clear();
    this.clockFx.clear(timeStopped(this.world));
    this.immuneShown.clear();
    this.buildRoom();
    this.zoomView.fadeIn(ROOM_FADE, 7, 7, 10);
  }

  /** Top right buttons (Talents with the unspent points badge), the run HUD in the top centre. */
  private layoutUi(): void {
    const { width, height } = this.scale;
    const compact = width < 820 || height < 520;
    const phone = densityOf(width, height, compact) === 'phone';
    const margin = phone ? 8 : compact ? 12 : 22;
    // Touch layout keeps out of the notch / home indicator (zero inside the portal iframe).
    const insets = this.touch ? safeInsets(this.game.canvas) : undefined;
    // Phones see more of the room (data/controls phoneLayout.runZoom); world text and the auto-aim radius follow.
    // Keyed on the device, not the canvas: a desktop in a short window or a small portal iframe keeps zoom 1.
    const zoom = isPhone(this.game) ? phoneLayout.runZoom : 1;
    this.zoomView.set(zoom, width, height);
    this.fitRoomView();
    this.textScale = 1 / zoom;
    this.aimTuning = zoom === 1 ? touchTuning : { ...touchTuning, autoAimRadius: touchTuning.autoAimRadius / zoom };
    for (const actor of this.mobs.values()) actor.elite?.label.setScale(this.textScale);
    this.light.setScale(this.textScale);
    this.supportFx.setTextScale(this.textScale);
    this.hud.layout(width, height, insets);
    this.clockFx.layout(width, height, zoom);
    this.treeButton?.destroy();
    this.treeButton = undefined;
    this.pauseButton?.destroy();
    this.pauseButton = undefined;
    // Phones: square icon buttons (designer decision 2026-10-27), at least the touch minimum.
    const h = phone ? TOUCH_MIN : compact ? 34 : 40;
    const w = phone ? h : compact ? 96 : 150;
    const pw = phone ? h : compact ? 84 : 120;
    const right = margin + (insets?.right ?? 0);
    const buttonY = margin + (phone ? h / 2 - 2 : 18) + (insets?.top ?? 0);
    const hasHero = findCharacter(getApp(this).profile, this.characterId) !== undefined;
    const buttonGap = phone ? 8 : 10;
    const reserved = right + w + buttonGap + pw;
    // Narrow portrait phones: the corner buttons would cover the timer, so the run HUD starts under them.
    const crowded = hasHero && width - 2 * reserved < MIN_HEADER_WIDTH;
    const headerTop = (insets?.top ?? 0) + (crowded ? buttonY + h / 2 + 2 : 0);
    // Under the buttons the centre column only keeps clear of the touch layout's orbs in the top left.
    const sideReserved = crowded ? (this.touch ? this.hud.touchOrbsRight() + 8 : 0) : reserved;
    this.runHud.layout(width, height, sideReserved, this.touch ? this.hud.touchClusterTop() : undefined, headerTop);
    if (!hasHero) return;
    // Key names only with the keyboard layout.
    const keyCaptions = !compact && !this.touch;
    const openTree = (): void => this.openTree();
    const pause = (): void => {
      if (!this.paused && !this.treeOpen && !this.ended()) this.setPaused(true);
    };
    const treeX = width - right - w / 2;
    const pauseX = width - right - w - buttonGap - pw / 2;
    this.treeButton = pinToScreen(
      phone ? makeIconButton(this, treeX, buttonY, w, 'talents', openTree) : makeButton(this, treeX, buttonY, w, h, keyCaptions ? t('arena.talentsKey') : t('arena.talents'), openTree),
      HUD_UI_DEPTH,
    );
    // Touch has no Esc: the pause menu (and with it "end the run") needs a button.
    this.pauseButton = pinToScreen(
      phone ? makeIconButton(this, pauseX, buttonY, pw, 'pause', pause) : makeButton(this, pauseX, buttonY, pw, h, keyCaptions ? t('arena.pauseKey') : t('arena.pause'), pause),
      HUD_UI_DEPTH,
    );
    // The unspent points badge sits on the Talents button's top right corner.
    this.badge.setPosition(width - right - 4, buttonY - h / 2 + 4, compact ? 10 : 12);
  }

  private refreshBanner(): void {
    const character = findCharacter(getApp(this).profile, this.characterId);
    if (!character) return;
    const hero = { classId: character.classId, level: this.world.player.level, passives: character.passives };
    const { points, specPoints } = unspentPoints(passiveTree, hero);
    this.badge.setPoints(points, specPoints);
  }

  /** Opens the passive tree over the run; whether the run pauses is the mode's rule. */
  private openTree(): void {
    if (this.treeOpen || this.paused || this.ended()) return;
    const app = getApp(this);
    if (!findCharacter(app.profile, this.characterId)) return;
    this.treeOpen = true;
    const run: RunTreeHooks = {
      level: () => this.world.player.level,
      changed: () => this.applyPassives(true),
      closed: () => this.closeTree(),
    };
    if (this.mode.pauseOnMenus) {
      this.setGameplay(false);
      this.scene.pause();
    }
    const data: PassiveTreeSceneData = { characterId: this.characterId, run };
    this.scene.launch('passive-tree', data);
  }

  /** Feeds the changed allocation into the running world (stats update at once) and optionally saves. */
  private applyPassives(save: boolean): void {
    const app = getApp(this);
    const character = findCharacter(app.profile, this.characterId);
    if (!character) return;
    // Points spent mid-run come from levels gained in this run: store that progress with them,
    // otherwise the saved allocation would exceed the saved level and be reset on the next load.
    character.level = this.world.player.level;
    character.xp = this.world.player.xp;
    setLoadoutModifiers(this.world, this.content, heroModifiers(character, itemsData, passiveTree), heroMechanics(character, passiveTree, itemsData));
    this.refreshBanner();
    if (save) app.save();
  }

  private closeTree(): void {
    this.treeOpen = false;
    this.applyPassives(false);
    const away = this.pauseAfterTree || document.hidden || orientationBlocked();
    this.pauseAfterTree = false;
    if (this.mode.pauseOnMenus) this.scene.resume();
    if (away && !this.ended()) {
      // Back to the pause menu instead of live play; gameplay stays stopped for the portal.
      this.paused = true;
      this.setGameplay(false);
      this.showOverlay('pause');
    } else if (this.mode.pauseOnMenus) {
      this.setGameplay(true);
    }
    // Keys and buttons held when the tree opened must not fire now.
    this.input.keyboard?.resetKeys();
    this.skillBuffer = [];
    this.skillWasDown = [];
    this.interactQueued = false;
    this.potionQueued = false;
    this.uiPress = false;
    for (const a of this.touchAims) a.manual = false;
    this.touchTaps.fill(false);
    this.touchKeysWereDown.fill(false);
    this.touchControls?.reset();
    this.accumulator = 0;
  }

  /**
   * Tells the portal gameplay started / stopped. Pause, tree and run end can overlap: the platform passes on only
   * changes (EventGuardPlatform), so repeats here are harmless.
   */
  private setGameplay(active: boolean): void {
    const platform = getApp(this).platform;
    if (active) platform.gameplayStart();
    else platform.gameplayStop();
  }

  private setPaused(paused: boolean): void {
    // A phone held upright (portrait cover up): stay paused until it is turned back and the player resumes.
    if (!paused && orientationBlocked()) return;
    this.paused = paused;
    if (paused) {
      this.setGameplay(false);
      this.showOverlay('pause');
    } else {
      this.setGameplay(true);
      this.hideOverlay();
      this.accumulator = 0;
    }
  }

  /**
   * Pause menu and the end of the run: the chest of a won run, the consolation of a failed one (docs/design/maps.md).
   * Supports found during the run are kept unless the hero died or the run was abandoned (core keepsSupportDrops).
   */
  private showOverlay(kind: OverlayKind): void {
    this.hideOverlay();
    this.overlayKind = kind;
    const { width, height } = this.scale;
    const compact = width < 820 || height < 520;
    const phone = densityOf(width, height, compact) === 'phone';
    const died = kind === 'end' && this.run.failReason === 'death';
    const objects: Phaser.GameObjects.GameObject[] = [];
    const shade = this.add.rectangle(width / 2, height / 2, width, height, died ? 0x1a0303 : 0x000000, died ? 0.6 : 0.55).setInteractive();
    objects.push(shade);
    const panelW = Math.min(460, width - 32);

    // Body lines first, so the panel can size (and on short screens trim the lists) before anything is placed.
    const lines: Line[] = [];
    // Lines wrap at the panel width (long item names, longer translations): measure the wrapped height once per line.
    const probe = label(this, 0, 0, '', UI.size.body).setVisible(false).setWordWrapWidth(panelW - 32);
    const measured = new Map<Line, number>();
    const lineH = (l: Line): number => {
      let h = measured.get(l);
      if (h === undefined) {
        probe.setFontSize(l.size).setFontStyle(l.bold ? 'bold' : 'normal').setText(l.text);
        h = l.heading ? l.size + 8 : Math.max(l.size + 6, probe.height + 4);
        measured.set(l, h);
      }
      return h + (l.gap ?? 0);
    };
    const headerH = phone ? 46 : compact ? 56 : 78;
    // Key hints (R / Esc) only where there is a keyboard: touch screens get the room for the reward list instead.
    const keyHints = !this.touch;
    const footerH = (compact ? (keyHints ? 92 : 66) : keyHints ? 116 : 86) - (phone ? 10 : 0);
    if (kind === 'pause') {
      const pending = this.world.supportDrops.length;
      if (pending > 0) {
        lines.push({ text: t('arena.found', { supports: supportsWord(pending) }), size: UI.size.body, color: UI.goldBrightText, bold: true });
        lines.push({ text: t('arena.foundWarning'), size: UI.size.small, color: UI.muted });
      }
    } else {
      const { fixed, list, notes } = this.endLines(compact);
      // Trim the list on short screens: the fixed parts always fit, the rest becomes "and N more".
      const fixedH = headerH + footerH + [...fixed, ...notes].reduce((h, l) => h + lineH(l), 0);
      const room = Math.max(1, Math.floor((height - 12 - fixedH) / (UI.size.body + 6)));
      if (list.length > room) {
        const hidden = list.length - (room - 1);
        list.length = room - 1;
        list.push({ text: t('arena.more', { count: hidden }), size: UI.size.small, color: UI.muted });
      }
      lines.push(...fixed, ...list, ...notes);
    }
    const bodyH = lines.reduce((h, l) => h + lineH(l), 0);
    probe.destroy();
    const panelH = Math.min(height - 8, headerH + bodyH + footerH);
    objects.push(makeFrame(this, width / 2, height / 2, panelW, panelH, 'panel'));
    const top = height / 2 - panelH / 2;
    objects.push(heading(this, width / 2, top + (phone ? 23 : compact ? 28 : 40), this.overlayTitle(kind), phone ? 22 : compact ? 26 : 34).setOrigin(0.5));
    let y = top + headerH;
    let banner: Phaser.GameObjects.Text | undefined;
    for (const l of lines) {
      y += l.gap ?? 0;
      const text = l.heading ? heading(this, width / 2, y, l.text, l.size) : label(this, width / 2, y, l.text, l.size, l.color, l.bold);
      objects.push(text.setOrigin(0.5, 0));
      if (!l.heading) text.setWordWrapWidth(panelW - 32).setAlign('center');
      if (l.legendary) banner = text.setStroke('#2a0820', 5);
      y += lineH(l) - (l.gap ?? 0);
    }

    const buttonW = Math.min(200, (panelW - 48) / 2);
    const buttonH = phone ? 40 : compact ? 44 : 52;
    const buttonY = top + panelH - (phone ? 32 : compact ? 38 : 50);
    if (kind === 'pause') {
      // Full screen toggle in the panel's top right corner (hidden where the browser has no element full screen).
      const fsSize = phone ? 30 : compact ? 34 : 38;
      const fsInset = phone ? 8 : 12;
      const fullscreen = makeFullscreenButton(this, width / 2 + panelW / 2 - fsSize / 2 - fsInset, top + fsSize / 2 + fsInset, fsSize);
      if (fullscreen) objects.push(fullscreen);
      objects.push(makeButton(this, width / 2 + buttonW / 2 + 6, buttonY, buttonW, buttonH, t('arena.resume'), () => this.setPaused(false), 'primary'));
      objects.push(makeButton(this, width / 2 - buttonW / 2 - 6, buttonY, buttonW, buttonH, t('arena.endRun'), () => this.confirmAbandon()));
    } else {
      const next = this.nextRun();
      objects.push(makeButton(this, width / 2 + buttonW / 2 + 6, buttonY, buttonW, buttonH, next.caption, () => this.restartRun(next.map), 'primary'));
      objects.push(makeButton(this, width / 2 - buttonW / 2 - 6, buttonY, buttonW, buttonH, t('arena.toHub'), () => this.leaveToMenu()));
    }
    const hint = kind === 'pause' ? t('arena.hintPause') : this.nextRun().hint;
    if (keyHints) objects.push(label(this, width / 2, buttonY - (compact ? 36 : 46), hint, UI.size.small, UI.muted).setOrigin(0.5));
    for (const o of objects) pinToScreen(o, 20000);
    const fadeTargets = objects.slice(1);
    for (const o of fadeTargets) (o as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(0);
    this.tweens.add({ targets: fadeTargets, alpha: 1, duration: died ? 600 : 180, delay: died ? 500 : 0 });
    if (banner) objects.push(...this.celebrateLegendary(banner));
    this.overlay = objects;
  }

  /**
   * Legendary drop on the chest screen: the banner pulses; the first time this run's chest is shown also a screen
   * flash and a particle burst from the banner (not again when the overlay is rebuilt on resize). No sound yet.
   * Returns objects to destroy with the overlay.
   */
  private celebrateLegendary(banner: Phaser.GameObjects.Text): Phaser.GameObjects.GameObject[] {
    const pulse = this.tweens.add({ targets: banner, scale: 1.08, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: 200 });
    banner.once('destroy', () => pulse.remove());
    if (this.legendaryCelebrated) return [];
    this.legendaryCelebrated = true;
    const [r, g, b] = LEGENDARY_FLASH;
    this.cameras.main.flash(LEGENDARY_FLASH_MS, r, g, b);
    const x = banner.x;
    const y = banner.y + banner.height / 2;
    const burst = this.add.particles(x, y, softDotTexture(this), {
      emitting: false,
      speed: { min: 120, max: 360 },
      angle: { min: 0, max: 360 },
      gravityY: 160,
      scale: { start: 0.45, end: 0 },
      alpha: { start: 1, end: 0 },
      color: [0xffffff, 0xffb8ef, 0xff5fd2, 0xb46cff],
      lifespan: { min: 600, max: 1200 },
      blendMode: Phaser.BlendModes.ADD,
    });
    pinToScreen(burst, 20001);
    burst.explode(LEGENDARY_PARTICLES);
    return [burst];
  }

  private overlayTitle(kind: OverlayKind): string {
    if (kind === 'pause') return t('arena.titlePause');
    if (this.run.status === 'won') return t('run.titleWon', { map: this.run.mapLevel });
    if (this.run.failReason === 'death') return t('arena.titleDeath');
    if (this.run.failReason === 'timeout') return t('run.titleTimeout');
    return t('run.titleAbandoned');
  }

  /** The end screen's primary action: the newly unlocked map, else the same map again. */
  private nextRun(): { map: number; caption: string; hint: string } {
    const unlocked = this.summary?.unlockedMap ?? null;
    if (unlocked !== null) return { map: unlocked, caption: t('run.nextMap', { map: unlocked }), hint: t('run.hintNext') };
    const won = this.run.status === 'won';
    return { map: this.run.mapLevel, caption: won ? t('run.again') : t('arena.retry'), hint: won ? t('run.hintAgain') : t('arena.hintRetry') };
  }

  /**
   * End screen text: run summary and XP, the unlocked map, then the chest / consolation (list: items and kept
   * supports, trimmed on short screens), then notes (stash full, supports lost).
   */
  private endLines(compact: boolean): { fixed: Line[]; list: Line[]; notes: Line[] } {
    const run = this.run;
    const world = this.world;
    const summary = this.summary ?? undefined;
    const fixed: Line[] = [];
    const small = UI.size.small;
    const body = compact ? UI.size.small : UI.size.body;
    fixed.push({ text: t('run.summary', { time: formatElapsed(run.elapsed), kills: t('unit.kills', { count: world.kills }) }), size: small, color: UI.muted });
    fixed.push({ text: t('arena.xp', { xp: Math.floor(world.xpGained + run.bonusXp), level: world.player.level }), size: body, color: UI.goldBrightText, bold: true });
    // Phones: the XP line already includes the bonus; the room goes to the chest list instead.
    if (run.bonusXp > 0 && !compact) fixed.push({ text: t('run.bonusXp', { xp: Math.floor(run.bonusXp) }), size: small, color: UI.muted });
    if (summary?.unlockedMap) fixed.push({ text: t('run.unlocked', { map: summary.unlockedMap }), size: body + 2, color: UI.goldBrightText, bold: true, gap: 4 });
    fixed.push({ text: run.status === 'won' ? t('run.chest') : t('run.consolation'), size: compact ? 18 : 20, color: UI.goldBrightText, heading: true, gap: compact ? 4 : 8 });
    const tier = summary?.plan.speedTier;
    if (tier && tier.extraItems > 0) fixed.push({ text: t('run.fastClear', { count: tier.extraItems }), size: small, color: UI.goldText, bold: true });
    const rewards = summary?.rewards;
    const shards = rewards?.shards ?? 0;
    const essence = rewards?.essence ?? 0;
    const currency: string[] = [];
    if (shards > 0) currency.push(currencyWord(SALVAGE_CURRENCY, shards));
    if (essence > 0) currency.push(currencyWord(ESSENCE_CURRENCY, essence));
    const items = rewards?.items ?? [];
    if (currency.length === 2) fixed.push({ text: t('run.currency', { shards: currency[0]!, essence: currency[1]! }), size: body, color: UI.text, bold: true });
    else if (currency.length === 1) fixed.push({ text: `+${currency[0]!}`, size: body, color: UI.text, bold: true });

    // A legendary drop: a banner under the chest heading (showOverlay adds the flash and the burst), and the item goes
    // first in the list so trimming on a short screen never hides it.
    const legendaryId = rewards?.legendaryId;
    if (legendaryId && items.some((i) => i.id === legendaryId)) {
      fixed.push({ text: upper(t('run.legendary')), size: compact ? 24 : 30, color: UI.rarity.legendary, bold: true, gap: 2, legendary: true });
    }
    const list: Line[] = [];
    const ordered = legendaryId ? [...items.filter((i) => i.id === legendaryId), ...items.filter((i) => i.id !== legendaryId)] : items;
    for (const item of ordered) {
      // Rares and uniques: own name with the base type (a unique without text is already named by its base).
      const own = itemName(item);
      const base = baseName(item.baseId);
      const name = (item.rarity === 'rare' || item.unique) && own !== base ? t('arena.lootRare', { name: own, base }) : own;
      list.push({ text: t('arena.lootItem', { name, level: item.level }), size: body, color: UI.rarity[item.rarity], bold: true });
    }
    const supports = this.content.supports?.supports ?? {};
    for (const s of summary?.supports?.kept ?? []) {
      const def = supports[s.defId];
      if (def) list.push({ text: `◆ ${supportTitle(def, s.tier)}`, size: body, color: tierColor(s.tier), bold: true });
    }
    const notes: Line[] = [];
    if (list.length === 0 && currency.length === 0) notes.push({ text: t('run.nothing'), size: small, color: UI.muted });
    const salvagedShards = Math.max(0, shards - (summary?.plan.shards ?? 0));
    if ((rewards?.salvagedIds.length ?? 0) > 0) notes.push({ text: t('arena.stashFull', { shards: shardsWord(salvagedShards) }), size: small, color: UI.muted });
    // Uniques / legendaries that did not fit wait in the mail (claimed in the inventory); mail items that took room
    // freed before the chest are mentioned too.
    const toMail = rewards?.overflowIds.length ?? 0;
    if (toMail > 0) notes.push({ text: t('run.mailWaiting', { count: toMail }), size: small, color: UI.goldText, bold: true });
    const fromMail = summary?.claimedFromOverflow.length ?? 0;
    if (fromMail > 0) notes.push({ text: t('inv.mailMoved', { count: fromMail }), size: small, color: UI.muted });
    const tabSalvaged = summary?.supports?.salvagedCount ?? 0;
    if (tabSalvaged > 0) notes.push({ text: t('arena.tabFull', { supports: supportsWord(tabSalvaged), shards: shardsWord(summary?.supports?.shards ?? 0) }), size: small, color: UI.muted });
    const found = world.supportDrops.length;
    if (found > 0 && !keepsSupportDrops(run)) {
      const text = run.failReason === 'death' ? t('arena.lost', { supports: supportsWord(found) }) : t('run.lostAbandoned', { supports: supportsWord(found) });
      notes.push({ text, size: small, color: UI.danger, bold: true });
    }
    return { fixed, list, notes };
  }

  /** "End run" from the pause menu: confirm first (it fails the run and loses found supports), then abandon. */
  private confirmAbandon(): void {
    const pending = this.world.supportDrops.length;
    const message = pending > 0 ? `${t('run.abandonConfirm')}\n${t('run.abandonSupports', { supports: supportsWord(pending) })}` : t('run.abandonConfirm');
    confirmDialog(this, message, t('arena.endRun'), () => this.handleEvents(abandonRun(this.run)), undefined, 21000);
  }

  private hideOverlay(): void {
    for (const o of this.overlay ?? []) o.destroy();
    this.overlay = undefined;
  }

  private restartRun(mapLevel: number): void {
    const data: RunSceneData = { characterId: this.characterId, mode: this.mode, mapLevel };
    this.scene.restart(data);
  }

  private leaveToMenu(): void {
    this.recordRun();
    this.zoomView.fadeOut(SCREEN_EXIT, 10, 9, 12);
    this.cameras.main.once('camerafadeoutcomplete', () => this.scene.start('main-menu'));
  }

  /** Records the run once (finishRun: rewards, map unlock, supports) and tells the portal gameplay stopped. */
  private recordRun(): void {
    if (this.summary !== undefined) return;
    const app = getApp(this);
    this.setGameplay(false);
    this.summary = finishRun(app.profile, this.characterId, this.run, { maps: mapsData, items: itemsData, classes: this.content.classes, ...(this.content.supports ? { supports: this.content.supports } : {}) });
    app.save();
    // PROPOSAL (docs/design/account.md): the first finished run is the "meaningful moment".
    if (!app.user && app.loginHint === 'none') app.loginHint = 'pending';
  }

  override update(_time: number, deltaMs: number): void {
    const ended = this.ended();
    // Touch controls only during live play: paused, in the tree or after the run every finger is dropped.
    if (this.touchControls) {
      this.touchControls.setEnabled(!this.paused && !this.treeOpen && !ended && this.overlay === undefined);
      this.touchControls.update();
    }
    // While the tree is open (modes that do not pause), its screen owns the keys.
    if (!this.treeOpen) {
      if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
        if (ended) {
          if (this.overlayKind === 'end') this.leaveToMenu();
        } else this.setPaused(!this.paused);
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.R) && ended && this.overlayKind === 'end') {
        this.restartRun(this.nextRun().map);
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.P) && !this.paused && !ended) {
        this.openTree();
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.ONE) && !this.paused && !ended) this.potionQueued = true;
    }
    if (this.paused) return;

    this.accumulator += deltaMs / 1000;
    let steps = 0;
    while (this.accumulator >= DT && steps < MAX_STEPS_PER_FRAME) {
      this.snapshotPositions();
      this.handleEvents(stepRun(this.run, this.readInput(), this.content, mapsData, DT));
      this.accumulator -= DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    this.loadBossSprites();

    // Render between the last two sim states so motion is smooth at any refresh rate.
    this.alpha = Math.min(1, this.accumulator / DT);
    const dt = deltaMs / 1000;
    const stopped = timeStopped(this.world);
    if (!stopped) this.enemyTime += dt;
    this.syncActors(dt);
    this.updateCorpses(dt);
    this.drawFx(dt);
    this.drawAltarLoading();
    this.clockFx.update(dt, stopped, this.world.timeStop, this.hero.sprite.x, this.hero.sprite.y, BODY_PX, this.world.time);
    // Lifted over the time-stop tint while it shows, so the hero keeps full colour.
    if (this.clockFx.active() && this.hero.oneShot?.anim !== 'death') this.hero.sprite.setDepth(HERO_STOP_DEPTH);

    const heroScreen = toScreen(this.hero.display);
    this.cameras.main.centerOn(heroScreen.x, heroScreen.y - 30);
    this.light.setPosition(heroScreen.x, heroScreen.y - 30);
    this.room.update(dt, {
      hero: heroScreen,
      doorOpen: openDoor(this.run, mapsData) !== null,
      altar: this.altarLook(),
      altarInRange: canActivateAltar(this.run, mapsData),
      summon: this.run.phase === 'summoning' ? 1 - this.run.waveTimer / Math.max(1e-6, mapsData.rules.boss.spawnDelay) : -1,
    });
    this.drawDoorPointer();
    this.drawAimIndicator();
    this.hud.update(this.world, dt);
    this.runHud.update(this.run, dt, this.bossReady());
  }

  /** Camera on the hero, HUD orbs / slots / run header redrawn at their new places; time does not move (dt 0). */
  private redrawStill(): void {
    const heroScreen = toScreen(this.hero.display);
    this.cameras.main.centerOn(heroScreen.x, heroScreen.y - 30);
    this.light.setPosition(heroScreen.x, heroScreen.y - 30);
    this.drawDoorPointer();
    this.hud.update(this.world, 0);
    this.runHud.update(this.run, 0, this.bossReady());
  }

  private altarLook(): AltarLook {
    if (this.run.phase === 'summoning') return 'summoning';
    return this.run.phase === 'altar' && this.run.status === 'active' ? 'ready' : 'spent';
  }

  /** An arrow at the screen edge towards the open door while it is out of view. */
  private drawDoorPointer(): void {
    const g = this.pointer.clear();
    const door = openDoor(this.run, mapsData) && this.room.doorScreen();
    if (!door) return;
    const cam = this.cameras.main;
    const view = cam.worldView;
    const margin = 40;
    if (door.x > view.x + margin && door.x < view.right - margin && door.y - 60 > view.y + margin && door.y < view.bottom - margin) return;
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;
    const dx = door.x - cam.scrollX - cx;
    const dy = door.y - 40 - cam.scrollY - cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // Ray from the centre to an inset screen rectangle that keeps clear of the run HUD at the top and the orbs and
    // skill bar at the bottom.
    const compact = width < 820 || height < 520;
    const inset = compact ? 44 : 70;
    const top = Math.min(cy - 20, this.runHud.bottom() + 30);
    const bottom = Math.max(cy + 20, this.touch ? this.hud.touchClusterTop() - 30 : height - (compact ? 120 : 160));
    const kx = ux > 0 ? (width - inset - cx) / ux : ux < 0 ? (inset - cx) / ux : Number.POSITIVE_INFINITY;
    const ky = uy > 0 ? (bottom - cy) / uy : uy < 0 ? (top - cy) / uy : Number.POSITIVE_INFINITY;
    const k = Math.min(kx, ky);
    const x = cx + ux * k;
    const y = cy + uy * k;
    const pulse = 0.6 + 0.4 * Math.sin(this.world.time * 6);
    const size = 18;
    const px = -uy;
    const py = ux;
    // A notched arrowhead (longer than wide), nudged outwards with the pulse, so its direction reads at a glance.
    const push = 4 * pulse;
    const tipX = x + ux * (size * 1.1 + push);
    const tipY = y + uy * (size * 1.1 + push);
    const backX = x - ux * (size * 0.8 - push);
    const backY = y - uy * (size * 0.8 - push);
    const notchX = x - ux * (size * 0.25 - push);
    const notchY = y - uy * (size * 0.25 - push);
    const lx = backX + px * size * 0.75;
    const ly = backY + py * size * 0.75;
    const rx = backX - px * size * 0.75;
    const ry = backY - py * size * 0.75;
    g.fillStyle(0xffb44a, 0.6 + 0.35 * pulse);
    g.fillTriangle(tipX, tipY, lx, ly, notchX, notchY);
    g.fillTriangle(tipX, tipY, notchX, notchY, rx, ry);
    g.lineStyle(2, 0x1a1006, 0.9);
    g.lineBetween(tipX, tipY, lx, ly).lineBetween(lx, ly, notchX, notchY).lineBetween(notchX, notchY, rx, ry).lineBetween(rx, ry, tipX, tipY);
  }

  private readInput(): RunInput {
    if (this.treeOpen) return { move: NO_MOVE, aim: this.world.player.pos, basicAttack: false, skills: NO_SKILLS };
    if (this.touchControls) return this.readTouchInput(this.touchControls);
    const k = this.keys;
    const pointer = this.input.activePointer;
    const aim = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const screenMove = vec((k.D.isDown ? 1 : 0) - (k.A.isDown ? 1 : 0), (k.S.isDown ? 1 : 0) - (k.W.isDown ? 1 : 0));
    const held = [pointer.rightButtonDown(), k.Q.isDown, k.E.isDown];
    // A quick tap during an attack would be lost; keep it buffered for a short while.
    const skills = held.map((down, i) => {
      if (down && !this.skillWasDown[i]) this.skillBuffer[i] = INPUT_BUFFER;
      this.skillWasDown[i] = down;
      this.skillBuffer[i] = Math.max(0, (this.skillBuffer[i] ?? 0) - DT);
      return down || (this.skillBuffer[i] ?? 0) > 0;
    });
    // The altar waits for the boss's sheets (bossReady).
    const interact = (k.F.isDown || this.interactQueued) && this.bossReady();
    this.interactQueued = false;
    // Held key or a queued press; core drinks once per press edge.
    const potion = k.ONE.isDown || this.potionQueued;
    this.potionQueued = false;
    return {
      move: screenDirToWorld(screenMove),
      // Aim at ground level under the cursor; sprites stand on their feet.
      aim: toWorld(vec(aim.x, aim.y)),
      basicAttack: pointer.leftButtonDown() && !this.uiPress,
      skills,
      interact,
      potion,
    };
  }

  /**
   * Touch controls (docs/design/controls.md) as RunInput: the stick moves (WASD too); the held attack button attacks
   * the nearest enemy; a released skill button is a one-step press, buffered like a key tap and aimed while it waits:
   * a tap by the auto-aim rules (touchAim.tapAim), a drag along the drag. Nothing pressed: face the movement.
   */
  private readTouchInput(controls: TouchControls): RunInput {
    const k = this.keys;
    const player = this.world.player;
    const stick = controls.moveDirection();
    const screenMove = stick.x !== 0 || stick.y !== 0 ? stick : vec((k.D.isDown ? 1 : 0) - (k.A.isDown ? 1 : 0), (k.S.isDown ? 1 : 0) - (k.W.isDown ? 1 : 0));
    const move = screenDirToWorld(screenMove);
    const moveDir = move.x !== 0 || move.y !== 0 ? normalize(move) : undefined;
    for (let release = controls.nextRelease(); release; release = controls.nextRelease()) {
      const skill = release.slot - 1;
      const aim = this.touchAims[skill];
      if (!aim) continue;
      this.touchTaps[skill] = true;
      const dir = release.dir;
      aim.manual = dir !== undefined;
      if (dir) {
        const world = normalize(screenDirToWorld(dir));
        aim.dir.x = world.x;
        aim.dir.y = world.y;
        aim.fraction = dragFraction(Math.hypot(dir.x, dir.y), touchTuning.aimDragRadius);
      }
    }
    // Keyboard skills (Q / E as on desktop; RMB is mouse aim, left out) cast with auto-aim, held = repeated like keys.
    const keys = this.touchKeys;
    keys[1] = k.Q.isDown;
    keys[2] = k.E.isDown;
    const skills = this.touchSkills;
    const usable = this.touchUsable;
    for (let i = 0; i < skills.length; i++) {
      if (keys[i] && !this.touchKeysWereDown[i]) this.touchAims[i]!.manual = false;
      this.touchKeysWereDown[i] = keys[i] === true;
      const down = this.touchTaps[i] === true || keys[i] === true;
      if (down && !this.skillWasDown[i]) this.skillBuffer[i] = INPUT_BUFFER;
      this.skillWasDown[i] = down;
      this.skillBuffer[i] = Math.max(0, (this.skillBuffer[i] ?? 0) - DT);
      skills[i] = down || (this.skillBuffer[i] ?? 0) > 0;
      const action = player.actions.skills[i];
      usable[i] = action !== undefined && actionReady(player, action) && canAfford(player, action);
    }
    this.touchTaps.fill(false);
    const attack = controls.attackHeld();
    // Aim of the skill core fires first; none can fire: the held attack's auto-aim, else keep facing / movement.
    const first = firstUsableSkill(skills, usable);
    const castAction = first >= 0 ? player.actions.skills[first] : undefined;
    const castAim = first >= 0 ? this.touchAims[first] : undefined;
    let aim: Vec2;
    if (castAction && castAim) {
      aim = castAim.manual ? manualAim(castAction.delivery, player, castAim.dir, castAim.fraction) : tapAim(castAction.delivery, player, this.world.mobs, moveDir, this.aimTuning, this.aimFilter);
    } else {
      aim = attack ? tapAim(player.actions.basicAttack.delivery, player, this.world.mobs, moveDir, this.aimTuning, this.aimFilter) : idleAim(player, moveDir);
    }
    // The altar waits for the boss's sheets (bossReady), as with the keyboard.
    const interact = (k.F.isDown || this.interactQueued) && this.bossReady();
    this.interactQueued = false;
    const potion = k.ONE.isDown || this.potionQueued;
    this.potionQueued = false;
    return { move, aim, basicAttack: attack, skills, interact, potion };
  }

  /**
   * Touch drag-aim: an arrow on the floor from the hero to the skill's reach (traps / Teleport: to the landing spot the
   * drag length picks), a ring for skills without a direction; nothing while the release would cancel.
   */
  private drawAimIndicator(): void {
    const g = this.aimGfx.clear();
    const drag = this.touchControls?.dragAim();
    if (!drag || drag.cancel) return;
    const action = this.world.player.actions.skills[drag.slot - 1];
    if (!action) return;
    const from = toScreen(this.hero.display);
    const delivery = action.delivery;
    if (!isAimed(delivery)) {
      // Full circle / self: the area round the hero (iso ellipse: a world circle of radius r is 2r x r on screen).
      const r = delivery.kind === 'arc' ? delivery.radius : SELF_AIM_RING;
      g.lineStyle(4, AIM_ARROW, 0.75).strokeEllipse(from.x, from.y, r * 2, r);
      g.fillStyle(AIM_ARROW, 0.12).fillEllipse(from.x, from.y, r * 2, r);
      return;
    }
    const dir = normalize(screenDirToWorld(vec(drag.dx, drag.dy)));
    const distance = isDistanceAimed(delivery);
    const reach = deliveryReach(delivery) * (distance ? dragFraction(Math.hypot(drag.dx, drag.dy), touchTuning.aimDragRadius) : 1);
    const hero = this.hero.display;
    const target = vec(hero.x + dir.x * reach, hero.y + dir.y * reach);
    // Traps / Teleport land where core puts them: kept inside the room and out of obstacles (core clampToArena).
    const end = toScreen(distance ? clampToArena(target, delivery.kind === 'teleport' ? this.world.player.radius : 0, this.world) : target);
    let ex = end.x - from.x;
    let ey = end.y - from.y;
    const len = Math.hypot(ex, ey) || 1;
    // Direction-only skills: never a stub of an arrow. Traps / Teleport: the tip is exactly the landing spot.
    if (!distance && len < AIM_ARROW_MIN) {
      ex *= AIM_ARROW_MIN / len;
      ey *= AIM_ARROW_MIN / len;
    }
    const full = Math.max(1, Math.hypot(ex, ey));
    const ux = ex / full;
    const uy = ey / full;
    const tipX = from.x + ex;
    const tipY = from.y + ey;
    const head = 22;
    const baseX = tipX - ux * head;
    const baseY = tipY - uy * head;
    const nx = -uy;
    const ny = ux;
    g.lineStyle(10, AIM_ARROW_RIM, 0.5).lineBetween(from.x + ux * 18, from.y + uy * 18, baseX, baseY);
    g.lineStyle(6, AIM_ARROW, 0.7).lineBetween(from.x + ux * 18, from.y + uy * 18, baseX, baseY);
    g.fillStyle(AIM_ARROW, 0.85).fillTriangle(tipX, tipY, baseX + nx * 14, baseY + ny * 14, baseX - nx * 14, baseY - ny * 14);
    // Where a trap lands / a teleport ends: its spot on the floor.
    if (delivery.kind === 'trap' || delivery.kind === 'teleport') {
      const r = delivery.kind === 'trap' ? delivery.explodeRadius : TELEPORT_LANDING_RING;
      g.lineStyle(3, AIM_ARROW, 0.7).strokeEllipse(tipX, tipY, r * 2, r);
    }
  }

  private handleEvents(events: readonly RunStepEvent[]): void {
    for (const event of events) {
      if (isRunEvent(event)) this.onRunEvent(event);
      else this.onEvent(event);
    }
  }

  private onRunEvent(event: RunEvent): void {
    switch (event.type) {
      case 'roomEnter':
        this.enterRoom();
        if (event.kind === 'boss') this.announce(t('run.bossRoom'), t('run.bossRoomLine'));
        break;
      case 'waveStart':
        break;
      case 'roomCleared':
        this.room.openDoor();
        this.announce(t('run.roomCleared'), t('run.roomClearedLine'));
        break;
      case 'altarActivated':
        this.cameras.main.shake(event.delay * 1000, 0.002);
        this.announce(t('run.summoning'));
        break;
      case 'bossSpawned': {
        this.room.bossRises();
        this.cameras.main.shake(320, 0.008);
        this.cameras.main.flash(220, 120, 20, 10);
        const boss = this.world.mobs.find((m) => m.id === event.id);
        if (boss) this.announce(mobName(boss.defId));
        break;
      }
      case 'rankedKill':
        break;
      case 'timeWarning':
        this.runHud.warn();
        this.announce(t('run.timeLeft', { time: formatCountdown(event.secondsLeft) }));
        break;
      case 'runWon': {
        this.recordRun();
        this.chestBurst();
        this.scheduleEndScreen(WIN_SCREEN_DELAY);
        break;
      }
      case 'runFailed':
        this.recordRun();
        // Abandoned from the pause menu: straight to the results; death and timeout let the moment land first.
        if (event.reason === 'abandoned') {
          this.paused = true;
          this.showOverlay('end');
        } else this.scheduleEndScreen(event.reason === 'death' ? 0 : 0.6);
        break;
    }
  }

  private scheduleEndScreen(seconds: number): void {
    if (seconds <= 0) {
      this.showOverlay('end');
      return;
    }
    this.time.delayedCall(seconds * 1000, () => {
      if (this.scene.isActive() && this.overlayKind !== 'end') this.showOverlay('end');
    });
  }

  /** The boss fell: golden rays and a chest-coloured burst where it died. */
  private chestBurst(): void {
    const at = this.bossFall ?? this.world.player.pos;
    const s = toScreen(at);
    this.cameras.main.flash(260, 255, 220, 140);
    for (let i = 0; i < 3; i++) {
      const ring = this.add.ellipse(s.x, s.y, 50, 25).setStrokeStyle(4, 0xffd36a, 1).setDepth(5002);
      this.tweens.add({ targets: ring, scaleX: 7 + i * 2, scaleY: 7 + i * 2, alpha: 0, delay: i * 180, duration: 900, ease: 'Cubic.easeOut', onComplete: () => ring.destroy() });
    }
    const pillar = this.add.rectangle(s.x, s.y, 70, 320, 0xffe7a0, 0.6).setOrigin(0.5, 1).setDepth(5002).setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: pillar, scaleX: 0.1, alpha: 0, duration: 1200, ease: 'Quad.easeIn', onComplete: () => pillar.destroy() });
  }

  private onEvent(event: WorldEvent): void {
    switch (event.type) {
      case 'action': {
        // Consume the buffered press so a tap fires the skill once.
        const slot = this.world.player.actions.skills.findIndex((s) => s.id === event.actionId);
        if (slot >= 0) this.skillBuffer[slot] = 0;
        this.hero.facing = event.facing;
        this.playOneShot(this.hero, ACTION_ANIMS[event.actionId] ?? 'attack');
        break;
      }
      case 'counter': {
        // Free retaliation: the basic attack animation toward the attacker plus a golden slash and shield pop.
        this.counterFacing = event.facing;
        this.counterShot = this.playOneShot(this.hero, ACTION_ANIMS[event.actionId] ?? 'attack');
        const from = toScreen(this.world.player.pos);
        const toward = toScreen(vec(this.world.player.pos.x + event.facing.x, this.world.player.pos.y + event.facing.y));
        this.combatFx.counter(from.x, from.y, toward.x - from.x, toward.y - from.y);
        break;
      }
      case 'status':
        if (event.targetId === PLAYER_ID) {
          // The hero caught fire (a fiery elite's hit): a puff of embers; the burn itself is drawn from player.ignite.
          if (event.status === 'ignite') this.eliteFx.ignited(this.hero.sprite.x, this.hero.sprite.y, BODY_PX);
          break;
        }
        if (event.source === 'stunBar') {
          const actor = this.mobs.get(event.targetId);
          if (actor) {
            actor.stunBarFlash = STUN_BAR_FLASH;
            actor.stunBarShown = 0;
            this.combatFx.stunBarBurst(actor.sprite.x, actor.sprite.y);
          }
        }
        break;
      case 'area':
        if (event.source === 'deathExplosion') {
          const s = toScreen(event.origin);
          this.combatFx.deathExplosion(event.damageType === 'cold' ? 'ice' : 'fire', s.x, s.y, event.radius);
        } else {
          // Chain detonations: a golden tint plus a shock ring, so a chain reads apart from a triggered trap.
          const color = event.chain
            ? CHAIN_AREA_COLOR
            : event.trigger === 'burst'
              ? BURST_AREA_COLOR
              : event.trigger === 'originBlast'
                ? RIFT_AREA_COLOR
                : this.convertsToCold(event.actionId) ? COLD_AREA_COLOR : (AREA_COLORS[event.actionId] ?? 0xdde4ff);
          this.areas.push({ ...event, color, ttl: AREA_TTL });
          const s = toScreen(event.origin);
          if (event.chain) this.combatFx.chainBurst(s.x, s.y, event.radius);
          if (event.trigger === 'burst') {
            // A use that hits everything round the hero (Ancestral Horn: Battle Cry stuns): a gold shockwave.
            this.uniqueFx.shockwave(s.x, s.y, event.radius);
            this.cameras.main.shake(110, 0.004);
          } else if (event.trigger === 'originBlast') {
            // The blast left where the use started (Rift Ring: Teleport): a lightning rift at the start point.
            this.uniqueFx.rift(s.x, s.y, event.radius);
          } else if (event.trigger === 'everyNth') {
            // Cleave's special swing: the spin starts where the hero faces.
            const ahead = toScreen(vec(event.origin.x + event.facing.x, event.origin.y + event.facing.y));
            this.skillFx.whirl(s.x, s.y, event.radius, Math.atan2(ahead.y - s.y, ahead.x - s.x));
          } else if (event.trigger === 'dashLanding') {
            this.skillFx.slam(s.x, s.y, event.radius);
            this.cameras.main.shake(90, 0.003);
          }
        }
        break;
      case 'zoneSpawn':
        this.liveZones.add(event.zoneId);
        this.skillFx.zoneSpawned(event.zoneId, event.duration);
        break;
      case 'zoneExpire':
        this.liveZones.delete(event.zoneId);
        this.skillFx.zoneExpired(event.zoneId);
        break;
      case 'decoySpawn': {
        this.liveDecoys.add(event.decoyId);
        const look = CLASS_LOOKS.find((l) => l.classId === this.classId);
        this.skillFx.decoySpawned(event.decoyId, look?.sprite ?? 'knight', Math.max(0, this.hero.row));
        break;
      }
      case 'decoyExpire':
        this.liveDecoys.delete(event.decoyId);
        this.skillFx.decoyExpired(event.decoyId);
        break;
      case 'projectileSplit': {
        const s = toScreen(event.pos);
        this.skillFx.split(s.x, s.y - PROJECTILE_HEIGHT, this.convertsToCold(event.actionId));
        break;
      }
      case 'trapRemoved': {
        const s = toScreen(event.pos);
        this.combatFx.trapFizzle(s.x, s.y);
        break;
      }
      case 'critHeal':
        this.spawnDamageNumber(event.pos, event.amount, 'heal');
        this.uniqueFx.heal(this.hero.sprite.x, this.hero.sprite.y, BODY_PX);
        break;
      case 'lifeCost':
        // Paid before the use moved the hero (Teleport): shown where the hero is now, not at the start point.
        this.spawnDamageNumber(this.world.player.pos, event.amount, 'lifeCost');
        break;
      case 'dot':
        this.addDotTally(event.targetId, event.pos, event.amount, event.status === 'bleed');
        break;
      case 'teleport':
        this.areas.push({ origin: event.from, facing: vec(1, 0), radius: 40, angleDeg: 360, color: 0xb58cff, ttl: AREA_TTL * 2 });
        this.areas.push({ origin: event.to, facing: vec(1, 0), radius: 40, angleDeg: 360, color: 0xb58cff, ttl: AREA_TTL * 2 });
        break;
      case 'mobAttack': {
        const actor = this.mobs.get(event.id);
        if (actor) {
          this.playOneShot(actor, ATTACK_ANIMS[actor.set] ?? 'attack');
          if (actor.elite?.fire) {
            const mob = this.world.mobs.find((m) => m.id === event.id);
            if (mob) {
              const ahead = toScreen(vec(mob.pos.x + mob.facing.x, mob.pos.y + mob.facing.y));
              const here = toScreen(mob.pos);
              this.eliteFx.fireSwing(actor.sprite.x, actor.sprite.y, ahead.x - here.x, ahead.y - here.y, BODY_PX * actor.scale);
            }
          }
        }
        if (event.decoyId !== undefined) this.skillFx.decoyStruck(event.decoyId);
        break;
      }
      case 'hit': {
        if (event.source === 'zone') {
          // Ground zone ticks read like damage over time: summed per mob into the small DoT numbers.
          this.addDotTally(event.targetId, event.pos, event.amount);
          break;
        }
        const actor = event.targetId === PLAYER_ID ? this.hero : this.mobs.get(event.targetId);
        // Hit reaction only interrupts idle/run, never an attack or skill.
        // A frozen mob holds its pose.
        // A casting mob keeps its wind-up pose.
        if (actor && !actor.oneShot && !actor.frozen && !actor.pose) this.playOneShot(actor, 'hit');
        // A skeleton's hit (Eye of the Abyss): muted teal numbers, apart from the hero's own damage.
        const kind: DamageNumberKind =
          event.source === 'ally' ? (event.isCrit ? 'allyCrit' : 'ally') : event.isCrit ? 'crit' : event.targetId === PLAYER_ID ? 'player' : 'hit';
        this.spawnDamageNumber(event.pos, event.amount, kind);
        break;
      }
      case 'allySpawn': {
        // The dead mob's body gives way to the skeleton climbing out of it.
        for (const corpse of this.corpses) if (corpse.id === event.mobId) corpse.ttl = Math.min(corpse.ttl, RAISED_CORPSE_TIME);
        const view = this.allyView(event.allyId, event.defId, event.pos);
        if (view && SPRITE_SETS[view.actor.set]?.spawn) this.playOneShot(view.actor, 'spawn');
        const s = toScreen(event.pos);
        this.allyFx.rise(s.x, s.y);
        break;
      }
      case 'allyAttack': {
        const view = this.allies.get(event.allyId);
        if (!view) break;
        view.actor.facing = event.facing;
        this.playOneShot(view.actor, ATTACK_ANIMS[view.actor.set] ?? 'attack');
        const ally = this.world.allies.find((a) => a.id === event.allyId);
        if (ally) {
          const here = toScreen(ally.pos);
          const ahead = toScreen(vec(ally.pos.x + event.facing.x, ally.pos.y + event.facing.y));
          this.allyFx.swing(view.actor.sprite.x, view.actor.sprite.y, ahead.x - here.x, ahead.y - here.y, BODY_PX * view.actor.scale);
        }
        break;
      }
      case 'allyHit': {
        const view = this.allies.get(event.allyId);
        if (view) {
          view.struck = ALLY_STRUCK;
          if (!view.actor.oneShot) this.playOneShot(view.actor, 'hit');
        }
        this.spawnDamageNumber(event.pos, event.amount, 'allyHurt');
        break;
      }
      case 'allyExpire':
        this.allyGone(event.allyId, event.reason);
        break;
      case 'allyKill': {
        // Resource restored by a skeleton's kill: a small popup over the hero in the resource's colour.
        const amount = Math.round(event.resource);
        if (amount < 1) break;
        const resId = getClass(this.content, this.classId).resource.id;
        const message = t('arena.allyResource', { amount, resName: resourceText(resId), resGen: resourceText(resId, 'gen') });
        this.spawnFloatText(this.world.player.pos, message, 'allyResource', BODY_PX + 36, RESOURCE_POPUP_COLORS[resId]);
        break;
      }
      case 'death': {
        this.flushDotTally(event.id);
        const actor = this.mobs.get(event.id);
        if (actor) {
          const shot = this.playOneShot(actor, 'death');
          actor.pose = undefined;
          if (actor.elite) {
            this.eliteFx.removeGlow(actor.sprite, actor.elite.glow);
            actor.elite.label.destroy();
          }
          actor.sprite.clearTint();
          actor.sprite.setDepth(toScreen(actor.display).y - 40);
          // A minion whose summoner fell this step (its death event came first): it crumbles to dust (core gives
          // no rewards for it), staggered so the group does not drop in unison.
          const crumbles = actor.summonerId !== undefined && !this.mobs.has(actor.summonerId);
          if (crumbles) {
            if (shot) shot.elapsed = -Math.random() * CRUMBLE_STAGGER;
            actor.sprite.setTint(CRUMBLE_TINT).setTintMode(Phaser.TintModes.MULTIPLY);
            this.bossFx.crumble(actor.sprite.x, actor.sprite.y);
          }
          this.corpses.push({ actor, id: event.id, ttl: crumbles ? CRUMBLE_CORPSE_TIME : actor.rank === 'boss' ? CORPSE_TIME * 3 : CORPSE_TIME });
          this.mobs.delete(event.id);
          this.immuneShown.delete(event.id);
          if (actor.rank !== 'normal') {
            // A ranked mob falls: a ring in its colour.
            const color = actor.elite ? eliteLook(actor.elite.modifier).color : RANK_LOOKS[actor.rank].ring;
            this.areas.push({ origin: event.pos, facing: vec(1, 0), radius: actor.rank === 'boss' ? 160 : 80, angleDeg: 360, color, ttl: AREA_TTL * 3 });
          }
          if (actor.rank === 'boss') this.bossFall = event.pos;
          actor.elite = undefined;
        }
        break;
      }
      case 'skillLevelUp':
        this.hud.skillLevelUp(event.skillId);
        break;
      case 'echo': {
        // The free repeat: the hero swings again (its own action event follows) with a violet afterimage; the
        // Devourer's Crown echo (souls spent) in soul colours, with a purple-green soul burst.
        const from = toScreen(event.pos);
        const ahead = toScreen(vec(event.pos.x + event.facing.x, event.pos.y + event.facing.y));
        if (event.souls) {
          this.supportFx.echo(this.hero.sprite, ahead.x - from.x, ahead.y - from.y, SOUL_GREEN, SOUL_VIOLET);
          this.soulFx.echo(this.hero.sprite.x, this.hero.sprite.y, BODY_PX);
        } else this.supportFx.echo(this.hero.sprite, ahead.x - from.x, ahead.y - from.y);
        break;
      }
      case 'soulGain': {
        // A fallen mob's soul flies to the hero (Devourer's Crown); the HUD counter reads PlayerState.souls.
        const s = toScreen(event.pos);
        this.soulFx.gain(s.x, s.y - BODY_PX * 0.5);
        break;
      }
      case 'soulEcho':
        // This use took the full souls count: the crown flares now, its free echo follows ('echo' with souls).
        this.soulFx.charge(this.hero.sprite.x, this.hero.sprite.y, BODY_PX);
        break;
      case 'chain': {
        const xs = this.chainXs;
        const ys = this.chainYs;
        xs.length = 0;
        ys.length = 0;
        for (const p of event.points) {
          const s = toScreen(p);
          xs.push(s.x);
          ys.push(s.y - CHAIN_HEIGHT);
        }
        this.supportFx.chain(xs, ys);
        break;
      }
      case 'knockback': {
        const s = toScreen(event.pos);
        const end = toScreen(vec(event.pos.x + event.dir.x * event.distance, event.pos.y + event.dir.y * event.distance));
        this.supportFx.knockback(s.x, s.y, end.x - s.x, end.y - s.y, Math.hypot(end.x - s.x, end.y - s.y));
        break;
      }
      case 'supportDrop': {
        const def = this.content.supports?.supports[event.defId];
        if (!def) break;
        const s = toScreen(event.pos);
        this.supportFx.supportDrop(s.x, s.y, supportIcon(this, def, event.tier), `◆ ${supportTitle(def, event.tier)}`, tierColor(event.tier), tierColorNum(event.tier));
        break;
      }
      case 'mobCastInterrupted': {
        // The telegraph itself is drawn from MobState.casting, so it is already gone; here the "cut" feedback.
        const actor = this.mobs.get(event.id);
        if (!actor) break;
        const mob = this.world.mobs.find((m) => m.id === event.id);
        // A phase change also cancels the wind-up: the roar is the feedback then.
        if (mob?.phaseTransition) break;
        this.bossFx.interrupt(actor.sprite.x, actor.sprite.y, BODY_PX * actor.scale);
        this.spawnFloatText(actor.display, t('boss.interrupted'), 'interrupt', BODY_PX * actor.scale + 18);
        break;
      }
      case 'mobAbility': {
        const s = toScreen(event.pos);
        if (event.kind === 'nova') {
          this.bossFx.nova(s.x, s.y, event.radius ?? 100);
          this.cameras.main.shake(160, event.hit ? 0.007 : 0.004);
        } else if (event.kind === 'summon') {
          for (const id of event.spawnedIds ?? []) {
            const minion = this.world.mobs.find((m) => m.id === id);
            if (!minion) continue;
            const p = toScreen(minion.pos);
            this.bossFx.raise(p.x, p.y);
          }
        }
        break;
      }
      case 'mobPhase': {
        if (event.transition === undefined) break;
        const actor = this.mobs.get(event.id);
        const s = actor ? { x: actor.sprite.x, y: actor.sprite.y } : toScreen(event.pos);
        const mob = this.world.mobs.find((m) => m.id === event.id);
        this.bossFx.roar(s.x, s.y, mob?.radius ?? 26);
        this.cameras.main.shake(event.transition * 1000, 0.004);
        this.cameras.main.flash(260, 70, 30, 110);
        if (mob) this.announce(mobName(mob.defId), t('boss.phase', { phase: event.phase }));
        break;
      }
      case 'immune': {
        const last = this.immuneShown.get(event.targetId);
        if (last !== undefined && this.world.time - last < IMMUNE_TEXT_INTERVAL) break;
        this.immuneShown.set(event.targetId, this.world.time);
        const actor = this.mobs.get(event.targetId);
        const s = toScreen(event.pos);
        this.bossFx.deflect(s.x, s.y - BODY_PX * (actor?.scale ?? 1) * 0.5);
        this.spawnFloatText(event.pos, t('boss.immune'), 'immune', BODY_PX * (actor?.scale ?? 1) + 4);
        break;
      }
      case 'hostileZoneSpawn': {
        // An exploding elite's death circle grows in on its own (drawDeathZone); the violet pop is the grave circles'.
        if (event.source === 'eliteDeath') break;
        const s = toScreen(event.pos);
        this.bossFx.zoneDropped(s.x, s.y, event.radius);
        break;
      }
      case 'hostileZoneErupt': {
        const s = toScreen(event.pos);
        if (event.source === 'eliteDeath') {
          this.eliteFx.blast(s.x, s.y, event.radius);
          this.combatFx.deathExplosion('fire', s.x, s.y, event.radius);
          this.cameras.main.shake(event.hit ? 220 : 140, event.hit ? 0.009 : 0.004);
          break;
        }
        const fire = this.firesWith(event.eliteModifier);
        this.bossFx.erupt(s.x, s.y, event.radius, fire);
        if (fire) this.eliteFx.fireErupt(s.x, s.y);
        if (event.hit) this.cameras.main.shake(120, 0.005);
        break;
      }
      case 'levelUp':
        this.showLevelUp(event.level);
        this.refreshBanner();
        break;
      case 'playerDeath':
        this.playOneShot(this.hero, 'death');
        this.cameras.main.shake(250, 0.006);
        break;
      case 'cheatDeath': {
        // Clock of the Last Moment saved the hero: the face flares and shatters, a chime-white flash, time stops.
        const s = toScreen(event.pos);
        this.clockFx.trigger(s.x, s.y, event.stopDuration);
        this.cameras.main.shake(200, 0.007);
        this.spawnFloatText(event.pos, upper(t('arena.lastMoment')), 'lastMoment', BODY_PX + 40);
        break;
      }
      case 'timeStopEnd':
        this.clockFx.resume(this.hero.sprite.x, this.hero.sprite.y);
        break;
      case 'potionDrink':
        // The whole heal as one number (it is restored over event.duration; the orb glows meanwhile).
        this.spawnDamageNumber(event.pos, event.amount, 'heal');
        this.potionFx.drink(this.hero.sprite.x, this.hero.sprite.y, BODY_PX);
        this.hud.potionDrink();
        break;
      case 'potionDenied':
        this.hud.potionDenied(event.reason, this.world);
        break;
      case 'potionCharge':
        this.hud.potionCharge();
        break;
      default:
        break;
    }
  }

  private createActor(set: string, pos: Vec2, rank: MobRank = 'normal', scale = 1): Actor {
    // Big sets (bosses) are baked in their own frame at their in-game size: own origin, smaller draw scale.
    const layout = spriteLayout(set);
    const sprite = this.add
      .sprite(0, 0, textureKey(set, 'idle'), 0)
      .setOrigin(0.5, layout.originY)
      .setScale(scale / layout.nativeScale);
    sharpen(sprite.texture);
    return { sprite, set, display: pos, facing: vec(1, 1), row: -1, time: 0, runPhase: 0, moving: false, oneShot: undefined, frozen: false, stunBarShown: 0, stunBarFlash: 0, rank, scale, pose: undefined, summonerId: undefined, elite: undefined };
  }

  /** Remembers where everything was before a sim step, for interpolation. */
  private snapshotPositions(): void {
    const prev = this.prevPositions;
    prev.clear();
    prev.set(PLAYER_ID, this.world.player.pos);
    for (const mob of this.world.mobs) prev.set(mob.id, mob.pos);
    for (const ally of this.world.allies) prev.set(ally.id, ally.pos);
    for (const p of this.world.projectiles) prev.set(p.id, p.pos);
  }

  private interpolated(id: number, current: Vec2): Vec2 {
    const prev = this.prevPositions.get(id);
    if (!prev || distance(prev, current) > SNAP_DISTANCE) return current;
    const a = this.alpha;
    return vec(prev.x + (current.x - prev.x) * a, prev.y + (current.y - prev.y) * a);
  }

  /** World units per second over the last sim step. */
  private speedOf(id: number, current: Vec2): number {
    const prev = this.prevPositions.get(id);
    if (!prev) return 0;
    const d = distance(prev, current);
    return d > SNAP_DISTANCE ? 0 : d / DT;
  }

  private playOneShot(actor: Actor, anim: string): Actor['oneShot'] {
    if (actor.oneShot?.anim === 'death') return undefined;
    // Climbing out of the floor plays through: attacks and hits right after appearing are not shown over it.
    if (actor.oneShot?.anim === 'spawn' && anim !== 'death') return undefined;
    actor.oneShot = { anim, elapsed: 0 };
    return actor.oneShot;
  }

  private syncActors(dt: number): void {
    const player = this.world.player;
    const classDef = getClass(this.content, this.classId);
    if (this.counterShot && this.hero.oneShot !== this.counterShot) this.counterShot = undefined;
    if (!player.dead) this.hero.facing = this.counterShot ? this.counterFacing : player.motion ? player.motion.dir : player.facing;
    this.hero.display = this.interpolated(PLAYER_ID, player.pos);
    this.updateActor(this.hero, dt, this.speedOf(PLAYER_ID, player.pos), classDef.baseStats.movementSpeed ?? 200);
    this.hero.sprite.setAlpha(player.invulnerable > 0 ? 0.55 : 1);
    // Burning (a fiery elite's ignite): the same flickering warm glow as an ignited mob.
    const burn = player.ignite > 0 && !player.dead ? statusLook(0, 0, player.ignite, 0, this.world.time, PLAYER_ID) : undefined;
    if (burn) {
      this.hero.sprite.setTint(burn.color).setTintMode(burn.mode);
      this.heroTinted = true;
    } else if (this.heroTinted) {
      this.hero.sprite.clearTint();
      this.heroTinted = false;
    }

    // Time stop (cheatDeath): every mob holds its pose and frame; its looks run on the stopped enemy clock.
    const stopped = timeStopped(this.world);
    for (const mob of this.world.mobs) {
      let actor = this.mobs.get(mob.id);
      const def = getMob(this.content, mob.defId);
      if (!actor) {
        const set = mobSprite(mob.defId);
        // Sheets still on their way (on demand / a retry after a failed download): the mob shows up once they land.
        if (!this.ensureSprites(set)) continue;
        // Sets baked bigger (the boss) already show their def's size: their native scale is the normal-mob scale.
        const bodyScale = def.radius > 0 ? mob.radius / def.radius : 1;
        actor = this.createActor(set, mob.pos, mobRank(def, mob), bodyScale * spriteLayout(set).nativeScale);
        actor.summonerId = mob.summonerId;
        if (mob.eliteModifier !== undefined) actor.elite = this.createEliteMark(actor, mob.eliteModifier);
        // The boss and raised minions climb out of the floor.
        if ((actor.rank === 'boss' || mob.summonerId !== undefined) && SPRITE_SETS[set]?.spawn) this.playOneShot(actor, 'spawn');
        this.mobs.set(mob.id, actor);
      }
      // Ability wind-up / phase roar poses come straight from core state (telegraphs stay right on any frame).
      const roar = mob.phaseTransition;
      const cast = mob.casting;
      if (roar) {
        // Arms go up over the first third and hold there.
        const anim = ROAR_ANIM;
        const progress = 0.75 * Math.min(1, (1 - roar.remaining / Math.max(1e-6, roar.total)) * 3);
        if (actor.pose) {
          actor.pose.anim = anim;
          actor.pose.progress = progress;
        } else actor.pose = { anim, progress };
      } else if (cast) {
        const anim = CAST_ANIMS[cast.kind] ?? 'idle';
        const progress = 1 - cast.remaining / Math.max(1e-6, cast.total);
        if (actor.pose) {
          actor.pose.anim = anim;
          actor.pose.progress = progress;
        } else actor.pose = { anim, progress };
      } else actor.pose = undefined;
      actor.facing = mob.facing;
      const target = this.interpolated(mob.id, mob.pos);
      if (distance(actor.display, target) > SNAP_DISTANCE) actor.display = target;
      else {
        const k = 1 - Math.exp(-MOB_SMOOTHING * dt);
        actor.display = vec(actor.display.x + (target.x - actor.display.x) * k, actor.display.y + (target.y - actor.display.y) * k);
      }
      // A frozen mob holds its pose; a boss under freeze (freezeSlow) only looks frozen and keeps moving.
      actor.frozen = mob.freeze > 0;
      // Reference speed with the elite modifier (fast elites): the run cycle keeps pace with the feet.
      this.updateActor(actor, dt, this.speedOf(mob.id, mob.pos), mobMoveSpeed(this.content, def, mob), actor.frozen || stopped);
      // Likewise a boss under an ordinary stun (stunSlow) looks stunned but keeps moving.
      const frozenLook = Math.max(mob.freeze, mob.freezeSlow);
      const look = statusLook(frozenLook, Math.max(mob.stun, mob.stunSlow), mob.ignite, Math.max(mob.slow, mob.auraSlow), this.enemyTime, mob.id);
      if (roar) actor.sprite.setTint(IMMUNE_TINTS[Math.floor(this.enemyTime * 12) % 2]!).setTintMode(Phaser.TintModes.SCREEN);
      else if (look !== undefined) actor.sprite.setTint(look.color).setTintMode(look.mode);
      else if (actor.rank !== 'normal') actor.sprite.setTint(RANK_LOOKS[actor.rank].tint).setTintMode(Phaser.TintModes.MULTIPLY);
      else actor.sprite.clearTint();
    }
    this.syncAllies(dt);
    this.updateDotNumbers(dt);
  }

  /**
   * Raised allies (Eye of the Abyss): hero-side, so they keep moving and animating through a time stop. Their look
   * fades in the last seconds of their lifetime (AllyFx.style).
   */
  private syncAllies(dt: number): void {
    for (const ally of this.world.allies) {
      if (ally.life <= 0) continue;
      const view = this.allyView(ally.id, ally.defId, ally.pos);
      if (!view) continue;
      const actor = view.actor;
      // An attack swing keeps facing its target (the allyAttack event); otherwise the core facing.
      if (!actor.oneShot || actor.oneShot.anim !== (ATTACK_ANIMS[actor.set] ?? 'attack')) actor.facing = ally.facing;
      const target = this.interpolated(ally.id, ally.pos);
      if (distance(actor.display, target) > SNAP_DISTANCE) actor.display = target;
      else {
        const k = 1 - Math.exp(-MOB_SMOOTHING * dt);
        actor.display = vec(actor.display.x + (target.x - actor.display.x) * k, actor.display.y + (target.y - actor.display.y) * k);
      }
      this.updateActor(actor, dt, this.speedOf(ally.id, ally.pos), ally.moveSpeed);
      // Over the time-stop tint like the hero (just under the dial): allies keep their colour and keep moving.
      if (this.clockFx.active()) actor.sprite.setDepth(HERO_STOP_DEPTH - 1.5);
      view.struck = Math.max(0, view.struck - dt);
      this.allyFx.style(actor.sprite, view.glow, ally.remaining, this.world.time, ally.id, view.struck);
    }
  }

  /** The view of ally `id`, created on first sight (spectral look); undefined while its sheets are still loading. */
  private allyView(id: number, defId: string, pos: Vec2): AllyView | undefined {
    let view = this.allies.get(id);
    if (view) return view;
    const set = mobSprite(defId);
    if (!this.ensureSprites(set)) return undefined;
    const actor = this.createActor(set, pos, 'normal', spriteLayout(set).nativeScale);
    view = { actor, glow: this.allyFx.dress(actor.sprite), struck: 0 };
    this.allies.set(id, view);
    return view;
  }

  /** Ally `id` is gone: shattered (killed by enemies) or crumbled (its time ran out / a newer one took its place). */
  private allyGone(id: number, reason: 'timeout' | 'killed' | 'cap'): void {
    const view = this.allies.get(id);
    if (!view) return;
    this.allies.delete(id);
    const actor = view.actor;
    this.allyFx.undress(actor.sprite, view.glow);
    this.playOneShot(actor, 'death');
    actor.sprite.setDepth(actor.sprite.y - 40);
    const killed = reason === 'killed';
    if (killed) {
      this.allyFx.shatter(actor.sprite.x, actor.sprite.y, BODY_PX * actor.scale);
      actor.sprite.setTint(0xc8fff0).setTintMode(Phaser.TintModes.SCREEN);
    } else {
      this.allyFx.crumble(actor.sprite.x, actor.sprite.y);
      actor.sprite.setTint(ALLY_CRUMBLE_TINT).setTintMode(Phaser.TintModes.MULTIPLY);
    }
    this.corpses.push({ actor, ttl: killed ? ALLY_SHATTER_TIME : ALLY_CRUMBLE_TIME, alpha: actor.sprite.alpha });
  }

  /** Adds damage-over-time style damage (ignite, ground zone ticks) to the mob's pending small number. */
  private addDotTally(targetId: number, pos: Vec2, amount: number, bleed = false): void {
    let tally = this.dotTallies.get(targetId);
    if (!tally) {
      tally = { amount: 0, timer: DOT_NUMBER_INTERVAL, pos, bleed };
      this.dotTallies.set(targetId, tally);
    }
    tally.amount += amount;
    tally.pos = pos;
    tally.bleed = bleed;
  }

  /**
   * Pops a damage number for each mob's ignite damage every DOT_NUMBER_INTERVAL, and once more when it ends.
   * Ground zone ticks (no ignite) show at once, one small number per tick.
   */
  private updateDotNumbers(dt: number): void {
    if (this.dotTallies.size === 0) return;
    // The hero's own burn (fiery elites) is summed like a mob's ignite.
    const heroTally = this.dotTallies.get(PLAYER_ID);
    if (heroTally) {
      heroTally.timer -= dt;
      if (this.world.player.ignite <= 0) this.flushDotTally(PLAYER_ID);
      else if (heroTally.timer <= 0) {
        this.showDotTally(heroTally, PLAYER_ID);
        heroTally.amount = 0;
        heroTally.timer = DOT_NUMBER_INTERVAL;
      }
    }
    for (const mob of this.world.mobs) {
      const tally = this.dotTallies.get(mob.id);
      if (!tally) continue;
      tally.timer -= dt;
      // Ignite and bleed keep ticking: their damage is summed; zone ticks (neither) show at once.
      if (mob.ignite <= 0 && (mob.bleed ?? 0) <= 0) this.flushDotTally(mob.id);
      else if (tally.timer <= 0) {
        // Still burning: show the sum and keep counting in the same tally.
        this.showDotTally(tally, mob.id);
        tally.amount = 0;
        tally.timer = DOT_NUMBER_INTERVAL;
      }
    }
  }

  /** Shows the accumulated ignite damage of one mob (if any) and forgets the tally until the next dot event. */
  private flushDotTally(id: number): void {
    const tally = this.dotTallies.get(id);
    if (!tally) return;
    this.showDotTally(tally, id);
    this.dotTallies.delete(id);
  }

  /** `id`: whose tally it is; the hero's own damage over time shows in the incoming-damage colour. */
  private showDotTally(tally: DotTally, id: number): void {
    if (tally.amount >= 0.5) this.spawnDamageNumber(tally.pos, tally.amount, id === PLAYER_ID ? 'playerDot' : tally.bleed ? 'bleed' : 'dot');
  }

  private updateActor(actor: Actor, dt: number, speed: number, referenceSpeed: number, frozen = false): void {
    if (frozen) {
      // Frozen: keep the current frame and row; only follow position and depth.
      const screen = toScreen(actor.display);
      actor.sprite.setPosition(screen.x, screen.y);
      actor.sprite.setDepth(screen.y);
      return;
    }
    // Moving state comes from sim velocity, not from per-frame deltas (which are zero on frames
    // without a sim step at high refresh rates and made run/idle flicker).
    actor.moving = speed > MOVING_SPEED;
    actor.time += dt;
    // Run cycle speed follows actual speed so feet don't slide (slowed mobs animate slower).
    if (actor.moving) actor.runPhase += dt * Phaser.Math.Clamp(speed / Math.max(1, referenceSpeed), 0.5, 2);
    actor.row = stickyDirectionRow(actor.facing, actor.row);
    this.applyFrame(actor, dt);
    const screen = toScreen(actor.display);
    actor.sprite.setPosition(screen.x, screen.y);
    if (actor.oneShot?.anim !== 'death') actor.sprite.setDepth(screen.y);
  }

  private applyFrame(actor: Actor, dt: number): void {
    const set = SPRITE_SETS[actor.set] ?? {};
    let anim = actor.moving ? 'run' : 'idle';
    let col = 0;

    const shot = actor.oneShot;
    const shotDef = shot && set[shot.anim];
    const pose = actor.pose;
    const poseDef = pose && shot?.anim !== 'death' ? set[pose.anim] : undefined;
    if (pose && poseDef) {
      // A state-driven pose wins over idle / run and any one-shot but death (which clears the pose).
      actor.oneShot = undefined;
      anim = pose.anim;
      col = Phaser.Math.Clamp(Math.floor(pose.progress * poseDef.frames), 0, poseDef.frames - 1);
    } else if (shot && shotDef) {
      shot.elapsed += dt;
      const index = Math.floor(shot.elapsed * shotDef.fps);
      if (index < shotDef.frames || shot.anim === 'death') {
        anim = shot.anim;
        // Negative elapsed (a staggered start) holds the first frame.
        col = Math.max(0, Math.min(index, shotDef.frames - 1));
      } else {
        actor.oneShot = undefined;
      }
    } else if (shot) {
      actor.oneShot = undefined;
    }
    const def = set[anim];
    if (!def) return;
    if (anim === 'run') col = Math.floor(actor.runPhase * def.fps) % def.frames;
    else if (anim === 'idle') col = Math.floor(actor.time * def.fps) % def.frames;

    const key = textureKey(actor.set, anim);
    if (actor.sprite.texture.key !== key) {
      actor.sprite.setTexture(key);
      sharpen(actor.sprite.texture);
    }
    actor.sprite.setFrame(Math.max(0, actor.row) * def.frames + col);
  }

  private updateCorpses(dt: number): void {
    const alive: Corpse[] = [];
    for (const corpse of this.corpses) {
      corpse.ttl -= dt;
      corpse.actor.time += dt;
      this.applyFrame(corpse.actor, dt);
      corpse.actor.sprite.setAlpha((corpse.alpha ?? 1) * Math.min(1, corpse.ttl / 0.5));
      if (corpse.ttl > 0) alive.push(corpse);
      else corpse.actor.sprite.destroy();
    }
    this.corpses = alive;
  }

  /** Spinning mark over the altar while the hero waits at it for the boss's sheets (bossReady). */
  private drawAltarLoading(): void {
    if (this.bossReady() || !canActivateAltar(this.run, mapsData)) return;
    const t = currentTemplate(this.run, mapsData);
    if (t.kind !== 'boss') return;
    const s = toScreen(t.altar);
    const a = this.time.now / 160;
    this.fxTop.lineStyle(3, 0xe8c070, 0.9).beginPath().arc(s.x, s.y - 112, 9, a, a + Math.PI * 1.4).strokePath();
  }

  private drawFx(dt: number): void {
    const g = this.fx.clear();
    const top = this.fxTop.clear();
    // Enemy marks and projectiles go under the time-stop tint; while time stands still their clock and dt hold too.
    const enemyTop = this.fxEnemy.clear();
    const et = this.enemyTime;
    const edt = timeStopped(this.world) ? 0 : dt;
    const player = this.world.player;

    // Light floors (environment): a soft shadow under every body, so pale mobs stand out of pale stone.
    const shadow = this.env.light.actorShadow;
    if (shadow) {
      g.fillStyle(shadow.color, shadow.alpha);
      if (!player.dead) g.fillEllipse(this.hero.sprite.x, this.hero.sprite.y, player.radius * ACTOR_SHADOW_W, player.radius * ACTOR_SHADOW_H);
      for (const mob of this.world.mobs) {
        const actor = this.mobs.get(mob.id);
        if (actor?.sprite.visible) g.fillEllipse(actor.sprite.x, actor.sprite.y, mob.radius * ACTOR_SHADOW_W, mob.radius * ACTOR_SHADOW_H);
      }
      for (const ally of this.world.allies) {
        const view = this.allies.get(ally.id);
        if (view?.actor.sprite.visible) g.fillEllipse(view.actor.sprite.x, view.actor.sprite.y, ally.radius * ACTOR_SHADOW_W, ally.radius * ACTOR_SHADOW_H);
      }
    }

    // Ground zones (fire puddle, ice field) lie on the floor under everything else.
    for (const zone of this.world.zones) {
      const p = toScreen(zone.pos);
      this.skillFx.drawZone(g, zone, p.x, p.y, this.world.time, dt);
    }
    for (const decoy of this.world.decoys) {
      const p = toScreen(decoy.pos);
      this.skillFx.drawDecoy(g, decoy.id, p.x, p.y, decoy.radius, ORIGIN_Y, dt);
    }
    this.skillFx.updateFadingGhosts(dt);
    // Raised allies: a teal ring under each, a small life bar (once hurt) and the lifetime line over the head. During a
    // time stop their rings go over the tint with them (the sprites are lifted to HERO_STOP_DEPTH - 1.5).
    const allyGround = this.clockFx.active() ? this.fxAllyStop : g;
    this.fxAllyStop.clear();
    for (const ally of this.world.allies) {
      const view = this.allies.get(ally.id);
      if (!view || ally.life <= 0) continue;
      const { x, y } = view.actor.sprite;
      this.allyFx.drawAlly(allyGround, top, x, y, ally.radius, BODY_PX * view.actor.scale, ally.life / ally.maxLife, ally.remaining / ally.duration, this.world.time, ally.id);
    }
    // Grave circles (hostile zones): warning discs filling up until they erupt.
    for (const zone of this.world.hostileZones) {
      const p = toScreen(zone.pos);
      if (zone.source === 'eliteDeath') this.eliteFx.drawDeathZone(g, enemyTop, zone, p.x, p.y, et, edt);
      else this.bossFx.drawHostileZone(g, zone, p.x, p.y, et, this.firesWith(zone.eliteModifier));
    }

    // Ring under the hero so they never get lost in a crowd; orange while buffed.
    const hero = toScreen(this.hero.display);
    g.lineStyle(2, player.buffs.length > 0 ? 0xff9a3c : 0xe8c15a, 0.9).strokeEllipse(hero.x, hero.y, 46, 23);
    if (player.ignite > 0 && !player.dead) this.eliteFx.drawHeroBurn(g, top, this.hero.sprite.x, this.hero.sprite.y, BODY_PX, this.world.time, dt, Math.min(1, player.ignite / 0.4));

    for (const trap of this.world.traps) {
      // Slow auras first, under every trigger ring; only while armed (that is when core applies them).
      if (!trap.aura || trap.armTimer > 0) continue;
      const p = toScreen(trap.pos);
      this.combatFx.drawTrapAura(g, p.x, p.y, trap.aura.radius, this.world.time, trap.id);
    }
    for (const trap of this.world.traps) {
      const p = toScreen(trap.pos);
      const armed = trap.armTimer <= 0;
      const pulse = armed ? 0.6 + 0.4 * Math.sin(this.world.time * 10) : 0.4;
      // Trigger zone (radius locked on the trap when thrown); a world circle of radius r is a 2r x r ellipse on screen.
      g.lineStyle(1, armed ? 0xff7a3a : 0x888888, armed ? 0.25 + 0.3 * pulse : 0.25).strokeEllipse(p.x, p.y, trap.triggerRadius * 2, trap.triggerRadius);
      g.fillStyle(armed ? 0xff5a1a : 0x777777, pulse).fillEllipse(p.x, p.y, 22, 11);
      g.lineStyle(1, 0x000000, 0.8).strokeEllipse(p.x, p.y, 22, 11);
      if (trap.chainTimer !== null) this.combatFx.drawTrapFuse(top, p.x, p.y, this.world.time, dt);
    }

    for (const area of this.areas) area.ttl -= dt;
    this.areas = this.areas.filter((a) => a.ttl > 0);
    for (const area of this.areas) {
      const half = Phaser.Math.DegToRad(Math.min(area.angleDeg, 360) / 2);
      const dir = Math.atan2(area.facing.y, area.facing.x);
      const full = area.angleDeg >= 360;
      const points = full ? [] : [toScreen(area.origin)];
      const segments = full ? 32 : 16;
      for (let i = 0; i <= segments; i++) {
        const a = dir - half + (2 * half * i) / segments;
        points.push(toScreen(vec(area.origin.x + Math.cos(a) * area.radius, area.origin.y + Math.sin(a) * area.radius)));
      }
      g.fillStyle(area.color, (area.ttl / AREA_TTL) * 0.45);
      g.fillPoints(points.map((p) => new Phaser.Math.Vector2(p.x, p.y)), true);
    }

    // Status marks on living mobs (ice patch, stun dots, embers) and death explosion bursts.
    for (const mob of this.world.mobs) {
      const actor = this.mobs.get(mob.id);
      if (!actor) continue;
      // Core body radius (rank scaled): rings and status marks match what hits land on.
      const radius = mob.radius;
      if (actor.rank !== 'normal') this.drawRankMarks(g, enemyTop, actor, mob.life / mob.maxLife, radius);
      if (actor.elite) {
        // Screen velocity over the last sim step (fast elites trail speed streaks).
        const prev = this.prevPositions.get(mob.id);
        let vx = 0;
        let vy = 0;
        if (prev) {
          const dx = (mob.pos.x - prev.x) / DT;
          const dy = (mob.pos.y - prev.y) / DT;
          vx = (dx - dy) * ISO_K;
          vy = ((dx + dy) * ISO_K) / 2;
        }
        if (actor.elite.glow) this.eliteFx.pulseGlow(actor.elite.glow, et, mob.id);
        if (!actor.frozen) this.eliteFx.drawElite(enemyTop, actor.elite, actor.sprite.x, actor.sprite.y, radius, BODY_PX * actor.scale, vx, vy, et, edt);
      }
      // Ability telegraphs, the immune roar and the later-phase mark (mobs with abilities).
      const bodyHeight = BODY_PX * actor.scale;
      if (mob.phaseTransition) {
        const pause = mob.phaseTransition;
        this.bossFx.drawImmuneAura(g, enemyTop, actor.sprite.x, actor.sprite.y, radius, bodyHeight, 1 - pause.remaining / Math.max(1e-6, pause.total), et, edt);
      } else if ((mob.phase ?? 1) > 1) this.bossFx.drawPhaseMark(g, actor.sprite.x, actor.sprite.y, radius, et, edt);
      const cast = mob.casting;
      if (cast) {
        const def = getMob(this.content, mob.defId);
        const ability = def.abilities?.list.find((a) => a.id === cast.abilityId);
        this.bossFx.drawCast(g, enemyTop, cast, ability, actor.display.x, actor.display.y, actor.sprite.x, actor.sprite.y, radius, bodyHeight, et, edt);
      }
      const frozenLook = Math.max(mob.freeze, mob.freezeSlow);
      this.combatFx.drawMobStatus(g, enemyTop, actor.sprite.x, actor.sprite.y, radius, frozenLook, Math.max(mob.stun, mob.stunSlow), mob.ignite, et, edt, mob.id);
      // Stun bar (stunBar mechanic): eases up to the core fill, snaps down on reset; flashes full after a stun.
      actor.stunBarFlash = Math.max(0, actor.stunBarFlash - edt);
      if (mob.stunBar < actor.stunBarShown) actor.stunBarShown = mob.stunBar;
      else actor.stunBarShown += (mob.stunBar - actor.stunBarShown) * (1 - Math.exp(-STUN_BAR_SMOOTHING * edt));
      if (actor.stunBarShown < 0.002 && mob.stunBar <= 0) actor.stunBarShown = 0;
      this.combatFx.drawStunBar(enemyTop, actor.sprite.x, actor.sprite.y, actor.stunBarShown, actor.stunBarFlash);
      // Bleed (support): one drop per stack under the feet.
      const bleedStacks = (mob.bleed ?? 0) > 0 ? (mob.bleedStacks?.length ?? 0) : 0;
      if (bleedStacks > 0) this.supportFx.drawBleed(enemyTop, actor.sprite.x, actor.sprite.y, bleedStacks, et, mob.id);
      // Knockback (support): speed streaks while the mob is still flying.
      const knock = mob.knockback;
      if (knock && knock.remaining > 0) {
        const ahead = toScreen(vec(mob.pos.x + knock.dir.x, mob.pos.y + knock.dir.y));
        const here = toScreen(mob.pos);
        this.supportFx.drawKnockbackTrail(enemyTop, actor.sprite.x, actor.sprite.y, ahead.x - here.x, ahead.y - here.y);
      }
    }
    this.combatFx.drawBursts(g, top, dt);
    this.skillFx.drawBursts(g, top, dt);
    this.bossFx.drawBursts(g, top, dt);
    this.eliteFx.drawBursts(g, top, dt);
    this.uniqueFx.drawBursts(g, top, dt);
    this.allyFx.drawBursts(g, top, dt);
    this.uniqueFx.drawCritMark(top, this.hero.sprite.x, this.hero.sprite.y, BODY_PX, player.nextAttackCrit && !player.dead, this.world.time, dt);
    const maxSouls = soulsMax(player);
    const soulsFull = maxSouls !== undefined && player.souls >= maxSouls && !player.dead;
    this.soulFx.update(g, top, dt, this.hero.sprite.x, this.hero.sprite.y, BODY_PX, soulsFull, this.world.time);
    this.supportFx.update(g, top, dt, this.hero.sprite.x, this.hero.sprite.y);
    this.potionFx.update(g, top, dt, this.hero.sprite.x, this.hero.sprite.y, BODY_PX, player.potion.heals.length > 0 && !player.dead);

    for (const p of this.world.projectiles) {
      const pos = this.interpolated(p.id, p.pos);
      const s = toScreen(pos);
      const tail = toScreen(vec(pos.x - p.dir.x * 18, pos.y - p.dir.y * 18));
      // Mob shots sit under the time-stop tint (and freeze with it); the hero's stay above in full colour.
      const pt = p.owner === 'mob' ? enemyTop : top;
      const color =
        p.owner === 'mob' ? MOB_PROJECTILE_COLOR : p.action?.damageConversion?.to === 'cold' ? COLD_PROJECTILE_COLOR : (PROJECTILE_COLORS[p.sourceId] ?? 0xffffff);
      g.fillStyle(0x000000, 0.35).fillEllipse(s.x, s.y, p.radius * 2, p.radius);
      const mobBasic = p.owner === 'mob' && p.abilityId === undefined;
      const thrownBone = p.owner === 'mob' && (p.abilityId !== undefined ? THROWN_BONE_ABILITIES.has(p.abilityId) : THROWN_BONE_MOBS.has(p.sourceId));
      if (p.owner === 'mob' && this.firesWith(p.eliteModifier)) {
        // A fiery elite's shots burn: a fire bolt, or a flaming halo round a thrown bone (its shape still reads).
        this.eliteFx.drawFireBolt(pt, s.x, s.y - PROJECTILE_HEIGHT, tail.x, tail.y - PROJECTILE_HEIGHT, p.radius, edt, thrownBone);
        if (!thrownBone) continue;
      }
      if (p.owner === 'mob' && p.abilityId !== undefined && BONE_SPEAR_ABILITIES.has(p.abilityId)) {
        this.bossFx.drawBoneSpear(pt, s.x, s.y - PROJECTILE_HEIGHT, tail.x, tail.y - PROJECTILE_HEIGHT, p.radius);
      } else if (thrownBone) {
        // Spin on the render clock (smooth between fixed core ticks); the id offsets the start angle.
        const spin = this.enemyTime * THROWN_BONE_SPIN * Math.PI * 2 + p.id;
        this.bossFx.drawThrownBone(pt, s.x, s.y - PROJECTILE_HEIGHT, p.radius, spin);
      } else if (mobBasic && DARK_BOLT_MOBS.has(p.sourceId)) {
        this.bossFx.drawDarkBolt(pt, s.x, s.y - PROJECTILE_HEIGHT, tail.x, tail.y - PROJECTILE_HEIGHT, p.radius);
      } else if (mobBasic && EARTH_CLOD_MOBS.has(p.sourceId)) {
        this.bossFx.drawEarthClod(pt, s.x, s.y - PROJECTILE_HEIGHT, tail.x, tail.y - PROJECTILE_HEIGHT, p.radius);
      } else if (p.explodeRadius > 0) {
        // Exploding projectiles (fireball and its split children) leave a short fading glow behind.
        pt.fillStyle(color, 0.22).fillCircle(tail.x, tail.y - PROJECTILE_HEIGHT, p.radius * 1.3);
        pt.fillStyle(color, 0.35).fillCircle(s.x, s.y - PROJECTILE_HEIGHT, p.radius * 2.2);
        pt.fillStyle(color, 1).fillCircle(s.x, s.y - PROJECTILE_HEIGHT, p.radius * 1.2);
      } else {
        // Far Shot: the bolt glows brighter as its distance bonus builds up.
        const glow = p.action ? farShotGlow(player.mechanics, p.action.tags, p.travelled) : 0;
        if (glow > 0) pt.lineStyle(3 + 5 * glow, FAR_SHOT_GLOW, 0.15 + 0.45 * glow).lineBetween(tail.x, tail.y - PROJECTILE_HEIGHT, s.x, s.y - PROJECTILE_HEIGHT);
        pt.lineStyle(3, color, 1).lineBetween(tail.x, tail.y - PROJECTILE_HEIGHT, s.x, s.y - PROJECTILE_HEIGHT);
      }
    }
  }

  /**
   * Elites and the boss: a coloured double ring under the feet; elites also get a small life bar over the head
   * (the boss has its bar at the top of the screen).
   */
  private drawRankMarks(g: Phaser.GameObjects.Graphics, top: Phaser.GameObjects.Graphics, actor: Actor, life: number, radius: number): void {
    const look = RANK_LOOKS[actor.rank as Exclude<MobRank, 'normal'>];
    const { x, y } = actor.sprite;
    const pulse = 0.5 + 0.5 * Math.sin(this.enemyTime * 4 + x * 0.01);
    const rx = radius * 2.6;
    // An elite's ring takes its modifier's colour (the life bar stays the elite gold).
    const ring = actor.elite ? eliteLook(actor.elite.modifier).color : look.ring;
    g.fillStyle(ring, 0.14 + 0.08 * pulse).fillEllipse(x, y, rx, rx / 2);
    g.lineStyle(2, ring, 0.75 + 0.2 * pulse).strokeEllipse(x, y, rx, rx / 2);
    g.lineStyle(1, ring, 0.45).strokeEllipse(x, y, rx * 1.25, rx * 0.625);
    if (actor.rank !== 'elite') return;
    const w = 44;
    const h = 5;
    const by = y - 92 * actor.scale;
    top.fillStyle(0x000000, 0.75).fillRect(x - w / 2 - 1, by - 1, w + 2, h + 2);
    top.fillStyle(0x3a0a08, 1).fillRect(x - w / 2, by, w, h);
    top.fillStyle(look.ring, 1).fillRect(x - w / 2, by, w * Phaser.Math.Clamp(life, 0, 1), h);
    // Coloured edge on the bar and the modifier's name right above it.
    if (actor.elite) {
      top.lineStyle(1, ring, 0.9).strokeRect(x - w / 2 - 1.5, by - 1.5, w + 3, h + 3);
      actor.elite.label.setPosition(x, by - 3);
    }
  }

  /** An elite's modifier marks: its localized name (positioned with the life bar every frame) and the glow outline. */
  private createEliteMark(actor: Actor, modifier: string): EliteMark {
    const look = eliteLook(modifier);
    const label = this.add
      .text(actor.sprite.x, actor.sprite.y, eliteModifierName(modifier), { fontFamily: UI.bodyFont, fontStyle: 'bold', fontSize: `${UI.size.small}px`, color: look.css, stroke: '#000', strokeThickness: 4 })
      .setOrigin(0.5, 1)
      .setScale(this.textScale)
      .setDepth(4001);
    const def = eliteModifierDef(this.content, modifier);
    return { modifier, fire: this.firesWith(modifier), fast: (def?.moveSpeed ?? 1) > 1, label, glow: this.eliteFx.addGlow(actor.sprite, modifier) };
  }

  /**
   * The hero's action converts its damage to cold (Heart of Winter's Fireball, from core's effective action): icy
   * looks for its explosion and split.
   */
  private convertsToCold(actionId: string): boolean {
    const actions = this.world.player.actions;
    const action = actions.skills.find((a) => a.id === actionId) ?? (actions.basicAttack.id === actionId ? actions.basicAttack : undefined);
    return action?.damageConversion?.to === 'cold';
  }

  /** The elite modifier converts its damage to fire (core data): fire looks for its projectiles, zones and swings. */
  private firesWith(modifier: string | undefined): boolean {
    return modifier !== undefined && eliteModifierDef(this.content, modifier)?.damageConversion?.to === 'fire';
  }

  /**
   * Darkness with a lit circle around the hero: a small gradient texture for the light falloff plus
   * plain dark rectangles reaching far beyond any screen, so wide displays never show an unlit strip
   * and GPU memory stays small (a screen-sized gradient texture would be ~100 MB on 1440p).
   * Its strength and colour come from the zone (the crypt: deep darkness; the temple ruins: a soft warm vignette).
   */
  private createLight(env: EnvironmentLook): Phaser.GameObjects.Container {
    const { darkness, darknessColor } = env.light;
    if (darkness <= 0) return this.add.container(0, 0).setDepth(5000);
    const key = `light-mask:${env.id}`;
    const size = LIGHT_TEXTURE;
    const rgb = `${(darknessColor >> 16) & 255},${(darknessColor >> 8) & 255},${darknessColor & 255}`;
    if (!this.textures.exists(key)) {
      const canvas = this.textures.createCanvas(key, size, size)!;
      const ctx = canvas.getContext();
      const gradient = ctx.createRadialGradient(size / 2, size / 2, LIGHT_RADIUS * 0.3, size / 2, size / 2, LIGHT_RADIUS);
      gradient.addColorStop(0, `rgba(${rgb},0)`);
      gradient.addColorStop(0.6, `rgba(${rgb},${darkness * 0.49})`);
      gradient.addColorStop(1, `rgba(${rgb},${darkness})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      canvas.refresh();
    }
    const far = 20000;
    const half = size / 2;
    const outside = this.add.graphics().fillStyle(darknessColor, darkness);
    outside.fillRect(-far, -far, 2 * far, far - half); // above
    outside.fillRect(-far, half, 2 * far, far - half); // below
    outside.fillRect(-far, -half, far - half, size); // left
    outside.fillRect(half, -half, far - half, size); // right
    return this.add.container(0, 0, [this.add.image(0, 0, key), outside]).setDepth(5000);
  }

  /**
   * A centre-screen announcement (heading + optional line) that fades in and out. One at a time: a new one replaces
   * the one on screen, so room / boss / time messages and the level-up banner never pile up.
   */
  private announce(title: string, sub?: string, size = 36): void {
    for (const o of this.announcement) o.destroy();
    const { width, height } = this.scale;
    const compact = width < 820 || height < 520;
    // Phones: smaller and above the hero (who stands in the screen centre), under the run HUD.
    const phone = densityOf(width, height, compact) === 'phone';
    const y = height * (compact && !phone ? 0.4 : 0.3);
    const big = heading(this, width / 2, y, title, phone ? Math.round(size * 0.62) : compact ? Math.round(size * 0.75) : size).setOrigin(0.5);
    const parts = [big];
    if (sub) parts.push(label(this, width / 2, y + (phone ? 24 : compact ? 28 : 38), sub, compact ? UI.size.small : UI.size.body, UI.goldBrightText, true).setOrigin(0.5));
    // Light floors: a dark halo instead of the warm glow, which washes out on pale stone.
    const halo = this.env.light.textHalo;
    for (const p of parts) {
      if (halo) p.setShadow(0, 2, halo, 8, true, true);
      pinToScreen(p, 15000);
      p.setAlpha(0);
      this.tweens.add({ targets: p, alpha: 1, duration: 200, hold: 1300, yoyo: true, onComplete: () => p.destroy() });
    }
    big.setScale(1.3);
    this.tweens.add({ targets: big, scale: 1, duration: 300, ease: 'Back.easeOut' });
    this.announcement = parts;
  }

  /**
   * Golden burst around the hero, a banner and a pulse on the XP bar. The core refills life (and the resource only
   * when ResourceDef.refillOnLevelUp: Rage is kept); the banner says what was restored.
   */
  private showLevelUp(level: number): void {
    this.hud.levelUp();
    this.cameras.main.flash(180, 255, 230, 160);
    const heroPos = this.world.player.pos;
    this.areas.push({ origin: heroPos, facing: vec(1, 0), radius: 120, angleDeg: 360, color: 0xffd36a, ttl: AREA_TTL * 3 });
    const screen = toScreen(heroPos);
    const ring = this.add.ellipse(screen.x, screen.y, 40, 20).setStrokeStyle(4, 0xffd36a, 1).setDepth(4001);
    this.tweens.add({ targets: ring, scaleX: 6, scaleY: 6, alpha: 0, duration: 700, ease: 'Cubic.easeOut', onComplete: () => ring.destroy() });
    const pillar = this.add.rectangle(screen.x, screen.y, 46, 220, 0xffe7a0, 0.55).setOrigin(0.5, 1).setDepth(4001).setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: pillar, scaleX: 0.1, alpha: 0, duration: 800, ease: 'Quad.easeIn', onComplete: () => pillar.destroy() });

    const classDef = getClass(this.content, this.classId);
    // Blood Magic: no resource to restore (max 0).
    const refills = classDef.resource.refillOnLevelUp && maxResource(classDef, this.world.player) > 0;
    const resId = classDef.resource.id;
    const restored = refills ? t('arena.restoredBoth', { resName: resourceText(resId), resAcc: resourceText(resId, 'acc') }) : t('arena.restoredLife');
    this.announce(t('arena.levelUp'), t('arena.levelUpLine', { level, restored }), 44);
  }

  /** A short floating label (localized) over a mob at world `pos`, `lift` px above its feet; pooled like damage numbers. */
  private spawnFloatText(pos: Vec2, message: string, kind: FloatTextKind, lift: number, color?: string): void {
    const style = FLOAT_TEXT_STYLES[kind];
    const screen = toScreen(pos);
    const text = this.textPool.pop() ?? this.add.text(0, 0, '', { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '18px', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(6000);
    // Keep it below the run HUD (timer, boss bar), which would hide it when the mob stands near the top of the screen.
    const k = this.textScale;
    const minY = this.cameras.main.worldView.y + (this.runHud.bottom() + 16) * k + style.rise * k;
    text.setText(message).setPosition(screen.x, Math.max(screen.y - lift, minY)).setColor(color ?? style.color).setFontSize(style.size).setScale(k).setAlpha(1).setVisible(true);
    this.tweens.add({
      targets: text,
      y: text.y - style.rise * k,
      alpha: 0,
      duration: style.duration,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        text.setVisible(false);
        this.textPool.push(text);
      },
    });
  }

  private spawnDamageNumber(pos: Vec2, amount: number, kind: DamageNumberKind): void {
    const style = DAMAGE_NUMBER_STYLES[kind];
    const screen = toScreen(pos);
    const text = this.textPool.pop() ?? this.add.text(0, 0, '', { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '18px', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(6000);
    // Damage over time numbers (ignite, bleed) sit a bit lower and to the side so they do not cover hit numbers.
    const small = kind === 'dot' || kind === 'playerDot' || kind === 'bleed' || kind === 'lifeCost';
    // Heal / life cost numbers sit to the left of the hero (incoming hit numbers jitter round the centre).
    const side = kind === 'heal' || kind === 'lifeCost';
    const dx = side ? -18 - Math.random() * 8 : small ? 14 + Math.random() * 10 : (Math.random() - 0.5) * 16;
    const value = small || kind === 'heal' ? Math.max(1, Math.round(amount)) : Math.round(amount);
    const label = kind === 'heal' ? `+${value}` : kind === 'lifeCost' ? `-${value}` : String(value);
    text
      .setText(label)
      .setPosition(screen.x + dx, screen.y - (kind === 'heal' ? 84 : small ? 56 : 70))
      .setColor(style.color)
      .setFontSize(style.size)
      .setScale(this.textScale)
      .setAlpha(1)
      .setVisible(true);
    this.tweens.add({
      targets: text,
      y: text.y - style.rise * this.textScale,
      alpha: 0,
      duration: style.duration,
      onComplete: () => {
        text.setVisible(false);
        this.textPool.push(text);
      },
    });
  }
}

/** One line of the pause / end screen. */
interface Line {
  text: string;
  size: number;
  color: string;
  bold?: boolean;
  heading?: boolean;
  /** Extra space above the line. */
  gap?: number;
  /** The legendary drop banner (pulses; flash and burst when first shown). */
  legendary?: true;
}

const RUN_EVENT_TYPES: ReadonlySet<string> = new Set<RunEvent['type']>(['roomEnter', 'waveStart', 'roomCleared', 'altarActivated', 'bossSpawned', 'rankedKill', 'timeWarning', 'runWon', 'runFailed']);

function isRunEvent(event: RunStepEvent): event is RunEvent {
  return RUN_EVENT_TYPES.has(event.type);
}

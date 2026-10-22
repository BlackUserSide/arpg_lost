import * as Phaser from 'phaser';
import { distance, vec, type Vec2 } from '../core/math';
import type { Content } from '../core/world/content';
import { createWorld, distanceDamageMore, getClass, getMob, maxResource, PLAYER_ID, setLoadoutModifiers, step, type PlayerInput, type WorldEvent, type WorldState } from '../core/world/world';
import { unspentPoints } from '../core/passives/allocation';
import { equippedWeapon } from '../core/items/equipment';
import { grantArenaRewards, type RunRewards } from '../core/items/inventory';
import { heroMechanics, heroModifiers } from '../core/progression/hero';
import { applyRunResult, findCharacter } from '../core/progression/profile';
import { createRng } from '../core/rng';
import { itemsData } from '../data/items';
import { content } from '../data';
import { passiveTree } from '../data/passives';
import { getApp } from './app';
import { CombatFx, STUN_BAR_FLASH, statusLook } from './combatFx';
import { Hud } from './hud';
import { resourceNames } from './resourceText';
import { PointsBanner } from './passiveBanner';
import type { PassiveTreeSceneData, RunTreeHooks } from './PassiveTreeScene';
import { SOLO_MODE, type RunMode } from './runMode';
import { fadeIn, heading, label, makeButton, makeFrame, pinToScreen, UI } from './ui';
import { screenDirToWorld, stickyDirectionRow, toScreen, toWorld } from './iso';
import { ACTION_ANIMS, CLASS_LOOKS, loadSprites, MOB_SPRITES, ORIGIN_Y, SPRITE_SETS, textureKey } from './sprites';

// Isometric arena: Flare floor tiles, characters baked from KayKit 3D models (tools/sprite-baker).

const DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

const TILE_WORLD = 68; // world units per floor tile side (96px wide diamond at ISO_K)
const TILE_SCALE = 0.5;
const CORPSE_TIME = 2.5;
const AREA_TTL = 0.18;
const LIGHT_RADIUS = 520;
/** Light falloff texture side; must exceed 2 × LIGHT_RADIUS. */
const LIGHT_TEXTURE = 1200;
const DARKNESS = 0.92;
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
/** How fast the displayed stun bar catches up with the core fill (1/s, exponential). */
const STUN_BAR_SMOOTHING = 18;
/** Ignite damage is summed per mob and shown as one number this often (seconds). */
const DOT_NUMBER_INTERVAL = 0.5;

const PLAIN_FLOORS = [0, 1, 2, 3, 20, 21, 22, 23];
const DETAIL_FLOORS = [16, 17, 18, 19, 24, 25, 26, 27, 28, 29, 30, 31];

/** Visual-only colors per action / damage flavour. */
const AREA_COLORS: Record<string, number> = { cleave: 0xff9a3c, fireball: 0xff6a1a, explosive_trap: 0xff8a2a, frost_nova: 0x8fd3ff };
const PROJECTILE_COLORS: Record<string, number> = { ranger_bolt: 0xe8e2cf, volley: 0xe8e2cf, wand_bolt: 0xb58cff, fireball: 0xff7a1a };
const MOB_PROJECTILE_COLOR = 0xff4b4b;
/** Area tint of a trap explosion set off by another trap. */
const CHAIN_AREA_COLOR = 0xffd23a;
/** Far Shot (distanceDamage) glow around bolts. */
const FAR_SHOT_GLOW = 0xfff0a0;

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
}

interface Corpse {
  actor: Actor;
  ttl: number;
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
}

type DamageNumberKind = 'hit' | 'crit' | 'player' | 'dot';

/** Visual-only damage number looks. */
const DAMAGE_NUMBER_STYLES: Record<DamageNumberKind, { color: string; size: number; rise: number; duration: number }> = {
  hit: { color: '#ffffff', size: 18, rise: 30, duration: 600 },
  crit: { color: '#ffd23f', size: 26, rise: 30, duration: 600 },
  player: { color: '#ff5050', size: 18, rise: 30, duration: 600 },
  dot: { color: '#ff9a3c', size: 14, rise: 20, duration: 700 },
};

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'Q' | 'E' | 'R' | 'P' | 'ESC', Phaser.Input.Keyboard.Key>;

const NO_MOVE = vec(0, 0);
const NO_SKILLS: readonly boolean[] = [false, false, false];
const HUD_UI_DEPTH = 10010;

export class IsoArenaScene extends Phaser.Scene {
  private readonly content: Content = content;
  private characterId = '';
  private classId = 'warrior';
  private runRecorded = false;
  private rewards: RunRewards | undefined;
  private world!: WorldState;
  private accumulator = 0;
  private alpha = 1;
  private prevPositions = new Map<number, Vec2>();
  private keys!: Keys;
  private hero!: Actor;
  private mobs = new Map<number, Actor>();
  private corpses: Corpse[] = [];
  private areas: AreaFx[] = [];
  private fx!: Phaser.GameObjects.Graphics;
  private fxTop!: Phaser.GameObjects.Graphics;
  private light!: Phaser.GameObjects.Container;
  private hud!: Hud;
  private overlay: Phaser.GameObjects.GameObject[] | undefined;
  private paused = false;
  private textPool: Phaser.GameObjects.Text[] = [];
  private combatFx!: CombatFx;
  private dotTallies = new Map<number, DotTally>();
  private skillWasDown: boolean[] = [];
  private skillBuffer: number[] = [];
  private mode: RunMode = SOLO_MODE;
  /** The passive tree is open over the run (the run keeps going only if the mode does not pause on menus). */
  private treeOpen = false;
  /** The tab lost focus or was hidden while the tree was open. */
  private pauseAfterTree = false;
  private treeButton: Phaser.GameObjects.Container | undefined;
  private banner!: PointsBanner;
  /** The current mouse/touch press started on a HUD control, so it must not attack. */
  private uiPress = false;
  /** The hero's counter-attack animation and the direction it faces while it plays (core keeps the hero's facing). */
  private counterShot: Actor['oneShot'];
  private counterFacing: Vec2 = vec(1, 0);

  constructor() {
    super('iso-arena');
  }

  init(data: { characterId?: string; mode?: RunMode }): void {
    if (data.characterId) this.characterId = data.characterId;
    this.mode = data.mode ?? SOLO_MODE;
    this.classId = findCharacter(getApp(this).profile, this.characterId)?.classId ?? 'warrior';
    this.runRecorded = false;
  }

  preload(): void {
    this.load.spritesheet('floor', 'assets/test/floor.png', { frameWidth: 192, frameHeight: 96 });
    loadSprites(this);
  }

  create(): void {
    const character = findCharacter(getApp(this).profile, this.characterId);
    const classDef = getClass(this.content, this.classId);
    // Equipment and passives enter the run as modifiers, plus the equipped weapon.
    const loadout = character
      ? {
          level: character.level,
          xp: character.xp,
          modifiers: heroModifiers(character, itemsData, passiveTree),
          mechanics: heroMechanics(character, passiveTree),
          weapon: equippedWeapon(character.equipment, itemsData, classDef.weapon),
        }
      : {};
    // TEMPORARY (until maps, 0.4): the arena's area level follows the hero, so there is no low-area penalty.
    this.world = createWorld(this.content, this.classId, (Math.random() * 2 ** 32) >>> 0, loadout);
    this.rewards = undefined;
    // Dev-only handle for debugging and automated checks from the console.
    if (import.meta.env.DEV) (window as unknown as { __world: WorldState }).__world = this.world;
    this.accumulator = 0;
    this.alpha = 1;
    this.prevPositions.clear();
    this.mobs.clear();
    this.corpses = [];
    this.areas = [];
    this.textPool = [];
    this.dotTallies.clear();
    this.skillWasDown = [];
    this.skillBuffer = [];
    this.counterShot = undefined;

    for (const [set, anims] of Object.entries(SPRITE_SETS)) {
      for (const anim of Object.keys(anims)) this.textures.get(textureKey(set, anim)).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }

    this.input.mouse?.disableContextMenu();
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,Q,E,R,P,ESC') as Keys;
    this.input.on('pointerdown', (_p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => (this.uiPress = over.length > 0));
    this.input.on('pointerup', () => (this.uiPress = false));

    this.buildFloor();
    this.fx = this.add.graphics().setDepth(-1000);
    this.fxTop = this.add.graphics().setDepth(4000);
    this.combatFx = new CombatFx(this);
    const look = CLASS_LOOKS.find((l) => l.classId === this.classId);
    this.hero = this.createActor(look?.sprite ?? 'knight', this.world.player.pos);
    this.light = this.createLight();

    const { width, height } = this.content.arena;
    const left = toScreen(vec(0, height)).x;
    const right = toScreen(vec(width, 0)).x;
    const bottom = toScreen(vec(width, height)).y;
    this.cameras.main.setBounds(left - 200, -200, right - left + 400, bottom + 400);
    this.cameras.main.setBackgroundColor('#07070a');

    this.hud = new Hud(this, getClass(this.content, this.classId), this.content.progression);
    this.hud.layout(this.scale.width, this.scale.height);
    this.overlay = undefined;
    this.paused = false;
    this.treeOpen = false;
    this.pauseAfterTree = false;
    this.uiPress = false;
    this.treeButton = undefined;
    this.banner = new PointsBanner(this, () => this.openTree(), { depth: HUD_UI_DEPTH, pinned: true });
    this.layoutTreeUi();
    this.refreshBanner();
    const relayout = (): void => {
      this.hud.layout(this.scale.width, this.scale.height);
      this.layoutTreeUi();
      if (this.overlay) this.showOverlay(this.paused ? 'pause' : 'death');
    };
    this.scale.on('resize', relayout);
    // Leaving the tab pauses the run (and tells the portal gameplay stopped).
    const autoPause = (): void => {
      // With the tree open, remember it: closing the tree must not resume a run nobody is watching.
      if (this.treeOpen) this.pauseAfterTree = true;
      else if (!this.paused && !this.world.player.dead) this.setPaused(true);
    };
    const back = (): void => {
      this.pauseAfterTree = false;
    };
    this.game.events.on(Phaser.Core.Events.BLUR, autoPause);
    this.game.events.on(Phaser.Core.Events.HIDDEN, autoPause);
    this.game.events.on(Phaser.Core.Events.FOCUS, back);
    this.game.events.on(Phaser.Core.Events.VISIBLE, back);

    getApp(this).platform.gameplayStart();
    fadeIn(this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', relayout);
      this.game.events.off(Phaser.Core.Events.BLUR, autoPause);
      this.game.events.off(Phaser.Core.Events.HIDDEN, autoPause);
      this.game.events.off(Phaser.Core.Events.FOCUS, back);
      this.game.events.off(Phaser.Core.Events.VISIBLE, back);
      if (this.treeOpen) this.scene.stop('passive-tree');
      this.treeOpen = false;
      this.endRun();
    });
  }

  /** Talents button (top right) and the unspent points banner under the run info. */
  private layoutTreeUi(): void {
    const { width, height } = this.scale;
    const compact = width < 820 || height < 520;
    const margin = compact ? 12 : 22;
    this.treeButton?.destroy();
    this.treeButton = undefined;
    if (!findCharacter(getApp(this).profile, this.characterId)) return;
    const w = compact ? 96 : 150;
    const h = compact ? 34 : 40;
    this.treeButton = pinToScreen(makeButton(this, width - margin - w / 2, margin + 18, w, h, compact ? 'Таланти' : 'Таланти (P)', () => this.openTree()), HUD_UI_DEPTH);
    const bh = compact ? 34 : 40;
    this.banner.setPosition(width / 2, margin + 36 + 10 + bh / 2, bh);
  }

  private refreshBanner(): void {
    const character = findCharacter(getApp(this).profile, this.characterId);
    if (!character) return;
    const hero = { classId: character.classId, level: this.world.player.level, passives: character.passives };
    const { points, specPoints } = unspentPoints(passiveTree, hero);
    this.banner.setPoints(points, specPoints);
  }

  /** Opens the passive tree over the run; whether the run pauses is the mode's rule. */
  private openTree(): void {
    if (this.treeOpen || this.paused || this.world.player.dead) return;
    const app = getApp(this);
    if (!findCharacter(app.profile, this.characterId)) return;
    this.treeOpen = true;
    const run: RunTreeHooks = {
      level: () => this.world.player.level,
      changed: () => this.applyPassives(true),
      closed: () => this.closeTree(),
    };
    if (this.mode.pauseOnMenus) {
      app.platform.gameplayStop();
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
    setLoadoutModifiers(this.world, this.content, heroModifiers(character, itemsData, passiveTree), heroMechanics(character, passiveTree));
    this.refreshBanner();
    if (save) app.save();
  }

  private closeTree(): void {
    this.treeOpen = false;
    this.applyPassives(false);
    const away = this.pauseAfterTree || document.hidden;
    this.pauseAfterTree = false;
    if (this.mode.pauseOnMenus) this.scene.resume();
    if (away && !this.world.player.dead) {
      // Back to the pause menu instead of live play; gameplay stays stopped for the portal.
      this.paused = true;
      if (!this.mode.pauseOnMenus) getApp(this).platform.gameplayStop();
      this.showOverlay('pause');
    } else if (this.mode.pauseOnMenus) {
      getApp(this).platform.gameplayStart();
    }
    // Keys and buttons held when the tree opened must not fire now.
    this.input.keyboard?.resetKeys();
    this.skillBuffer = [];
    this.skillWasDown = [];
    this.uiPress = false;
    this.accumulator = 0;
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    const platform = getApp(this).platform;
    if (paused) {
      platform.gameplayStop();
      this.showOverlay('pause');
    } else {
      platform.gameplayStart();
      this.hideOverlay();
      this.accumulator = 0;
    }
  }

  private showOverlay(kind: 'pause' | 'death'): void {
    this.hideOverlay();
    const { width, height } = this.scale;
    const compact = width < 820 || height < 520;
    const objects: Phaser.GameObjects.GameObject[] = [];
    const shade = this.add.rectangle(width / 2, height / 2, width, height, kind === 'death' ? 0x1a0303 : 0x000000, kind === 'death' ? 0.6 : 0.55).setInteractive();
    objects.push(shade);
    const panelW = Math.min(420, width - 32);
    const lootLines = kind === 'death' ? Math.max(1, this.rewards?.items.length ?? 0) : 0;
    const panelH = (kind === 'death' ? (compact ? 254 : 294) : compact ? 190 : 220) + lootLines * 24 + (kind === 'death' ? 24 : 0);
    objects.push(makeFrame(this, width / 2, height / 2, panelW, panelH, 'panel'));
    const top = height / 2 - panelH / 2;
    const title = heading(this, width / 2, top + (compact ? 30 : 40), kind === 'death' ? 'You have fallen' : 'Paused', compact ? 28 : 36).setOrigin(0.5);
    objects.push(title);
    let y = top + (compact ? 64 : 82);
    if (kind === 'death') {
      const seconds = Math.floor(this.world.time);
      const summary = `Survived ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}  ·  ${this.world.kills} kills  ·  wave ${this.world.spawn.wave}`;
      objects.push(label(this, width / 2, y, summary, UI.size.body, UI.muted).setOrigin(0.5, 0));
      y += 24;
      const xpLine = `+${Math.floor(this.world.xpGained)} XP  ·  level ${this.world.player.level}`;
      objects.push(label(this, width / 2, y, xpLine, UI.size.body, UI.goldBrightText, true).setOrigin(0.5, 0));
      y += 34;
      objects.push(heading(this, width / 2, y, 'Loot', 20).setOrigin(0.5, 0));
      y += 28;
      const items = this.rewards?.items ?? [];
      if (items.length === 0) {
        const per = itemsData.rules.arenaRewards.killsPerItem;
        objects.push(label(this, width / 2, y, `Nothing this time — every ${per} kills earn an item`, UI.size.small, UI.muted).setOrigin(0.5, 0));
      }
      for (const item of items) {
        const base = itemsData.bases[item.baseId];
        const line = item.rarity === 'rare' ? `${item.name} (${base?.name ?? ''})` : item.name;
        objects.push(label(this, width / 2, y, `${line}  ·  ilvl ${item.level}`, UI.size.body, UI.rarity[item.rarity], true).setOrigin(0.5, 0));
        y += 24;
      }
      if (this.rewards && this.rewards.salvaged > 0) {
        objects.push(label(this, width / 2, y, `Stash full: salvaged for ${this.rewards.salvaged} shards`, UI.size.small, UI.muted).setOrigin(0.5, 0));
      }
    }
    const buttonW = Math.min(200, (panelW - 48) / 2);
    const buttonY = top + panelH - (compact ? 40 : 50);
    const primary =
      kind === 'death'
        ? makeButton(this, width / 2 + buttonW / 2 + 6, buttonY, buttonW, compact ? 44 : 52, 'Try again', () => this.restartRun(), 'primary')
        : makeButton(this, width / 2 + buttonW / 2 + 6, buttonY, buttonW, compact ? 44 : 52, 'Resume', () => this.setPaused(false), 'primary');
    const menu = makeButton(this, width / 2 - buttonW / 2 - 6, buttonY, buttonW, compact ? 44 : 52, 'Main menu', () => this.leaveToMenu());
    objects.push(primary, menu);
    objects.push(label(this, width / 2, buttonY - (compact ? 40 : 48), kind === 'death' ? 'R — try again   ·   Esc — menu' : 'Esc — resume', UI.size.small, UI.muted).setOrigin(0.5));
    for (const o of objects) pinToScreen(o, 20000);
    const fadeTargets = objects.slice(1);
    for (const o of fadeTargets) (o as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(0);
    this.tweens.add({ targets: fadeTargets, alpha: 1, duration: kind === 'death' ? 600 : 150, delay: kind === 'death' ? 500 : 0 });
    this.overlay = objects;
  }

  private hideOverlay(): void {
    for (const o of this.overlay ?? []) o.destroy();
    this.overlay = undefined;
  }

  private restartRun(): void {
    this.scene.restart({ characterId: this.characterId, mode: this.mode });
  }

  private leaveToMenu(): void {
    this.endRun();
    this.cameras.main.fadeOut(200, 10, 9, 12);
    this.cameras.main.once('camerafadeoutcomplete', () => this.scene.start('main-menu'));
  }

  /** Records the run once (death or leaving) and tells the portal gameplay stopped. */
  private endRun(): void {
    if (this.runRecorded) return;
    this.runRecorded = true;
    const app = getApp(this);
    app.platform.gameplayStop();
    if (!findCharacter(app.profile, this.characterId)) return;
    applyRunResult(app.profile, this.characterId, {
      kills: this.world.kills,
      duration: this.world.time,
      died: this.world.player.dead,
      progress: { level: this.world.player.level, xp: this.world.player.xp },
    });
    this.rewards = grantArenaRewards(app.profile, createRng((Math.random() * 2 ** 32) >>> 0), { kills: this.world.kills, wave: this.world.spawn.wave }, itemsData);
    app.save();
    // PROPOSAL (docs/design/account.md): until bosses/loot exist, the first finished run is the "meaningful moment".
    if (!app.user && app.loginHint === 'none') app.loginHint = 'pending';
  }

  override update(_time: number, deltaMs: number): void {
    const dead = this.world.player.dead;
    // While the tree is open (modes that do not pause), its screen owns the keys.
    if (!this.treeOpen) {
      if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
        if (dead) this.leaveToMenu();
        else this.setPaused(!this.paused);
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.R) && dead) {
        this.restartRun();
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.P) && !this.paused && !dead) {
        this.openTree();
        return;
      }
    }
    if (this.paused) return;

    this.accumulator += deltaMs / 1000;
    let steps = 0;
    while (this.accumulator >= DT && steps < MAX_STEPS_PER_FRAME) {
      this.snapshotPositions();
      for (const event of step(this.world, this.readInput(), this.content, DT)) this.onEvent(event);
      this.accumulator -= DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    // Render between the last two sim states so motion is smooth at any refresh rate.
    this.alpha = Math.min(1, this.accumulator / DT);
    const dt = deltaMs / 1000;
    this.syncActors(dt);
    this.updateCorpses(dt);
    this.drawFx(dt);

    const heroScreen = toScreen(this.hero.display);
    this.cameras.main.centerOn(heroScreen.x, heroScreen.y - 30);
    this.light.setPosition(heroScreen.x, heroScreen.y - 30);
    this.hud.update(this.world, dt);
  }

  private readInput(): PlayerInput {
    if (this.treeOpen) return { move: NO_MOVE, aim: this.world.player.pos, basicAttack: false, skills: NO_SKILLS };
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
    return {
      move: screenDirToWorld(screenMove),
      // Aim at ground level under the cursor; sprites stand on their feet.
      aim: toWorld(vec(aim.x, aim.y)),
      basicAttack: pointer.leftButtonDown() && !this.uiPress,
      skills,
    };
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
          const color = event.chain ? CHAIN_AREA_COLOR : (AREA_COLORS[event.actionId] ?? 0xdde4ff);
          this.areas.push({ ...event, color, ttl: AREA_TTL });
          if (event.chain) {
            const s = toScreen(event.origin);
            this.combatFx.chainBurst(s.x, s.y, event.radius);
          }
        }
        break;
      case 'trapRemoved': {
        const s = toScreen(event.pos);
        this.combatFx.trapFizzle(s.x, s.y);
        break;
      }
      case 'dot': {
        let tally = this.dotTallies.get(event.targetId);
        if (!tally) {
          tally = { amount: 0, timer: DOT_NUMBER_INTERVAL, pos: event.pos };
          this.dotTallies.set(event.targetId, tally);
        }
        tally.amount += event.amount;
        tally.pos = event.pos;
        break;
      }
      case 'teleport':
        this.areas.push({ origin: event.from, facing: vec(1, 0), radius: 40, angleDeg: 360, color: 0xb58cff, ttl: AREA_TTL * 2 });
        this.areas.push({ origin: event.to, facing: vec(1, 0), radius: 40, angleDeg: 360, color: 0xb58cff, ttl: AREA_TTL * 2 });
        break;
      case 'mobAttack': {
        const actor = this.mobs.get(event.id);
        if (actor) this.playOneShot(actor, 'attack');
        break;
      }
      case 'hit': {
        const actor = event.targetId === PLAYER_ID ? this.hero : this.mobs.get(event.targetId);
        // Hit reaction only interrupts idle/run, never an attack or skill.
        // A frozen mob holds its pose.
        if (actor && !actor.oneShot && !actor.frozen) this.playOneShot(actor, 'hit');
        this.spawnDamageNumber(event.pos, event.amount, event.isCrit ? 'crit' : event.targetId === PLAYER_ID ? 'player' : 'hit');
        break;
      }
      case 'death': {
        this.flushDotTally(event.id);
        const actor = this.mobs.get(event.id);
        if (actor) {
          this.playOneShot(actor, 'death');
          actor.sprite.clearTint();
          actor.sprite.setDepth(toScreen(actor.display).y - 40);
          this.corpses.push({ actor, ttl: CORPSE_TIME });
          this.mobs.delete(event.id);
        }
        break;
      }
      case 'levelUp':
        this.showLevelUp(event.level);
        this.refreshBanner();
        break;
      case 'playerDeath':
        this.playOneShot(this.hero, 'death');
        this.endRun();
        this.cameras.main.shake(250, 0.006);
        this.showOverlay('death');
        break;
      default:
        break;
    }
  }

  private createActor(set: string, pos: Vec2): Actor {
    const sprite = this.add.sprite(0, 0, textureKey(set, 'idle'), 0).setOrigin(0.5, ORIGIN_Y);
    return { sprite, set, display: pos, facing: vec(1, 1), row: -1, time: 0, runPhase: 0, moving: false, oneShot: undefined, frozen: false, stunBarShown: 0, stunBarFlash: 0 };
  }

  /** Remembers where everything was before a sim step, for interpolation. */
  private snapshotPositions(): void {
    const prev = this.prevPositions;
    prev.clear();
    prev.set(PLAYER_ID, this.world.player.pos);
    for (const mob of this.world.mobs) prev.set(mob.id, mob.pos);
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

    for (const mob of this.world.mobs) {
      let actor = this.mobs.get(mob.id);
      if (!actor) {
        actor = this.createActor(MOB_SPRITES[mob.defId] ?? 'skeleton_warrior', mob.pos);
        this.mobs.set(mob.id, actor);
      }
      actor.facing = mob.facing;
      const target = this.interpolated(mob.id, mob.pos);
      if (distance(actor.display, target) > SNAP_DISTANCE) actor.display = target;
      else {
        const k = 1 - Math.exp(-MOB_SMOOTHING * dt);
        actor.display = vec(actor.display.x + (target.x - actor.display.x) * k, actor.display.y + (target.y - actor.display.y) * k);
      }
      const def = getMob(this.content, mob.defId);
      // A frozen mob holds its pose; a boss under freeze (freezeSlow) only looks frozen and keeps moving.
      actor.frozen = mob.freeze > 0;
      this.updateActor(actor, dt, this.speedOf(mob.id, mob.pos), def.moveSpeed, actor.frozen);
      // Likewise a boss under an ordinary stun (stunSlow) looks stunned but keeps moving.
      const frozenLook = Math.max(mob.freeze, mob.freezeSlow);
      const look = statusLook(frozenLook, Math.max(mob.stun, mob.stunSlow), mob.ignite, Math.max(mob.slow, mob.auraSlow), this.world.time, mob.id);
      if (look === undefined) actor.sprite.clearTint();
      else actor.sprite.setTint(look.color).setTintMode(look.mode);
    }
    this.updateDotNumbers(dt);
  }

  /** Pops a damage number for each mob's ignite damage every DOT_NUMBER_INTERVAL, and once more when it ends. */
  private updateDotNumbers(dt: number): void {
    if (this.dotTallies.size === 0) return;
    for (const mob of this.world.mobs) {
      const tally = this.dotTallies.get(mob.id);
      if (!tally) continue;
      tally.timer -= dt;
      if (mob.ignite <= 0) this.flushDotTally(mob.id);
      else if (tally.timer <= 0) {
        // Still burning: show the sum and keep counting in the same tally.
        this.showDotTally(tally);
        tally.amount = 0;
        tally.timer = DOT_NUMBER_INTERVAL;
      }
    }
  }

  /** Shows the accumulated ignite damage of one mob (if any) and forgets the tally until the next dot event. */
  private flushDotTally(id: number): void {
    const tally = this.dotTallies.get(id);
    if (!tally) return;
    this.showDotTally(tally);
    this.dotTallies.delete(id);
  }

  private showDotTally(tally: DotTally): void {
    if (tally.amount >= 0.5) this.spawnDamageNumber(tally.pos, tally.amount, 'dot');
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
    if (shot && shotDef) {
      shot.elapsed += dt;
      const index = Math.floor(shot.elapsed * shotDef.fps);
      if (index < shotDef.frames || shot.anim === 'death') {
        anim = shot.anim;
        col = Math.min(index, shotDef.frames - 1);
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
    if (actor.sprite.texture.key !== key) actor.sprite.setTexture(key);
    actor.sprite.setFrame(Math.max(0, actor.row) * def.frames + col);
  }

  private updateCorpses(dt: number): void {
    const alive: Corpse[] = [];
    for (const corpse of this.corpses) {
      corpse.ttl -= dt;
      corpse.actor.time += dt;
      this.applyFrame(corpse.actor, dt);
      corpse.actor.sprite.setAlpha(Math.min(1, corpse.ttl / 0.5));
      if (corpse.ttl > 0) alive.push(corpse);
      else corpse.actor.sprite.destroy();
    }
    this.corpses = alive;
  }

  private drawFx(dt: number): void {
    const g = this.fx.clear();
    const top = this.fxTop.clear();
    const player = this.world.player;

    // Ring under the hero so they never get lost in a crowd; orange while buffed.
    const hero = toScreen(this.hero.display);
    g.lineStyle(2, player.buffs.length > 0 ? 0xff9a3c : 0xe8c15a, 0.9).strokeEllipse(hero.x, hero.y, 46, 23);

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
      const radius = getMob(this.content, mob.defId).radius;
      const frozenLook = Math.max(mob.freeze, mob.freezeSlow);
      this.combatFx.drawMobStatus(g, top, actor.sprite.x, actor.sprite.y, radius, frozenLook, Math.max(mob.stun, mob.stunSlow), mob.ignite, this.world.time, dt, mob.id);
      // Stun bar (stunBar mechanic): eases up to the core fill, snaps down on reset; flashes full after a stun.
      actor.stunBarFlash = Math.max(0, actor.stunBarFlash - dt);
      if (mob.stunBar < actor.stunBarShown) actor.stunBarShown = mob.stunBar;
      else actor.stunBarShown += (mob.stunBar - actor.stunBarShown) * (1 - Math.exp(-STUN_BAR_SMOOTHING * dt));
      if (actor.stunBarShown < 0.002 && mob.stunBar <= 0) actor.stunBarShown = 0;
      this.combatFx.drawStunBar(top, actor.sprite.x, actor.sprite.y, actor.stunBarShown, actor.stunBarFlash);
    }
    this.combatFx.drawBursts(g, top, dt);

    for (const p of this.world.projectiles) {
      const pos = this.interpolated(p.id, p.pos);
      const s = toScreen(pos);
      const tail = toScreen(vec(pos.x - p.dir.x * 18, pos.y - p.dir.y * 18));
      const color = p.owner === 'mob' ? MOB_PROJECTILE_COLOR : (PROJECTILE_COLORS[p.sourceId] ?? 0xffffff);
      g.fillStyle(0x000000, 0.35).fillEllipse(s.x, s.y, p.radius * 2, p.radius);
      if (p.explodeRadius > 0) {
        top.fillStyle(color, 0.35).fillCircle(s.x, s.y - PROJECTILE_HEIGHT, p.radius * 2.2);
        top.fillStyle(color, 1).fillCircle(s.x, s.y - PROJECTILE_HEIGHT, p.radius * 1.2);
      } else {
        // Far Shot: the bolt glows brighter as its distance bonus builds up.
        const glow = p.action ? farShotGlow(player.mechanics, p.action.tags, p.travelled) : 0;
        if (glow > 0) top.lineStyle(3 + 5 * glow, FAR_SHOT_GLOW, 0.15 + 0.45 * glow).lineBetween(tail.x, tail.y - PROJECTILE_HEIGHT, s.x, s.y - PROJECTILE_HEIGHT);
        top.lineStyle(3, color, 1).lineBetween(tail.x, tail.y - PROJECTILE_HEIGHT, s.x, s.y - PROJECTILE_HEIGHT);
      }
    }
  }

  private buildFloor(): void {
    const { width, height } = this.content.arena;
    const cols = Math.ceil(width / TILE_WORLD);
    const rows = Math.ceil(height / TILE_WORLD);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const hash = (i * 73856093) ^ (j * 19349663);
        const pool = Math.abs(hash) % 5 === 0 ? DETAIL_FLOORS : PLAIN_FLOORS;
        const frame = pool[Math.abs(hash >> 3) % pool.length] ?? 0;
        const p = toScreen(vec((i + 0.5) * TILE_WORLD, (j + 0.5) * TILE_WORLD));
        this.add.image(p.x, p.y, 'floor', frame).setScale(TILE_SCALE).setDepth(-100000);
      }
    }
  }

  /**
   * Darkness with a lit circle around the hero: a small gradient texture for the light falloff plus
   * plain dark rectangles reaching far beyond any screen, so wide displays never show an unlit strip
   * and GPU memory stays small (a screen-sized gradient texture would be ~100 MB on 1440p).
   */
  private createLight(): Phaser.GameObjects.Container {
    const key = 'light-mask';
    const size = LIGHT_TEXTURE;
    if (!this.textures.exists(key)) {
      const canvas = this.textures.createCanvas(key, size, size)!;
      const ctx = canvas.getContext();
      const gradient = ctx.createRadialGradient(size / 2, size / 2, LIGHT_RADIUS * 0.3, size / 2, size / 2, LIGHT_RADIUS);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(0.6, `rgba(0,0,0,${DARKNESS * 0.49})`);
      gradient.addColorStop(1, `rgba(0,0,0,${DARKNESS})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      canvas.refresh();
    }
    const far = 20000;
    const half = size / 2;
    const outside = this.add.graphics().fillStyle(0x000000, DARKNESS);
    outside.fillRect(-far, -far, 2 * far, far - half); // above
    outside.fillRect(-far, half, 2 * far, far - half); // below
    outside.fillRect(-far, -half, far - half, size); // left
    outside.fillRect(half, -half, far - half, size); // right
    return this.add.container(0, 0, [this.add.image(0, 0, key), outside]).setDepth(5000);
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

    const { width, height } = this.scale;
    const banner = heading(this, width / 2, height * 0.28, 'Level Up', 44).setOrigin(0.5);
    const classDef = getClass(this.content, this.classId);
    // Blood Magic: no resource to restore (max 0).
    const refills = classDef.resource.refillOnLevelUp && maxResource(classDef, this.world.player) > 0;
    const restored = refills ? `life and ${resourceNames(classDef.resource.id).en.toLowerCase()} restored` : 'life restored';
    const sub = label(this, width / 2, height * 0.28 + 38, `Level ${level}  ·  ${restored}`, UI.size.body, UI.goldBrightText, true).setOrigin(0.5);
    for (const t of [banner, sub]) {
      pinToScreen(t, 15000);
      t.setAlpha(0);
      this.tweens.add({ targets: t, alpha: 1, duration: 200, hold: 1300, yoyo: true, onComplete: () => t.destroy() });
    }
    banner.setScale(1.4);
    this.tweens.add({ targets: banner, scale: 1, duration: 300, ease: 'Back.easeOut' });
  }

  private spawnDamageNumber(pos: Vec2, amount: number, kind: DamageNumberKind): void {
    const style = DAMAGE_NUMBER_STYLES[kind];
    const screen = toScreen(pos);
    const text = this.textPool.pop() ?? this.add.text(0, 0, '', { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '18px', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(6000);
    // Ignite numbers sit a bit lower and to the side so they do not cover hit numbers.
    const dx = kind === 'dot' ? 14 + Math.random() * 10 : (Math.random() - 0.5) * 16;
    text
      .setText(String(kind === 'dot' ? Math.max(1, Math.round(amount)) : Math.round(amount)))
      .setPosition(screen.x + dx, screen.y - (kind === 'dot' ? 56 : 70))
      .setColor(style.color)
      .setFontSize(style.size)
      .setAlpha(1)
      .setVisible(true);
    this.tweens.add({
      targets: text,
      y: text.y - style.rise,
      alpha: 0,
      duration: style.duration,
      onComplete: () => {
        text.setVisible(false);
        this.textPool.push(text);
      },
    });
  }
}

import * as Phaser from 'phaser';
import { distance, vec, type Vec2 } from '../core/math';
import type { Content } from '../core/world/content';
import { createWorld, getClass, getMob, PLAYER_ID, step, type PlayerInput, type WorldEvent, type WorldState } from '../core/world/world';
import { equippedWeapon, equipmentModifiers } from '../core/items/equipment';
import { grantArenaRewards, type RunRewards } from '../core/items/inventory';
import { applyRunResult, findCharacter } from '../core/progression/profile';
import { createRng } from '../core/rng';
import { itemsData } from '../data/items';
import { content } from '../data';
import { getApp } from './app';
import { Hud } from './hud';
import { fadeIn, heading, label, makeButton, makeFrame, UI } from './ui';
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

const PLAIN_FLOORS = [0, 1, 2, 3, 20, 21, 22, 23];
const DETAIL_FLOORS = [16, 17, 18, 19, 24, 25, 26, 27, 28, 29, 30, 31];

/** Visual-only colors per action / damage flavour. */
const AREA_COLORS: Record<string, number> = { cleave: 0xff9a3c, fireball: 0xff6a1a, explosive_trap: 0xff8a2a, frost_nova: 0x8fd3ff };
const PROJECTILE_COLORS: Record<string, number> = { ranger_bolt: 0xe8e2cf, volley: 0xe8e2cf, wand_bolt: 0xb58cff, fireball: 0xff7a1a };
const MOB_PROJECTILE_COLOR = 0xff4b4b;

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

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'Q' | 'E' | 'R' | 'ESC', Phaser.Input.Keyboard.Key>;

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
  private light!: Phaser.GameObjects.Image;
  private hud!: Hud;
  private overlay: Phaser.GameObjects.GameObject[] | undefined;
  private paused = false;
  private textPool: Phaser.GameObjects.Text[] = [];
  private skillWasDown: boolean[] = [];
  private skillBuffer: number[] = [];

  constructor() {
    super('iso-arena');
  }

  init(data: { characterId?: string }): void {
    if (data.characterId) this.characterId = data.characterId;
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
    // Equipment enters the run as modifiers plus the equipped weapon.
    const loadout = character
      ? { modifiers: equipmentModifiers(character.equipment, itemsData), weapon: equippedWeapon(character.equipment, itemsData, classDef.weapon) }
      : {};
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
    this.skillWasDown = [];
    this.skillBuffer = [];

    for (const [set, anims] of Object.entries(SPRITE_SETS)) {
      for (const anim of Object.keys(anims)) this.textures.get(textureKey(set, anim)).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }

    this.input.mouse?.disableContextMenu();
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,Q,E,R,ESC') as Keys;

    this.buildFloor();
    this.fx = this.add.graphics().setDepth(-1000);
    this.fxTop = this.add.graphics().setDepth(4000);
    const look = CLASS_LOOKS.find((l) => l.classId === this.classId);
    this.hero = this.createActor(look?.sprite ?? 'knight', this.world.player.pos);
    this.light = this.add.image(0, 0, this.makeLightTexture()).setDepth(5000);

    const { width, height } = this.content.arena;
    const left = toScreen(vec(0, height)).x;
    const right = toScreen(vec(width, 0)).x;
    const bottom = toScreen(vec(width, height)).y;
    this.cameras.main.setBounds(left - 200, -200, right - left + 400, bottom + 400);
    this.cameras.main.setBackgroundColor('#07070a');

    this.hud = new Hud(this, getClass(this.content, this.classId));
    this.hud.layout(this.scale.width, this.scale.height);
    this.overlay = undefined;
    this.paused = false;
    const relayout = (): void => {
      this.hud.layout(this.scale.width, this.scale.height);
      if (this.overlay) this.showOverlay(this.paused ? 'pause' : 'death');
    };
    this.scale.on('resize', relayout);
    // Leaving the tab pauses the run (and tells the portal gameplay stopped).
    const autoPause = (): void => {
      if (!this.paused && !this.world.player.dead) this.setPaused(true);
    };
    this.game.events.on(Phaser.Core.Events.BLUR, autoPause);
    this.game.events.on(Phaser.Core.Events.HIDDEN, autoPause);

    getApp(this).platform.gameplayStart();
    fadeIn(this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', relayout);
      this.game.events.off(Phaser.Core.Events.BLUR, autoPause);
      this.game.events.off(Phaser.Core.Events.HIDDEN, autoPause);
      this.endRun();
    });
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
    const panelH = (kind === 'death' ? (compact ? 230 : 270) : compact ? 190 : 220) + lootLines * 24 + (kind === 'death' ? 24 : 0);
    objects.push(makeFrame(this, width / 2, height / 2, panelW, panelH, 'panel'));
    const top = height / 2 - panelH / 2;
    const title = heading(this, width / 2, top + (compact ? 30 : 40), kind === 'death' ? 'You have fallen' : 'Paused', compact ? 28 : 36).setOrigin(0.5);
    objects.push(title);
    let y = top + (compact ? 64 : 82);
    if (kind === 'death') {
      const seconds = Math.floor(this.world.time);
      const summary = `Survived ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}  ·  ${this.world.kills} kills  ·  wave ${this.world.spawn.wave}`;
      objects.push(label(this, width / 2, y, summary, UI.size.body, UI.muted).setOrigin(0.5, 0));
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
    for (const o of objects) {
      (o as unknown as Phaser.GameObjects.Components.ScrollFactor & Phaser.GameObjects.Components.Depth).setScrollFactor(0).setDepth(20000);
    }
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
    this.scene.restart({ characterId: this.characterId });
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
    });
    this.rewards = grantArenaRewards(app.profile, createRng((Math.random() * 2 ** 32) >>> 0), { kills: this.world.kills, wave: this.world.spawn.wave }, itemsData);
    app.save();
    // PROPOSAL (docs/design/account.md): until bosses/loot exist, the first finished run is the "meaningful moment".
    if (!app.user && app.loginHint === 'none') app.loginHint = 'pending';
  }

  override update(_time: number, deltaMs: number): void {
    const dead = this.world.player.dead;
    if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
      if (dead) this.leaveToMenu();
      else this.setPaused(!this.paused);
      return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.R) && dead) {
      this.restartRun();
      return;
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
      basicAttack: pointer.leftButtonDown(),
      skills,
    };
  }

  private onEvent(event: WorldEvent): void {
    switch (event.type) {
      case 'action': {
        // Consume the buffered press so a tap fires the skill once.
        const slot = getClass(this.content, this.classId).skills.findIndex((s) => s.id === event.actionId);
        if (slot >= 0) this.skillBuffer[slot] = 0;
        this.hero.facing = event.facing;
        this.playOneShot(this.hero, ACTION_ANIMS[event.actionId] ?? 'attack');
        break;
      }
      case 'area':
        this.areas.push({ ...event, color: AREA_COLORS[event.actionId] ?? 0xdde4ff, ttl: AREA_TTL });
        break;
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
        if (actor && !actor.oneShot) this.playOneShot(actor, 'hit');
        this.spawnDamageNumber(event.pos, event.amount, event.isCrit, event.targetId === PLAYER_ID);
        break;
      }
      case 'death': {
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
    return { sprite, set, display: pos, facing: vec(1, 1), row: -1, time: 0, runPhase: 0, moving: false, oneShot: undefined };
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

  private playOneShot(actor: Actor, anim: string): void {
    if (actor.oneShot?.anim === 'death') return;
    actor.oneShot = { anim, elapsed: 0 };
  }

  private syncActors(dt: number): void {
    const player = this.world.player;
    const classDef = getClass(this.content, this.classId);
    if (!player.dead) this.hero.facing = player.motion ? player.motion.dir : player.facing;
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
      this.updateActor(actor, dt, this.speedOf(mob.id, mob.pos), getMob(this.content, mob.defId).moveSpeed);
      if (mob.stun > 0) actor.sprite.setTint(0xfff27a);
      else if (mob.slow > 0) actor.sprite.setTint(0x8fd3ff);
      else actor.sprite.clearTint();
    }
  }

  private updateActor(actor: Actor, dt: number, speed: number, referenceSpeed: number): void {
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
      const p = toScreen(trap.pos);
      const armed = trap.armTimer <= 0;
      const pulse = armed ? 0.6 + 0.4 * Math.sin(this.world.time * 10) : 0.4;
      g.fillStyle(armed ? 0xff5a1a : 0x777777, pulse).fillEllipse(p.x, p.y, 22, 11);
      g.lineStyle(1, 0x000000, 0.8).strokeEllipse(p.x, p.y, 22, 11);
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

  /** Radial darkness with a lit circle around the hero. */
  private makeLightTexture(): string {
    const key = 'light-mask';
    if (this.textures.exists(key)) return key;
    const size = 2400;
    const canvas = this.textures.createCanvas(key, size, size);
    const ctx = canvas!.getContext();
    const gradient = ctx.createRadialGradient(size / 2, size / 2, LIGHT_RADIUS * 0.3, size / 2, size / 2, LIGHT_RADIUS);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.6, 'rgba(0,0,0,0.45)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.92)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    canvas!.refresh();
    return key;
  }

  private spawnDamageNumber(pos: Vec2, amount: number, isCrit: boolean, onPlayer: boolean): void {
    const screen = toScreen(pos);
    const text = this.textPool.pop() ?? this.add.text(0, 0, '', { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '18px', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(6000);
    text
      .setText(String(Math.round(amount)))
      .setPosition(screen.x + (Math.random() - 0.5) * 16, screen.y - 70)
      .setColor(onPlayer ? '#ff5050' : isCrit ? '#ffd23f' : '#ffffff')
      .setFontSize(isCrit ? 26 : 18)
      .setAlpha(1)
      .setVisible(true);
    this.tweens.add({
      targets: text,
      y: text.y - 30,
      alpha: 0,
      duration: 600,
      onComplete: () => {
        text.setVisible(false);
        this.textPool.push(text);
      },
    });
  }
}

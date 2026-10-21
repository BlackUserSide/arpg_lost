import * as Phaser from 'phaser';
import { vec, type Vec2 } from '../core/math';
import type { Content } from '../core/world/content';
import { createWorld, getClass, PLAYER_ID, playerStat, step, type PlayerInput, type WorldEvent, type WorldState } from '../core/world/world';
import { applyRunResult, findCharacter } from '../core/progression/profile';
import { content } from '../data';
import { getApp } from './app';
import { directionRow, screenDirToWorld, toScreen, toWorld } from './iso';
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

const PLAIN_FLOORS = [0, 1, 2, 3, 20, 21, 22, 23];
const DETAIL_FLOORS = [16, 17, 18, 19, 24, 25, 26, 27, 28, 29, 30, 31];

/** Visual-only colors per action / damage flavour. */
const AREA_COLORS: Record<string, number> = { cleave: 0xff9a3c, fireball: 0xff6a1a, explosive_trap: 0xff8a2a, frost_nova: 0x8fd3ff };
const PROJECTILE_COLORS: Record<string, number> = { ranger_bolt: 0xe8e2cf, volley: 0xe8e2cf, wand_bolt: 0xb58cff, fireball: 0xff7a1a };
const MOB_PROJECTILE_COLOR = 0xff4b4b;

interface Actor {
  sprite: Phaser.GameObjects.Sprite;
  set: string;
  lastPos: Vec2;
  facing: Vec2;
  time: number;
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
  private world!: WorldState;
  private accumulator = 0;
  private keys!: Keys;
  private hero!: Actor;
  private mobs = new Map<number, Actor>();
  private corpses: Corpse[] = [];
  private areas: AreaFx[] = [];
  private fx!: Phaser.GameObjects.Graphics;
  private fxTop!: Phaser.GameObjects.Graphics;
  private light!: Phaser.GameObjects.Image;
  private hud!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private skillText!: Phaser.GameObjects.Text;
  private deathText!: Phaser.GameObjects.Text;
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
    this.world = createWorld(this.content, this.classId, (Math.random() * 2 ** 32) >>> 0);
    // Dev-only handle for debugging and automated checks from the console.
    if (import.meta.env.DEV) (window as unknown as { __world: WorldState }).__world = this.world;
    this.accumulator = 0;
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

    this.hud = this.add.graphics().setScrollFactor(0).setDepth(10000);
    this.hudText = this.add.text(16, 64, '', { color: '#ddd', fontSize: '16px' }).setScrollFactor(0).setDepth(10000);
    this.skillText = this.add.text(0, 0, '', { color: '#ddd', fontSize: '15px', align: 'center' }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(10000);
    this.deathText = this.add
      .text(0, 0, 'You died\nR — try again · Esc — menu', { color: '#fff', fontSize: '28px', align: 'center' })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(10001)
      .setVisible(false);

    getApp(this).platform.gameplayStart();
    this.events.once('shutdown', () => this.endRun());
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
    app.save();
    // PROPOSAL (docs/design/account.md): until bosses/loot exist, the first finished run is the "meaningful moment".
    if (!app.user && app.loginHint === 'none') app.loginHint = 'pending';
  }

  override update(_time: number, deltaMs: number): void {
    if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
      this.endRun();
      this.scene.start('main-menu');
      return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.R) && this.world.player.dead) {
      this.scene.restart({ characterId: this.characterId });
      return;
    }

    this.accumulator += deltaMs / 1000;
    let steps = 0;
    while (this.accumulator >= DT && steps < MAX_STEPS_PER_FRAME) {
      for (const event of step(this.world, this.readInput(), this.content, DT)) this.onEvent(event);
      this.accumulator -= DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    const dt = deltaMs / 1000;
    this.syncActors(dt);
    this.updateCorpses(dt);
    this.drawFx(dt);

    const heroScreen = toScreen(this.world.player.pos);
    this.cameras.main.centerOn(heroScreen.x, heroScreen.y - 30);
    this.light.setPosition(heroScreen.x, heroScreen.y - 30);
    this.drawHud();
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
          actor.sprite.setDepth(toScreen(actor.lastPos).y - 40);
          this.corpses.push({ actor, ttl: CORPSE_TIME });
          this.mobs.delete(event.id);
        }
        break;
      }
      case 'playerDeath':
        this.playOneShot(this.hero, 'death');
        this.deathText.setVisible(true);
        this.endRun();
        break;
      default:
        break;
    }
  }

  private createActor(set: string, pos: Vec2): Actor {
    const sprite = this.add.sprite(0, 0, textureKey(set, 'idle'), 0).setOrigin(0.5, ORIGIN_Y);
    return { sprite, set, lastPos: pos, facing: vec(1, 1), time: 0, moving: false, oneShot: undefined };
  }

  private playOneShot(actor: Actor, anim: string): void {
    if (actor.oneShot?.anim === 'death') return;
    actor.oneShot = { anim, elapsed: 0 };
  }

  private syncActors(dt: number): void {
    const player = this.world.player;
    if (!player.dead) this.hero.facing = player.motion ? player.motion.dir : player.facing;
    this.updateActor(this.hero, player.pos, dt);
    this.hero.sprite.setAlpha(player.invulnerable > 0 ? 0.55 : 1);

    for (const mob of this.world.mobs) {
      let actor = this.mobs.get(mob.id);
      if (!actor) {
        actor = this.createActor(MOB_SPRITES[mob.defId] ?? 'skeleton_warrior', mob.pos);
        this.mobs.set(mob.id, actor);
      }
      actor.facing = mob.facing;
      this.updateActor(actor, mob.pos, dt);
      if (mob.stun > 0) actor.sprite.setTint(0xfff27a);
      else if (mob.slow > 0) actor.sprite.setTint(0x8fd3ff);
      else actor.sprite.clearTint();
    }
  }

  private updateActor(actor: Actor, pos: Vec2, dt: number): void {
    actor.moving = Math.hypot(pos.x - actor.lastPos.x, pos.y - actor.lastPos.y) > 0.01;
    actor.lastPos = pos;
    actor.time += dt;
    this.applyFrame(actor, dt);
    const screen = toScreen(pos);
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
    if (anim === 'run' || anim === 'idle') col = Math.floor(actor.time * def.fps) % def.frames;

    const key = textureKey(actor.set, anim);
    if (actor.sprite.texture.key !== key) actor.sprite.setTexture(key);
    actor.sprite.setFrame(directionRow(actor.facing) * def.frames + col);
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
    const hero = toScreen(player.pos);
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
      const s = toScreen(p.pos);
      const tail = toScreen(vec(p.pos.x - p.dir.x * 18, p.pos.y - p.dir.y * 18));
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
    const text = this.textPool.pop() ?? this.add.text(0, 0, '', { fontSize: '16px', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(6000);
    text
      .setText(String(Math.round(amount)))
      .setPosition(screen.x + (Math.random() - 0.5) * 16, screen.y - 70)
      .setColor(onPlayer ? '#ff5050' : isCrit ? '#ffd23f' : '#ffffff')
      .setFontSize(isCrit ? 22 : 16)
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

  private drawHud(): void {
    const p = this.world.player;
    const classDef = getClass(this.content, p.classId);
    const maxLife = playerStat(classDef, p, 'life');
    const maxShield = playerStat(classDef, p, 'energyShield');
    const maxMana = playerStat(classDef, p, 'mana');
    const h = this.hud.clear();
    const bar = (y: number, value: number, max: number, color: number): void => {
      h.fillStyle(0x000000, 0.6).fillRect(16, y, 220, 16);
      h.fillStyle(color).fillRect(16, y, max > 0 ? (220 * Math.max(0, value)) / max : 0, 16);
    };
    bar(16, p.life, maxLife, 0xc0392b);
    if (maxShield > 0) h.fillStyle(0x9fd8ff, 0.7).fillRect(16, 16, (220 * p.energyShield) / Math.max(maxLife, maxShield), 5);
    bar(38, p.mana, maxMana, 0x2e6fd8);
    const seconds = Math.floor(this.world.time);
    this.hudText.setText(
      `Kills ${this.world.kills}   Wave ${this.world.spawn.wave}   ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}\n` +
        'WASD move · LMB attack · RMB/Q/E skills · Esc class select',
    );

    const keys = ['RMB', 'Q', 'E'];
    this.skillText.setText(
      classDef.skills
        .map((s, i) => {
          const cd = p.cooldowns[s.id] ?? 0;
          const state = cd > 0.05 ? `${cd.toFixed(1)}s` : p.mana < s.manaCost ? 'no mana' : 'ready';
          return `[${keys[i]}] ${s.id.replace(/_/g, ' ')} — ${state}`;
        })
        .join('     '),
    );
    this.skillText.setPosition(this.scale.width / 2, this.scale.height - 16);
    this.deathText.setPosition(this.scale.width / 2, this.scale.height / 2);
  }
}

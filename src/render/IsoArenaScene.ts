import * as Phaser from 'phaser';
import { normalize, sub, vec, type Vec2 } from '../core/math';
import type { Content } from '../core/world/content';
import { createWorld, getClass, PLAYER_ID, playerStat, step, type PlayerInput, type WorldEvent, type WorldState } from '../core/world/world';
import { content } from '../data';
import { directionRow, screenDirToWorld, toScreen, toWorld } from './iso';

// Art test scene: isometric view with Flare floor tiles and Bellanger character sheets.

const DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const CLASS_ID = 'warrior';

const TILE_WORLD = 68; // world units per floor tile side (96px wide diamond at ISO_K)
const TILE_SCALE = 0.5;
const CHAR_SCALE = 1.5;
const CHAR_ORIGIN_Y = 0.72;
const FRAMES_PER_ROW = 8;
const WALK_FPS = 8;
const ATTACK_TIME = 0.22;
const HIT_TIME = 0.12;
const CORPSE_TIME = 2;
const SWING_TTL = 0.14;
const LIGHT_RADIUS = 520;

const PLAIN_FLOORS = [0, 1, 2, 3, 20, 21, 22, 23];
const DETAIL_FLOORS = [16, 17, 18, 19, 24, 25, 26, 27, 28, 29, 30, 31];

const HERO_LAYERS = ['male_base', 'male_heavy', 'male_longsword'];
const MOB_SHEETS: Record<string, { sheet: string; tint?: number; scale?: number }> = {
  zombie: { sheet: 'zombie' },
  runner: { sheet: 'skeleton', scale: 0.85 },
};

const enum Col {
  Walk = 0,
  Attack = 4,
  Special = 5,
  Hit = 6,
  Dead = 7,
}

interface Actor {
  sprites: Phaser.GameObjects.Sprite[];
  lastPos: Vec2;
  facing: Vec2;
  walkTime: number;
  attackTime: number;
  hitTime: number;
}

interface Corpse {
  sprite: Phaser.GameObjects.Sprite;
  ttl: number;
}

interface Swing {
  origin: Vec2;
  facing: Vec2;
  radius: number;
  angleDeg: number;
  ttl: number;
  isSkill: boolean;
}

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'Q' | 'E' | 'R', Phaser.Input.Keyboard.Key>;

export class IsoArenaScene extends Phaser.Scene {
  private readonly content: Content = content;
  private world!: WorldState;
  private accumulator = 0;
  private keys!: Keys;
  private hero!: Actor;
  private mobs = new Map<number, Actor>();
  private corpses: Corpse[] = [];
  private swings: Swing[] = [];
  private fx!: Phaser.GameObjects.Graphics;
  private light!: Phaser.GameObjects.Image;
  private hud!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private deathText!: Phaser.GameObjects.Text;
  private textPool: Phaser.GameObjects.Text[] = [];

  constructor() {
    super('iso-arena');
  }

  preload(): void {
    this.load.spritesheet('floor', 'assets/test/floor.png', { frameWidth: 192, frameHeight: 96 });
    for (const name of [...HERO_LAYERS, ...Object.values(MOB_SHEETS).map((m) => m.sheet)]) {
      this.load.spritesheet(name, `assets/test/${name}.png`, { frameWidth: 128, frameHeight: 128 });
    }
  }

  create(): void {
    this.world = createWorld(this.content, CLASS_ID, (Math.random() * 2 ** 32) >>> 0);
    this.accumulator = 0;
    this.mobs.clear();
    this.corpses = [];
    this.swings = [];

    for (const name of [...HERO_LAYERS, 'zombie', 'skeleton']) {
      this.textures.get(name).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }

    this.input.mouse?.disableContextMenu();
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,Q,E,R') as Keys;

    this.buildFloor();
    this.fx = this.add.graphics().setDepth(-1000);
    this.hero = this.createActor(HERO_LAYERS, CHAR_SCALE, undefined, this.world.player.pos);
    this.light = this.add.image(0, 0, this.makeLightTexture()).setDepth(5000);

    const { width, height } = this.content.arena;
    const left = toScreen(vec(0, height)).x;
    const right = toScreen(vec(width, 0)).x;
    const bottom = toScreen(vec(width, height)).y;
    this.cameras.main.setBounds(left - 200, -200, right - left + 400, bottom + 400);
    this.cameras.main.setBackgroundColor('#07070a');

    this.hud = this.add.graphics().setScrollFactor(0).setDepth(10000);
    this.hudText = this.add.text(16, 64, '', { color: '#ddd', fontSize: '16px' }).setScrollFactor(0).setDepth(10000);
    this.deathText = this.add
      .text(0, 0, 'You died\nPress R to restart', { color: '#fff', fontSize: '32px', align: 'center' })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(10001)
      .setVisible(false);
  }

  override update(_time: number, deltaMs: number): void {
    if (Phaser.Input.Keyboard.JustDown(this.keys.R) && this.world.player.dead) {
      this.scene.restart();
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
    return {
      move: screenDirToWorld(screenMove),
      // Aim at ground level under the cursor; sprites stand on their feet.
      aim: toWorld(vec(aim.x, aim.y)),
      basicAttack: pointer.leftButtonDown(),
      skills: [pointer.rightButtonDown(), k.Q.isDown, k.E.isDown],
    };
  }

  private onEvent(event: WorldEvent): void {
    switch (event.type) {
      case 'action': {
        const classDef = getClass(this.content, this.world.player.classId);
        this.swings.push({ ...event, ttl: SWING_TTL, isSkill: event.actionId !== classDef.basicAttack.id });
        this.hero.attackTime = ATTACK_TIME;
        this.hero.facing = event.facing;
        break;
      }
      case 'mobAttack': {
        const actor = this.mobs.get(event.id);
        if (actor) actor.attackTime = ATTACK_TIME;
        break;
      }
      case 'hit': {
        const actor = event.targetId === PLAYER_ID ? this.hero : this.mobs.get(event.targetId);
        if (actor) actor.hitTime = HIT_TIME;
        this.spawnDamageNumber(event.pos, event.amount, event.isCrit, event.targetId === PLAYER_ID);
        break;
      }
      case 'death': {
        const actor = this.mobs.get(event.id);
        if (actor) {
          const [body, ...rest] = actor.sprites;
          rest.forEach((s) => s.destroy());
          if (body) {
            body.setFrame(directionRow(actor.facing) * FRAMES_PER_ROW + Col.Dead).setDepth(-500);
            this.corpses.push({ sprite: body, ttl: CORPSE_TIME });
          }
          this.mobs.delete(event.id);
        }
        break;
      }
      case 'playerDeath':
        this.deathText.setVisible(true);
        break;
      default:
        break;
    }
  }

  private createActor(sheets: readonly string[], scale: number, tint: number | undefined, pos: Vec2): Actor {
    const sprites = sheets.map((sheet) => {
      const sprite = this.add.sprite(0, 0, sheet, 6 * FRAMES_PER_ROW).setOrigin(0.5, CHAR_ORIGIN_Y).setScale(scale);
      if (tint !== undefined) sprite.setTint(tint);
      return sprite;
    });
    return { sprites, lastPos: pos, facing: vec(1, 1), walkTime: 0, attackTime: 0, hitTime: 0 };
  }

  private syncActors(dt: number): void {
    const player = this.world.player;
    this.hero.facing = player.facing;
    this.updateActor(this.hero, player.pos, dt, player.dead);

    for (const mob of this.world.mobs) {
      let actor = this.mobs.get(mob.id);
      if (!actor) {
        const look = MOB_SHEETS[mob.defId] ?? { sheet: 'zombie' };
        actor = this.createActor([look.sheet], CHAR_SCALE * (look.scale ?? 1), look.tint, mob.pos);
        this.mobs.set(mob.id, actor);
      }
      const toPlayer = normalize(sub(player.pos, mob.pos));
      if (toPlayer.x !== 0 || toPlayer.y !== 0) actor.facing = toPlayer;
      this.updateActor(actor, mob.pos, dt, false);
    }
  }

  private updateActor(actor: Actor, pos: Vec2, dt: number, dead: boolean): void {
    const moved = Math.hypot(pos.x - actor.lastPos.x, pos.y - actor.lastPos.y) > 0.01;
    actor.lastPos = pos;
    actor.attackTime = Math.max(0, actor.attackTime - dt);
    actor.hitTime = Math.max(0, actor.hitTime - dt);
    if (moved) actor.walkTime += dt;

    let col: number;
    if (dead) col = Col.Dead;
    else if (actor.attackTime > 0) col = Col.Attack;
    else if (actor.hitTime > 0) col = Col.Hit;
    else if (moved) col = Col.Walk + (Math.floor(actor.walkTime * WALK_FPS) % 4);
    else col = Col.Walk;

    const frame = directionRow(actor.facing) * FRAMES_PER_ROW + col;
    const screen = toScreen(pos);
    for (const sprite of actor.sprites) {
      sprite.setFrame(frame).setPosition(screen.x, screen.y).setDepth(screen.y);
      if (actor.hitTime > 0) sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
      else sprite.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
    }
  }

  private updateCorpses(dt: number): void {
    for (const corpse of this.corpses) {
      corpse.ttl -= dt;
      corpse.sprite.setAlpha(Math.min(1, corpse.ttl / 0.5));
    }
    const alive: Corpse[] = [];
    for (const corpse of this.corpses) {
      if (corpse.ttl > 0) alive.push(corpse);
      else corpse.sprite.destroy();
    }
    this.corpses = alive;
  }

  private drawFx(dt: number): void {
    const g = this.fx.clear();
    // Ring under the hero so they never get lost in a crowd.
    const hero = toScreen(this.world.player.pos);
    g.lineStyle(2, 0xe8c15a, 0.9).strokeEllipse(hero.x, hero.y, 46, 23);
    for (const swing of this.swings) swing.ttl -= dt;
    this.swings = this.swings.filter((s) => s.ttl > 0);
    for (const swing of this.swings) {
      const half = Phaser.Math.DegToRad(swing.angleDeg / 2);
      const dir = Math.atan2(swing.facing.y, swing.facing.x);
      const points = [toScreen(swing.origin)];
      const segments = 16;
      for (let i = 0; i <= segments; i++) {
        const a = dir - half + (2 * half * i) / segments;
        points.push(toScreen(vec(swing.origin.x + Math.cos(a) * swing.radius, swing.origin.y + Math.sin(a) * swing.radius)));
      }
      g.fillStyle(swing.isSkill ? 0xff9a3c : 0xdde4ff, (swing.ttl / SWING_TTL) * 0.4);
      g.fillPoints(points.map((p) => new Phaser.Math.Vector2(p.x, p.y)), true);
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
    const maxMana = playerStat(classDef, p, 'mana');
    const h = this.hud.clear();
    const bar = (y: number, value: number, max: number, color: number): void => {
      h.fillStyle(0x000000, 0.6).fillRect(16, y, 220, 16);
      h.fillStyle(color).fillRect(16, y, max > 0 ? (220 * Math.max(0, value)) / max : 0, 16);
    };
    bar(16, p.life, maxLife, 0xc0392b);
    bar(38, p.mana, maxMana, 0x2e6fd8);
    const seconds = Math.floor(this.world.time);
    this.hudText.setText(
      `Kills ${this.world.kills}   Wave ${this.world.spawn.wave}   ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}\n` +
        'WASD move · LMB attack · RMB cleave · ?view=flat for debug view',
    );
    this.deathText.setPosition(this.scale.width / 2, this.scale.height / 2);
  }
}

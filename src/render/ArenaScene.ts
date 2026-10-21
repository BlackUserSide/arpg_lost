import * as Phaser from 'phaser';
import { vec, type Vec2 } from '../core/math';
import type { Content } from '../core/world/content';
import { createWorld, getClass, getMob, PLAYER_ID, playerStat, step, type PlayerInput, type WorldEvent, type WorldState } from '../core/world/world';
import { content } from '../data';

const DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const CLASS_ID = 'warrior';

const MOB_COLORS: Record<string, number> = { zombie: 0x5f9e4f, runner: 0xc9a227 };
const SWING_TTL = 0.12;
const FLASH_TTL = 0.08;

interface Swing {
  origin: Vec2;
  facing: Vec2;
  radius: number;
  angleDeg: number;
  ttl: number;
  isSkill: boolean;
}

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'Q' | 'E' | 'R', Phaser.Input.Keyboard.Key>;

export class ArenaScene extends Phaser.Scene {
  private readonly content: Content = content;
  private world!: WorldState;
  private accumulator = 0;
  private keys!: Keys;
  private gfx!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private deathText!: Phaser.GameObjects.Text;
  private swings: Swing[] = [];
  private flashes = new Map<number, number>();
  private textPool: Phaser.GameObjects.Text[] = [];

  constructor() {
    super('arena');
  }

  create(): void {
    this.world = createWorld(this.content, CLASS_ID, (Math.random() * 2 ** 32) >>> 0);
    this.accumulator = 0;
    this.swings = [];
    this.flashes.clear();

    const { width, height } = this.content.arena;
    this.cameras.main.setBounds(0, 0, width, height);
    this.input.mouse?.disableContextMenu();
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,Q,E,R') as Keys;

    this.drawFloor();
    this.gfx = this.add.graphics();
    this.hud = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.hudText = this.add.text(16, 64, '', { color: '#ddd', fontSize: '16px' }).setScrollFactor(0).setDepth(100);
    this.deathText = this.add
      .text(0, 0, 'You died\nPress R to restart', { color: '#fff', fontSize: '32px', align: 'center' })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(101)
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
      const events = step(this.world, this.readInput(), this.content, DT);
      for (const event of events) this.onEvent(event);
      this.accumulator -= DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    const frameDt = deltaMs / 1000;
    for (const swing of this.swings) swing.ttl -= frameDt;
    this.swings = this.swings.filter((s) => s.ttl > 0);
    for (const [id, ttl] of this.flashes) {
      if (ttl - frameDt <= 0) this.flashes.delete(id);
      else this.flashes.set(id, ttl - frameDt);
    }

    this.cameras.main.centerOn(this.world.player.pos.x, this.world.player.pos.y);
    this.drawWorld();
    this.drawHud();
  }

  private readInput(): PlayerInput {
    const k = this.keys;
    const pointer = this.input.activePointer;
    const aim = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return {
      move: vec((k.D.isDown ? 1 : 0) - (k.A.isDown ? 1 : 0), (k.S.isDown ? 1 : 0) - (k.W.isDown ? 1 : 0)),
      aim: vec(aim.x, aim.y),
      basicAttack: pointer.leftButtonDown(),
      skills: [pointer.rightButtonDown(), k.Q.isDown, k.E.isDown],
    };
  }

  private onEvent(event: WorldEvent): void {
    switch (event.type) {
      case 'action': {
        const classDef = getClass(this.content, this.world.player.classId);
        this.swings.push({ ...event, ttl: SWING_TTL, isSkill: event.actionId !== classDef.basicAttack.id });
        break;
      }
      case 'hit':
        this.flashes.set(event.targetId, FLASH_TTL);
        this.spawnDamageNumber(event.pos, event.amount, event.isCrit, event.targetId === PLAYER_ID);
        break;
      case 'playerDeath':
        this.deathText.setVisible(true);
        break;
      default:
        break;
    }
  }

  private spawnDamageNumber(pos: Vec2, amount: number, isCrit: boolean, onPlayer: boolean): void {
    const text = this.textPool.pop() ?? this.add.text(0, 0, '', { fontSize: '16px' }).setOrigin(0.5).setDepth(50);
    text
      .setText(String(Math.round(amount)))
      .setPosition(pos.x + (Math.random() - 0.5) * 16, pos.y - 20)
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

  private drawFloor(): void {
    const { width, height } = this.content.arena;
    const floor = this.add.graphics();
    floor.fillStyle(0x24262b).fillRect(0, 0, width, height);
    floor.lineStyle(1, 0x2e3138);
    for (let x = 0; x <= width; x += 64) floor.lineBetween(x, 0, x, height);
    for (let y = 0; y <= height; y += 64) floor.lineBetween(0, y, width, y);
    floor.lineStyle(4, 0x555a66).strokeRect(0, 0, width, height);
  }

  private drawWorld(): void {
    const g = this.gfx.clear();

    for (const swing of this.swings) {
      const half = Phaser.Math.DegToRad(swing.angleDeg / 2);
      const dir = Math.atan2(swing.facing.y, swing.facing.x);
      g.fillStyle(swing.isSkill ? 0xff9a3c : 0xdde4ff, (swing.ttl / SWING_TTL) * 0.45);
      g.slice(swing.origin.x, swing.origin.y, swing.radius, dir - half, dir + half, false).fillPath();
    }

    for (const mob of this.world.mobs) {
      const def = getMob(this.content, mob.defId);
      const flash = this.flashes.has(mob.id);
      g.fillStyle(flash ? 0xffffff : (MOB_COLORS[mob.defId] ?? 0xaa4444)).fillCircle(mob.pos.x, mob.pos.y, def.radius);
      if (mob.life < def.life) {
        const w = def.radius * 2;
        g.fillStyle(0x000000, 0.6).fillRect(mob.pos.x - w / 2, mob.pos.y - def.radius - 8, w, 4);
        g.fillStyle(0xd94040).fillRect(mob.pos.x - w / 2, mob.pos.y - def.radius - 8, (w * Math.max(0, mob.life)) / def.life, 4);
      }
    }

    const p = this.world.player;
    const flash = this.flashes.has(PLAYER_ID);
    g.fillStyle(p.dead ? 0x444444 : flash ? 0xff7070 : 0x4a8cff).fillCircle(p.pos.x, p.pos.y, p.radius);
    g.lineStyle(3, 0xffffff).lineBetween(p.pos.x, p.pos.y, p.pos.x + p.facing.x * (p.radius + 8), p.pos.y + p.facing.y * (p.radius + 8));
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
      `Life ${Math.ceil(p.life)}/${maxLife}   Mana ${Math.floor(p.mana)}/${maxMana}\n` +
        `Kills ${this.world.kills}   Wave ${this.world.spawn.wave}   ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}\n` +
        'WASD move · LMB attack · RMB cleave',
    );
    this.deathText.setPosition(this.scale.width / 2, this.scale.height / 2);
  }
}

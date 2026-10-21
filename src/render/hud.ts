import * as Phaser from 'phaser';
import type { ActionDef, ClassDef } from '../core/world/content';
import { playerStat, type WorldState } from '../core/world/world';
import { skillIcon } from './hudIcons';
import { frameTexture, label, makeFrame, UI } from './ui';

// In-run HUD: Diablo-style life/mana orbs, skill bar with cooldown shutters, run info, buffs.
// Render-only: reads world state every frame.

const DEPTH = 10000;
const SLOT_KEYS = ['LMB', 'RMB', 'Q', 'E'];

interface Orb {
  ring: Phaser.GameObjects.Image;
  text: Phaser.GameObjects.Text;
  x: number;
  y: number;
  r: number;
  deep: number;
  bright: number;
}

interface Slot {
  action: ActionDef;
  frame: Phaser.GameObjects.Image;
  icon: Phaser.GameObjects.Image;
  key: Phaser.GameObjects.Text;
  cdText: Phaser.GameObjects.Text;
  x: number;
  y: number;
  size: number;
}

function orbRingTexture(scene: Phaser.Scene, r: number): string {
  const key = `hud:orb-ring:${r}`;
  if (scene.textures.exists(key)) return key;
  const pad = 14;
  const size = r * 2 + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 10;
  const metal = ctx.createLinearGradient(0, c - r, 0, c + r);
  metal.addColorStop(0, '#f3d58a');
  metal.addColorStop(0.5, '#9a6a22');
  metal.addColorStop(1, '#5a3c14');
  ctx.strokeStyle = metal;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(c, c, r + 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.stroke();
  // Studs at the cardinal points.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    ctx.fillStyle = '#f3d58a';
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * (r + 3), c + Math.sin(a) * (r + 3), 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Glass highlight.
  const glass = ctx.createRadialGradient(c - r * 0.35, c - r * 0.45, 2, c - r * 0.35, c - r * 0.45, r * 0.6);
  glass.addColorStop(0, 'rgba(255,255,255,0.35)');
  glass.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.arc(c, c, r - 2, 0, Math.PI * 2);
  ctx.fill();
  scene.textures.addCanvas(key, canvas);
  return key;
}

export class Hud {
  private readonly liquid: Phaser.GameObjects.Graphics;
  private readonly shutters: Phaser.GameObjects.Graphics;
  private readonly life: Orb;
  private readonly mana: Orb;
  private readonly slots: Slot[];
  private readonly info: Phaser.GameObjects.Text;
  private infoFrame: Phaser.GameObjects.Image;
  private buffIcons: Phaser.GameObjects.GameObject[] = [];
  private time = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly classDef: ClassDef,
  ) {
    this.liquid = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH);
    this.shutters = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 2);
    this.life = this.createOrb(0x6a0d0d, 0xd23a2a);
    this.mana = this.createOrb(0x0d1f6a, 0x3a72e0);
    this.slots = [classDef.basicAttack, ...classDef.skills].map((action, i) => {
      const frame = makeFrame(scene, 0, 0, 56, 56, 'secondary').setScrollFactor(0).setDepth(DEPTH);
      const icon = scene.add.image(0, 0, skillIcon(scene, action.id)).setScrollFactor(0).setDepth(DEPTH + 1);
      const key = label(scene, 0, 0, SLOT_KEYS[i] ?? '', 12, UI.goldBrightText, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 3);
      key.setStroke('#000', 3);
      const cdText = label(scene, 0, 0, '', 18, UI.text, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 3);
      cdText.setStroke('#000', 4);
      return { action, frame, icon, key, cdText, x: 0, y: 0, size: 56 };
    });
    this.infoFrame = makeFrame(scene, 0, 0, 240, 36, 'secondary').setScrollFactor(0).setDepth(DEPTH);
    this.info = label(scene, 0, 0, '', 15, UI.text, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1);
  }

  layout(width: number, height: number): void {
    const compact = width < 820 || height < 520;
    const r = compact ? 38 : 54;
    const margin = compact ? 12 : 22;
    this.placeOrb(this.life, margin + r + 6, height - margin - r - 6, r);
    this.placeOrb(this.mana, width - margin - r - 6, height - margin - r - 6, r);

    const size = compact ? 48 : 60;
    const gap = compact ? 6 : 10;
    const total = this.slots.length * size + (this.slots.length - 1) * gap;
    this.slots.forEach((slot, i) => {
      slot.size = size;
      slot.x = width / 2 - total / 2 + size / 2 + i * (size + gap);
      slot.y = height - margin - size / 2;
      slot.frame.setTexture(frameTexture(this.scene, size, size, 'secondary')).setPosition(slot.x, slot.y);
      slot.icon.setPosition(slot.x, slot.y).setDisplaySize(size - 10, size - 10);
      slot.key.setPosition(slot.x, slot.y + size / 2 - 2);
      slot.cdText.setPosition(slot.x, slot.y);
    });

    const infoW = compact ? 200 : 240;
    this.infoFrame.destroy();
    this.infoFrame = makeFrame(this.scene, width / 2, margin + 18, infoW, 36, 'secondary').setScrollFactor(0).setDepth(DEPTH);
    this.info.setPosition(width / 2, margin + 18);
  }

  update(world: WorldState, dt: number): void {
    this.time += dt;
    const p = world.player;
    const maxLife = playerStat(this.classDef, p, 'life');
    const maxMana = playerStat(this.classDef, p, 'mana');
    const maxShield = playerStat(this.classDef, p, 'energyShield');

    const g = this.liquid.clear();
    this.drawOrb(g, this.life, maxLife > 0 ? p.life / maxLife : 0);
    this.drawOrb(g, this.mana, maxMana > 0 ? p.mana / maxMana : 0);
    if (maxShield > 0 && p.energyShield > 0) {
      // Energy shield: a pale arc hugging the life orb.
      g.lineStyle(5, 0x9fd8ff, 0.95);
      g.beginPath();
      g.arc(this.life.x, this.life.y, this.life.r - 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (p.energyShield / maxShield));
      g.strokePath();
    }
    this.life.text.setText(`${Math.ceil(p.life)}`);
    this.mana.text.setText(`${Math.floor(p.mana)}`);

    const s = this.shutters.clear();
    for (const slot of this.slots) {
      const cd = p.cooldowns[slot.action.id] ?? 0;
      const noMana = p.mana < slot.action.manaCost;
      slot.icon.setAlpha(cd > 0.05 || noMana ? 0.45 : 1);
      if (noMana) slot.icon.setTint(0x6a7ab8);
      else slot.icon.clearTint();
      if (cd > 0.05 && slot.action.cooldown > 0) {
        const frac = Math.min(1, cd / slot.action.cooldown);
        s.fillStyle(0x000000, 0.6);
        s.slice(slot.x, slot.y, (slot.size - 10) / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac, false);
        s.fillPath();
        slot.cdText.setText(cd >= 1 ? String(Math.ceil(cd)) : cd.toFixed(1));
      } else {
        slot.cdText.setText('');
      }
    }

    const seconds = Math.floor(world.time);
    this.info.setText(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}    Kills ${world.kills}    Wave ${world.spawn.wave}`);
    this.updateBuffs(world);
  }

  private updateBuffs(world: WorldState): void {
    for (const o of this.buffIcons) o.destroy();
    this.buffIcons = [];
    const buffs = world.player.buffs;
    if (buffs.length === 0) return;
    const first = this.slots[0];
    if (!first) return;
    const size = 30;
    buffs.forEach((buff, i) => {
      const source = this.classDef.skills.find((a) => a.selfEffects?.some((e) => e.kind === 'buff' && e.id === buff.id));
      const x = first.x - first.size / 2 + size / 2 + i * (size + 6);
      const y = first.y - first.size / 2 - size / 2 - 10;
      const icon = this.scene.add.image(x, y, skillIcon(this.scene, source?.id ?? buff.id)).setDisplaySize(size, size).setScrollFactor(0).setDepth(DEPTH);
      const t = label(this.scene, x, y + size / 2 + 6, `${Math.ceil(buff.remaining)}s`, 12, UI.goldBrightText, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1);
      t.setStroke('#000', 3);
      this.buffIcons.push(icon, t);
    });
  }

  private createOrb(deep: number, bright: number): Orb {
    const ring = this.scene.add.image(0, 0, orbRingTexture(this.scene, 54)).setScrollFactor(0).setDepth(DEPTH + 1);
    const text = label(this.scene, 0, 0, '', 16, UI.text, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2);
    text.setStroke('#000', 4);
    return { ring, text, x: 0, y: 0, r: 54, deep, bright };
  }

  private placeOrb(orb: Orb, x: number, y: number, r: number): void {
    orb.x = x;
    orb.y = y;
    orb.r = r;
    orb.ring.setTexture(orbRingTexture(this.scene, r)).setPosition(x, y);
    orb.text.setPosition(x, y + r * 0.15).setFontSize(r > 45 ? 18 : 14);
  }

  /** Liquid filled up to `frac`, with a gently moving surface. */
  private drawOrb(g: Phaser.GameObjects.Graphics, orb: Orb, frac: number): void {
    const { x, y, r } = orb;
    g.fillStyle(0x07060a, 1).fillCircle(x, y, r);
    const f = Phaser.Math.Clamp(frac, 0, 1);
    if (f <= 0) return;
    const level = y + r - 2 * r * f;
    const points: Phaser.Math.Vector2[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const dx = -r + (2 * r * i) / steps;
      const half = Math.sqrt(Math.max(0, r * r - dx * dx));
      const wave = f < 1 ? Math.sin(this.time * 2.4 + dx * 0.12) * 2.2 : 0;
      points.push(new Phaser.Math.Vector2(x + dx, Math.min(y + half, Math.max(y - half, level + wave))));
    }
    for (let i = steps; i >= 0; i--) {
      const dx = -r + (2 * r * i) / steps;
      points.push(new Phaser.Math.Vector2(x + dx, y + Math.sqrt(Math.max(0, r * r - dx * dx))));
    }
    g.fillStyle(orb.deep, 1).fillPoints(points, true);
    // Bright surface line.
    if (f < 1) g.lineStyle(2, orb.bright, 0.9).strokePoints(points.slice(0, steps + 1), false);
    else g.fillStyle(orb.bright, 0.25).fillCircle(x, y + r * 0.3, r * 0.6);
  }
}


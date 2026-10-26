import * as Phaser from 'phaser';
import { xpToNextLevel, type ProgressionRules } from '../core/progression/levels';
import type { ActionDef, ClassDef, Content } from '../core/world/content';
import {
  actionCost,
  canAfford,
  chargeInfo,
  lifeRecoveryPool,
  playerStat,
  skillLevelInfo,
  type ActionSet,
  type SkillLevelData,
  type WorldState,
} from '../core/world/world';
import { t, upper } from '../i18n';
import { skillIcon } from './hudIcons';
import { formatCost, resourceText } from './resourceText';
import { ClockBadge } from './clockHud';
import { AlliesBadge } from './alliesHud';
import { POTION_ROSE } from './potionFx';
import { PotionSlot } from './potionHud';
import { SoulsBadge } from './soulsHud';
import { frameTexture, label, makeFrame, UI } from './ui';
import type { SafeInsets } from './touchMode';

// In-run HUD: Diablo-style life / class-resource orbs, skill bar with cooldown shutters, XP bar, buffs. The map run's
// timer, room line and boss bar are render/runHud.ts.
// Render-only: reads world state every frame.

const DEPTH = 10000;
/** Slot key captions; mouse buttons are translated ("LMB" / "ЛКМ"). */
const slotKeys = (): string[] => [t('hud.key.lmb'), t('hud.key.rmb'), 'Q', 'E'];
/** Energy shield colours, used when the shield fills the life orb. */
const SHIELD_DEEP = 0x1d4f7a;
const SHIELD_BRIGHT = 0x9fd8ff;

/** Look of the resource orb per ClassDef.resource.id (visual only). */
interface ResourceLook {
  /** Liquid body. */
  readonly deep: number;
  /** Liquid surface and glow. */
  readonly bright: number;
  /** Name caption colour. */
  readonly text: string;
  /** Tint of a skill icon the hero cannot afford. */
  readonly unaffordable: number;
}

const RESOURCE_LOOKS: Readonly<Record<string, ResourceLook>> = {
  // Burnt orange / amber: hot, but clearly apart from the crimson life orb.
  rage: { deep: 0x7a3206, bright: 0xffa230, text: '#ffb45a', unaffordable: 0xb8845a },
  energy: { deep: 0x5a6a08, bright: 0xe2f04a, text: '#e6f07a', unaffordable: 0xa8b46a },
  mana: { deep: 0x0d1f6a, bright: 0x3a72e0, text: '#8fb3ff', unaffordable: 0x6a7ab8 },
};
/** Unknown resource ids (a future class without a look yet): neutral violet. */
const FALLBACK_LOOK: ResourceLook = { deep: 0x3a1a5a, bright: 0xa070e0, text: '#c8a8f0', unaffordable: 0x8a6ab8 };
/** Seconds the resource orb glows after a gain (Rage from hits). */
const GAIN_GLOW = 0.35;
/** Smallest jump (resource points) that counts as a gain for the glow. */
const GAIN_GLOW_MIN = 0.5;
/** Seconds a skill slot glows after the skill levels up. */
const SKILL_LEVEL_GLOW = 1.1;
/** Skill level pips: filled / empty diamond colours, and the skill XP bar fill. */
const PIP_ON = 0xf3d58a;
const PIP_OFF = 0x2e2414;
const PIP_RIM = 0xc89a3a;
const SKILL_XP = 0x7fc8e8;
/** Cost caption colour when skills cost life (Blood Magic). */
const LIFE_COST_TEXT = '#ff8a7a';
/** Seconds the life orb's potion glow takes to fade in / out. */
const POTION_GLOW_FADE = 0.2;

/** A skill slot as a touch button (docs/design/controls.md): slot 0 = basic attack, 1..3 = skills; screen px. */
export interface TouchButton {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  /** Hit radius (a bit larger than the drawn frame). */
  readonly r: number;
}

/** Touch layout (px): the big basic attack button, the skill buttons round it, the potion; extra hit margin. */
const TOUCH_SIZES = {
  compact: { attack: 84, skill: 60, potion: 56, arcGap: 28, gap: 12, orb: 30, hit: 8 },
  wide: { attack: 104, skill: 72, potion: 64, arcGap: 28, gap: 16, orb: 40, hit: 10 },
} as const;
/** Screen angles (degrees, 0 = right, 90 = down) of skills 1..3 round the attack button: left, up-left, up. */
const TOUCH_ARC = [180, 225, 270] as const;
/** Touch button held: scale and rim colour. */
const PRESSED_SCALE = 0.93;
const PRESSED_RIM = 0xf3d58a;
/** Buff icon side (px). */
const BUFF_SIZE = 30;

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
  /** Effective action bound to the slot (world.player.actions; refreshed when the loadout changes). */
  action: ActionDef;
  frame: Phaser.GameObjects.Image;
  icon: Phaser.GameObjects.Image;
  key: Phaser.GameObjects.Text;
  cdText: Phaser.GameObjects.Text;
  /** Price of one use, top-left: in the class resource, or ♥ life under Blood Magic; empty when free. */
  costText: Phaser.GameObjects.Text;
  /** The action is paid with life. */
  lifeCost: boolean;
  /** Stored charges badge (top-right corner), only for multi-charge actions. */
  chargeBadge: Phaser.GameObjects.Arc;
  chargeText: Phaser.GameObjects.Text;
  /** Charge count last drawn (avoids re-setting text every frame); -1 = hidden. */
  shownCharges: number;
  x: number;
  y: number;
  size: number;
  /** Class skill with a level (pips + skill XP bar under the frame); false for the basic attack. */
  levelled: boolean;
  /** Skill level / XP last read from world.player.skillProgress (-1 = not read yet). */
  shownLevel: number;
  shownXp: number;
  maxLevel: number;
  /** Fill of the skill XP bar (0..1); NaN at max level (bar drawn full in gold). */
  xpFrac: number;
  /** Level-up glow, SKILL_LEVEL_GLOW → 0 seconds. */
  levelGlow: number;
  /** Touch layout: a finger is on this button (drawn pressed). */
  pressed: boolean;
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
  private readonly xpBar: Phaser.GameObjects.Graphics;
  /** Skill level pips, skill XP bars and level-up glows under / around the skill slots. */
  private readonly skillLevelGfx: Phaser.GameObjects.Graphics;
  private compact = false;
  private readonly levelText: Phaser.GameObjects.Text;
  private xpRect = { x: 0, y: 0, w: 0, h: 0 };
  private levelPulse = 0;
  private readonly life: Orb;
  private readonly resource: Orb;
  private readonly resourceLook: ResourceLook;
  /** Resource name above its orb ("Rage"). */
  private readonly resourceName: Phaser.GameObjects.Text;
  /** Resource last frame, to glow on gains; NaN before the first frame. */
  private lastResource = Number.NaN;
  private resourceGlow = 0;
  /** Whether the resource number is drawn in the "empty" colour. */
  private resourceEmptyShown = false;
  private readonly slots: Slot[];
  private buffIcons: Phaser.GameObjects.GameObject[] = [];
  private time = 0;
  /** Mechanics list the slot costs were computed for (the world replaces the array on change). */
  private costsFor: unknown;
  /** Action set the slots were bound to (the world replaces it when the loadout changes). */
  private actionsFor: ActionSet | undefined;
  /** Caption on the resource orb when skills cost life instead (max resource 0). */
  private readonly resourceNote: Phaser.GameObjects.Text;
  /** Devourer's Crown souls counter above the resource orb (hidden without the souls mechanic). */
  private readonly souls: SoulsBadge;
  /** Clock of the Last Moment recharge badge: in the souls spot, or stacked above the souls pill when both show. */
  private readonly clock: ClockBadge;
  /** Eye of the Abyss skeleton counter: stacked like the clock (above whichever badges show below it). */
  private readonly allies: AlliesBadge;
  /** Where the stacked badges start (bottom edge of the lowest, screen px), the gap between them, the right edge. */
  private badgeSpot = { x: 0, bottom: 0, gap: 0, maxRight: 0 };
  /** Which of souls / clock / allies were visible at the last stacking (bit mask); -1 = lay out again. */
  private badgeMask = -1;
  /** Life potion slot left of the skill bar (absent without Content.lifePotion). */
  private readonly potion: PotionSlot | undefined;
  /** Glow on the life orb while a potion heal runs, 0..1. */
  private potionGlow = 0;
  /** Over the orb rings, under the orb numbers: the potion glow. */
  private readonly orbGlow: Phaser.GameObjects.Graphics;
  /** Touch layout is on (layout() got safe insets): skill slots are buttons in the bottom right, orbs top left. */
  private touch = false;
  /** Touch layout: the slots as buttons, and the top edge of the button cluster (screen px). */
  private buttons: TouchButton[] = [];
  private clusterTop = 0;
  /** Centre of the first buff icon (more run rightwards from it). */
  private buffAnchor = { x: 0, y: 0 };
  /** Touch layout: badges stack downwards from here (top edge, px) under the buffs. */
  private badgeTop = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly classDef: ClassDef,
    private readonly progression: ProgressionRules,
    private readonly skillLevels: SkillLevelData | undefined,
    content?: Content,
    /** A tap / click on the potion slot (drink). */
    onPotionPress: () => void = () => undefined,
  ) {
    this.liquid = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH);
    this.shutters = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 2);
    this.xpBar = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH);
    this.skillLevelGfx = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 2);
    this.levelText = label(scene, 0, 0, '', 15, UI.goldBrightText, true).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 1);
    this.levelText.setStroke('#000', 4);
    this.life = this.createOrb(0x6a0d0d, 0xd23a2a);
    this.resourceLook = RESOURCE_LOOKS[classDef.resource.id] ?? FALLBACK_LOOK;
    this.resource = this.createOrb(this.resourceLook.deep, this.resourceLook.bright);
    this.resourceName = label(scene, 0, 0, upper(resourceText(classDef.resource.id)), 12, this.resourceLook.text, true)
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(DEPTH + 2);
    this.resourceName.setStroke('#000', 3).setLetterSpacing(1);
    const keys = slotKeys();
    this.slots = [classDef.basicAttack, ...classDef.skills].map((action, i) => {
      const frame = makeFrame(scene, 0, 0, 56, 56, 'secondary').setScrollFactor(0).setDepth(DEPTH);
      const icon = scene.add.image(0, 0, skillIcon(scene, action.id)).setScrollFactor(0).setDepth(DEPTH + 1);
      const key = label(scene, 0, 0, keys[i] ?? '', 12, UI.goldBrightText, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 3);
      key.setStroke('#000', 3);
      const cdText = label(scene, 0, 0, '', 18, UI.text, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 3);
      cdText.setStroke('#000', 4);
      const costText = label(scene, 0, 0, '', 12, LIFE_COST_TEXT, true).setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH + 3);
      costText.setStroke('#000', 3);
      const chargeBadge = scene.add.circle(0, 0, 10, 0x1a1408, 0.92).setStrokeStyle(2, 0xc89a3a, 1).setScrollFactor(0).setDepth(DEPTH + 3).setVisible(false);
      const chargeText = label(scene, 0, 0, '', 13, UI.goldBrightText, true).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 4).setVisible(false);
      chargeText.setStroke('#000', 3);
      return {
        action,
        frame,
        icon,
        key,
        cdText,
        costText,
        lifeCost: false,
        chargeBadge,
        chargeText,
        shownCharges: -1,
        x: 0,
        y: 0,
        size: 56,
        levelled: i > 0 && skillLevels !== undefined,
        shownLevel: -1,
        shownXp: -1,
        maxLevel: 1,
        xpFrac: Number.NaN,
        levelGlow: 0,
        pressed: false,
      };
    });
    // Created after the orb rings (same depth, drawn above them), below the numbers (DEPTH + 2).
    this.orbGlow = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 1);
    this.resourceNote = label(scene, 0, 0, t('hud.skillsCostLife'), 12, '#ff8a7a', true).setOrigin(0.5).setAlign('center').setScrollFactor(0).setDepth(DEPTH + 2).setVisible(false);
    this.resourceNote.setStroke('#000', 3);
    this.souls = new SoulsBadge(scene, DEPTH + 2);
    this.clock = new ClockBadge(scene, DEPTH + 2);
    this.allies = new AlliesBadge(scene, DEPTH + 2);
    this.potion = content?.lifePotion ? new PotionSlot(scene, DEPTH, content.lifePotion, content, classDef, onPotionPress) : undefined;
  }

  /**
   * Places everything for a screen size. `touch` (the safe area insets) switches to the touch layout: skill slots
   * become the touch buttons in the bottom right; the orbs, XP bar, buffs and badges move to the top left.
   */
  layout(width: number, height: number, touch?: SafeInsets): void {
    const compact = width < 820 || height < 520;
    this.compact = compact;
    this.touch = touch !== undefined;
    for (const slot of this.slots) slot.key.setVisible(!touch);
    this.potion?.setKeyHint(!touch);
    if (touch) {
      this.layoutTouch(width, height, touch);
      return;
    }
    this.buttons = [];
    const r = compact ? 38 : 54;
    const margin = compact ? 12 : 22;
    this.placeOrb(this.life, margin + r + 6, height - margin - r - 6, r);
    this.placeOrb(this.resource, width - margin - r - 6, height - margin - r - 6, r);
    // Name just above the orb's metal ring.
    this.resourceName.setPosition(this.resource.x, this.resource.y - r - (compact ? 8 : 10)).setFontSize(compact ? 11 : 12);

    const size = compact ? 48 : 60;
    const gap = compact ? 6 : 10;
    const total = this.slots.length * size + (this.slots.length - 1) * gap;
    // Strip under the frames for the skill level row (pips + skill XP bar), clear of the key caption.
    // The potion slot uses the same row for its charge pips.
    const levelStrip = this.skillLevels || this.potion ? (compact ? 10 : 13) : 0;
    this.slots.forEach((slot, i) => {
      this.placeSlot(slot, width / 2 - total / 2 + size / 2 + i * (size + gap), height - margin - levelStrip - size / 2, size);
    });
    // Potion slot left of the skill bar, a wider gap apart (it is not a skill).
    const firstSlot = this.slots[0];
    if (this.potion && firstSlot) this.potion.layout(firstSlot.x - size - gap * 2, firstSlot.y, size, compact);
    this.resourceNote.setPosition(this.resource.x, this.resource.y);
    // Souls pill above the resource name (its caption on top), clear of the skill bar on narrow phones.
    const soulsBottom = this.resourceName.y - this.resourceName.height - (compact ? 6 : 8);
    this.souls.layout(this.resource.x, soulsBottom, compact);
    this.badgeSpot = { x: this.resource.x, bottom: soulsBottom, gap: compact ? 2 : 4, maxRight: width - 4 };
    this.badgeMask = -1;
    // XP bar spans the skill bar, just above it; level number to its left.
    const barH = compact ? 6 : 8;
    this.xpRect = { x: width / 2 - total / 2, y: height - margin - levelStrip - size - (compact ? 10 : 14) - barH, w: total, h: barH };
    this.levelText.setPosition(this.xpRect.x - 8, this.xpRect.y + barH / 2).setFontSize(compact ? 13 : 15);
    // Buffs above the XP bar, from the first slot's left edge.
    if (firstSlot) this.buffAnchor = { x: firstSlot.x - firstSlot.size / 2 + BUFF_SIZE / 2, y: firstSlot.y - firstSlot.size / 2 - BUFF_SIZE / 2 - 28 };
  }

  /**
   * Touch layout (docs/design/controls.md): bottom right the big basic attack button with skills 1..3 on an arc round
   * it (left, up-left, up) and the potion beyond (left of skill 1 in landscape, above skill 3 in portrait); top left
   * the orbs (side by side, stacked on narrow screens), the XP bar under them, then buffs and badges.
   */
  private layoutTouch(width: number, height: number, insets: SafeInsets): void {
    const compact = this.compact;
    const z = compact ? TOUCH_SIZES.compact : TOUCH_SIZES.wide;
    const margin = compact ? 12 : 22;
    const left = margin + insets.left;
    const right = width - margin - insets.right;
    const top = (compact ? 8 : 16) + insets.top;
    const bottom = height - margin - insets.bottom;
    const strip = compact ? 10 : 13;

    // Orbs, top left; the resource name sits above its orb.
    const r = z.orb;
    const nameH = compact ? 14 : 16;
    const narrow = width < 560;
    const orbY = top + nameH + r + 4;
    this.placeOrb(this.life, left + r + 4, orbY, r);
    if (narrow) this.placeOrb(this.resource, this.life.x, orbY + r * 2 + nameH + 12, r);
    else this.placeOrb(this.resource, this.life.x + r * 2 + 18, orbY, r);
    this.resourceName.setPosition(this.resource.x, this.resource.y - r - (compact ? 6 : 8)).setFontSize(compact ? 11 : 12);
    this.resourceNote.setPosition(this.resource.x, this.resource.y);

    // XP bar under the orbs, the level number left of it.
    const barH = compact ? 6 : 8;
    const xpLeft = left + (compact ? 22 : 26);
    const xpRight = Math.max(xpLeft + 110, this.resource.x + r + 4);
    this.xpRect = { x: xpLeft, y: this.resource.y + r + (compact ? 12 : 16), w: xpRight - xpLeft, h: barH };
    this.levelText.setPosition(this.xpRect.x - 8, this.xpRect.y + barH / 2).setFontSize(compact ? 13 : 15);
    this.buffAnchor = { x: left + BUFF_SIZE / 2, y: this.xpRect.y + barH + 10 + BUFF_SIZE / 2 };
    // Badges under the buff row (its timer caption included).
    this.badgeTop = this.buffAnchor.y + BUFF_SIZE / 2 + 22;
    this.badgeSpot = { x: left + (compact ? 46 : 54), bottom: 0, gap: compact ? 2 : 4, maxRight: width - 4 };
    this.badgeMask = -1;

    // Buttons, bottom right.
    const ax = right - z.attack / 2;
    const ay = bottom - strip - z.attack / 2;
    const arc = z.attack / 2 + z.skill / 2 + z.arcGap;
    this.buttons = [];
    let clusterTop = ay - z.attack / 2;
    this.slots.forEach((slot, i) => {
      const size = i === 0 ? z.attack : z.skill;
      const angle = ((TOUCH_ARC[i - 1] ?? 0) * Math.PI) / 180;
      const x = i === 0 ? ax : ax + Math.cos(angle) * arc;
      const y = i === 0 ? ay : ay + Math.sin(angle) * arc;
      this.placeSlot(slot, x, y, size);
      this.buttons.push({ slot: i, x, y, r: size / 2 + z.hit });
      clusterTop = Math.min(clusterTop, y - size / 2);
    });
    if (this.potion) {
      const skill1 = this.slots[1];
      const skill3 = this.slots[3];
      const landscape = width >= height;
      const px = landscape && skill1 ? skill1.x - z.skill / 2 - z.gap - z.potion / 2 : (skill3?.x ?? ax);
      const py = landscape ? ay + z.attack / 2 - z.potion / 2 : (skill3?.y ?? ay) - z.skill / 2 - strip - z.gap - z.potion / 2;
      this.potion.layout(px, py, z.potion, compact);
      clusterTop = Math.min(clusterTop, py - z.potion / 2);
    }
    this.clusterTop = clusterTop;
  }

  /** Touch layout: the slots as touch buttons (empty in the desktop layout). */
  touchButtons(): readonly TouchButton[] {
    return this.buttons;
  }

  /** Touch layout: top edge of the button cluster (screen px), so other controls stay clear of it. */
  touchClusterTop(): number {
    return this.clusterTop;
  }

  /** Touch layout: right edge of the orbs in the top left (screen px). */
  touchOrbsRight(): number {
    return Math.max(this.life.x + this.life.r, this.resource.x + this.resource.r) + 6;
  }

  /** A finger is on the slot's touch button: the frame lights up like a hovered button. */
  setSlotPressed(index: number, pressed: boolean): void {
    const slot = this.slots[index];
    if (!slot) return;
    slot.pressed = pressed;
    // Pressed: lighter frame, the button sinks a little (a gold rim is drawn over it in update).
    slot.frame.setTexture(frameTexture(this.scene, slot.size, slot.size, pressed ? 'secondaryHover' : 'secondary')).setScale(pressed ? PRESSED_SCALE : 1);
    slot.icon.setDisplaySize((slot.size - 10) * (pressed ? PRESSED_SCALE : 1), (slot.size - 10) * (pressed ? PRESSED_SCALE : 1));
  }

  private placeSlot(slot: Slot, x: number, y: number, size: number): void {
    const compact = this.compact;
    slot.size = size;
    slot.x = x;
    slot.y = y;
    const k = slot.pressed ? PRESSED_SCALE : 1;
    slot.frame.setTexture(frameTexture(this.scene, size, size, slot.pressed ? 'secondaryHover' : 'secondary')).setPosition(x, y).setScale(k);
    slot.icon.setPosition(x, y).setDisplaySize((size - 10) * k, (size - 10) * k);
    slot.key.setPosition(x, y + size / 2 - 2);
    slot.cdText.setPosition(x, y).setFontSize(size > 70 ? 22 : 18);
    slot.costText.setPosition(x - size / 2 + 4, y - size / 2 + 3);
    // Charge badge on the frame's top-right corner (key caption is bottom-centre, life cost top-left).
    const br = compact ? 10 : 11;
    const bx = x + size / 2 - br + 3;
    const by = y - size / 2 + br - 3;
    slot.chargeBadge.setPosition(bx, by).setRadius(br);
    slot.chargeText.setPosition(bx, by).setFontSize(compact ? 12 : 14);
  }

  update(world: WorldState, dt: number): void {
    this.time += dt;
    const p = world.player;
    const maxLife = playerStat(this.classDef, p, 'life');
    const maxResource = playerStat(this.classDef, p, 'resource');
    const maxShield = playerStat(this.classDef, p, 'energyShield');

    const g = this.liquid.clear();
    // Crystal Shell leaves 1 life: energy shield is the real pool, so it fills the life orb.
    const shieldIsPool = lifeRecoveryPool(p.mechanics) === 'energyShield' && maxShield > 0;
    if (shieldIsPool) this.drawOrb(g, this.life, p.energyShield / maxShield, SHIELD_DEEP, SHIELD_BRIGHT);
    else this.drawOrb(g, this.life, maxLife > 0 ? p.life / maxLife : 0);
    // Blood Magic: no resource at all; the orb greys out and says skills cost life.
    const noResource = maxResource <= 0;
    // Glow on discrete gains (Rage per hit, potions), not on steady regeneration: the jump must beat a generous
    // regen allowance (a frame can cover a couple of fixed core steps).
    const regenAllowance = playerStat(this.classDef, p, 'resourceRegen') * Math.max(dt, 1 / 30) * 2 + GAIN_GLOW_MIN;
    if (p.resource - this.lastResource > regenAllowance) this.resourceGlow = GAIN_GLOW;
    this.lastResource = p.resource;
    this.resourceGlow = Math.max(0, this.resourceGlow - dt);
    if (noResource) g.fillStyle(0x1a1719, 1).fillCircle(this.resource.x, this.resource.y, this.resource.r);
    else this.drawResourceOrb(g, p.resource / maxResource);
    this.resource.ring.setAlpha(noResource ? 0.45 : 1);
    this.resource.text.setVisible(!noResource);
    this.resourceName.setAlpha(noResource ? 0.4 : 1);
    this.resourceNote.setVisible(noResource);
    if (!shieldIsPool && maxShield > 0 && p.energyShield > 0) {
      // Energy shield: a pale arc hugging the life orb.
      g.lineStyle(5, 0x9fd8ff, 0.95);
      g.beginPath();
      g.arc(this.life.x, this.life.y, this.life.r - 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (p.energyShield / maxShield));
      g.strokePath();
    }
    // Potion heal running: a rose glow throbbing round the life orb.
    this.potionGlow = Phaser.Math.Clamp(this.potionGlow + (p.potion.heals.length > 0 ? dt : -dt) / POTION_GLOW_FADE, 0, 1);
    const og = this.orbGlow.clear();
    if (this.potionGlow > 0) {
      const pulse = 0.7 + 0.3 * Math.sin(this.time * 9);
      const a = this.potionGlow * pulse;
      og.fillStyle(POTION_ROSE, 0.2 * a).fillCircle(this.life.x, this.life.y, this.life.r);
      og.lineStyle(4, 0xffb0c0, 0.85 * a).strokeCircle(this.life.x, this.life.y, this.life.r - 3);
      og.lineStyle(3, POTION_ROSE, 0.75 * a).strokeCircle(this.life.x, this.life.y, this.life.r + 9 + 2 * pulse);
    }
    this.life.text.setText(shieldIsPool ? `${Math.ceil(p.energyShield)}` : `${Math.ceil(p.life)}`);
    this.resource.text.setText(`${Math.floor(p.resource)}`);

    if (this.actionsFor !== p.actions) {
      // Effective skills (cooldowns etc. after passives) are resolved by core; slot order = class order.
      this.actionsFor = p.actions;
      const actions = [p.actions.basicAttack, ...p.actions.skills];
      this.slots.forEach((slot, i) => {
        slot.action = actions[i] ?? slot.action;
      });
      this.costsFor = undefined;
    }
    if (this.costsFor !== p.mechanics) {
      // Prices only change with the hero's mechanics, not every frame.
      this.costsFor = p.mechanics;
      // Costs come from the effective action (supports multiply them, so they can be fractional: shown rounded).
      for (const slot of this.slots) {
        const cost = actionCost(p.mechanics, slot.action.resourceCost);
        slot.lifeCost = cost.pool === 'life';
        if (cost.amount <= 0) slot.costText.setText('');
        else if (slot.lifeCost) slot.costText.setText(`♥${formatCost(cost.amount)}`).setColor(LIFE_COST_TEXT);
        else slot.costText.setText(formatCost(cost.amount)).setColor(this.resourceLook.text);
      }
    }
    const s = this.shutters.clear();
    for (const slot of this.slots) {
      // Multi-charge actions stay usable while any charge is stored; the shutter shows the next charge's recharge.
      const info = chargeInfo(p, slot.action);
      const multi = info.max > 1;
      const cd = info.recharge;
      const blocked = multi ? info.charges <= 0 : cd > 0.05;
      const unaffordable = !canAfford(p, slot.action);
      slot.icon.setAlpha(blocked || unaffordable ? 0.45 : 1);
      if (unaffordable) slot.icon.setTint(slot.lifeCost ? 0xb86a6a : this.resourceLook.unaffordable);
      else slot.icon.clearTint();
      if (slot.pressed) {
        const half = (slot.size * PRESSED_SCALE) / 2;
        s.lineStyle(3, PRESSED_RIM, 0.95).strokeRect(slot.x - half + 3, slot.y - half + 3, half * 2 - 6, half * 2 - 6);
      }
      const shown = multi ? info.charges : -1;
      if (shown !== slot.shownCharges) {
        slot.shownCharges = shown;
        const empty = multi && info.charges === 0;
        slot.chargeBadge.setVisible(multi).setStrokeStyle(2, empty ? 0x6a5a3a : 0xc89a3a, 1);
        slot.chargeText.setVisible(multi).setText(multi ? String(info.charges) : '').setColor(empty ? '#8a8070' : UI.goldBrightText);
      }
      if (cd > 0.05) {
        // A mid-run swap can shorten the cooldown below what is still running: never divide by less than the remainder.
        const frac = Math.min(1, cd / Math.max(slot.action.cooldown, cd));
        // Charges still stored: a lighter shutter, the skill stays usable.
        s.fillStyle(0x000000, blocked ? 0.6 : 0.28);
        s.slice(slot.x, slot.y, (slot.size - 10) / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac, false);
        s.fillPath();
        // Countdown only while blocked; with charges left a big number would read as "not ready".
        slot.cdText.setText(blocked ? (cd >= 1 ? String(Math.ceil(cd)) : cd.toFixed(1)) : '');
      } else {
        slot.cdText.setText('');
      }
    }

    this.souls.update(p, dt);
    this.clock.update(p, dt);
    this.allies.refresh(world);
    // Badges stack upwards from the souls spot: souls, then the clock, then the skeleton counter, each above the
    // visible ones below it (re-laid only when the set of visible badges changes).
    const mask = (this.souls.visible ? 1 : 0) | (this.clock.visible ? 2 : 0) | (this.allies.visible ? 4 : 0);
    if (mask !== this.badgeMask && this.touch) {
      this.badgeMask = mask;
      this.stackBadgesDown();
    } else if (mask !== this.badgeMask) {
      this.badgeMask = mask;
      const spot = this.badgeSpot;
      let bottom = spot.bottom;
      if (this.souls.visible) bottom -= this.souls.stackHeight + spot.gap;
      this.clock.layout(spot.x, bottom, this.compact, spot.maxRight);
      if (this.clock.visible) bottom -= this.clock.stackHeight + spot.gap;
      this.allies.layout(spot.x, bottom, this.compact, spot.maxRight);
    }
    this.allies.update(world, dt);
    this.potion?.update(p, dt);
    this.drawXp(world, dt);
    this.drawSkillLevels(world, dt);
    this.updateBuffs(world);
  }

  /** Touch layout: souls, clock and skeleton badges stack downwards from badgeTop (each pill's caption above it). */
  private stackBadgesDown(): void {
    const spot = this.badgeSpot;
    const compact = this.compact;
    let top = this.badgeTop;
    // Laid out once to learn the stack height (it does not depend on the position), then placed.
    this.souls.layout(spot.x, top, compact);
    this.souls.layout(spot.x, top + this.souls.stackHeight - 6, compact);
    if (this.souls.visible) top += this.souls.stackHeight + spot.gap;
    this.clock.layout(spot.x, top, compact, spot.maxRight);
    this.clock.layout(spot.x, top + this.clock.stackHeight - 6, compact, spot.maxRight);
    if (this.clock.visible) top += this.clock.stackHeight + spot.gap;
    this.allies.layout(spot.x, top, compact, spot.maxRight);
    this.allies.layout(spot.x, top + this.allies.stackHeight - 6, compact, spot.maxRight);
  }

  /** Brief glow on the slot of a skill that just levelled up (WorldEvent skillLevelUp). */
  skillLevelUp(skillId: string): void {
    for (const slot of this.slots) if (slot.levelled && slot.action.id === skillId) slot.levelGlow = SKILL_LEVEL_GLOW;
  }

  /**
   * Under each class skill: one diamond pip per level (filled up to the current level) and a thin bar of XP to the
   * next level (full gold at max level). Read-only over world.player.skillProgress.
   */
  private drawSkillLevels(world: WorldState, dt: number): void {
    const data = this.skillLevels;
    const g = this.skillLevelGfx.clear();
    if (!data) return;
    const pip = this.compact ? 3 : 3.5;
    const step = this.compact ? 8 : 9;
    const barH = this.compact ? 3 : 4;
    for (const slot of this.slots) {
      if (!slot.levelled) continue;
      const progress = world.player.skillProgress[slot.action.id];
      const level = progress?.level ?? 1;
      const xp = progress?.xp ?? 0;
      if (level !== slot.shownLevel || xp !== slot.shownXp) {
        // Only on change: skillLevelInfo builds objects.
        slot.shownLevel = level;
        slot.shownXp = xp;
        const info = skillLevelInfo(slot.action.id, progress, data);
        slot.maxLevel = info.maxLevel;
        slot.xpFrac = Number.isFinite(info.xpToNext) && info.xpToNext > 0 ? Phaser.Math.Clamp(info.xp / info.xpToNext, 0, 1) : Number.NaN;
      }
      slot.levelGlow = Math.max(0, slot.levelGlow - dt);
      const glow = slot.levelGlow / SKILL_LEVEL_GLOW;
      const half = slot.size / 2;
      const rowY = slot.y + half + (this.compact ? 7 : 9);
      const atMax = Number.isNaN(slot.xpFrac);
      const pipsW = (slot.maxLevel - 1) * step;
      // Left-aligned: the key caption sits bottom-centre on the frame.
      const firstPip = slot.x - half + 2 + pip;
      for (let l = 1; l <= slot.maxLevel; l++) {
        const px = firstPip + (l - 1) * step;
        const on = l <= slot.shownLevel;
        // The newest pip swells while the slot glows.
        const r = on && l === slot.shownLevel ? pip * (1 + glow * 0.6) : pip;
        diamond(g, px, rowY, r + 1.2);
        g.fillStyle(0x000000, 0.85).fillPath();
        diamond(g, px, rowY, r);
        g.fillStyle(on ? PIP_ON : PIP_OFF, 1).fillPath();
        if (!on) g.lineStyle(1, PIP_RIM, 1).strokePath();
      }
      // XP to the next level; at max level the bar stays full in gold.
      const bx = firstPip + pipsW + pip + 4;
      const bw = slot.x + half - bx;
      const by = rowY - barH / 2;
      g.fillStyle(0x000000, 0.8).fillRect(bx - 1, by - 1, bw + 2, barH + 2);
      g.fillStyle(PIP_OFF, 1).fillRect(bx, by, bw, barH);
      g.fillStyle(atMax ? PIP_ON : SKILL_XP, 1).fillRect(bx, by, atMax ? bw : bw * slot.xpFrac, barH);
      if (glow > 0) {
        // Soft golden ring around the frame, fading out.
        g.lineStyle(3, 0xffe08a, 0.9 * glow).strokeRoundedRect(slot.x - half - 3, slot.y - half - 3, slot.size + 6, slot.size + 6, 6);
        g.fillStyle(0xfff2c0, 0.22 * glow).fillRect(slot.x - half + 4, slot.y - half + 4, slot.size - 8, slot.size - 8);
      }
    }
  }

  /** WorldEvent 'potionDrink': a flash on the potion slot. */
  potionDrink(): void {
    this.potion?.drank();
  }

  /** WorldEvent 'potionDenied': the slot shakes and says why. */
  potionDenied(reason: 'empty' | 'full', world: WorldState): void {
    this.potion?.denied(reason, world.player);
  }

  /** WorldEvent 'potionCharge': a pulse on the potion slot. */
  potionCharge(): void {
    this.potion?.charged();
  }

  /** Flashes the XP bar and level number after a level-up. */
  levelUp(): void {
    this.levelPulse = 1;
  }

  private drawXp(world: WorldState, dt: number): void {
    const { x, y, w, h } = this.xpRect;
    const p = world.player;
    const next = xpToNextLevel(p.level, this.progression);
    const frac = Number.isFinite(next) ? Phaser.Math.Clamp(p.xp / next, 0, 1) : 1;
    this.levelPulse = Math.max(0, this.levelPulse - dt / 1.2);
    const g = this.xpBar.clear();
    g.fillStyle(0x000000, 0.7).fillRect(x - 2, y - 2, w + 4, h + 4);
    g.lineStyle(1, 0x9a6a22, 1).strokeRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle(0x1a1408, 1).fillRect(x, y, w, h);
    g.fillStyle(0xc89a3a, 1).fillRect(x, y, w * frac, h);
    g.fillStyle(0xf3d58a, 0.6).fillRect(x, y, w * frac, Math.max(1, h / 3));
    // Quarter ticks.
    g.fillStyle(0x000000, 0.5);
    for (let i = 1; i < 4; i++) g.fillRect(x + (w * i) / 4, y, 1, h);
    if (this.levelPulse > 0) g.fillStyle(0xfff2c0, this.levelPulse * 0.8).fillRect(x - 2, y - 2, w + 4, h + 4);
    this.levelText.setText(String(p.level)).setScale(1 + this.levelPulse * 0.6);
  }

  private updateBuffs(world: WorldState): void {
    for (const o of this.buffIcons) o.destroy();
    this.buffIcons = [];
    const buffs = world.player.buffs;
    if (buffs.length === 0) return;
    const size = BUFF_SIZE;
    buffs.forEach((buff, i) => {
      const source = world.player.actions.skills.find((a) => a.selfEffects?.some((e) => e.kind === 'buff' && e.id === buff.id));
      const x = this.buffAnchor.x + i * (size + 6);
      const y = this.buffAnchor.y;
      const icon = this.scene.add.image(x, y, skillIcon(this.scene, source?.id ?? buff.id)).setDisplaySize(size, size).setScrollFactor(0).setDepth(DEPTH);
      const time = label(this.scene, x, y + size / 2 + 6, t('hud.buffSeconds', { seconds: Math.ceil(buff.remaining) }), 12, UI.goldBrightText, true)
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(DEPTH + 1);
      time.setStroke('#000', 3);
      this.buffIcons.push(icon, time);
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

  /**
   * The resource orb. An empty pool (Rage at run start) reads as an empty vessel, not a broken one: a faint tint of
   * the resource colour on the glass and a dim rim; a gain makes the orb glow briefly.
   */
  private drawResourceOrb(g: Phaser.GameObjects.Graphics, frac: number): void {
    const orb = this.resource;
    const look = this.resourceLook;
    this.drawOrb(g, orb, frac);
    if (frac < 1) {
      // Tinted empty glass above the liquid line.
      g.fillStyle(look.deep, 0.22).fillCircle(orb.x, orb.y, orb.r);
      g.lineStyle(2, look.bright, 0.4).strokeCircle(orb.x, orb.y, orb.r - 3);
    }
    const empty = frac <= 0;
    if (empty !== this.resourceEmptyShown) {
      // Only on change: setColor re-renders the text texture.
      this.resourceEmptyShown = empty;
      orb.text.setColor(empty ? look.text : UI.text);
    }
    if (this.resourceGlow > 0) {
      const a = this.resourceGlow / GAIN_GLOW;
      g.lineStyle(4, look.bright, 0.9 * a).strokeCircle(orb.x, orb.y, orb.r - 2);
      g.fillStyle(look.bright, 0.2 * a).fillCircle(orb.x, orb.y, orb.r);
    }
  }

  /** Liquid filled up to `frac`, with a gently moving surface. Colours default to the orb's own. */
  private drawOrb(g: Phaser.GameObjects.Graphics, orb: Orb, frac: number, deep = orb.deep, bright = orb.bright): void {
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
    g.fillStyle(deep, 1).fillPoints(points, true);
    // Bright surface line.
    if (f < 1) g.lineStyle(2, bright, 0.9).strokePoints(points.slice(0, steps + 1), false);
    else g.fillStyle(bright, 0.25).fillCircle(x, y + r * 0.3, r * 0.6);
  }
}

/** Path of a diamond (rotated square) with half-diagonal `r`; the caller fills / strokes it. */
function diamond(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number): void {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
}


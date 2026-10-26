import * as Phaser from 'phaser';
import { vec, type Vec2 } from '../core/math';
import type { TouchControlsTuning } from '../data/controls';
import type { TouchButton } from './hud';
import { stickDirection } from './touchAim';
import { pinToScreen } from './ui';

// Mobile run controls (docs/design/controls.md): a floating stick on the left half of the screen and the HUD's skill
// slots as buttons on the right (Hud.touchButtons). Multi-touch: every finger is tracked by its pointer id, so the
// stick and a button (or two buttons) work at once. Input only: RunScene turns this into RunInput (aim rules in
// touchAim.ts); the potion button is the HUD's own interactive potion slot.
// Drag-aim: a skill press aims manually once the finger is past aimDragThreshold and off the button (a drag that
// never leaves the button is a tap: auto-aim); bringing it back onto the button cancels (released there, nothing is
// cast). A cancelled touch (system gesture, notification shade, call) never casts.

/** Stick look (screen px): base ring and knob radii. */
const STICK = {
  compact: { base: 58, knob: 26 },
  wide: { base: 70, knob: 30 },
} as const;
const STICK_DEPTH = 10003;
const STICK_FILL = 0x0a090c;
const STICK_RIM = 0xd9a94a;
const KNOB = 0xf3d58a;
const AIM_RING = 0xff7a2a;
const CANCEL_RED = 0xff4a3a;
/** Milliseconds after a touch during which a mouse press is the browser's emulated one (ignored). */
const EMULATED_MOUSE_GUARD = 800;

/** How a slot's button looks: free, held by a finger, or a drag-aim brought back onto it (release cancels). */
export type ButtonState = 'idle' | 'pressed' | 'cancel';

interface Stick {
  readonly id: number;
  baseX: number;
  baseY: number;
  x: number;
  y: number;
}

interface Press {
  readonly button: TouchButton;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  /** Dragged past the threshold and off the button: manual aim (skills only). */
  dragging: boolean;
  /** Dragging, came back onto the button: releasing now cancels. */
  cancel: boolean;
}

/** A skill button let go: `dir` is the drag on screen (direction and length) for manual aim, undefined for a tap. */
export interface SkillRelease {
  /** HUD slot: 1..3 = skills. */
  readonly slot: number;
  readonly dir: Vec2 | undefined;
}

/** A skill being aimed by dragging: its slot, the drag offset on screen (px), whether releasing now cancels. */
export interface DragAim {
  readonly slot: number;
  readonly dx: number;
  readonly dy: number;
  readonly cancel: boolean;
}

export class TouchControls {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private stick: Stick | undefined;
  private readonly presses = new Map<number, Press>();
  private readonly releases: SkillRelease[] = [];
  private enabled = true;
  private lastTouch = Number.NEGATIVE_INFINITY;
  private readonly drag = { slot: 0, dx: 0, dy: 0, cancel: false };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly buttons: () => readonly TouchButton[],
    private readonly tuning: TouchControlsTuning,
    /** A slot's button changed look (the HUD draws it). */
    private readonly onButtonState: (slot: number, state: ButtonState) => void,
    /** The slot's skill aims a distance by the drag length (the drag radius ring is shown for it). */
    private readonly distanceAimed: (slot: number) => boolean,
  ) {
    this.gfx = pinToScreen(scene.add.graphics(), STICK_DEPTH);
    const input = scene.input;
    input.on(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
    input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      input.off(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
      input.off(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
      input.off(Phaser.Input.Events.POINTER_UP, this.onUp, this);
      input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    });
  }

  /** Off while paused, in the passive tree or after the run: every finger is dropped without casting. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  /** Drops every tracked finger (no casts) and queued releases. */
  reset(): void {
    this.stick = undefined;
    for (const press of this.presses.values()) this.onButtonState(press.button.slot, 'idle');
    this.presses.clear();
    this.releases.length = 0;
    this.gfx.clear();
  }

  /** Stick direction on screen (unit, or zero inside the dead zone / without a stick). */
  moveDirection(): Vec2 {
    const s = this.stick;
    if (!s) return vec(0, 0);
    return stickDirection(s.x - s.baseX, s.y - s.baseY, this.stickLook().base, this.tuning.stickDeadZone);
  }

  /** The basic attack button is held. */
  attackHeld(): boolean {
    for (const press of this.presses.values()) if (press.button.slot === 0) return true;
    return false;
  }

  /** The oldest skill button release not taken yet. */
  nextRelease(): SkillRelease | undefined {
    return this.releases.shift();
  }

  /** The skill being drag-aimed (the latest one if several), or undefined. The object is reused. */
  dragAim(): DragAim | undefined {
    let found: Press | undefined;
    for (const press of this.presses.values()) if (press.dragging) found = press;
    if (!found) return undefined;
    this.drag.slot = found.button.slot;
    this.drag.dx = found.x - found.startX;
    this.drag.dy = found.y - found.startY;
    this.drag.cancel = found.cancel;
    return this.drag;
  }

  /** Per frame: forgets fingers whose release was missed (left the page, cancelled touch), draws the stick. */
  update(): void {
    if (this.stick && !this.isDown(this.stick.id)) this.stick = undefined;
    for (const [id, press] of this.presses) {
      if (this.isDown(id)) continue;
      this.presses.delete(id);
      this.onButtonState(press.button.slot, 'idle');
    }
    this.draw();
  }

  private isDown(id: number): boolean {
    const pointers = this.scene.input.manager.pointers;
    for (let i = 0; i < pointers.length; i++) if (pointers[i]!.id === id) return pointers[i]!.isDown;
    return false;
  }

  private stickLook(): { base: number; knob: number } {
    const { width, height } = this.scene.scale;
    return width < 820 || height < 520 ? STICK.compact : STICK.wide;
  }

  private onDown(pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]): void {
    if (pointer.wasTouch) this.lastTouch = this.scene.time.now;
    else if (this.scene.time.now - this.lastTouch < EMULATED_MOUSE_GUARD) return;
    // Presses on other HUD controls (pause, talents, potion, altar, overlays) are theirs.
    if (!this.enabled || over.length > 0 || this.presses.has(pointer.id)) return;
    const button = this.buttonAt(pointer.x, pointer.y);
    if (button) {
      // One finger per button: a second finger on a held button does nothing.
      for (const press of this.presses.values()) if (press.button.slot === button.slot) return;
      this.presses.set(pointer.id, { button, startX: pointer.x, startY: pointer.y, x: pointer.x, y: pointer.y, dragging: false, cancel: false });
      this.onButtonState(button.slot, 'pressed');
      return;
    }
    if (!this.stick && pointer.x < this.scene.scale.width / 2) {
      this.stick = { id: pointer.id, baseX: pointer.x, baseY: pointer.y, x: pointer.x, y: pointer.y };
    }
  }

  private onMove(pointer: Phaser.Input.Pointer): void {
    const s = this.stick;
    if (s && s.id === pointer.id) {
      s.x = pointer.x;
      s.y = pointer.y;
      // Past the ring the base follows the finger, so a long drag keeps steering.
      const base = this.stickLook().base;
      const dx = s.x - s.baseX;
      const dy = s.y - s.baseY;
      const len = Math.hypot(dx, dy);
      if (len > base) {
        s.baseX = s.x - (dx / len) * base;
        s.baseY = s.y - (dy / len) * base;
      }
      return;
    }
    const press = this.presses.get(pointer.id);
    if (!press) return;
    press.x = pointer.x;
    press.y = pointer.y;
    if (press.button.slot === 0) return;
    const onButton = Math.hypot(press.x - press.button.x, press.y - press.button.y) <= press.button.r;
    if (!press.dragging && !onButton && Math.hypot(press.x - press.startX, press.y - press.startY) >= this.tuning.aimDragThreshold) press.dragging = true;
    if (!press.dragging) return;
    const cancel = onButton;
    if (cancel !== press.cancel) {
      press.cancel = cancel;
      this.onButtonState(press.button.slot, cancel ? 'cancel' : 'pressed');
    }
  }

  private onUp(pointer: Phaser.Input.Pointer): void {
    if (this.stick?.id === pointer.id) this.stick = undefined;
    const press = this.presses.get(pointer.id);
    if (!press) return;
    this.presses.delete(pointer.id);
    const slot = press.button.slot;
    this.onButtonState(slot, 'idle');
    // A cancelled touch (Phaser reports touchcancel as a pointer up) is dropped like a cancelled aim.
    if (!this.enabled || slot === 0 || press.cancel || pointer.wasCanceled) return;
    this.releases.push({ slot, dir: press.dragging ? vec(press.x - press.startX, press.y - press.startY) : undefined });
  }

  /** The button under (x, y): the nearest one whose hit circle contains the point. */
  private buttonAt(x: number, y: number): TouchButton | undefined {
    let best: TouchButton | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const b of this.buttons()) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d <= b.r && d < bestDist) {
        best = b;
        bestDist = d;
      }
    }
    return best;
  }

  private draw(): void {
    const g = this.gfx.clear();
    if (!this.enabled) return;
    const s = this.stick;
    if (s) {
      const look = this.stickLook();
      g.fillStyle(STICK_FILL, 0.35).fillCircle(s.baseX, s.baseY, look.base);
      g.lineStyle(3, STICK_RIM, 0.55).strokeCircle(s.baseX, s.baseY, look.base);
      const dx = s.x - s.baseX;
      const dy = s.y - s.baseY;
      const len = Math.hypot(dx, dy);
      const k = len > look.base ? look.base / len : 1;
      const kx = s.baseX + dx * k;
      const ky = s.baseY + dy * k;
      g.fillStyle(KNOB, 0.45).fillCircle(kx, ky, look.knob);
      g.lineStyle(2, 0x1a1006, 0.8).strokeCircle(kx, ky, look.knob);
    }
    // Drag-aiming: a ring under the finger and a line back to where it pressed; for distance-aimed skills a faint
    // ring of the drag radius (its edge = full range). Red while the release would cancel.
    for (const press of this.presses.values()) {
      if (!press.dragging) continue;
      const color = press.cancel ? CANCEL_RED : AIM_RING;
      if (!press.cancel && this.distanceAimed(press.button.slot)) {
        g.lineStyle(2, AIM_RING, 0.3).strokeCircle(press.startX, press.startY, this.tuning.aimDragRadius);
      }
      g.lineStyle(2, color, 0.6).lineBetween(press.startX, press.startY, press.x, press.y);
      g.lineStyle(3, color, 0.85).strokeCircle(press.x, press.y, 18);
    }
  }
}

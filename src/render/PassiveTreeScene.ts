import * as Phaser from 'phaser';
import {
  allocate,
  allocatePath,
  canAllocate,
  canDeallocate,
  classStart,
  cloneAllocation,
  findPath,
  nextSpecMilestone,
  isAllocated,
  neighbors,
  unspentPoints,
  type AllocateError,
  type PassivePath,
  type PassivePoints,
} from '../core/passives/allocation';
import { hasPendingMechanics } from '../core/passives/mechanics';
import { changeSpec, refundNode, refundWheel, type RespecError } from '../core/passives/respec';
import type { PassiveHero, PassiveNodeDef, PassiveNodeType } from '../core/passives/types';
import { findCharacter, type CharacterRecord } from '../core/progression/profile';
import { classes } from '../data/classes';
import { passiveTree } from '../data/passives';
import { getApp, type App } from './app';
import { t } from '../i18n';
import { passiveName, specName } from './contentText';
import { allocateError, costLabel, describeNode, nodesWord, nodeTypeLabel, pendingEffect, pointsWord, respecError, shardsWord } from './passiveText';
import { confirmDialog, fadeIn, heading, label, makeButton, makeFrame, UI, uiMetrics } from './ui';

// Passive tree screen: the wheel + specialization branches, pan/zoom (mouse drag + wheel, touch drag + pinch),
// hover tooltip (mouse) / tap-to-inspect panel (touch), allocation, path allocation and paid respec.
// Every rule is a core call; this file only draws and forwards intents.

const TREE = passiveTree;
/** Static node list, reused by every redraw and hit test (drag/pinch redraw each frame). */
const NODES: readonly PassiveNodeDef[] = Object.values(TREE.nodes);
const START_NODES: readonly PassiveNodeDef[] = NODES.filter((n) => n.type === 'start');
const EMPTY_PATH: ReadonlySet<string> = new Set();

/** Hooks given by the run screen when the tree opens over a run. */
export interface RunTreeHooks {
  /** Hero level right now (the run levels the hero before the saved record catches up). */
  level(): number;
  /** After every change: the run refreshes hero stats and saves. */
  changed(): void;
  /** The tree was closed; the run resumes. */
  closed(): void;
}

export interface PassiveTreeSceneData {
  characterId: string;
  /** Hub screen to return to (ignored over a run). */
  returnTo?: 'main-menu' | 'inventory';
  run?: RunTreeHooks;
}

type NodeState = 'allocated' | 'allocatable' | 'reachable' | 'locked' | 'blocked';

// ---- Visual constants --------------------------------------------------------------------------------

/** Node radius in tree units. */
const NODE_RADIUS: Record<PassiveNodeType, number> = { start: 30, small: 15, notable: 22, keystone: 23, specEntry: 20, specKeystone: 27, spec: 17 };
const CLASS_COLORS: Readonly<Record<string, number>> = { warrior: 0xd0583c, ranger: 0x6fbf4a, mage: 0x5b8cf0 };
const LOOK: Record<NodeState, { fill: number; rim: number; alpha: number }> = {
  allocated: { fill: 0xc8952f, rim: 0xfff0c0, alpha: 1 },
  allocatable: { fill: 0x3a2618, rim: 0xff7a2a, alpha: 1 },
  reachable: { fill: 0x241d22, rim: 0x9a7a3a, alpha: 1 },
  locked: { fill: 0x17131a, rim: 0x5a4e44, alpha: 1 },
  blocked: { fill: 0x0f0c10, rim: 0x2e2830, alpha: 0.4 },
};
const GOLD_LINE = 0xe0b050;
const EMBER = 0xff7a2a;
const DRAG_THRESHOLD = 8;
const MAX_ZOOM = 2.2;
/** Zoom below which small nodes get hard to hit; the initial view never goes below it. */
const READABLE_ZOOM = { mouse: 0.42, touch: 0.6 } as const;
/** Node labels appear from this zoom on; the packed centre (keystones) needs more. */
const LABEL_ZOOM = 0.55;
const KEYSTONE_LABEL_ZOOM = 1.1;
/** When the whole tree does not fit, the view centres this far out along the class direction. */
const FOCUS_RADIUS = 430;
const WHEEL_ZOOM_SPEED = 0.0015;

interface Point {
  x: number;
  y: number;
}

/** Tree-space positions (y down for drawing). */
const POS: ReadonlyMap<string, Point> = new Map(
  Object.values(TREE.nodes).map((n) => {
    const a = (n.pos.angleDeg * Math.PI) / 180;
    return [n.id, { x: Math.cos(a) * n.pos.radius, y: -Math.sin(a) * n.pos.radius }];
  }),
);
const MAX_RADIUS = Math.max(...Object.values(TREE.nodes).map((n) => n.pos.radius));
/** Half-size of the area to fit: outermost nodes plus room for branch and class names. */
const EXTENT = MAX_RADIUS + 140;

/**
 * Faint backdrop rings, derived from the layout so they follow data changes: the inner ring (the nodes
 * the keystones hang off), the class starts, and one midway between them.
 */
const BACKDROP_RINGS: readonly number[] = (() => {
  const nodes = Object.values(TREE.nodes);
  const inner = Math.max(0, ...nodes.filter((n) => n.type === 'keystone').flatMap((n) => neighbors(TREE, n.id).map((id) => TREE.nodes[id]?.pos.radius ?? 0)));
  const outer = Math.max(0, ...nodes.filter((n) => n.type === 'start').map((n) => n.pos.radius));
  return inner > 0 && outer > inner ? [inner, (inner + outer) / 2, outer] : [outer];
})();

/** Class names sit outside the wheel beyond their spec branches (the start node is ringed by nodes). */
const CLASS_LABEL_POS: ReadonlyMap<string, Point> = new Map(
  Object.values(TREE.nodes)
    .filter((n) => n.type === 'start')
    .map((n) => {
      const a = (n.pos.angleDeg * Math.PI) / 180;
      const r = MAX_RADIUS + 110;
      return [n.id, { x: Math.cos(a) * r, y: -Math.sin(a) * r }];
    }),
);

/** Spec branch name positions: outside the branch, along its mean direction. */
const SPEC_LABEL_POS: ReadonlyMap<string, Point> = new Map(
  Object.keys(TREE.specs).map((specId) => {
    const nodes = Object.values(TREE.nodes).filter((n) => n.specId === specId);
    let x = 0;
    let y = 0;
    for (const n of nodes) {
      const p = POS.get(n.id)!;
      const len = Math.hypot(p.x, p.y) || 1;
      x += p.x / len;
      y += p.y / len;
    }
    const len = Math.hypot(x, y) || 1;
    const r = Math.max(...nodes.map((n) => n.pos.radius)) + 50;
    return [specId, { x: (x / len) * r, y: (y / len) * r }];
  }),
);

/** Unit polygons, reused for every node (no per-draw allocation). */
function unitPolygon(sides: number, rotation: number): Point[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = rotation + (i / sides) * Math.PI * 2;
    return { x: Math.cos(a), y: Math.sin(a) };
  });
}
const OCTAGON = unitPolygon(8, Math.PI / 8);
const DIAMOND = unitPolygon(4, -Math.PI / 2);
const POLY_BUFFERS = new Map([OCTAGON, DIAMOND].map((u) => [u, u.map(() => new Phaser.Math.Vector2())]));

const isSpecType = (t: PassiveNodeType): boolean => t === 'spec' || t === 'specEntry' || t === 'specKeystone';

/** Currency the respec action would take, by running the core action on a copy with ample funds. */
const PROBE_FUNDS = 1e9;
function dryRun(hero: PassiveHero, action: (hero: PassiveHero, wallet: Record<string, number>) => RespecError | null): { cost: number; error: RespecError | null } {
  const currency = TREE.respec.currency;
  const wallet: Record<string, number> = { [currency]: PROBE_FUNDS };
  const trial: PassiveHero = { classId: hero.classId, level: hero.level, passives: cloneAllocation(hero.passives) };
  const error = action(trial, wallet);
  return { cost: error ? 0 : PROBE_FUNDS - (wallet[currency] ?? PROBE_FUNDS), error };
}

interface Touch {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

export class PassiveTreeScene extends Phaser.Scene {
  private app!: App;
  private characterId = '';
  private returnTo: 'main-menu' | 'inventory' = 'main-menu';
  private run: RunTreeHooks | undefined;

  // View: tree point at the viewport centre + zoom.
  private cx = 0;
  private cy = 0;
  private zoom = 1;
  private minZoom = 0.2;
  private view = { x: 0, y: 0, w: 0, h: 0 };
  private compact = false;
  /** Phone density (render/ui.ts uiMetrics): slimmer header, bottom bar and details panel. */
  private phone = false;
  private touchUi = false;

  // Core-derived state, refreshed after every change.
  private states = new Map<string, NodeState>();
  private errors = new Map<string, AllocateError | null>();
  private points: PassivePoints = { points: 0, specPoints: 0 };
  private ownStart = '';

  private hovered: string | undefined;
  private selected: string | undefined;
  private path: PassivePath | null = null;
  private pathSet: ReadonlySet<string> = EMPTY_PATH;
  private message = '';
  private messageTone: string = UI.muted;

  private backdrop: Phaser.GameObjects.Rectangle | undefined;
  private g!: Phaser.GameObjects.Graphics;
  private pulse!: Phaser.GameObjects.Graphics;
  private nodeLabels = new Map<string, Phaser.GameObjects.Text>();
  private specLabels = new Map<string, Phaser.GameObjects.Text>();
  private ui: Phaser.GameObjects.Container | undefined;
  private panel: Phaser.GameObjects.Container | undefined;
  private tooltip: Phaser.GameObjects.Container | undefined;
  private dirty = true;

  private touches = new Map<number, Touch>();
  private dragging = false;
  /** A multi-touch gesture happened since the first finger went down: the release is not a tap. */
  private gesture = false;
  private pinch: { dist: number; zoom: number; mx: number; my: number } | undefined;

  constructor() {
    super('passive-tree');
  }

  init(data: PassiveTreeSceneData): void {
    this.characterId = data.characterId;
    this.returnTo = data.returnTo ?? 'main-menu';
    this.run = data.run;
    this.hovered = undefined;
    this.selected = undefined;
    this.path = null;
    this.pathSet = EMPTY_PATH;
    this.message = '';
    this.touches.clear();
    this.dragging = false;
    this.gesture = false;
    this.pinch = undefined;
    this.nodeLabels.clear();
    this.specLabels.clear();
    this.ui = undefined;
    this.panel = undefined;
    this.tooltip = undefined;
    this.backdrop = undefined;
  }

  create(): void {
    this.app = getApp(this);
    const character = this.character;
    if (!character) {
      this.close();
      return;
    }
    this.ownStart = classStart(TREE, character.classId) ?? '';
    this.touchUi = this.sys.game.device.input.touch;
    if (this.run) {
      // Over a run: a nearly opaque veil, so the frozen fight still shows faintly behind.
      this.backdrop = this.add.rectangle(0, 0, 10, 10, UI.bg, 0.94).setOrigin(0).setDepth(-10);
    } else {
      this.cameras.main.setBackgroundColor(UI.bg);
    }
    this.g = this.add.graphics().setDepth(0);
    this.pulse = this.add.graphics().setDepth(1);
    this.tweens.add({ targets: this.pulse, alpha: 0.2, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.createLabels();

    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on('pointerupoutside', this.onPointerUp, this);
    this.input.on('wheel', this.onWheel, this);
    this.input.keyboard?.on('keydown-ESC', () => this.close());
    this.input.keyboard?.on('keydown-P', () => this.close());

    this.layout();
    this.fitView();
    this.refreshStates();
    this.buildUi();
    if (!this.run) fadeIn(this);

    const onResize = (): void => {
      this.layout();
      this.clampView();
      this.buildUi();
      this.buildPanel();
      this.hideTooltip();
    };
    this.scale.on('resize', onResize);
    this.events.once('shutdown', () => this.scale.off('resize', onResize));
  }

  override update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.redraw();
  }

  private get character(): CharacterRecord | undefined {
    return findCharacter(this.app.profile, this.characterId);
  }

  /** The hero as the passive rules see it. Over a run the level is the live one. */
  private hero(): PassiveHero {
    const c = this.character!;
    return this.run ? { classId: c.classId, level: this.run.level(), passives: c.passives } : c;
  }

  // ---- View -------------------------------------------------------------------------------------------

  private layout(): void {
    const { width, height } = this.scale;
    const metrics = uiMetrics(width, height);
    this.compact = metrics.compact;
    this.phone = metrics.phone;
    const headerH = this.phone ? metrics.headerH : this.compact ? 44 : 60;
    this.view = { x: 0, y: headerH, w: width, h: height - headerH };
    this.backdrop?.setSize(width, height);
    this.dirty = true;
  }

  /** Whole tree if it fits at a readable zoom (shifted towards the own start), else zoomed on the own class. */
  private fitView(): void {
    const { w, h } = this.view;
    const fit = Math.min(w, h) / (2 * EXTENT);
    const readable = this.touchUi ? READABLE_ZOOM.touch : READABLE_ZOOM.mouse;
    this.minZoom = Math.min(fit, readable) * 0.9;
    const start = POS.get(this.ownStart) ?? { x: 0, y: 0 };
    if (fit >= readable) {
      this.zoom = fit;
      const slackX = Math.max(0, w / 2 / fit - EXTENT);
      const slackY = Math.max(0, h / 2 / fit - EXTENT);
      this.cx = Phaser.Math.Clamp(start.x, -slackX, slackX);
      this.cy = Phaser.Math.Clamp(start.y, -slackY, slackY);
    } else {
      this.zoom = readable;
      const len = Math.hypot(start.x, start.y) || 1;
      this.cx = (start.x / len) * FOCUS_RADIUS;
      this.cy = (start.y / len) * FOCUS_RADIUS;
    }
    this.clampView();
  }

  private clampView(): void {
    this.zoom = Phaser.Math.Clamp(this.zoom, this.minZoom, MAX_ZOOM);
    this.cx = Phaser.Math.Clamp(this.cx, -EXTENT, EXTENT);
    this.cy = Phaser.Math.Clamp(this.cy, -EXTENT, EXTENT);
    this.dirty = true;
  }

  private sx(x: number): number {
    return this.view.x + this.view.w / 2 + (x - this.cx) * this.zoom;
  }

  private sy(y: number): number {
    return this.view.y + this.view.h / 2 + (y - this.cy) * this.zoom;
  }

  /** Screen radius: scales with zoom but never shrinks to a speck in the overview. */
  private radiusOf(node: PassiveNodeDef): number {
    const r = NODE_RADIUS[node.type];
    return Math.max(r * this.zoom, r * 0.3);
  }

  private panBy(dx: number, dy: number): void {
    this.cx -= dx / this.zoom;
    this.cy -= dy / this.zoom;
    this.clampView();
  }

  /** Zooms keeping the tree point under (sx, sy) fixed. */
  private zoomAt(sx: number, sy: number, zoom: number): void {
    const next = Phaser.Math.Clamp(zoom, this.minZoom, MAX_ZOOM);
    const ox = sx - (this.view.x + this.view.w / 2);
    const oy = sy - (this.view.y + this.view.h / 2);
    const tx = this.cx + ox / this.zoom;
    const ty = this.cy + oy / this.zoom;
    this.zoom = next;
    this.cx = tx - ox / next;
    this.cy = ty - oy / next;
    this.clampView();
    this.hideTooltip();
  }

  private nodeAt(px: number, py: number): string | undefined {
    if (py < this.view.y) return undefined;
    const minHit = this.touchUi ? 22 : 12;
    let best: string | undefined;
    let bestD = Infinity;
    for (const node of NODES) {
      const p = POS.get(node.id)!;
      const d = Math.hypot(this.sx(p.x) - px, this.sy(p.y) - py);
      const hit = Math.max(this.radiusOf(node) + 4, minHit);
      if (d <= hit && d < bestD) {
        best = node.id;
        bestD = d;
      }
    }
    return best;
  }

  // ---- Input ------------------------------------------------------------------------------------------

  private onPointerDown(pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]): void {
    if (over.length > 0 || pointer.y < this.view.y) return;
    this.touches.set(pointer.id, { x: pointer.x, y: pointer.y, startX: pointer.x, startY: pointer.y });
    this.hideTooltip();
    if (this.touches.size === 1) {
      this.dragging = false;
      this.gesture = false;
    } else {
      this.gesture = true;
      this.pinch = undefined;
    }
  }

  private onPointerMove(pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]): void {
    const t = this.touches.get(pointer.id);
    if (!t) {
      if (over.length > 0) this.clearHover();
      else if (!pointer.isDown && !pointer.wasTouch) this.updateHover(pointer);
      return;
    }
    const dx = pointer.x - t.x;
    const dy = pointer.y - t.y;
    t.x = pointer.x;
    t.y = pointer.y;
    if (this.touches.size >= 2) {
      this.updatePinch();
      return;
    }
    if (!this.dragging && Math.hypot(pointer.x - t.startX, pointer.y - t.startY) > DRAG_THRESHOLD) this.dragging = true;
    if (this.dragging) this.panBy(dx, dy);
  }

  private updatePinch(): void {
    const it = this.touches.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return;
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (!this.pinch) {
      this.pinch = { dist, zoom: this.zoom, mx, my };
      return;
    }
    this.panBy(mx - this.pinch.mx, my - this.pinch.my);
    this.pinch.mx = mx;
    this.pinch.my = my;
    this.zoomAt(mx, my, (this.pinch.zoom * dist) / this.pinch.dist);
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (!this.touches.delete(pointer.id)) return;
    this.pinch = undefined;
    if (this.touches.size > 0) return;
    const tap = !this.dragging && !this.gesture;
    this.dragging = false;
    if (tap) this.onTap(pointer);
  }

  private onWheel(pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[], _dx: number, dy: number): void {
    if (over.length > 0) return;
    this.zoomAt(pointer.x, pointer.y, this.zoom * Math.exp(-dy * WHEEL_ZOOM_SPEED));
  }

  private onTap(pointer: Phaser.Input.Pointer): void {
    const id = this.nodeAt(pointer.x, pointer.y);
    if (!id) {
      if (this.selected) this.select(undefined);
      return;
    }
    const state = this.states.get(id);
    if (pointer.button === 2) {
      if (state === 'allocated' && id !== this.ownStart) this.requestRefund(id);
      return;
    }
    // Mouse: hover already showed the tooltip, a click takes the node. Touch: first tap inspects, second takes.
    if (state === 'allocatable' && (!pointer.wasTouch || this.selected === id)) {
      this.tryAllocate(id);
      return;
    }
    this.select(id);
  }

  private updateHover(pointer: Phaser.Input.Pointer): void {
    const id = this.nodeAt(pointer.x, pointer.y);
    if (id !== this.hovered) {
      this.hovered = id;
      this.dirty = true;
      this.hideTooltip();
      if (id && id !== this.selected) this.showTooltip(id);
    }
    this.placeTooltip(pointer.x, pointer.y);
  }

  private clearHover(): void {
    if (this.hovered === undefined) return;
    this.hovered = undefined;
    this.dirty = true;
    this.hideTooltip();
  }

  // ---- Core state -------------------------------------------------------------------------------------

  private refreshStates(): void {
    const hero = this.hero();
    for (const node of NODES) {
      if (node.type === 'start') {
        this.states.set(node.id, node.id === this.ownStart ? 'allocated' : 'blocked');
        this.errors.set(node.id, 'start-node');
        continue;
      }
      if (isAllocated(hero.passives, node.id)) {
        this.states.set(node.id, 'allocated');
        this.errors.set(node.id, 'already-allocated');
        continue;
      }
      const error = canAllocate(TREE, hero, node.id);
      this.errors.set(node.id, error);
      this.states.set(
        node.id,
        error === null ? 'allocatable' : error === 'no-points' || error === 'no-spec-points' ? 'reachable' : error === 'not-connected' ? 'locked' : 'blocked',
      );
    }
    this.points = unspentPoints(TREE, hero);
    this.updatePath();
    this.dirty = true;
  }

  private updatePath(): void {
    const id = this.selected;
    const state = id ? this.states.get(id) : undefined;
    this.path = id && (state === 'locked' || state === 'reachable') ? findPath(TREE, this.hero(), id) : null;
    this.pathSet = this.path && this.path.nodes.length > 1 ? new Set(this.path.nodes) : EMPTY_PATH;
  }

  private persist(): void {
    if (this.run) this.run.changed();
    else this.app.save();
  }

  private afterChange(message: string): void {
    this.refreshStates();
    this.persist();
    this.setMessage(message, UI.goldBrightText);
    this.buildPanel();
  }

  private setMessage(text: string, tone: string = UI.danger): void {
    this.message = text;
    this.messageTone = tone;
    this.buildUi();
  }

  private tryAllocate(id: string): void {
    const error = allocate(TREE, this.hero(), id);
    if (error) {
      this.setMessage(allocateError(error));
      return;
    }
    const taken = TREE.nodes[id];
    this.afterChange(t('tree.taken', { name: taken ? passiveName(taken) : id }));
  }

  private tryPath(id: string): void {
    const count = this.path?.nodes.length ?? 0;
    const error = allocatePath(TREE, this.hero(), id);
    if (error) {
      this.setMessage(allocateError(error));
      return;
    }
    this.afterChange(t('tree.takenPath', { nodes: nodesWord(count) }));
  }

  private requestRefund(id: string): void {
    const hero = this.hero();
    const { cost, error } = dryRun(hero, (h, w) => refundNode(TREE, h, id, w));
    if (error) {
      this.setMessage(respecError(error));
      return;
    }
    const target = TREE.nodes[id];
    const name = target ? passiveName(target) : id;
    const run = (): void => {
      const e = refundNode(TREE, this.hero(), id, this.app.profile.currency);
      if (e) this.setMessage(respecError(e));
      else this.afterChange(t('tree.refunded', { name }));
    };
    if (cost === 0) run();
    else confirmDialog(this, t('tree.refundConfirm', { name, price: shardsWord(cost) }), t('tree.refund'), run);
  }

  private requestWheelReset(): void {
    const { cost, error } = dryRun(this.hero(), (h, w) => refundWheel(TREE, h, w));
    if (error) {
      this.setMessage(respecError(error), UI.muted);
      return;
    }
    confirmDialog(
      this,
      t('tree.wheelConfirm', { price: costLabel(cost) }),
      t('tree.reset'),
      () => {
        const e = refundWheel(TREE, this.hero(), this.app.profile.currency);
        if (e) this.setMessage(respecError(e));
        else this.afterChange(t('tree.wheelReset'));
      },
    );
  }

  private requestSpecChange(): void {
    const hero = this.hero();
    const { cost, error } = dryRun(hero, (h, w) => changeSpec(TREE, h, w));
    if (error) {
      this.setMessage(error === 'nothing-to-reset' ? t('tree.noSpec') : respecError(error), UI.muted);
      return;
    }
    const name = hero.passives.spec ? specName(hero.passives.spec) : '';
    confirmDialog(
      this,
      name ? t('tree.specConfirmNamed', { name, price: costLabel(cost) }) : t('tree.specConfirm', { price: costLabel(cost) }),
      t('tree.change'),
      () => {
        const e = changeSpec(TREE, this.hero(), this.app.profile.currency);
        if (e) this.setMessage(respecError(e));
        else this.afterChange(t('tree.specReset'));
      },
    );
  }

  private select(id: string | undefined): void {
    this.selected = id;
    this.updatePath();
    this.hideTooltip();
    this.buildPanel();
    this.dirty = true;
  }

  private close(): void {
    if (this.run) {
      const hooks = this.run;
      this.scene.stop();
      hooks.closed();
      return;
    }
    this.scene.start(this.returnTo, { characterId: this.characterId });
  }

  // ---- Drawing ----------------------------------------------------------------------------------------

  private createLabels(): void {
    for (const node of NODES) {
      if (node.type === 'small' || node.type === 'spec' || node.type === 'specEntry') continue;
      const start = node.type === 'start';
      const text = this.add
        .text(0, 0, passiveName(node), {
          fontFamily: start ? UI.headingFont : UI.bodyFont,
          fontStyle: 'bold',
          fontSize: start ? '24px' : '13px',
          color: UI.text,
          stroke: '#000',
          strokeThickness: start ? 4 : 3,
        })
        .setOrigin(0.5, start ? 0.5 : 0)
        .setDepth(2);
      this.nodeLabels.set(node.id, text);
    }
    for (const spec of Object.values(TREE.specs)) {
      const text = this.add
        .text(0, 0, specName(spec.id), { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '20px', color: UI.text, stroke: '#000', strokeThickness: 4 })
        .setOrigin(0.5)
        .setDepth(2);
      this.specLabels.set(spec.id, text);
    }
  }

  private isOwned(id: string): boolean {
    return id === this.ownStart || (this.states.get(id) === 'allocated' && TREE.nodes[id]?.type !== 'start');
  }

  private redraw(): void {
    const g = this.g.clear();
    const pulse = this.pulse.clear();
    const z = this.zoom;
    const hero = this.hero();
    const chosenSpec = hero.passives.spec;

    // Backdrop: faint rings of the wheel and spokes to the class starts.
    const ox = this.sx(0);
    const oy = this.sy(0);
    g.lineStyle(1, 0x2a2228, 0.8);
    for (const r of BACKDROP_RINGS) g.strokeCircle(ox, oy, r * z);
    for (const node of START_NODES) {
      const p = POS.get(node.id)!;
      const color = CLASS_COLORS[node.classId ?? ''] ?? 0x888888;
      g.fillStyle(color, node.id === this.ownStart ? 0.1 : 0.05).fillCircle(this.sx(p.x), this.sy(p.y), 150 * z);
    }

    // Chosen spec branch: a soft glow under its edges.
    if (chosenSpec) {
      g.lineStyle(Math.max(6, 18 * z), EMBER, 0.16);
      for (const [a, b] of TREE.edges) {
        const na = TREE.nodes[a];
        const nb = TREE.nodes[b];
        if (nb?.specId === chosenSpec || (na?.specId === chosenSpec && nb?.type !== 'start')) this.line(g, a, b);
      }
    }

    // Edges.
    for (const [a, b] of TREE.edges) {
      const sa = this.states.get(a);
      const sb = this.states.get(b);
      const ownA = this.isOwned(a);
      const ownB = this.isOwned(b);
      if (ownA && ownB) g.lineStyle(4, GOLD_LINE, 1);
      else if ((ownA && sb === 'allocatable') || (ownB && sa === 'allocatable')) g.lineStyle(3, 0xb07a30, 0.95);
      else if (sa === 'blocked' || sb === 'blocked') g.lineStyle(2, 0x2a2430, 0.45);
      else g.lineStyle(2, 0x3d3540, 0.95);
      this.line(g, a, b);
    }

    // Path preview.
    const pathSet = this.pathSet;
    if (pathSet.size > 0) {
      g.lineStyle(3, EMBER, 0.95);
      for (const id of pathSet) for (const n of neighbors(TREE, id)) if (pathSet.has(n) || this.isOwned(n)) this.line(g, id, n);
    }

    // Nodes.
    for (const node of NODES) {
      const p = POS.get(node.id)!;
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      const r = this.radiusOf(node);
      const state = this.states.get(node.id) ?? 'locked';
      if (node.type === 'start') this.drawStart(g, node, x, y, r);
      else this.drawNode(g, node, x, y, r, state);
      // Halo gap scales with zoom: a fixed 5 px ring swallows short edges (e.g. inner ring to keystone) in the overview.
      if (state === 'allocatable') pulse.lineStyle(3, EMBER, 1).strokeCircle(x, y, r + Math.min(5, Math.max(2.5, 5 * z)));
      if (pathSet.has(node.id)) g.lineStyle(2, EMBER, 1).strokeCircle(x, y, r + 4);
      if (node.id === this.selected || node.id === this.hovered) g.lineStyle(2, 0xfff6d8, 1).strokeCircle(x, y, r + (node.id === this.selected ? 7 : 5));
    }

    // Labels.
    const showNames = z >= LABEL_ZOOM;
    for (const [id, text] of this.nodeLabels) {
      const node = TREE.nodes[id]!;
      const p = POS.get(id)!;
      const state = this.states.get(id);
      const visible = node.type === 'start' || (node.type === 'keystone' ? z >= KEYSTONE_LABEL_ZOOM : showNames);
      text.setVisible(visible);
      if (!visible) continue;
      if (node.type === 'start') {
        const own = id === this.ownStart;
        const c = CLASS_LABEL_POS.get(id)!;
        text.setPosition(this.sx(c.x), this.sy(c.y)).setFontSize(this.compact ? 18 : 24);
        text.setColor(own ? UI.goldBrightText : UI.muted).setAlpha(own ? 1 : 0.6);
        continue;
      }
      text.setPosition(this.sx(p.x), this.sy(p.y) + this.radiusOf(node) + 3);
      text.setColor(state === 'allocated' ? UI.goldBrightText : node.type === 'keystone' || node.type === 'specKeystone' ? '#ffb070' : UI.text);
      text.setAlpha(state === 'blocked' ? 0.45 : 1);
    }
    for (const [specId, text] of this.specLabels) {
      const spec = TREE.specs[specId]!;
      const name = specName(specId);
      const p = SPEC_LABEL_POS.get(specId)!;
      const own = spec.classId === hero.classId;
      text.setPosition(this.sx(p.x), this.sy(p.y)).setFontSize(this.compact ? 16 : 20);
      if (!own) text.setText(name).setColor(UI.muted).setAlpha(0.45);
      else if (chosenSpec === specId) text.setText(`${name} ✓`).setColor(UI.goldBrightText).setAlpha(1);
      // The other branch of the own class: dimmed like its nodes; the tooltip says why.
      else if (chosenSpec) text.setText(name).setColor(UI.muted).setAlpha(0.55);
      else text.setText(name).setColor(UI.text).setAlpha(1);
    }
  }

  private line(g: Phaser.GameObjects.Graphics, a: string, b: string): void {
    const pa = POS.get(a);
    const pb = POS.get(b);
    if (pa && pb) g.lineBetween(this.sx(pa.x), this.sy(pa.y), this.sx(pb.x), this.sy(pb.y));
  }

  private polygon(g: Phaser.GameObjects.Graphics, unit: Point[], x: number, y: number, r: number, fill: boolean): void {
    const pts = POLY_BUFFERS.get(unit)!;
    unit.forEach((u, i) => pts[i]!.set(x + u.x * r, y + u.y * r));
    if (fill) g.fillPoints(pts, true);
    else g.strokePoints(pts, true);
  }

  private drawStart(g: Phaser.GameObjects.Graphics, node: PassiveNodeDef, x: number, y: number, r: number): void {
    const own = node.id === this.ownStart;
    const color = CLASS_COLORS[node.classId ?? ''] ?? 0x888888;
    g.fillStyle(0x000000, 0.6).fillCircle(x, y, r + 3);
    g.fillStyle(color, own ? 1 : 0.35).fillCircle(x, y, r);
    g.lineStyle(3, own ? 0xf3d58a : 0x5a4e44, own ? 1 : 0.6).strokeCircle(x, y, r);
    g.fillStyle(0x120d0a, own ? 0.85 : 0.5);
    this.polygon(g, DIAMOND, x, y, r * 0.45, true);
  }

  private drawNode(g: Phaser.GameObjects.Graphics, node: PassiveNodeDef, x: number, y: number, r: number, state: NodeState): void {
    const look = LOOK[state];
    let rim = look.rim;
    // Locked branches of the own class keep a hint of the class colour.
    let rimAlpha = 1;
    if (isSpecType(node.type) && (state === 'locked' || state === 'reachable')) {
      rim = CLASS_COLORS[TREE.specs[node.specId ?? '']?.classId ?? ''] ?? rim;
      rimAlpha = 0.6;
    }
    const a = look.alpha;
    const lw = node.type === 'small' || node.type === 'spec' ? 2 : 3;
    if (node.type === 'keystone') {
      g.fillStyle(look.fill, a);
      this.polygon(g, OCTAGON, x, y, r, true);
      g.lineStyle(lw, rim, a * rimAlpha);
      this.polygon(g, OCTAGON, x, y, r, false);
      g.lineStyle(1.5, rim, a * 0.7);
      this.polygon(g, OCTAGON, x, y, r * 0.7, false);
    } else if (isSpecType(node.type)) {
      const rr = r * 1.15;
      g.fillStyle(look.fill, a);
      this.polygon(g, DIAMOND, x, y, rr, true);
      g.lineStyle(lw, rim, a * rimAlpha);
      this.polygon(g, DIAMOND, x, y, rr, false);
      if (node.type === 'specKeystone') {
        g.lineStyle(1.5, rim, a * 0.8);
        this.polygon(g, DIAMOND, x, y, rr * 0.62, false);
      }
    } else {
      g.fillStyle(look.fill, a).fillCircle(x, y, r);
      g.lineStyle(lw, rim, a).strokeCircle(x, y, r);
      if (node.type === 'notable') g.lineStyle(1.5, rim, a * 0.75).strokeCircle(x, y, r + Math.max(2, 4 * this.zoom));
    }
    if (state === 'allocated') g.fillStyle(0xfff6d8, 0.35).fillCircle(x - r * 0.25, y - r * 0.3, r * 0.3);
  }

  // ---- UI ---------------------------------------------------------------------------------------------

  private buildUi(): void {
    this.ui?.destroy();
    const ui = this.add.container(0, 0).setDepth(100);
    this.ui = ui;
    const character = this.character;
    if (!character) return;
    const { width, height } = this.scale;
    const compact = this.compact;
    const m = compact ? 8 : 16;
    const headerH = this.view.y;

    // Header: blocks taps, shows points and shards.
    ui.add(this.add.rectangle(0, 0, width, headerH, 0x0e0b10, 0.97).setOrigin(0).setInteractive());
    ui.add(this.add.rectangle(0, headerH - 2, width, 2, 0x9a6a22, 1).setOrigin(0));
    const phone = this.phone;
    const title = heading(this, m + 4, phone ? 7 : compact ? 6 : 10, t('tree.title'), phone ? 20 : compact ? 24 : 32);
    ui.add(title);
    const level = this.hero().level;
    if (width >= 900) ui.add(label(this, title.x + title.width + 14, headerH / 2, t('tree.heroLine', { name: character.name, level }), UI.size.small, UI.muted).setOrigin(0, 0.5));

    const closeW = phone ? 40 : compact ? 44 : this.run ? 150 : 120;
    const closeText = compact ? '✕' : this.run ? t('tree.closeRun') : t('common.back');
    ui.add(makeButton(this, width - m - closeW / 2, headerH / 2, closeW, phone ? 30 : compact ? 34 : 42, closeText, () => this.close()));

    const shards = this.app.profile.currency[TREE.respec.currency] ?? 0;
    const { points, specPoints } = this.points;
    const stats = [
      { text: t('tree.points', { count: points }), color: points > 0 ? UI.goldBrightText : UI.muted },
      { text: t('tree.specPoints', { count: specPoints }), color: specPoints > 0 ? UI.goldBrightText : UI.muted },
      { text: `◆ ${shards}`, color: UI.text },
    ];
    let right = width - m - closeW - (compact ? 10 : 20);
    for (let i = stats.length - 1; i >= 0; i--) {
      const s = stats[i]!;
      const t = label(this, right, headerH / 2, s.text, compact ? UI.size.small : UI.size.body, s.color, true).setOrigin(1, 0.5);
      ui.add(t);
      right -= t.width + (compact ? 14 : 24);
    }

    // Bottom left: respec actions with their current price.
    const hero = this.hero();
    const bh = phone ? 32 : compact ? 36 : 44;
    const by = height - (phone ? 6 : m) - bh / 2;
    const wheel = dryRun(hero, (h, w) => refundWheel(TREE, h, w));
    const spec = dryRun(hero, (h, w) => changeSpec(TREE, h, w));
    const price = (r: { cost: number; error: RespecError | null }): string => (r.error ? '' : r.cost > 0 ? ` · ${r.cost} ◆` : compact ? ' · 0 ◆' : ` · ${t('common.free')}`);
    const wheelText = t('tree.resetWheel', { price: price(wheel) });
    const specText = t(compact ? 'tree.changeSpecShort' : 'tree.changeSpec', { price: price(spec) });
    const bw1 = phone ? 150 : compact ? 170 : 220;
    const bw2 = phone ? 160 : compact ? 180 : 280;
    const resetBtn = makeButton(this, m + bw1 / 2, by, bw1, bh, wheelText, () => this.requestWheelReset());
    const specBtn = makeButton(this, m + bw1 + 8 + bw2 / 2, by, bw2, bh, specText, () => this.requestSpecChange());
    if (wheel.error) resetBtn.setAlpha(0.5);
    if (spec.error) specBtn.setAlpha(0.5);
    ui.add([resetBtn, specBtn]);

    // Bottom right: zoom controls (also the only zoom on touch screens without pinch).
    const zs = phone ? 32 : compact ? 36 : 42;
    const zoomButtons: Array<[string, number, () => void]> = [
      ['−', phone ? 36 : compact ? 36 : 42, () => this.zoomAt(this.view.x + this.view.w / 2, this.view.y + this.view.h / 2, this.zoom / 1.3)],
      ['+', phone ? 36 : compact ? 36 : 42, () => this.zoomAt(this.view.x + this.view.w / 2, this.view.y + this.view.h / 2, this.zoom * 1.3)],
      [t('tree.overview'), phone ? 64 : compact ? 70 : 90, () => this.fitView()],
    ];
    let zx = width - m;
    for (let i = zoomButtons.length - 1; i >= 0; i--) {
      const [text, w, fn] = zoomButtons[i]!;
      ui.add(makeButton(this, zx - w / 2, by, w, zs, text, fn));
      zx -= w + (phone ? 8 : 6);
    }

    // Message line above the bottom buttons; a hint when nothing happened yet.
    const hint = this.touchUi ? t('tree.hintTouch') : t('tree.hintMouse');
    const msg = this.message || hint;
    const msgText = label(this, m + 4, by - bh / 2 - (phone ? 6 : 8), msg, compact && !phone ? 13 : UI.size.small, this.message ? this.messageTone : UI.muted, !!this.message).setOrigin(0, 1);
    msgText.setStroke('#000', 3);
    ui.add(msgText);
  }

  private hideTooltip(): void {
    this.tooltip?.destroy();
    this.tooltip = undefined;
  }

  private placeTooltip(px: number, py: number): void {
    const t = this.tooltip;
    if (!t) return;
    const { width, height } = this.scale;
    const w = t.getData('w') as number;
    const h = t.getData('h') as number;
    let x = px + 18;
    let y = py + 18;
    if (x + w > width - 4) x = px - w - 12;
    if (y + h > height - 4) y = Math.max(this.view.y + 4, height - h - 4);
    t.setPosition(Math.max(4, x), y);
  }

  /** Name, type and cost, effect lines, availability; built for the hover tooltip and the details panel. */
  private nodeInfo(id: string, width: number, parent: Phaser.GameObjects.Container, x: number, y0: number, withHints: boolean): number {
    const node = TREE.nodes[id]!;
    const hero = this.hero();
    let y = y0;
    const add = (text: string, size: number, color: string, bold = false, gap = 2): void => {
      const t = label(this, x, y, text, size, color, bold).setWordWrapWidth(width);
      parent.add(t);
      y += t.height + gap;
    };
    const nameColor = node.type === 'keystone' || node.type === 'specKeystone' ? '#ffb070' : node.type === 'notable' || node.type === 'start' ? UI.goldBrightText : UI.text;
    add(passiveName(node), this.phone ? 16 : UI.size.heading - 2, nameColor, true, 2);
    if (node.type === 'start') {
      add(nodeTypeLabel('start'), 12, UI.muted, false, 8);
      add(id === this.ownStart ? t('tree.ownStart') : t('tree.otherStart'), UI.size.small, UI.muted);
      return y;
    }
    const spec = node.specId ? TREE.specs[node.specId] : undefined;
    const cost = t(spec ? 'banner.specPoints' : 'banner.talentPoints', { count: node.cost });
    add(t('tree.typeCost', { type: nodeTypeLabel(node.type), cost }), 12, UI.muted, false, spec ? 2 : 8);
    if (spec) add(t('tree.branch', { name: specName(spec.id) }), 12, UI.muted, false, 8);
    for (const line of describeNode(node, classes[hero.classId]?.resource.id)) add(line, UI.size.small, '#8fb3ff', false, 3);
    if (hasPendingMechanics(node)) add(pendingEffect(), 12, '#c9a46a', true, 3);
    y += 6;

    const state = this.states.get(id);
    const error = this.errors.get(id) ?? null;
    if (state === 'allocated') {
      add(t('tree.allocated'), UI.size.small, UI.goldBrightText, true);
      const blocked = canDeallocate(TREE, hero, id);
      if (blocked) add(respecError(blocked), 12, UI.muted);
      else if (withHints) {
        // The panel shows the price on its button instead.
        const { cost: refund } = dryRun(hero, (h, w) => refundNode(TREE, h, id, w));
        add(t(withHints && !this.touchUi ? 'tree.refundPriceRmb' : 'tree.refundPrice', { price: costLabel(refund) }), 12, UI.muted);
      }
    } else if (state === 'allocatable') {
      add(withHints && !this.touchUi ? t('tree.canTakeLmb') : t('tree.canTake'), UI.size.small, '#9fd67a', true);
    } else if (error) {
      add(this.reason(error, node), UI.size.small, UI.danger, false);
    }
    const path = id === this.selected ? this.path : state === 'locked' || state === 'reachable' ? findPath(TREE, hero, id) : null;
    if (path && path.nodes.length > 1) {
      const enough = path.cost <= (spec ? this.points.specPoints : this.points.points);
      add(t('tree.path', { nodes: nodesWord(path.nodes.length), points: pointsWord(path.cost) }), UI.size.small, enough ? UI.goldBrightText : UI.muted, true);
      if (withHints && !this.touchUi) add(t('tree.showPath'), 12, UI.muted);
    }
    return y;
  }

  private reason(error: AllocateError, node: PassiveNodeDef): string {
    if (error === 'no-spec-points') {
      const level = this.hero().level;
      const next = nextSpecMilestone(TREE, level);
      return next !== undefined ? t('tree.nextSpecPoint', { error: allocateError(error), level: next }) : allocateError(error);
    }
    if (error === 'exclusive') {
      const passives = this.hero().passives;
      const other = [...passives.nodes, ...passives.specNodes].map((id) => TREE.nodes[id]).find((n) => n && n.exclusiveGroup === node.exclusiveGroup);
      if (other) return t('tree.incompatible', { name: passiveName(other) });
    }
    return allocateError(error);
  }

  private showTooltip(id: string): void {
    const w = this.compact ? 240 : 300;
    const pad = 12;
    const t = this.add.container(0, 0).setDepth(300);
    const bg = this.add.graphics();
    t.add(bg);
    const bottom = this.nodeInfo(id, w - pad * 2, t, pad, pad, true);
    const h = bottom + pad - 4;
    bg.fillStyle(0x0e0b10, 0.96).fillRoundedRect(0, 0, w, h, 6);
    bg.lineStyle(2, 0x9a6a22, 1).strokeRoundedRect(0, 0, w, h, 6);
    t.setData('w', w).setData('h', h);
    this.tooltip = t;
  }

  /** Docked details panel for the selected node, with its actions. */
  private buildPanel(): void {
    this.panel?.destroy();
    this.panel = undefined;
    const id = this.selected;
    const node = id ? TREE.nodes[id] : undefined;
    if (!id || !node) return;
    const { width, height } = this.scale;
    const compact = this.compact;
    const m = compact ? 8 : 16;
    const w = Math.min(this.phone ? 250 : compact ? 270 : 330, width * 0.45);
    const pad = this.phone ? 12 : 16;
    const left = width - m - w;
    const top = this.view.y + m;
    const panel = this.add.container(0, 0).setDepth(200);
    this.panel = panel;
    const content = this.add.container(0, 0);
    let y = this.nodeInfo(id, w - pad * 2 - 30, content, left + pad, top + pad, false) + 6;

    // Actions.
    const state = this.states.get(id);
    const bh = this.phone ? 36 : compact ? 38 : 44;
    const bw = w - pad * 2;
    const cxBtn = left + w / 2;
    const buttons: Phaser.GameObjects.Container[] = [];
    if (state === 'allocatable') {
      buttons.push(makeButton(this, cxBtn, 0, bw, bh, t('tree.take'), () => this.tryAllocate(id), 'primary'));
    } else if (state === 'allocated' && node.type !== 'start' && !canDeallocate(TREE, this.hero(), id)) {
      const { cost } = dryRun(this.hero(), (h, wl) => refundNode(TREE, h, id, wl));
      buttons.push(makeButton(this, cxBtn, 0, bw, bh, t('tree.refundButton', { price: costLabel(cost) }), () => this.requestRefund(id), 'danger'));
    } else if (this.path && this.path.nodes.length > 1) {
      buttons.push(makeButton(this, cxBtn, 0, bw, bh, t('tree.takePath', { points: pointsWord(this.path.cost) }), () => this.tryPath(id), 'primary'));
    }
    for (const b of buttons) {
      b.setY(y + bh / 2);
      y += bh + 8;
    }

    const maxH = height - top - m - (this.phone ? 38 : compact ? 44 : 56);
    const h = Math.min(maxH, Math.ceil((y - top + pad - 8) / 10) * 10);
    // Panel frame swallows taps so they do not reach the tree underneath.
    const frame = makeFrame(this, left + w / 2, top + h / 2, w, h, 'panel');
    const blocker = this.add.rectangle(left, top, w, h, 0x000000, 0.001).setOrigin(0).setInteractive();
    const closeBtn = makeButton(this, left + w - 22, top + 22, 30, 30, '✕', () => this.select(undefined));
    panel.add([frame, blocker, content, ...buttons, closeBtn]);
  }
}

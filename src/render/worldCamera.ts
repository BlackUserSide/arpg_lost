import * as Phaser from 'phaser';

// Zoomed run view (phones: data/controls phoneLayout.runZoom). Phaser zooms every object a camera draws, screen-pinned
// ones included, so a zoomed main camera would shrink the HUD too. With a zoom other than 1 the scene gets a second,
// unzoomed camera for the HUD: every frame before rendering, objects pinned to the screen (scroll factor 0) are drawn
// by the HUD camera only and everything else by the world camera only. Input follows (Phaser hit-tests an object only
// with a camera that renders it). Screen-pinned world overlays (a tint over the room, under the HUD) opt out with
// keepInWorldCamera and size themselves with worldOverlayRect.

const worldLayer = new WeakSet<Phaser.GameObjects.GameObject>();

/** A screen-pinned object that still belongs to the world camera (drawn among world objects, zoomed with them). */
export function keepInWorldCamera<T extends Phaser.GameObjects.GameObject>(obj: T): T {
  worldLayer.add(obj);
  return obj;
}

/**
 * Rectangle (top-left and size, in the object's own coordinates) a screen-pinned world-camera object must cover to
 * fill the screen under `zoom`: Phaser scales pinned objects about the screen centre.
 */
export function worldOverlayRect(width: number, height: number, zoom: number): { x: number; y: number; w: number; h: number } {
  const w = width / zoom;
  const h = height / zoom;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

export class ZoomedWorldView {
  private hudCamera: Phaser.Cameras.Scene2D.Camera | undefined;
  private zoom = 1;

  constructor(private readonly scene: Phaser.Scene) {
    scene.events.on(Phaser.Scenes.Events.PRE_RENDER, this.assign, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.PRE_RENDER, this.assign, this);
      this.hudCamera = undefined;
    });
  }

  /** World zoom of the main camera now. */
  get value(): number {
    return this.zoom;
  }

  /** Sets the world zoom for a screen size (call on create and resize). */
  set(zoom: number, width: number, height: number): void {
    const cams = this.scene.cameras;
    this.zoom = zoom;
    cams.main.setZoom(zoom);
    if (zoom === 1) {
      if (this.hudCamera) {
        cams.remove(this.hudCamera);
        this.hudCamera = undefined;
        for (const o of this.scene.children.list) o.cameraFilter = 0;
      }
      return;
    }
    if (!this.hudCamera) this.hudCamera = cams.add(0, 0, width, height, false, 'hud');
    else this.hudCamera.setSize(width, height);
    this.assign();
  }

  private assign(): void {
    const hud = this.hudCamera;
    if (!hud) return;
    const worldId = this.scene.cameras.main.id;
    for (const o of this.scene.children.list) {
      const pinned = (o as unknown as Phaser.GameObjects.Components.ScrollFactor).scrollFactorX === 0 && !worldLayer.has(o);
      o.cameraFilter = pinned ? worldId : hud.id;
    }
  }
}

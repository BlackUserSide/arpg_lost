import * as Phaser from 'phaser';
import { t } from '../i18n';
import { lockLandscape, unlockOrientation } from './orientationGate';
import { label, makeButton, showToast, UI } from './ui';

// Full-screen toggle (phones lose a lot of height to the browser bars). The Fullscreen API needs a user gesture: the
// UI kit's buttons fire on pointerup, which Phaser handles inside the DOM event, so the request is allowed there.
// The target is the page shell (index.html #shell, scale config fullscreenTarget), so everything drawn on the canvas
// and the DOM name input stay inside. The run's touch controls are drawn by Phaser on the same canvas.
// iPhone Safari has no element full screen (Phaser reports it unavailable): the button is hidden and the home-screen
// web app (public/manifest.webmanifest) is the way to lose the bars there. Inside an iframe without the permission
// (allowfullscreen) document.fullscreenEnabled is false: hidden too.

/** How long (ms) a prefixed, promise-less request may take to enter full screen before its listener is dropped. */
const PREFIXED_ENTER_WAIT = 3000;

interface PrefixedDocument {
  readonly webkitFullscreenEnabled?: boolean;
}

/** Element full screen can be requested here (API present and allowed in this frame). */
export function fullscreenAvailable(scene: Phaser.Scene): boolean {
  if (!scene.scale.fullscreen.available || typeof document === 'undefined') return false;
  const doc = document as Document & PrefixedDocument;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled;
  return enabled !== false;
}

/** Enters or leaves full screen. Must run inside a user gesture handler (pointerup of a UI kit button). */
export function toggleFullscreen(scene: Phaser.Scene): void {
  const scale = scene.scale;
  if (scale.isFullscreen) {
    unlockOrientation();
    scale.stopFullscreen();
    return;
  }
  // The request is made here rather than via scale.startFullscreen() so a refusal (iframe policy, browser setting)
  // is caught instead of surfacing as an unhandled promise rejection. Phaser's fullscreenchange listeners still
  // resize the game and emit ENTER_FULLSCREEN / LEAVE_FULLSCREEN.
  const fs = scale.fullscreen;
  const target = scale.getFullscreenTarget() as HTMLElement & Record<string, unknown>;
  const request = target[fs.request];
  if (typeof request !== 'function') {
    showToast(scene, t('menu.fullscreenFailed'));
    return;
  }
  let result: unknown;
  try {
    result = fs.request === 'requestFullscreen' ? request.call(target, { navigationUI: 'hide' }) : request.call(target);
  } catch {
    showToast(scene, t('menu.fullscreenFailed'));
    return;
  }
  // Android phones: in full screen the orientation can be locked to landscape (render/orientationGate.ts). Silent
  // where it cannot (iOS has no element full screen at all; tablets and desktops are not locked).
  const game = scene.game;
  if (result instanceof Promise) {
    result.then(
      () => lockLandscape(game),
      () => {
        if (scene.scene.isActive()) showToast(scene, t('menu.fullscreenFailed'));
      },
    );
  } else {
    // Prefixed APIs without a promise: the switch is not done yet, lock once the browser reports it. A refused request
    // reports nothing Phaser forwards (it only drops its target on fullscreenerror), so the listener is dropped after
    // a while: a later full screen entered some other way must not lock the orientation.
    const onEnter = (): void => {
      window.clearTimeout(timer);
      lockLandscape(game);
    };
    const timer = window.setTimeout(() => scale.off(Phaser.Scale.Events.ENTER_FULLSCREEN, onEnter), PREFIXED_ENTER_WAIT);
    scale.once(Phaser.Scale.Events.ENTER_FULLSCREEN, onEnter);
  }
}

/** Game object name of the toggle (tests and debugging find it by name). */
export const FULLSCREEN_BUTTON = 'fullscreen-button';
const ICON_COLOR = 0xf3d58a;
const ICON_HOVER = 0xfff0c0;

/** Four corner brackets: pointing out (enter full screen) or in (leave it). */
function drawIcon(g: Phaser.GameObjects.Graphics, size: number, active: boolean, color: number): void {
  g.clear();
  const half = size * 0.3;
  const arm = size * 0.16;
  g.lineStyle(Math.max(2, size * 0.075), color, 1);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      // Corner point of the bracket; for "leave" it sits nearer the centre and the arms point outwards.
      const cx = active ? sx * (half - arm) : sx * half;
      const cy = active ? sy * (half - arm) : sy * half;
      const dir = active ? 1 : -1;
      g.beginPath();
      g.moveTo(cx, cy + sy * arm * dir);
      g.lineTo(cx, cy);
      g.lineTo(cx + sx * arm * dir, cy);
      g.strokePath();
    }
  }
}

export interface FullscreenButtonOptions {
  /** Hover caption below (true) or above (false) the button: desktop only, touch has no hover. */
  readonly tipBelow?: boolean;
}

/**
 * Square icon button that toggles full screen; undefined where full screen is unavailable (the caller skips it).
 * The icon follows the real state (entered / left with Esc, the back gesture or the browser's own controls).
 */
export function makeFullscreenButton(scene: Phaser.Scene, x: number, y: number, size: number, options: FullscreenButtonOptions = {}): Phaser.GameObjects.Container | undefined {
  if (!fullscreenAvailable(scene)) return undefined;
  const button = makeButton(scene, x, y, size, size, '', () => toggleFullscreen(scene)).setName(FULLSCREEN_BUTTON);
  const icon = scene.add.graphics();
  button.add(icon);
  const bg = button.list[0] as Phaser.GameObjects.Image;
  const tipText = (): string => (scene.scale.isFullscreen ? t('menu.exitFullscreen') : t('menu.fullscreen'));
  const tipY = options.tipBelow === false ? -size / 2 - 6 : size / 2 + 6;
  const tip = label(scene, 0, tipY, tipText(), UI.size.small, UI.text).setOrigin(0.5, options.tipBelow === false ? 1 : 0);
  tip.setStroke('#0a090c', 4).setVisible(false);
  button.add(tip);
  let hover = false;
  const redraw = (): void => {
    drawIcon(icon, size, scene.scale.isFullscreen, hover ? ICON_HOVER : ICON_COLOR);
    tip.setText(tipText());
  };
  bg.on('pointerover', (pointer: Phaser.Input.Pointer) => {
    hover = true;
    // Mouse only: a touch "hover" would leave the caption stuck after the tap.
    tip.setVisible(!pointer.wasTouch);
    redraw();
  });
  bg.on('pointerout', () => {
    hover = false;
    tip.setVisible(false);
    redraw();
  });
  redraw();
  const onChange = (): void => {
    tip.setVisible(false);
    redraw();
  };
  scene.scale.on(Phaser.Scale.Events.ENTER_FULLSCREEN, onChange);
  scene.scale.on(Phaser.Scale.Events.LEAVE_FULLSCREEN, onChange);
  button.once(Phaser.GameObjects.Events.DESTROY, () => {
    scene.scale.off(Phaser.Scale.Events.ENTER_FULLSCREEN, onChange);
    scene.scale.off(Phaser.Scale.Events.LEAVE_FULLSCREEN, onChange);
  });
  return button;
}

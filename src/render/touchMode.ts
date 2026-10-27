import type * as Phaser from 'phaser';
import { phoneLayout } from '../data/controls';

// Which controls the run shows (docs/design/controls.md): the touch layout (stick + buttons) on phones and tablets,
// the keyboard + mouse one on desktops. `?touch=1` forces the touch layout (desktop testing), `?touch=0` the desktop one.

let forced: boolean | undefined | null = null;

function urlOverride(): boolean | undefined {
  if (forced !== null) return forced;
  let value: string | null = null;
  try {
    value = new URLSearchParams(window.location.search).get('touch');
  } catch {
    value = null;
  }
  forced = value === '1' || value === 'true' ? true : value === '0' || value === 'false' ? false : undefined;
  return forced;
}

/** The run uses the touch controls (also: key hints are hidden and captions do not name keys). */
export function touchControlsOn(game: Phaser.Game): boolean {
  const override = urlOverride();
  if (override !== undefined) return override;
  return touchDevice(game);
}

/** A phone or tablet by the device itself (the `?touch=` override is ignored). */
export function touchDevice(game: Phaser.Game): boolean {
  const os = game.device.os;
  if (!os.desktop) return true;
  // iPadOS Safari reports a Mac by default; a Mac with a multi-touch screen is an iPad.
  return os.macOS && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
}

/**
 * A phone: a touch device whose screen's shorter side is at most data/controls phoneLayout.maxShortSide. Reads the
 * device screen, not the window, so it holds inside the portal iframe and does not flip when the device rotates
 * (iOS keeps screen.width / height in portrait terms, Android swaps them: the shorter side is the same either way).
 * Phones play in landscape only (render/orientationGate.ts); tablets and desktops are unaffected.
 */
export function isPhone(game: Phaser.Game): boolean {
  if (typeof screen === 'undefined' || !touchDevice(game)) return false;
  return Math.min(screen.width, screen.height) <= phoneLayout.maxShortSide;
}

export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

let probe: HTMLDivElement | undefined;

/**
 * The device's safe area insets in CSS px (notch, home indicator), read from env(safe-area-inset-*), minus what the
 * page layout already keeps clear around `canvas`: index.html insets the game container by the same env() values, so
 * with `canvas` given this is normally zero (also inside the portal iframe, where env() is zero). Kept so the HUD
 * stays safe if the page ever lets the canvas reach under the notch again.
 */
export function safeInsets(canvas?: Element): SafeInsets {
  if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
      'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
    document.body.appendChild(probe);
  }
  const s = getComputedStyle(probe);
  const px = (v: string): number => parseFloat(v) || 0;
  const env = { top: px(s.paddingTop), right: px(s.paddingRight), bottom: px(s.paddingBottom), left: px(s.paddingLeft) };
  if (!canvas) return env;
  const r = canvas.getBoundingClientRect();
  return {
    top: Math.max(0, env.top - r.top),
    right: Math.max(0, env.right - (window.innerWidth - r.right)),
    bottom: Math.max(0, env.bottom - (window.innerHeight - r.bottom)),
    left: Math.max(0, env.left - r.left),
  };
}

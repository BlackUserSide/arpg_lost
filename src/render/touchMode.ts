import type * as Phaser from 'phaser';

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
  const os = game.device.os;
  if (!os.desktop) return true;
  // iPadOS Safari reports a Mac by default; a Mac with a multi-touch screen is an iPad.
  return os.macOS && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
}

export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

let probe: HTMLDivElement | undefined;

/**
 * The device's safe area insets in CSS px (notch, home indicator), read from env(safe-area-inset-*). Zero where the
 * browser keeps the page inside the safe area itself (no viewport-fit=cover, or inside the portal iframe).
 */
export function safeInsets(): SafeInsets {
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
  return { top: px(s.paddingTop), right: px(s.paddingRight), bottom: px(s.paddingBottom), left: px(s.paddingLeft) };
}

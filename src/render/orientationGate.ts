import type * as Phaser from 'phaser';
import { onLocaleChange, t } from '../i18n';
import { BODY_FONT } from './fonts';
import { isPhone } from './touchMode';

// Phones play in landscape only (designer decision 2026-10-27); tablets and desktops in any orientation.
// The web cannot lock the orientation on iOS (Safari, Chrome) at all, and on Android only in full screen or an
// installed web app, so a phone held upright gets a full-screen "turn your phone" cover instead. It is a DOM element
// inside the page shell (index.html #shell, the full-screen target): it covers every scene and the DOM name input
// alike, and it takes every touch, so nothing underneath gets input. A running run pauses (RunScene listens to
// ORIENTATION_BLOCKED) and stays on its pause menu after the turn back. Android: lockLandscape() is tried where the
// browser allows it (entering full screen, the installed web app).

/** Game event (game.events) with one boolean argument: the portrait cover was shown (true) or removed (false). */
export const ORIENTATION_BLOCKED = 'orientation-blocked';

const GATE_ID = 'rotate-gate';
const ACCENT = '#f3d58a';

let blocked = false;

/** The portrait cover is up (a phone held upright): game input is blocked, a run must not play. */
export function orientationBlocked(): boolean {
  return blocked;
}

interface OrientationLock {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

/** Android Chrome: lock to landscape on a phone. Silent no-op where not allowed (iOS, not full screen, desktops). */
export function lockLandscape(game: Phaser.Game): void {
  if (!isPhone(game) || typeof screen === 'undefined') return;
  const orientation = screen.orientation as (ScreenOrientation & OrientationLock) | undefined;
  if (typeof orientation?.lock !== 'function') return;
  try {
    orientation.lock('landscape').catch(() => undefined);
  } catch {
    // Not supported / not allowed here: the portrait cover still guards the game.
  }
}

/**
 * Releases lockLandscape() when leaving full screen (browsers also release it on their own then). The installed web
 * app keeps its lock from start-up.
 */
export function unlockOrientation(): void {
  if (typeof screen === 'undefined' || installedApp()) return;
  const orientation = screen.orientation as (ScreenOrientation & OrientationLock) | undefined;
  try {
    orientation?.unlock?.();
  } catch {
    // Nothing was locked.
  }
}

/** Running as an installed home-screen web app (manifest display: fullscreen / standalone). */
function installedApp(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches;
}

const STYLE = `
#${GATE_ID} {
  position: fixed; inset: 0; z-index: 1000; display: none;
  flex-direction: column; align-items: center; justify-content: center; gap: 28px;
  padding: 24px; box-sizing: border-box; text-align: center;
  background: radial-gradient(ellipse at center, #1a1519 0%, #0b0a0e 70%);
  color: ${ACCENT}; font: bold 20px ${BODY_FONT}; line-height: 1.35;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
#${GATE_ID}.on { display: flex; }
#${GATE_ID} svg { width: 120px; height: 120px; overflow: visible; }
#${GATE_ID} .phone { transform-origin: 60px 60px; animation: ${GATE_ID}-turn 2.4s ease-in-out infinite; }
#${GATE_ID} p { margin: 0; max-width: 18em; text-shadow: 0 2px 4px #000; }
@keyframes ${GATE_ID}-turn {
  0%, 20% { transform: rotate(0deg); }
  50%, 80% { transform: rotate(-90deg); }
  100% { transform: rotate(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  #${GATE_ID} .phone { animation: none; transform: rotate(-90deg); }
}
`;

/** Phone outline (portrait, turned by the CSS animation) and a curved arrow showing the turn. */
const ICON = `
<svg viewBox="0 0 120 120" aria-hidden="true">
  <path d="M 18 30 A 46 46 0 0 1 48 12" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round" opacity="0.6"/>
  <path d="M 40 6 L 49 12 L 41 20" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
  <g class="phone">
    <rect x="38" y="20" width="44" height="80" rx="7" fill="#0b0a0e" stroke="${ACCENT}" stroke-width="5"/>
    <rect x="44" y="30" width="32" height="56" rx="2" fill="${ACCENT}" opacity="0.18"/>
    <circle cx="60" cy="93" r="2.5" fill="${ACCENT}"/>
  </g>
</svg>`;

/**
 * Installs the portrait cover for phones (call once after the game is created). Tablets and desktops: nothing
 * happens. The cover follows window resize / orientation changes; the game gets ORIENTATION_BLOCKED on each change.
 */
export function installOrientationGate(game: Phaser.Game): void {
  if (typeof document === 'undefined' || !isPhone(game)) return;
  if (installedApp()) lockLandscape(game);

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  const gate = document.createElement('div');
  gate.id = GATE_ID;
  gate.setAttribute('role', 'alert');
  gate.innerHTML = ICON;
  const text = document.createElement('p');
  gate.appendChild(text);
  // Every touch on the cover ends here: no page scroll / zoom, nothing reaches the game.
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const type of ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'wheel']) {
    gate.addEventListener(type, swallow, { passive: false });
  }
  (document.getElementById('shell') ?? document.body).appendChild(gate);
  const setText = (): void => {
    text.textContent = t('orientation.rotate');
  };
  setText();
  onLocaleChange(setText);

  const update = (): void => {
    // The window, not the screen: inside the portal iframe the frame's shape is what the player sees.
    const portrait = window.innerHeight > window.innerWidth;
    if (portrait === blocked) return;
    blocked = portrait;
    gate.classList.toggle('on', portrait);
    if (portrait) {
      // A focused DOM field (hero name) under the cover would keep the keyboard up and take keys.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    } else {
      // Keys held while covered must not count as still held (a phone with a hardware keyboard).
      for (const scene of game.scene.getScenes(true)) scene.input.keyboard?.resetKeys();
    }
    game.events.emit(ORIENTATION_BLOCKED, portrait);
  };
  window.addEventListener('resize', update);
  // iOS may report the old window size during orientationchange: check again once the turn has settled.
  const turned = (): void => {
    update();
    window.setTimeout(update, 350);
  };
  window.addEventListener('orientationchange', turned);
  screen.orientation?.addEventListener?.('change', turned);
  update();
}

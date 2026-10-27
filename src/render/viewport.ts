import type * as Phaser from 'phaser';
import { safeInsets } from './touchMode';

// Keeps the page shell (index.html #shell) and the Phaser canvas the size of what the player actually sees.
//
// The scale manager (RESIZE mode) sizes the canvas from the box of its parent (#game, inset inside #shell by the safe
// area) and re-reads that box on window resize and every 500 ms. So the canvas follows the box; what goes wrong on
// iOS is the box itself: #shell was `position: fixed; inset: 0`, sized by the browser's initial containing block,
// and iOS (home-screen web app in particular, launched or turned in landscape) can keep that block at a stale,
// taller size. The canvas then matches a box that reaches below the screen and the bottom of every scene is cut off.
// On iOS the shell therefore gets an explicit size: the window size, never more than the screen itself (a page
// cannot be bigger than the screen it is shown on, whichever size iOS reports late). Every platform re-checks on
// resize / turn / visual viewport / page show events and again shortly after, since iOS reports the final size late.

const SHELL_ID = 'shell';
const GAME_ID = 'game';
/** Re-checks after a size event (ms): iOS settles the window size some time after the event. */
const RECHECK_MS = [100, 350, 1000] as const;
/** iOS only: background re-check of the shell size (ms); it only writes styles when the size changed. */
const POLL_MS = 1000;

/** iPhone / iPod / iPad (iPadOS Safari reports a Mac with a multi-touch screen). */
function appleTouch(game?: Phaser.Game): boolean {
  if (typeof navigator === 'undefined') return false;
  if (game) return game.device.os.iOS || (game.device.os.macOS && navigator.maxTouchPoints > 1);
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/** Running as an installed home-screen web app. */
export function standaloneApp(): boolean {
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
}

/** The device is turned sideways: the screen orientation API first, the window shape as a fallback. */
function landscape(): boolean {
  const type = screen.orientation?.type;
  if (typeof type === 'string') return type.startsWith('landscape');
  const legacy = (window as Window & { orientation?: number }).orientation;
  if (typeof legacy === 'number') return Math.abs(legacy) === 90;
  return window.innerWidth > window.innerHeight;
}

/** The screen size as the device is held now (iOS keeps screen.width / height in portrait terms). */
function orientedScreen(): { width: number; height: number } {
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape() ? { width: long, height: short } : { width: short, height: long };
}

/** iOS: gives the shell the window size, capped by the screen. Elsewhere the CSS (100% of the window) is kept. */
function fitShell(apple: boolean): void {
  const shell = document.getElementById(SHELL_ID);
  if (!shell || !apple) return;
  const s = orientedScreen();
  const width = Math.min(window.innerWidth, s.width > 0 ? s.width : Infinity);
  const height = Math.min(window.innerHeight, s.height > 0 ? s.height : Infinity);
  if (!(width > 0 && height > 0)) return;
  const w = `${Math.floor(width)}px`;
  const h = `${Math.floor(height)}px`;
  if (shell.style.width !== w) shell.style.width = w;
  if (shell.style.height !== h) shell.style.height = h;
}

/**
 * Sizes the shell now (call before the game is created, so the first canvas already has the right size) and returns
 * the installer that keeps it and the game in step afterwards.
 */
export function fitViewport(): (game: Phaser.Game) => void {
  if (typeof document === 'undefined') return () => undefined;
  fitShell(appleTouch());
  return installViewportFit;
}

/** Keeps the shell and the game size right on every resize / turn / page show (call once after the game is created). */
function installViewportFit(game: Phaser.Game): void {
  const apple = appleTouch(game);
  const check = (): void => {
    fitShell(apple);
    // Before boot the scale manager reads the box itself.
    if (!game.isBooted) return;
    if (game.scale.getParentBounds()) game.scale.refresh();
  };
  const timers: number[] = [];
  const schedule = (): void => {
    for (const id of timers) window.clearTimeout(id);
    timers.length = 0;
    check();
    for (const ms of RECHECK_MS) timers.push(window.setTimeout(check, ms));
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('pageshow', schedule);
  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });
  screen.orientation?.addEventListener?.('change', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  game.events.once('ready', schedule);
  schedule();
  // iOS can also change the size with no event at all (home-screen app start-up): a slow poll catches it.
  if (apple) window.setInterval(check, POLL_MS);
}

/** One line of sizes for the QA panel: what the browser reports against what the game uses (iOS sizing bugs). */
export function viewportDiagnostics(game: Phaser.Game): string {
  const r = (n: number): string => String(Math.round(n));
  const vv = window.visualViewport;
  const box = document.getElementById(GAME_ID)?.getBoundingClientRect();
  const parts = [
    `win ${r(window.innerWidth)}×${r(window.innerHeight)}`,
    `vv ${vv ? `${r(vv.width)}×${r(vv.height)}` : '-'}`,
    `scr ${r(screen.width)}×${r(screen.height)}`,
    `doc ${r(document.documentElement.clientWidth)}×${r(document.documentElement.clientHeight)}`,
    `#game ${box ? `${r(box.width)}×${r(box.height)}@${r(box.left)},${r(box.top)}` : '-'}`,
    `scale ${r(game.scale.width)}×${r(game.scale.height)}`,
    `safe ${(({ top, right, bottom, left }) => [top, right, bottom, left].map(r).join('/'))(safeInsets())}`,
    `dpr ${window.devicePixelRatio}`,
    `app ${standaloneApp() ? 'yes' : 'no'}`,
    `${landscape() ? 'land' : 'port'}`,
  ];
  return parts.join(' · ');
}

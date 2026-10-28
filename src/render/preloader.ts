import type * as Phaser from 'phaser';

// Drives the inline preloader of index.html (#boot): it is plain HTML / CSS there so it shows before the bundle and
// Phaser are downloaded. An inline script creeps it towards 30% while the bundle downloads and parses (no progress
// events exist for that); from here on the stages are real:
//   bundle running → app (storage, language, fonts) → first scene's asset loader (Phaser progress) → menu built.
// The platform loading events (loadingStart / loadingStop) are fired by the boot code and the menu scene, not here:
// this is only the picture.

const BOOT_ID = 'boot';
/** Share of the bar per stage (0..100): the bundle ran, the app is ready, the menu loader runs up to LOADER_END. */
const BUNDLE_DONE = 30;
const APP_DONE = 45;
const LOADER_END = 97;
/** Fade-out (ms), as the CSS transition of #boot.done; a short hold at 100% first. */
const HOLD_MS = 150;
const FADE_MS = 350;

let shown = 0;
let finished = false;

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(BOOT_ID);
}

/** Stops the inline creep (index.html) so it never overwrites real progress. */
function stopCreep(el: HTMLElement): void {
  const timer = Number(el.dataset.timer);
  if (Number.isFinite(timer)) window.clearInterval(timer);
  delete el.dataset.timer;
}

/** Sets the bar (0..100); never goes back. */
function setProgress(percent: number): void {
  const el = root();
  if (!el || finished) return;
  stopCreep(el);
  const fromDom = parseFloat((el.querySelector<HTMLElement>('.fill')?.style.width ?? '0').replace('%', '')) || 0;
  shown = Math.max(shown, fromDom, Math.min(100, percent));
  const fill = el.querySelector<HTMLElement>('.fill');
  const pct = el.querySelector<HTMLElement>('.pct');
  if (fill) fill.style.width = `${shown.toFixed(1)}%`;
  if (pct) pct.textContent = `${Math.floor(shown)}%`;
  el.setAttribute('aria-valuenow', String(Math.floor(shown)));
}

/** The bundle is running (Phaser and the game code are parsed). */
export function preloaderBundleReady(): void {
  setProgress(BUNDLE_DONE);
}

/** Profile, settings, language and its fonts are ready. */
export function preloaderAppReady(): void {
  setProgress(APP_DONE);
}

/**
 * Follows a scene's asset loader (call from its preload()). Only the first scene matters: after the preloader is gone
 * this does nothing.
 */
export function trackPreloaderLoader(scene: Phaser.Scene): void {
  if (finished || !root()) return;
  const onProgress = (value: number): void => setProgress(APP_DONE + (LOADER_END - APP_DONE) * value);
  scene.load.on('progress', onProgress);
  scene.load.once('complete', () => {
    scene.load.off('progress', onProgress);
    setProgress(LOADER_END);
  });
}

/** The first screen is built: fill the bar, fade the preloader out and remove it. */
export function finishPreloader(): void {
  const el = root();
  if (!el || finished) return;
  setProgress(100);
  finished = true;
  window.setTimeout(() => {
    el.classList.add('done');
    window.setTimeout(() => el.remove(), FADE_MS + 50);
  }, HOLD_MS);
}

/** Boot failed (old browser, network error): say so on the preloader instead of hanging at a percentage. */
export function failPreloader(message: string): void {
  const el = root();
  if (!el || finished) return;
  stopCreep(el);
  const pct = el.querySelector<HTMLElement>('.pct');
  if (pct) {
    pct.textContent = message;
    pct.style.color = '#e0705f';
    pct.style.letterSpacing = '0';
  }
}

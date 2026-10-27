import type * as Phaser from 'phaser';

// Small helpers shared by procedurally drawn room art (roomView, ruinsDecor, cryptDecor). Look only, never game state.

/** CSS rgba() of a 0xRRGGBB colour. */
export const css = (color: number, alpha = 1): string => `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${alpha})`;

/** Small deterministic generator (mulberry32) for decoration: the same seed always draws the same picture. */
export function decorRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a): seeds decoration by room template id, so it never moves between visits. */
export function stringHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A new canvas of the given size with its 2D context. */
export function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d')! };
}

/** Canvas texture `key` drawn by `draw` once per game (later calls return the cached key). */
export function canvasTexture(scene: Phaser.Scene, key: string, width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): string {
  if (scene.textures.exists(key)) return key;
  const { canvas, ctx } = makeCanvas(width, height);
  draw(ctx);
  scene.textures.addCanvas(key, canvas);
  return key;
}

/** The player asked the system for less motion: ambient animation (dust, wisps, flicker) stays still or off. */
export const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

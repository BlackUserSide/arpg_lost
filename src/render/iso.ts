import { vec, type Vec2 } from '../core/math';

/**
 * Isometric (2:1) projection between core world space (flat plane) and screen space.
 * Core never knows about it — only render projects positions and unprojects input.
 */
export const ISO_K = Math.SQRT1_2;

export function toScreen(p: Vec2): Vec2 {
  return vec((p.x - p.y) * ISO_K, ((p.x + p.y) * ISO_K) / 2);
}

export function toWorld(s: Vec2): Vec2 {
  const a = s.x / ISO_K;
  const b = (2 * s.y) / ISO_K;
  return vec((a + b) / 2, (b - a) / 2);
}

/** Screen-space direction (e.g. WASD) to world-space direction (not normalized). */
export function screenDirToWorld(d: Vec2): Vec2 {
  return toWorld(d);
}

/**
 * 8-way sprite row for a world-space direction, in Flare sheet order:
 * 0 W, 1 NW, 2 N, 3 NE, 4 E, 5 SE, 6 S, 7 SW (screen directions).
 */
export function directionRow(worldDir: Vec2): number {
  const s = toScreen(worldDir);
  if (s.x === 0 && s.y === 0) return 6;
  const angle = Math.atan2(s.y, s.x); // 0 = E, PI/2 = S
  const octant = Math.round(angle / (Math.PI / 4)); // -4..4
  const fromEast = ((octant % 8) + 8) % 8; // 0 E, 1 SE, 2 S, 3 SW, 4 W, 5 NW, 6 N, 7 NE
  return (fromEast + 4) % 8;
}

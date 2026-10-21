export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const length = (v: Vec2): number => Math.hypot(v.x, v.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Unit vector in the same direction, or zero vector for zero input. */
export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  return len > 0 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

export function rotate(v: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export const clamp =(value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

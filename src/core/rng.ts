/**
 * Deterministic seeded RNG (mulberry32). All randomness in core/ goes through an Rng instance
 * passed explicitly, so runs are reproducible and can later be validated on a server.
 * State is a single uint32, so it is trivially serializable.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** True with probability p (p <= 0 never, p >= 1 always). Always consumes one draw. */
  chance(p: number): boolean;
  /** Current state; pass to createRng to resume the same sequence. */
  getState(): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    getState: () => state,
  };
}

import { mobPoolAt } from '../core/run/run';
import type { RunRules } from '../core/run/types';
import type { Content } from '../core/world/content';
import { MOB_SPRITES } from './sprites';

// Which sprite sets a map run needs, so a run loads only those (phones: GPU memory) and the boss loads in the
// background during the run instead of on the loading screen.

/** Set drawn for a mob def (unknown defs fall back like RunScene does). */
export const mobSprite = (defId: string): string => MOB_SPRITES[defId] ?? 'skeleton_warrior';

/** `mobIds` plus every mob they can summon, transitively. */
export function withMinions(content: Content, mobIds: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...mobIds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const ability of content.mobs[id]?.abilities?.list ?? []) {
      if (ability.kind === 'summon') queue.push(...ability.pool.map((e) => e.mobId));
    }
  }
  return out;
}

export interface RunSpriteSets {
  /** Loaded before the run starts: the hero, the map's mob pool, their minions and the hero's raised allies. */
  readonly start: readonly string[];
  /** Loaded in the background during the run: the boss and its minions not already in `start`. */
  readonly boss: readonly string[];
}

/** Sprite sets for a run on `mapLevel` (mobPoolAt) by hero set `heroSet`; `allyMobIds`: mobs the hero can raise. */
export function runSpriteSets(content: Content, rules: RunRules, mapLevel: number, heroSet: string, allyMobIds: Iterable<string> = []): RunSpriteSets {
  const pool = mobPoolAt(rules, mapLevel).map((e) => e.mobId);
  const start = new Set([heroSet, ...[...withMinions(content, [...pool, ...allyMobIds])].map(mobSprite)]);
  const boss = new Set([...withMinions(content, [rules.boss.mobId])].map(mobSprite).filter((set) => !start.has(set)));
  return { start: [...start], boss: [...boss] };
}

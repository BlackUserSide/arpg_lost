// Folding a finished map run into the profile: hero progress and stats, map unlock, chest / consolation, supports.
// One call per run (render calls it when the run ends or the screen closes).

import type { ItemsData } from '../items/types';
import { applyRunResult, findCharacter, type Profile } from '../progression/profile';
import { createRng } from '../rng';
import { grantSupportDrops, type SupportRewards } from '../supports/tab';
import type { SupportData } from '../supports/types';
import { unlockNextMap } from './progress';
import { grantRunRewards, planRunRewards, runOutcome, type GrantedRewards, type RewardPlan, type RunOutcome } from './rewards';
import { abandonRun } from './run';
import type { MapsData, RunState } from './types';

/**
 * Supports found during the run are kept unless the hero died (designer decision 2026-10-23: "lost if the hero
 * died"). A timeout is not a death, so they are kept. An abandoned run loses them like a death, so leaving from the
 * pause menu cannot save them from a lost fight (roadmap 0.4 question).
 */
// DESIGN-TBD: timeout keeps the supports and abandoning loses them — confirm both with the designer.
export function keepsSupportDrops(run: RunState): boolean {
  return run.status === 'won' || (run.status === 'failed' && run.failReason === 'timeout');
}

export interface RunSummary {
  readonly outcome: RunOutcome;
  readonly plan: RewardPlan;
  readonly rewards: GrantedRewards;
  /** Supports granted to the tab (undefined when they were lost or there is no support data). */
  readonly supports?: SupportRewards;
  /** The map this win unlocked, or null. */
  readonly unlockedMap: number | null;
  /** Map completion XP the win granted (already in the hero's progress). */
  readonly bonusXp: number;
}

export interface FinishData {
  readonly maps: MapsData;
  readonly items: ItemsData;
  readonly supports?: SupportData;
}

/**
 * Records a run once: an active run is abandoned first (abandonRun). Then character stats and account records
 * (applyRunResult: XP and skill XP are kept on any outcome), the map unlock on a win, the chest or consolation
 * (planRunRewards / grantRunRewards, items rolled from the world's loot stream so the whole run replays from its
 * seed), and the supports if kept (keepsSupportDrops). Returns null if the run was already recorded or the character
 * does not exist (the run is then marked recorded and nothing is granted).
 */
export function finishRun(profile: Profile, characterId: string, run: RunState, data: FinishData): RunSummary | null {
  if (run.recorded) return null;
  abandonRun(run);
  run.recorded = true;
  const character = findCharacter(profile, characterId);
  if (!character) return null;
  const world = run.world;
  const won = run.status === 'won';
  applyRunResult(profile, characterId, {
    kills: world.kills,
    duration: run.elapsed,
    died: run.failReason === 'death',
    bossKilled: run.bossKilled,
    mapLevel: run.mapLevel,
    ...(won ? { clearTime: run.elapsed } : {}),
    progress: { level: world.player.level, xp: world.player.xp },
    skills: world.player.skillProgress,
  });
  const unlocked = won ? unlockNextMap(character, run.mapLevel, data.maps.rules.maxLinearMap) : null;

  const outcome = runOutcome(run, data.maps);
  const plan = planRunRewards(outcome, data.maps.rewards);
  const loot = createRng(world.lootRngState);
  const rewards = grantRunRewards(profile, loot, plan, data.items);
  world.lootRngState = loot.getState();

  const supports = data.supports && keepsSupportDrops(run) ? grantSupportDrops(profile, character, world.supportDrops, data.supports) : undefined;
  return { outcome, plan, rewards, ...(supports ? { supports } : {}), unlockedMap: unlocked, bonusXp: run.bonusXp };
}

// Account profile: characters, shared stash/currency, records. Pure data + pure functions;
// persistence lives in src/save, identity in src/platform.

import type { Equipment } from '../items/equipment';
import type { Item } from '../items/types';
import { createAllocation } from '../passives/allocation';
import type { PassiveAllocation } from '../passives/types';
import type { SkillProgress } from '../skills/levels';
import type { SupportItem } from '../supports/types';

export interface ProfileRules {
  readonly maxCharacters: number;
  readonly nameMinLength: number;
  readonly nameMaxLength: number;
}

export interface CharacterStats {
  runs: number;
  deaths: number;
  kills: number;
  /** Longest single run, seconds. */
  longestRun: number;
}

export interface CharacterRecord {
  readonly id: string;
  name: string;
  readonly classId: string;
  level: number;
  xp: number;
  stats: CharacterStats;
  equipment: Equipment;
  passives: PassiveAllocation;
  /**
   * Per class skill id: level and XP (docs/design/classes.md «Рівні скілів»). A missing skill is level 1, 0 XP
   * (read through classSkillProgress / skillLevelInfo).
   */
  skills: Record<string, SkillProgress>;
  /**
   * The supports tab (docs/design/skill-modifiers.md): every support the character owns, socketed ones included
   * (SupportItem.socket). At most SupportRules.tabSize; operations in core/supports/tab.ts. Empty for a new hero.
   */
  supports: SupportItem[];
  /** Map ladder progress (docs/design/maps.md, own per hero); see core/run/progress.ts. */
  maps: MapProgress;
}

/**
 * Per-hero map progress. `unlocked`: the highest map the hero may enter (every map 1..unlocked can be replayed);
 * beating the boss of map N unlocks N + 1, up to RunRules.maxLinearMap. Keys after the linear ladder
 * (docs/design/endgame.md) will be a separate field.
 */
export interface MapProgress {
  unlocked: number;
}

export interface ProfileRecords {
  bestMapLevel: number;
  bossKills: number;
  /** Fastest full map clear, seconds; null until the first clear. */
  bestClearTime: number | null;
  mostKillsInRun: number;
}

export interface Profile {
  characters: CharacterRecord[];
  /**
   * Shared by all characters of the account. `overflow` ("пошта", designer decision 2026-10-26): chest items that
   * did not fit the full stash and are kept rather than salvaged (LootRules.overflow), oldest first; they move into
   * the stash with claimOverflow / fillStashFromOverflow (core/items/inventory.ts).
   */
  stash: { items: Item[]; overflow: Item[] };
  currency: Record<string, number>;
  records: ProfileRecords;
  nextCharacterId: number;
  nextItemId: number;
}

export interface RunResult {
  readonly kills: number;
  readonly duration: number;
  readonly died: boolean;
  readonly bossKilled?: boolean;
  readonly mapLevel?: number;
  /** Set when the map was fully cleared. */
  readonly clearTime?: number;
  /** Hero level and XP at the end of the run (XP is kept on death). */
  readonly progress?: { readonly level: number; readonly xp: number };
  /** Skill levels and XP at the end of the run, per skill id (PlayerState.skillProgress; kept on death). */
  readonly skills?: Readonly<Record<string, Readonly<SkillProgress>>>;
}

/** Currency amounts are kept to this many decimals (fractional essence, docs/design/crafting.md); structural. */
const CURRENCY_DECIMALS = 4;

/** Adds (or with a negative amount, spends) account currency; the total is rounded so fractions never drift. */
export function addCurrency(profile: Profile, currency: string, amount: number): void {
  if (amount === 0) return;
  const scale = 10 ** CURRENCY_DECIMALS;
  profile.currency[currency] = Math.round(((profile.currency[currency] ?? 0) + amount) * scale) / scale;
}

export type CreateCharacterError = 'limit' | 'name-length' | 'name-chars' | 'unknown-class';

export function createProfile(): Profile {
  return {
    characters: [],
    stash: { items: [], overflow: [] },
    currency: {},
    records: { bestMapLevel: 0, bossKills: 0, bestClearTime: null, mostKillsInRun: 0 },
    nextCharacterId: 1,
    nextItemId: 1,
  };
}

/** Letters (any script), digits, space, '-' and '_'; no leading/trailing spaces. */
export function validateName(name: string, rules: ProfileRules): 'name-length' | 'name-chars' | null {
  const trimmed = name.trim();
  if (trimmed.length < rules.nameMinLength || trimmed.length > rules.nameMaxLength) return 'name-length';
  if (!/^[\p{L}\p{N} _-]+$/u.test(trimmed)) return 'name-chars';
  return null;
}

export function createCharacter(
  profile: Profile,
  input: { name: string; classId: string },
  rules: ProfileRules,
  knownClasses: readonly string[],
): { ok: true; character: CharacterRecord } | { ok: false; error: CreateCharacterError } {
  if (profile.characters.length >= rules.maxCharacters) return { ok: false, error: 'limit' };
  if (!knownClasses.includes(input.classId)) return { ok: false, error: 'unknown-class' };
  const nameError = validateName(input.name, rules);
  if (nameError) return { ok: false, error: nameError };
  const character: CharacterRecord = {
    id: `c${profile.nextCharacterId++}`,
    name: input.name.trim(),
    classId: input.classId,
    level: 1,
    xp: 0,
    stats: { runs: 0, deaths: 0, kills: 0, longestRun: 0 },
    equipment: {},
    passives: createAllocation(),
    skills: {},
    // Designer decision 2026-10-23: no starter supports, only loot.
    supports: [],
    // Designer decision 2026-10-23: a new hero starts at map 1.
    maps: { unlocked: 1 },
  };
  profile.characters.push(character);
  return { ok: true, character };
}

export function deleteCharacter(profile: Profile, id: string): boolean {
  const before = profile.characters.length;
  profile.characters = profile.characters.filter((c) => c.id !== id);
  return profile.characters.length < before;
}

export function findCharacter(profile: Profile, id: string): CharacterRecord | undefined {
  return profile.characters.find((c) => c.id === id);
}

/** Folds a finished run into character stats and account records. */
export function applyRunResult(profile: Profile, characterId: string, run: RunResult): void {
  const character = findCharacter(profile, characterId);
  if (!character) throw new Error(`Unknown character: ${characterId}`);
  character.stats.runs++;
  if (run.died) character.stats.deaths++;
  character.stats.kills += run.kills;
  character.stats.longestRun = Math.max(character.stats.longestRun, run.duration);
  if (run.progress) {
    character.level = run.progress.level;
    character.xp = run.progress.xp;
  }
  // Only level / xp are replaced, so other per-skill fields are kept.
  for (const [id, progress] of Object.entries(run.skills ?? {})) {
    character.skills[id] = { ...character.skills[id], level: progress.level, xp: progress.xp };
  }

  const records = profile.records;
  records.mostKillsInRun = Math.max(records.mostKillsInRun, run.kills);
  if (run.bossKilled) records.bossKills++;
  if (run.mapLevel !== undefined && run.bossKilled) records.bestMapLevel = Math.max(records.bestMapLevel, run.mapLevel);
  if (run.clearTime !== undefined) {
    records.bestClearTime = records.bestClearTime === null ? run.clearTime : Math.min(records.bestClearTime, run.clearTime);
  }
}

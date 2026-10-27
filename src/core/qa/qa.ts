// QA / closed-beta test mode: shortcuts that put a hero into a late-game state without hours of play (level, map
// ladder, one of every unique / legendary). Pure functions over the profile; every result is a state the game
// itself could produce, so it passes save validation (src/save/validate.ts) unchanged. The caller saves the profile.

import { generateUnique, uniqueLevel } from '../items/generate';
import { storeLoot, type LootPlace } from '../items/inventory';
import type { ItemsData, UniqueDef, WeaponType } from '../items/types';
import { createAllocation, validateAllocation } from '../passives/allocation';
import type { PassiveTreeData } from '../passives/types';
import type { ProgressionRules } from '../progression/levels';
import { findCharacter, type CharacterRecord, type Profile } from '../progression/profile';
import type { Rng } from '../rng';
import type { SkillLevelRules } from '../skills/levels';
import type { ClassDef } from '../world/content';

/** Preset of the "late game in one tap" button (src/data/qa.ts). */
export interface QaPreset {
  /** Hero level (clamped to ProgressionRules.maxLevel). */
  readonly level: number;
  /** Highest unlocked map (clamped to maxLinearMap). */
  readonly mapsUpTo: number;
  /** Item level the uniques / legendaries roll at. */
  readonly itemLevel: number;
  /** Also raise every class skill to its max level (qaMaxSkills). */
  readonly maxSkills: boolean;
}

/** Everything the QA helpers read. */
export interface QaData {
  readonly progression: ProgressionRules;
  readonly tree: PassiveTreeData;
  readonly maps: { readonly maxLinearMap: number };
  readonly items: ItemsData;
  readonly classes: Readonly<Record<string, ClassDef>>;
  readonly skillRules: SkillLevelRules;
}

export interface QaLevelResult {
  /** The level actually set (after clamping). */
  readonly level: number;
  /** True if the passive allocation no longer fitted the new level and was reset (all points refunded). */
  readonly passivesReset: boolean;
}

export interface QaGrantResult {
  /** Items put into the stash. */
  readonly stash: number;
  /** Items put into the overflow ("mail") because the stash was full. */
  readonly overflow: number;
  /** Items that fit nowhere (stash and overflow full) and were not kept. */
  readonly lost: number;
}

function requireCharacter(profile: Profile, characterId: string): CharacterRecord {
  const character = findCharacter(profile, characterId);
  if (!character) throw new Error(`Unknown character: ${characterId}`);
  return character;
}

/** A whole number in min..max (non-finite → min). */
function clampWhole(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

/**
 * Sets the hero level (whole, clamped to 1..maxLevel) with 0 XP towards the next one. Passive and spec points are
 * derived from the level, so raising it just makes points available. If the allocation no longer fits (a lowered
 * level, or it was already invalid) it is reset for free, as save validation would do. Skill levels are untouched:
 * they grow from skill XP (kills), not from the hero level. Worn items stay (the level requirement is only checked
 * when equipping; loading keeps them too).
 */
export function qaSetLevel(
  profile: Profile,
  characterId: string,
  level: number,
  data: Pick<QaData, 'progression' | 'tree'>,
): QaLevelResult {
  const character = requireCharacter(profile, characterId);
  character.level = clampWhole(level, 1, data.progression.maxLevel);
  character.xp = 0;
  const passivesReset = validateAllocation(data.tree, character) !== null;
  if (passivesReset) character.passives = createAllocation();
  return { level: character.level, passivesReset };
}

/**
 * Sets the map ladder so maps 1..upTo can be entered (whole, clamped to 1..maxLinearMap). Lowering is allowed too.
 * Returns the highest unlocked map.
 */
export function qaUnlockMaps(profile: Profile, characterId: string, upTo: number, data: Pick<QaData, 'maps'>): number {
  const character = requireCharacter(profile, characterId);
  character.maps.unlocked = clampWhole(upTo, 1, Math.max(1, data.maps.maxLinearMap));
  return character.maps.unlocked;
}

/**
 * Uniques and legendaries the hero can use, in data order: positive drop weight (weight 0 = the def may land before
 * its mechanic works), known base, and for weapon bases only the hero's weapon type (unique weapons go only to their
 * class). The item level is not a filter here (see qaGrantUniques).
 */
export function qaUniqueDefs(data: ItemsData, weaponType: WeaponType | undefined): UniqueDef[] {
  return Object.values(data.uniques).filter((u) => {
    const base = data.bases[u.baseId];
    return u.weight > 0 && base !== undefined && (!base.weapon || base.weapon.type === weaponType);
  });
}

/**
 * Grants one of every unique and legendary the character can use (qaUniqueDefs for its class weapon type), rolled at
 * `itemLevel` (whole, ≥ 1; a def whose minimum drop level is higher rolls at that level instead, so none is skipped).
 * Each item is stored like chest loot (storeLoot): the stash, else the overflow ("mail"), else lost. Item ids come
 * from the profile counter. Draws from `rng` in data order.
 */
export function qaGrantUniques(profile: Profile, characterId: string, rng: Rng, itemLevel: number, data: Pick<QaData, 'items' | 'classes'>): QaGrantResult {
  const character = requireCharacter(profile, characterId);
  const weaponType = data.classes[character.classId]?.weaponType;
  const level = clampWhole(itemLevel, 1, Number.MAX_SAFE_INTEGER);
  const counts: Record<LootPlace | 'lost', number> = { stash: 0, overflow: 0, lost: 0 };
  for (const def of qaUniqueDefs(data.items, weaponType)) {
    const item = generateUnique(rng, `i${profile.nextItemId++}`, def, Math.max(level, uniqueLevel(def, data.items)), data.items);
    counts[storeLoot(profile, item, data.items) ?? 'lost']++;
  }
  return counts;
}

/**
 * Sets every skill of the character's class to SkillLevelRules.maxLevel with 0 XP (XP is never kept at max level),
 * keeping any other per-skill fields. Skill records of skills the class does not have are left alone. Returns the
 * skill ids raised (empty for an unknown class).
 */
export function qaMaxSkills(profile: Profile, characterId: string, data: Pick<QaData, 'classes' | 'skillRules'>): string[] {
  const character = requireCharacter(profile, characterId);
  const skills = data.classes[character.classId]?.skills ?? [];
  for (const skill of skills) {
    character.skills[skill.id] = { ...character.skills[skill.id], level: data.skillRules.maxLevel, xp: 0 };
  }
  return skills.map((s) => s.id);
}

export interface QaPresetResult {
  readonly level: QaLevelResult;
  readonly mapsUnlocked: number;
  readonly items: QaGrantResult;
  /** Skill ids raised to max level (empty when the preset does not ask for it). */
  readonly maxedSkills: string[];
}

/**
 * "Late game in one tap": qaSetLevel + qaUnlockMaps + qaGrantUniques, and qaMaxSkills if preset.maxSkills, with the
 * preset numbers (src/data/qa.ts).
 */
export function qaApplyPreset(profile: Profile, characterId: string, rng: Rng, preset: QaPreset, data: QaData): QaPresetResult {
  const level = qaSetLevel(profile, characterId, preset.level, data);
  const mapsUnlocked = qaUnlockMaps(profile, characterId, preset.mapsUpTo, data);
  const items = qaGrantUniques(profile, characterId, rng, preset.itemLevel, data);
  const maxedSkills = preset.maxSkills ? qaMaxSkills(profile, characterId, data) : [];
  return { level, mapsUnlocked, items, maxedSkills };
}

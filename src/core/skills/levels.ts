// Skill levels and skill XP (docs/design/classes.md «Рівні скілів», «Ефекти 3-го рівня»). Like gems in PoE:
// every class skill on the bar has its own level (1..maxLevel) and XP, independent of the hero level. A level's
// bonuses are plain SkillChangeSets, so they flow through the skill resolver (core/skills/params) after the
// passive tree's sets. Pure functions over plain data; the progress records are saved per character.

import type { ClassDef } from '../world/content';
import type { SkillBonus, SkillChangeSet } from './types';

/** Saved per character per skill (CharacterRecord.skills). Socketed supports live in CharacterRecord.supports. */
export interface SkillProgress {
  level: number;
  /** XP towards the next level (0 at max level). */
  xp: number;
}

/** What a skill gains at one level: a SkillChangeSet without the targeting (it always targets its own skill). */
export type SkillLevelBonus = SkillBonus;

/**
 * The per-skill new effect (level 3 in the design). `pending`: the mechanic is not implemented yet; the effect
 * changes nothing and render shows it as "в розробці" (same convention as PENDING_MECHANICS for passives).
 */
export interface SkillLevelEffect extends SkillLevelBonus {
  /** Skill level from which the effect applies. */
  readonly level: number;
  readonly pending?: boolean;
}

export interface SkillLevelTable {
  /**
   * Bonus gained at each level above 1: index 0 = level 2, index 1 = level 3. Bonuses accumulate (a level-3
   * skill has both); like every skill change, their param changes add up in one sum with the other sources.
   */
  readonly perLevel: readonly SkillLevelBonus[];
  readonly effect?: SkillLevelEffect;
}

export interface SkillLevelRules {
  readonly maxLevel: number;
  /** XP to go from level L to L+1 is xpToNext[L − 1]. Length maxLevel − 1. */
  readonly xpToNext: readonly number[];
  /**
   * Skill XP per kill = the mob's base XP (MobDef.xp) × this. Not scaled by area level and not reduced in low
   * areas, so the pace in runs stays the same at any hero level (see src/data/skillLevels.ts).
   */
  readonly killXpMultiplier: number;
}

export interface SkillLevelData {
  readonly rules: SkillLevelRules;
  /** Per skill id. A skill without a table still levels up but gains nothing from it. */
  readonly skills: Readonly<Record<string, SkillLevelTable>>;
}

/** XP needed from `level` to the next one; Infinity at max level. */
export function skillXpToNext(level: number, rules: SkillLevelRules): number {
  if (level >= rules.maxLevel) return Infinity;
  return rules.xpToNext[Math.max(1, level) - 1] ?? Infinity;
}

/** Skill XP one kill gives (mob base XP × killXpMultiplier). */
export function skillKillXp(mobBaseXp: number, rules: SkillLevelRules): number {
  return mobBaseXp * rules.killXpMultiplier;
}

/** A level-1 record. */
export function newSkillProgress(): SkillProgress {
  return { level: 1, xp: 0 };
}

/**
 * The stored progress of a skill, sanitized: missing / malformed = level 1, 0 XP; level clamped to 1..maxLevel
 * (whole), XP to ≥ 0 and to 0 at max level. Returns a fresh object.
 */
export function readSkillProgress(stored: unknown, rules: SkillLevelRules): SkillProgress {
  if (typeof stored !== 'object' || stored === null) return newSkillProgress();
  const s = stored as Partial<Record<keyof SkillProgress, unknown>>;
  const rawLevel = typeof s.level === 'number' && Number.isFinite(s.level) ? Math.floor(s.level) : 1;
  const level = Math.min(Math.max(1, rawLevel), rules.maxLevel);
  const rawXp = typeof s.xp === 'number' && Number.isFinite(s.xp) ? Math.max(0, s.xp) : 0;
  return { level, xp: level >= rules.maxLevel ? 0 : rawXp };
}

/**
 * Progress of every skill of the class, from stored records (CharacterRecord.skills / Loadout.skills); skills
 * without a record start at level 1. Records of skills the class does not have are dropped.
 */
export function classSkillProgress(
  classDef: ClassDef,
  stored: Readonly<Record<string, unknown>> | undefined,
  rules: SkillLevelRules,
): Record<string, SkillProgress> {
  const out: Record<string, SkillProgress> = {};
  for (const skill of classDef.skills) out[skill.id] = readSkillProgress(stored?.[skill.id], rules);
  return out;
}

/** Adds XP, levelling up as many times as it covers; XP is not kept at max level. Returns levels gained. */
export function grantSkillXp(progress: SkillProgress, amount: number, rules: SkillLevelRules): number {
  if (progress.level >= rules.maxLevel || amount <= 0) return 0;
  let gained = 0;
  progress.xp += amount;
  while (progress.level < rules.maxLevel && progress.xp >= skillXpToNext(progress.level, rules)) {
    progress.xp -= skillXpToNext(progress.level, rules);
    progress.level++;
    gained++;
  }
  if (progress.level >= rules.maxLevel) progress.xp = 0;
  return gained;
}

/** True if the skill's level effect exists but is not implemented yet (render: "в розробці"). */
export function isLevelEffectPending(data: SkillLevelData, skillId: string): boolean {
  return data.skills[skillId]?.effect?.pending === true;
}

/** The change set one skill gets at `level`: accumulated per-level bonuses + its effect once reached (not pending). */
export function skillLevelChangeSet(skillId: string, level: number, data: SkillLevelData): SkillChangeSet | undefined {
  const table = data.skills[skillId];
  if (!table) return undefined;
  const bonuses = table.perLevel.slice(0, Math.max(0, Math.min(level, data.rules.maxLevel) - 1));
  const effect = table.effect;
  if (effect && !effect.pending && level >= effect.level) bonuses.push(effect);
  if (bonuses.length === 0) return undefined;
  return { skillIds: [skillId], ...mergeBonuses(bonuses) };
}

/**
 * Several bonuses of one skill as one: lists are concatenated, grants of later bonuses override earlier ones
 * field by field, resource cost multipliers multiply, leech and stun bar fill add up.
 */
export function mergeBonuses(bonuses: readonly SkillBonus[]): SkillBonus {
  const changes = bonuses.flatMap((b) => b.changes ?? []);
  const modifiers = bonuses.flatMap((b) => b.modifiers ?? []);
  const buffModifiers = bonuses.flatMap((b) => b.buffModifiers ?? []);
  const addOnHit = bonuses.flatMap((b) => b.addOnHit ?? []);
  const statusDurations = bonuses.flatMap((b) => b.statusDurations ?? []);
  const addSelfEffects = bonuses.flatMap((b) => b.addSelfEffects ?? []);
  let grants: SkillChangeSet['grants'];
  let costMultiplier: number | undefined;
  let leech: number | undefined;
  let stunBarFill: number | undefined;
  for (const b of bonuses) {
    if (b.grants) grants = { ...grants, ...b.grants };
    if (b.resourceCostMultiplier !== undefined) costMultiplier = (costMultiplier ?? 1) * b.resourceCostMultiplier;
    if (b.leech !== undefined) leech = (leech ?? 0) + b.leech;
    if (b.stunBarFillIncreased !== undefined) stunBarFill = (stunBarFill ?? 0) + b.stunBarFillIncreased;
  }
  return {
    ...(grants ? { grants } : {}),
    ...(changes.length > 0 ? { changes } : {}),
    ...(modifiers.length > 0 ? { modifiers } : {}),
    ...(buffModifiers.length > 0 ? { buffModifiers } : {}),
    ...(addOnHit.length > 0 ? { addOnHit } : {}),
    ...(statusDurations.length > 0 ? { statusDurations } : {}),
    ...(addSelfEffects.length > 0 ? { addSelfEffects } : {}),
    ...(costMultiplier !== undefined ? { resourceCostMultiplier: costMultiplier } : {}),
    ...(leech !== undefined ? { leech } : {}),
    ...(stunBarFill !== undefined ? { stunBarFillIncreased: stunBarFill } : {}),
  };
}

/** Change sets of all class skills at their current levels, in class skill order (resolver input after passives). */
export function skillLevelChangeSets(
  classDef: ClassDef,
  progress: Readonly<Record<string, SkillProgress>>,
  data: SkillLevelData | undefined,
): SkillChangeSet[] {
  if (!data) return [];
  const sets: SkillChangeSet[] = [];
  for (const skill of classDef.skills) {
    const set = skillLevelChangeSet(skill.id, progress[skill.id]?.level ?? 1, data);
    if (set) sets.push(set);
  }
  return sets;
}

/** Display info for one skill (HUD, character screen). */
export interface SkillLevelInfo {
  readonly skillId: string;
  readonly level: number;
  readonly maxLevel: number;
  /** XP towards the next level (0 at max). */
  readonly xp: number;
  /** XP needed for the next level; Infinity at max level. */
  readonly xpToNext: number;
  /** True if the level effect exists and is not implemented yet. */
  readonly effectPending: boolean;
  /** Level at which the skill's effect unlocks; undefined if the skill has none. */
  readonly effectLevel: number | undefined;
}

export function skillLevelInfo(skillId: string, progress: SkillProgress | undefined, data: SkillLevelData): SkillLevelInfo {
  const p = readSkillProgress(progress, data.rules);
  return {
    skillId,
    level: p.level,
    maxLevel: data.rules.maxLevel,
    xp: p.xp,
    xpToNext: skillXpToNext(p.level, data.rules),
    effectPending: isLevelEffectPending(data, skillId),
    effectLevel: data.skills[skillId]?.effect?.level,
  };
}

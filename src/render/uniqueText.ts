import type { UniqueDef } from '../core/items/types';
import type { PassiveMechanic } from '../core/passives/types';
import type { Content } from '../core/world/content';
import { tx, type Params } from '../i18n';
import { contentKey } from './contentText';
import { resourceText } from './resourceText';
import { formatModifiers, pct } from './statText';

// Effect text of unique / legendary items (unique.<id>.effect). The wording lives in the locale files; every number
// in it comes from the UniqueDef (its mechanics and effect modifiers), filled in here per unique. Pure (tested).

type SkillParams = Extract<PassiveMechanic, { kind: 'skillParams' }>;

/** Placeholder values of one unique's effect text, plus which effect modifiers the text already states. */
export interface UniqueEffectFill {
  readonly params: Params;
  /** Indices into UniqueDef.effectModifiers the text spells out (they get no extra modifier line). */
  readonly stated: readonly number[];
}

const skillParams = (def: UniqueDef): SkillParams[] => (def.mechanics ?? []).filter((m): m is SkillParams => m.kind === 'skillParams');

/** The resource of the class that owns `skillId` (Barrow Reaper's Cleave: Rage), else the viewing hero's. */
function skillResource(content: Content, skillId: string | undefined, fallback: string | undefined): string | undefined {
  if (skillId === undefined) return fallback;
  const owner = Object.values(content.classes).find((c) => c.skills.some((s) => s.id === skillId) || c.basicAttack.id === skillId);
  return owner?.resource.id ?? fallback;
}

type Filler = (def: UniqueDef, content: Content, resourceId: string | undefined) => UniqueEffectFill | undefined;

/** One filler per unique whose effect text has placeholders. undefined = the data lacks what the text needs. */
const FILLERS: Readonly<Record<string, Filler>> = {
  glass_cannon_crown: (def) => {
    const more = def.effectModifiers?.[0];
    return more ? { params: { pct: pct(more.value) }, stated: [0] } : undefined;
  },
  splitter: (def) => {
    const pierce = skillParams(def)
      .flatMap((m) => m.changes ?? [])
      .find((c) => c.param === 'pierce');
    return pierce?.add !== undefined ? { params: { count: pierce.add }, stated: [] } : undefined;
  },
  heart_of_winter: (def) => {
    const slow = skillParams(def)
      .flatMap((m) => m.addOnHit ?? [])
      .find((s) => s.status === 'slow');
    return slow?.magnitude !== undefined ? { params: { pct: pct(slow.magnitude), seconds: slow.duration }, stated: [] } : undefined;
  },
  barrow_reaper: (def, content, resourceId) => {
    const source = skillParams(def).find((m) => m.resourcePerHit !== undefined);
    if (!source?.resourcePerHit) return undefined;
    const resource = skillResource(content, source.skillIds?.[0], resourceId);
    return { params: { amount: source.resourcePerHit, resGen: resourceText(resource, 'gen') }, stated: [] };
  },
};

/** Placeholder values for a unique's effect text; uniques without a filler get none (their text has no numbers). */
export function uniqueEffectFill(def: UniqueDef, content: Content, resourceId?: string): UniqueEffectFill | undefined {
  const filler = FILLERS[def.id];
  return filler ? filler(def, content, resourceId) : { params: {}, stated: [] };
}

/**
 * The effect lines of a unique: its localized effect text (empty when the locale has none), then each effect
 * modifier the text does not already state, as a modifier line.
 */
export function uniqueEffectLines(def: UniqueDef, content: Content, resourceId?: string): string[] {
  const fill = uniqueEffectFill(def, content, resourceId);
  const lines: string[] = [];
  const text = tx(contentKey.uniqueEffect(def.id), fill?.params, '');
  if (text) lines.push(text);
  const rest = (def.effectModifiers ?? []).filter((_, i) => !fill?.stated.includes(i));
  lines.push(...formatModifiers(rest, resourceId));
  return lines;
}

import type { UniqueDef, UniqueTextParam } from '../core/items/types';
import type { Content } from '../core/world/content';
import { tx, type Params } from '../i18n';
import { contentKey } from './contentText';
import { resourceText } from './resourceText';
import { formatModifiers, pct } from './statText';

// Effect text of unique / legendary items (unique.<id>.effect). The wording lives in the locale files; every number
// in it comes from the UniqueDef: its effectParams say which value fills which placeholder (UniqueTextParam), so a
// new unique needs data and locale text only, no code here. Pure (tested).

/** Placeholder values of one unique's effect text, plus which effect modifiers the text already states. */
export interface UniqueEffectFill {
  readonly params: Params;
  /** Indices into UniqueDef.effectModifiers the text spells out (they get no extra modifier line). */
  readonly stated: readonly number[];
}

/** The value at a dot path inside the def ('mechanics.0.addOnHit.0.duration'), or undefined if any step is missing. */
function valueAt(def: UniqueDef, path: string): unknown {
  let node: unknown = def;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Readonly<Record<string, unknown>>)[key];
  }
  return node;
}

/** The resource of the class that owns `skillId` (Barrow Reaper's Cleave: Rage), else the viewing hero's. */
function skillResource(content: Content, skillId: string, fallback: string | undefined): string | undefined {
  const owner = Object.values(content.classes).find((c) => c.skills.some((s) => s.id === skillId) || c.basicAttack.id === skillId);
  return owner?.resource.id ?? fallback;
}

/** One placeholder value, or undefined when the path does not lead to a value of the right kind. */
function paramValue(def: UniqueDef, param: UniqueTextParam, content: Content, resourceId: string | undefined): string | number | undefined {
  if ('resourceOf' in param) {
    const skillId = valueAt(def, param.resourceOf);
    return typeof skillId === 'string' ? resourceText(skillResource(content, skillId, resourceId), 'gen') : undefined;
  }
  const value = valueAt(def, param.path);
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  // Signs are dropped: the wording carries the direction ("50% shorter", "less").
  return param.format === 'percent' ? pct(value) : Math.abs(value);
}

/** Effect modifier index a path points into ('effectModifiers.0.value' → 0), if any. */
function statedIndex(param: UniqueTextParam): number | undefined {
  if ('resourceOf' in param) return undefined;
  const [root, index] = param.path.split('.');
  return root === 'effectModifiers' && index !== undefined && /^\d+$/.test(index) ? Number(index) : undefined;
}

/**
 * Placeholder values for a unique's effect text from its effectParams; params whose path leads nowhere are left
 * out (uniqueEffectLines then drops the text line rather than show a raw placeholder).
 */
export function uniqueEffectFill(def: UniqueDef, content: Content, resourceId?: string): UniqueEffectFill {
  const params: Record<string, string | number> = {};
  const stated: number[] = [];
  for (const [name, param] of Object.entries(def.effectParams ?? {})) {
    const value = paramValue(def, param, content, resourceId);
    if (value === undefined) continue;
    params[name] = value;
    const index = statedIndex(param);
    if (index !== undefined) stated.push(index);
  }
  return { params, stated };
}

/**
 * The effect lines of a unique: its localized effect text (none when the locale has no text, or when a placeholder
 * could not be filled from the data), then each effect modifier the text does not already state, as a modifier line.
 */
export function uniqueEffectLines(def: UniqueDef, content: Content, resourceId?: string): string[] {
  const fill = uniqueEffectFill(def, content, resourceId);
  const lines: string[] = [];
  const text = tx(contentKey.uniqueEffect(def.id), fill.params, '');
  const shown = text !== '' && !/\{\w+\}/.test(text);
  if (shown) lines.push(text);
  // Without the text line nothing is stated: every effect modifier gets its own line.
  const rest = (def.effectModifiers ?? []).filter((_, i) => !(shown && fill.stated.includes(i)));
  lines.push(...formatModifiers(rest, resourceId));
  return lines;
}

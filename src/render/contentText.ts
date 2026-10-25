import type { Item, ItemsData } from '../core/items/types';
import type { PassiveNodeDef, PassiveTreeData } from '../core/passives/types';
import type { SupportData } from '../core/supports/types';
import { STATUS_IDS, type Content, type StatusId } from '../core/world/content';
import { t, tx, type MessageKey } from '../i18n';

// Display text of data-driven content, keyed by content id in the locale files. This file owns the key scheme;
// requiredContentKeys() lists every key the data needs, so the coverage tests fail when content is added without text.

export const contentKey = {
  className: (id: string): string => `class.${id}.name`,
  classDescription: (id: string): string => `class.${id}.description`,
  skillName: (id: string): string => `skill.${id}.name`,
  supportName: (id: string): string => `support.${id}.name`,
  supportDescription: (id: string): string => `support.${id}.description`,
  passiveName: (id: string): string => `passive.${id}.name`,
  specName: (id: string): string => `spec.${id}.name`,
  baseName: (id: string): string => `base.${id}.name`,
  mobName: (id: string): string => `mob.${id}.name`,
  eliteModifierName: (id: string): string => `eliteModifier.${id}.name`,
  resource: (id: string, form: 'name' | 'gen' | 'acc'): string => `resource.${id}.${form}`,
  rareWord: (position: 'first' | 'second', word: string): string => `item.rare.${position}.${word}`,
  uniqueName: (id: string): string => `unique.${id}.name`,
  /** The unique's effect line; its placeholders are filled from the UniqueDef's mechanics / effect modifiers. */
  uniqueEffect: (id: string): string => `unique.${id}.effect`,
} as const;

export const className = (id: string): string => tx(contentKey.className(id), undefined, id);
export const classDescription = (id: string): string => tx(contentKey.classDescription(id), undefined, '');
export const skillName = (id: string): string => tx(contentKey.skillName(id), undefined, id);
export const supportName = (id: string): string => tx(contentKey.supportName(id), undefined, id);
export const supportDescription = (id: string): string => tx(contentKey.supportDescription(id), undefined, '');
export const specName = (id: string): string => tx(contentKey.specName(id), undefined, id);
export const baseName = (id: string): string => tx(contentKey.baseName(id), undefined, id);
export const mobName = (id: string): string => tx(contentKey.mobName(id), undefined, id);
export const eliteModifierName = (id: string): string => tx(contentKey.eliteModifierName(id), undefined, id);

/** A passive node's name; a class start node is named after its class. */
export function passiveName(node: Pick<PassiveNodeDef, 'id' | 'type' | 'classId'>): string {
  if (node.type === 'start' && node.classId) return className(node.classId);
  return tx(contentKey.passiveName(node.id), undefined, node.id);
}

/**
 * A rare item's name. Core rolls it from data word lists (LootRules.rareNameWords, the English words double as ids)
 * and stores "First Second"; each word is translated on display, unknown words are shown as stored.
 */
export function rareItemName(stored: string): string {
  const [first = '', second = ''] = stored.split(' ');
  return t('item.rareName', {
    first: tx(contentKey.rareWord('first', first), undefined, first),
    second: tx(contentKey.rareWord('second', second), undefined, second),
  });
}

/** A unique / legendary item's own name; an id without text (a removed unique) falls back to the base name. */
export const uniqueName = (id: string, baseId: string): string => tx(contentKey.uniqueName(id), undefined, baseName(baseId));

/** Normal and magic items are named by their base; rares by their rolled name; uniques and legendaries by their own. */
export function itemName(item: Pick<Item, 'rarity' | 'name' | 'baseId' | 'unique'>): string {
  if (item.unique) return uniqueName(item.unique.id, item.baseId);
  return item.rarity === 'rare' && item.name ? rareItemName(item.name) : baseName(item.baseId);
}

/** Status words: object ("inflicts Freeze" / "накладає заморозку"), genitive ("Freeze duration"), target adjective. */
export function statusText(status: string, form: 'acc' | 'gen' | 'target'): string {
  return (STATUS_IDS as readonly string[]).includes(status) ? t(`status.${status as StatusId}.${form}` satisfies MessageKey) : status;
}

/** Every content key the data needs text for (en must have all of them, uk too). */
export function requiredContentKeys(content: Content, tree: PassiveTreeData, items: ItemsData, supports: SupportData): string[] {
  const keys: string[] = [];
  for (const cls of Object.values(content.classes)) {
    keys.push(contentKey.className(cls.id), contentKey.classDescription(cls.id));
    for (const action of [cls.basicAttack, ...cls.skills]) keys.push(contentKey.skillName(action.id));
    for (const form of ['name', 'gen', 'acc'] as const) keys.push(contentKey.resource(cls.resource.id, form));
  }
  for (const mob of Object.values(content.mobs)) keys.push(contentKey.mobName(mob.id));
  for (const mod of Object.values(content.eliteModifiers ?? {})) keys.push(contentKey.eliteModifierName(mod.id));
  for (const node of Object.values(tree.nodes)) if (node.type !== 'start') keys.push(contentKey.passiveName(node.id));
  for (const spec of Object.values(tree.specs)) keys.push(contentKey.specName(spec.id));
  for (const base of Object.values(items.bases)) keys.push(contentKey.baseName(base.id));
  for (const word of items.rules.rareNameWords.first) keys.push(contentKey.rareWord('first', word));
  for (const word of items.rules.rareNameWords.second) keys.push(contentKey.rareWord('second', word));
  for (const def of Object.values(items.uniques)) keys.push(contentKey.uniqueName(def.id), contentKey.uniqueEffect(def.id));
  for (const def of Object.values(supports.supports)) keys.push(contentKey.supportName(def.id), contentKey.supportDescription(def.id));
  return keys;
}

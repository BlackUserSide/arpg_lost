// The supports tab of a character (docs/design/skill-modifiers.md «Зберігання й розбір», «Слоти й вставка»):
// owning, socketing, unsocketing and salvaging supports. Pure functions that mutate plain profile / character JSON
// (CharacterRecord.supports); every number comes from SupportData.

import { SALVAGE_CURRENCY } from '../items/inventory';
import type { Profile } from '../progression/profile';
import type { ActionDef, ClassDef } from '../world/content';
import { supportFits } from './rules';
import type { SupportData, SupportItem, SupportRef } from './types';

/** What the tab rules need of a character (CharacterRecord satisfies it). */
export interface SupportOwner {
  supports: SupportItem[];
}

export type SocketError = 'no-support' | 'no-skill' | 'bad-slot' | 'unknown-support' | 'incompatible' | 'duplicate';
export type SalvageSupportError = 'no-support' | 'socketed';

/** Result of adding one support to a tab: kept, or salvaged into shards because the tab was full. */
export type AddSupportResult = { readonly kept: true; readonly item: SupportItem } | { readonly kept: false; readonly shards: number };

/** Shards a support of `tier` salvages into (SupportRules.salvage; 0 for a tier without a value). */
export function supportSalvageValue(ref: SupportRef, data: SupportData): number {
  return data.rules.salvage[Math.max(1, Math.floor(ref.tier)) - 1] ?? 0;
}

function addShards(profile: Profile, amount: number): void {
  if (amount <= 0) return;
  profile.currency[SALVAGE_CURRENCY] = (profile.currency[SALVAGE_CURRENCY] ?? 0) + amount;
}

/**
 * Adds a support to the character's tab with the next profile item id ('s' + nextItemId; ids are never reused).
 * The tab holds SupportRules.tabSize supports, socketed ones included; a support that does not fit is salvaged
 * into shards at once (designer decision 2026-10-23, like the item stash).
 */
export function addSupport(profile: Profile, owner: SupportOwner, ref: SupportRef, data: SupportData): AddSupportResult {
  if (owner.supports.length >= data.rules.tabSize) {
    const shards = supportSalvageValue(ref, data);
    addShards(profile, shards);
    return { kept: false, shards };
  }
  const item: SupportItem = { id: `s${profile.nextItemId++}`, defId: ref.defId, tier: ref.tier };
  owner.supports.push(item);
  return { kept: true, item };
}

/** Run drops into the tab, in drop order (see addSupport). */
export interface SupportRewards {
  readonly kept: SupportItem[];
  /** Supports that did not fit the tab. */
  readonly salvagedCount: number;
  /** Shards gained from them. */
  readonly shards: number;
}

// Designer decision: supports dropped during a run are lost if the hero dies — call this only for a survived run.
export function grantSupportDrops(profile: Profile, owner: SupportOwner, drops: readonly SupportRef[], data: SupportData): SupportRewards {
  const kept: SupportItem[] = [];
  let salvagedCount = 0;
  let shards = 0;
  for (const drop of drops) {
    const result = addSupport(profile, owner, drop, data);
    if (result.kept) kept.push(result.item);
    else {
      salvagedCount++;
      shards += result.shards;
    }
  }
  return { kept, salvagedCount, shards };
}

/**
 * Sockets an owned support into `slot` of a class skill. Free and lossless (designer decision 2026-10-22).
 * - The basic attack has no slots ('no-skill'); slot must be 0..slotsPerSkill−1 ('bad-slot').
 * - The support must fit the skill (supportFits: 'incompatible').
 * - Two supports of the same def cannot share a skill ('duplicate'); moving a support between the slots of one
 *   skill is allowed.
 * A support already in that slot goes back to the tab; a support socketed elsewhere moves here.
 */
export function socketSupport(owner: SupportOwner, supportId: string, skillId: string, slot: number, classDef: ClassDef, data: SupportData): SocketError | null {
  const item = owner.supports.find((s) => s.id === supportId);
  if (!item) return 'no-support';
  const skill = classDef.skills.find((s) => s.id === skillId);
  if (!skill) return 'no-skill';
  if (!Number.isInteger(slot) || slot < 0 || slot >= data.rules.slotsPerSkill) return 'bad-slot';
  const def = data.supports[item.defId];
  if (!def) return 'unknown-support';
  if (!supportFits(def, skill)) return 'incompatible';
  const sameDef = owner.supports.find((s) => s !== item && s.defId === item.defId && s.socket?.skillId === skillId && s.socket.slot !== slot);
  if (sameDef) return 'duplicate';
  for (const other of owner.supports) {
    if (other !== item && other.socket?.skillId === skillId && other.socket.slot === slot) delete other.socket;
  }
  item.socket = { skillId, slot };
  return null;
}

/** Returns a socketed support to the tab. */
export function unsocketSupport(owner: SupportOwner, supportId: string): 'no-support' | null {
  const item = owner.supports.find((s) => s.id === supportId);
  if (!item) return 'no-support';
  delete item.socket;
  return null;
}

/**
 * Salvages a support from the tab into shards (returns the amount). A socketed support has to be unsocketed first
 * (designer decision 2026-10-23).
 */
export function salvageSupport(profile: Profile, owner: SupportOwner, supportId: string, data: SupportData): { error: SalvageSupportError } | { shards: number } {
  const index = owner.supports.findIndex((s) => s.id === supportId);
  const item = owner.supports[index];
  if (!item) return { error: 'no-support' };
  if (item.socket) return { error: 'socketed' };
  owner.supports.splice(index, 1);
  const shards = supportSalvageValue(item, data);
  addShards(profile, shards);
  return { shards };
}

/**
 * Returns to the tab every socketed support that is no longer valid: unknown def or skill, slot out of range,
 * a second support in an occupied slot, a duplicate def on one skill, or a support that lost compatibility after a
 * data change (designer decision 2026-10-23). Earlier entries win. Returns the ids that were unsocketed.
 */
export function validateSockets(owner: SupportOwner, classDef: ClassDef, data: SupportData): string[] {
  const unsocketed: string[] = [];
  const taken = new Set<string>();
  const defs = new Set<string>();
  for (const item of owner.supports) {
    const socket = item.socket;
    if (!socket) continue;
    const skill = classDef.skills.find((s) => s.id === socket.skillId);
    const def = data.supports[item.defId];
    const slotKey = `${socket.skillId}#${socket.slot}`;
    const defKey = `${socket.skillId}#${item.defId}`;
    const valid =
      skill !== undefined &&
      def !== undefined &&
      Number.isInteger(socket.slot) &&
      socket.slot >= 0 &&
      socket.slot < data.rules.slotsPerSkill &&
      !taken.has(slotKey) &&
      !defs.has(defKey) &&
      supportFits(def, skill);
    if (!valid) {
      delete item.socket;
      unsocketed.push(item.id);
      continue;
    }
    taken.add(slotKey);
    defs.add(defKey);
  }
  return unsocketed;
}

/** Socketed supports per skill id, in slot order: what the hero brings into a run (Loadout.supports). */
export function socketedSupports(owner: Readonly<SupportOwner>): Record<string, SupportRef[]> {
  const out: Record<string, SupportRef[]> = {};
  const socketed = owner.supports.filter((s) => s.socket).sort((a, b) => (a.socket?.slot ?? 0) - (b.socket?.slot ?? 0));
  for (const item of socketed) {
    const skillId = item.socket?.skillId;
    if (skillId === undefined) continue;
    (out[skillId] ??= []).push({ defId: item.defId, tier: item.tier });
  }
  return out;
}

/** The support in a skill's slot, if any (hub UI). */
export function supportInSlot(owner: Readonly<SupportOwner>, skillId: string, slot: number): SupportItem | undefined {
  return owner.supports.find((s) => s.socket?.skillId === skillId && s.socket.slot === slot);
}

/** Owned supports of a def that fit a skill and are not socketed into it (hub UI: socket picker). */
export function socketCandidates(owner: Readonly<SupportOwner>, skill: ActionDef, data: SupportData): SupportItem[] {
  return owner.supports.filter((s) => {
    const def = data.supports[s.defId];
    return def !== undefined && s.socket?.skillId !== skill.id && supportFits(def, skill);
  });
}

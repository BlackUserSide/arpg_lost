import type { Modifier, StatId, Tag } from '../core/stats/types';
import { formatNumber, listAnd, t, type MessageKey } from '../i18n';
import { resourceText } from './resourceText';

// Stat modifier lines shared by item tooltips, passive nodes and supports. Pure functions (tested), no Phaser.
// Only wording lives in the locale files; every number comes from the data.
// `resourceId` (ClassDef.resource.id of the viewing hero) names the resource stats ("Rage"); "Resource" without it.

export const MINUS = '−';
/** Absolute value, up to two decimals, no trailing zeros, locale decimal separator. */
export const num = (v: number): string => formatNumber(Math.abs(v));
export const signOf = (v: number): string => (v < 0 ? MINUS : '+');
export const signed = (v: number): string => `${signOf(v)}${num(v)}`;
export const pct = (v: number): string => `${num(v * 100)}%`;
export const signedPct = (v: number): string => `${signOf(v)}${pct(v)}`;

export const STAT_KEY: Readonly<Record<StatId, MessageKey>> = {
  life: 'stat.life',
  lifeRegen: 'stat.lifeRegen',
  energyShield: 'stat.energyShield',
  energyShieldRegen: 'stat.energyShieldRegen',
  resource: 'stat.resource',
  resourceRegen: 'stat.resourceRegen',
  armour: 'stat.armour',
  fireResistance: 'stat.fireResistance',
  coldResistance: 'stat.coldResistance',
  lightningResistance: 'stat.lightningResistance',
  damage: 'stat.damage',
  critChance: 'stat.critChance',
  critMultiplier: 'stat.critMultiplier',
  attackSpeed: 'stat.attackSpeed',
  castSpeed: 'stat.castSpeed',
  cooldownRecovery: 'stat.cooldownRecovery',
  movementSpeed: 'stat.movementSpeed',
  damageTaken: 'stat.damageTaken',
  igniteChance: 'stat.igniteChance',
  igniteDamage: 'stat.igniteDamage',
  freezeDuration: 'stat.freezeDuration',
};

/** "+8% <damage phrase>" for a single damage tag ("Projectile Damage" / "урону снарядами"). */
const DAMAGE_TAG_KEY: Readonly<Record<Tag, MessageKey>> = {
  physical: 'damageTag.physical',
  fire: 'damageTag.fire',
  cold: 'damageTag.cold',
  lightning: 'damageTag.lightning',
  melee: 'damageTag.melee',
  projectile: 'damageTag.projectile',
  spell: 'damageTag.spell',
  area: 'damageTag.area',
  attack: 'damageTag.attack',
};

/** Tag names qualifying a non-damage stat or a skill group ("Melee" / "ближнього бою"). */
const TAG_KEY: Readonly<Record<Tag, MessageKey>> = {
  physical: 'tag.physical',
  fire: 'tag.fire',
  cold: 'tag.cold',
  lightning: 'tag.lightning',
  melee: 'tag.melee',
  projectile: 'tag.projectile',
  spell: 'tag.spell',
  area: 'tag.area',
  attack: 'tag.attack',
};

export function tagName(tag: string): string {
  const key = TAG_KEY[tag as Tag] as MessageKey | undefined;
  return key ? t(key) : tag;
}

/** Stats whose flat values are fractions shown as percentages (modifier lines and item tier ranges). */
export const PERCENT_FLAT: ReadonlySet<StatId> = new Set(['fireResistance', 'coldResistance', 'lightningResistance', 'critChance', 'critMultiplier', 'igniteChance']);

/** Stat phrase, the resource stats named after the hero's resource. */
export function statName(stat: StatId, resourceId?: string): string {
  if (stat === 'resource' || stat === 'resourceRegen') return t(STAT_KEY[stat], { resource: resourceText(resourceId, 'gen') });
  return t(STAT_KEY[stat]);
}

/** Folds a single damage tag into the noun ("Projectile Damage"), otherwise "<stat> with <tags>". */
function statPhrase(m: Modifier, resourceId: string | undefined): string {
  if (m.stat === 'damage' && m.tags?.length === 1) return t(DAMAGE_TAG_KEY[m.tags[0]!]);
  const stat = statName(m.stat, resourceId);
  return m.tags && m.tags.length > 0 ? t('mod.tagged', { stat, tags: listAnd(m.tags.map(tagName)) }) : stat;
}

export function formatModifier(m: Modifier, resourceId?: string): string {
  const stat = statPhrase(m, resourceId);
  // "100% less" switches the stat off (Bloodsucker: no life regen).
  if (m.kind === 'more' && m.value <= -1) return t('mod.none', { stat });
  if (m.kind === 'more') return t(m.value < 0 ? 'mod.less' : 'mod.more', { value: num(m.value * 100), stat });
  if (m.kind === 'increased') return t(m.value < 0 ? 'mod.reduced' : 'mod.increased', { value: num(m.value * 100), stat });
  if (m.stat === 'damage' && m.damageType) return t('mod.addedDamage', { sign: signOf(m.value), value: num(m.value), damage: t(DAMAGE_TAG_KEY[m.damageType]) });
  if (PERCENT_FLAT.has(m.stat)) return t('mod.flatPercent', { sign: signOf(m.value), value: num(m.value * 100), stat });
  return t('mod.flat', { sign: signOf(m.value), value: num(m.value), stat });
}

const RESISTANCES: readonly StatId[] = ['fireResistance', 'coldResistance', 'lightningResistance'];

/** One line per modifier; three equal flat resistances collapse into "all Elemental Resistances". */
export function formatModifiers(mods: readonly Modifier[], resourceId?: string): string[] {
  const res = mods.filter((m) => m.kind === 'flat' && RESISTANCES.includes(m.stat) && !m.tags);
  const allRes = res.length === 3 && new Set(res.map((m) => m.stat)).size === 3 && res.every((m) => m.value === res[0]!.value);
  const lines: string[] = [];
  let resDone = false;
  for (const m of mods) {
    if (allRes && res.includes(m)) {
      if (!resDone) lines.push(t('mod.allResistances', { sign: signOf(m.value), value: num(m.value * 100) }));
      resDone = true;
      continue;
    }
    lines.push(formatModifier(m, resourceId));
  }
  return lines;
}

/** Damage type words in the forms templates need (adjective, object, "as <type>", short column label). */
export type DamageTypeForm = 'name' | 'adj' | 'acc' | 'instr' | 'short';

export function damageTypeText(type: string, form: DamageTypeForm): string {
  const key = DAMAGE_TYPE_KEYS[type]?.[form];
  return key ? t(key) : type;
}

const damageTypeKeys = (type: 'physical' | 'fire' | 'cold' | 'lightning'): Record<DamageTypeForm, MessageKey> => ({
  name: `damageType.${type}.name`,
  adj: `damageType.${type}.adj`,
  acc: `damageType.${type}.acc`,
  instr: `damageType.${type}.instr`,
  short: `damageType.${type}.short`,
});

const DAMAGE_TYPE_KEYS: Readonly<Record<string, Record<DamageTypeForm, MessageKey>>> = {
  physical: damageTypeKeys('physical'),
  fire: damageTypeKeys('fire'),
  cold: damageTypeKeys('cold'),
  lightning: damageTypeKeys('lightning'),
};

import type { AnySkillParam, SkillBonus, SkillParamChange } from '../core/skills/types';
import type { SalvageSupportError, SocketError } from '../core/supports/tab';
import type { SupportDef, SupportTierDef } from '../core/supports/types';
import type { ClassDef } from '../core/world/content';
import { supportFits } from '../core/world/world';
import { capitalize, t, type MessageKey } from '../i18n';
import { skillName, statusText, supportName } from './contentText';
import { PARAM_KEY } from './passiveText';
import { damageTypeText, formatModifier, num, pct, signed, signedPct } from './statText';

// Skill modifier ("support") text: tooltips in the hub, run results. Pure functions (tested), no Phaser.
// Only wording lives in the locale files; every number comes from the support data.

/** Tier as a roman numeral (1 → "I"); tiers past the table fall back to digits. */
export function tierLabel(tier: number): string {
  return ['I', 'II', 'III', 'IV', 'V'][tier - 1] ?? String(tier);
}

/** "Echo II". */
export function supportTitle(def: Pick<SupportDef, 'id'>, tier: number): string {
  return t('supportLine.title', { name: supportName(def.id), tier: tierLabel(tier) });
}

const GROUP_KEY: Readonly<Record<SupportDef['group'], MessageKey>> = {
  melee: 'supportGroup.melee',
  projectile: 'supportGroup.projectile',
  spell: 'supportGroup.spell',
  general: 'supportGroup.general',
};

export const supportGroupLabel = (group: SupportDef['group']): string => t(GROUP_KEY[group]);

/** Param names for skill changes: the passive params plus the ones only levels / supports use. */
const ANY_PARAM_KEY: Readonly<Record<AnySkillParam, MessageKey>> = {
  ...PARAM_KEY,
  angle: 'param.angle',
  hitRadius: 'param.hitRadius',
  projectileCount: 'param.projectileCount',
  spread: 'param.spread',
};

const SECONDS: ReadonlySet<AnySkillParam> = new Set(['cooldown', 'buffDuration', 'armTime', 'statusDuration']);
const DEGREES: ReadonlySet<AnySkillParam> = new Set(['angle', 'spread']);

function changeText(c: SkillParamChange<AnySkillParam>): string {
  // Whole-number adds of counts read as sentences.
  if (c.param === 'projectileCount' && c.add !== undefined && c.increased === undefined) {
    return t('supportLine.projectiles', { count: Math.abs(c.add), sign: signed(c.add) });
  }
  if (c.param === 'pierce' && c.add !== undefined && c.increased === undefined) {
    return t('supportLine.pierce', { count: Math.abs(c.add) });
  }
  const parts: string[] = [];
  if (c.add !== undefined) {
    const value = signed(c.add);
    parts.push(SECONDS.has(c.param) ? t('unit.seconds', { value }) : DEGREES.has(c.param) ? `${value}°` : value);
  }
  if (c.increased !== undefined) parts.push(signedPct(c.increased));
  return capitalize(t('change.param', { param: t(ANY_PARAM_KEY[c.param]), values: parts.join(t('list.separator')) }));
}

/** "25% chance to Stun" / "Always Stun" style lead of an on-hit line. */
function chanceLead(chance: number | undefined, withChance: MessageKey, always: MessageKey, params: Record<string, string> = {}): string {
  return chance !== undefined ? t(withChance, { ...params, pct: pct(chance) }) : t(always, params);
}

/** Effect lines of one support tier's bonus (what it adds to the skill it is socketed into). */
export function describeSupportBonus(bonus: SkillBonus, resourceId?: string): string[] {
  const lines: string[] = [];
  for (const c of bonus.changes ?? []) lines.push(changeText(c));
  for (const s of bonus.addOnHit ?? []) {
    const seconds = num(s.duration);
    if (s.status === 'stun') {
      lines.push(t('supportLine.onHit.duration', { lead: chanceLead(s.chance, 'supportLine.stun.chance', 'supportLine.stun.always'), seconds }));
    } else if (s.status === 'bleed') {
      const stacks = s.maxStacks !== undefined ? t('supportLine.bleed.stacks', { count: s.maxStacks }) : '';
      const power = s.magnitude !== undefined ? t('supportLine.bleed.power', { pct: pct(s.magnitude) }) : t('supportLine.bleed.damage');
      lines.push(t('supportLine.bleed', { power, seconds, stacks }));
    } else if (s.status === 'ignite') {
      const lead = chanceLead(s.chance, 'supportLine.ignite.chance', 'supportLine.ignite.always');
      lines.push(s.magnitude !== undefined ? t('supportLine.ignite.power', { lead, pct: pct(s.magnitude), seconds }) : t('supportLine.onHit.duration', { lead, seconds }));
    } else {
      const status = statusText(s.status, 'acc');
      lines.push(t('supportLine.onHit.duration', { lead: chanceLead(s.chance, 'supportLine.status.chance', 'supportLine.status.always', { status }), seconds }));
    }
  }
  if (bonus.damageConversion) {
    lines.push(t('supportLine.conversion', { pct: pct(bonus.damageConversion.fraction), type: damageTypeText(bonus.damageConversion.to, 'acc') }));
  }
  const grants = bonus.grants;
  if (grants?.knockback) {
    const k = grants.knockback;
    const lead = chanceLead(k.chance, 'supportLine.knockback.chance', 'supportLine.knockback.always');
    lines.push(t('supportLine.knockback', { lead, distance: num(k.distance), elite: num(k.eliteMultiplier) }));
  }
  if (grants?.chainHit) {
    const c = grants.chainHit;
    lines.push(t('supportLine.chain.hops', { count: c.hops, range: num(c.range) }));
    lines.push(t('supportLine.chain.damage', { pct: pct(c.effectiveness), type: damageTypeText(c.damageType, 'instr') }));
  }
  if (grants?.echo) lines.push(t('supportLine.echo', { pct: pct(grants.echo.chance), seconds: num(grants.echo.delay) }));
  if (bonus.leech !== undefined && bonus.leech !== 0) lines.push(t('supportLine.leech', { pct: pct(bonus.leech) }));
  if (bonus.stunBarFillIncreased !== undefined && bonus.stunBarFillIncreased !== 0) {
    lines.push(t('mech.stunBonus.fill', { value: signedPct(bonus.stunBarFillIncreased) }));
  }
  for (const m of bonus.modifiers ?? []) lines.push(formatModifier(m, resourceId));
  return lines;
}

/** Variant names for the "instead" lines of a tier (the passive mechanic that switches the bonus). */
const MECHANIC_KEY: Readonly<Record<string, MessageKey>> = { stunBar: 'supportLine.variant.stunBar' };

/** All lines of a tier: the regular bonus, then each variant ("With the Stun bar: … instead"). */
export function describeSupportTier(tier: SupportTierDef, resourceId?: string): { lines: string[]; variants: string[] } {
  const lines = describeSupportBonus(tier.bonus, resourceId);
  const variants = (tier.variants ?? []).map((v) => {
    const key = MECHANIC_KEY[v.mechanic];
    return t('supportLine.variant', { label: key ? t(key) : v.mechanic, lines: describeSupportBonus(v.bonus, resourceId).join(t('list.separator')) });
  });
  return { lines, variants };
}

/** "Skill cost ×1.3". */
export function costMultiplierText(multiplier: number): string {
  return t('supportLine.costMultiplier', { mult: num(multiplier) });
}

/** Names of the class skills a support fits (basic attack has no slots). */
export function compatibleSkillNames(def: SupportDef, classDef: ClassDef): string[] {
  return classDef.skills.filter((s) => supportFits(def, s)).map((s) => skillName(s.id));
}

const SOCKET_ERROR_KEY: Readonly<Record<SocketError, MessageKey>> = {
  'no-support': 'supports.error.noSupport',
  'no-skill': 'supports.error.noSkill',
  'bad-slot': 'supports.error.badSlot',
  'unknown-support': 'supports.error.unknownSupport',
  incompatible: 'supports.error.incompatible',
  duplicate: 'supports.error.duplicate',
};

const SALVAGE_ERROR_KEY: Readonly<Record<SalvageSupportError, MessageKey>> = {
  'no-support': 'supports.error.noSupport',
  socketed: 'supports.error.socketed',
};

export const socketError = (error: SocketError): string => t(SOCKET_ERROR_KEY[error]);
export const salvageSupportError = (error: SalvageSupportError): string => t(SALVAGE_ERROR_KEY[error]);

export const supportsWord = (n: number): string => t('unit.supports', { count: n });

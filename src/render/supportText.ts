import type { SkillBonus, AnySkillParam, SkillParamChange } from '../core/skills/types';
import type { SalvageSupportError, SocketError } from '../core/supports/tab';
import type { SupportDef, SupportTierDef } from '../core/supports/types';
import type { ClassDef } from '../core/world/content';
import { supportFits } from '../core/world/world';
import { formatModifier, num, plural, SKILL_NAMES } from './passiveText';

// Ukrainian text for skill modifiers ("supports"): tooltips in the hub, run results. Pure functions (tested), no
// Phaser. Only wording lives here; every number comes from the support data.

const MINUS = '−';
const signed = (v: number): string => `${v < 0 ? MINUS : '+'}${num(v)}`;
const pct = (v: number): string => `${num(v * 100)}%`;
const signedPct = (v: number): string => `${v < 0 ? MINUS : '+'}${pct(v)}`;

/** Tier as a roman numeral (1 → "I"); tiers past the table fall back to digits. */
export function tierLabel(tier: number): string {
  return ['I', 'II', 'III', 'IV', 'V'][tier - 1] ?? String(tier);
}

/** "Луна II". */
export function supportTitle(def: Pick<SupportDef, 'name'>, tier: number): string {
  return `${def.name} ${tierLabel(tier)}`;
}

export const GROUP_LABEL: Record<SupportDef['group'], string> = {
  melee: 'Ближній бій',
  projectile: 'Снаряди',
  spell: 'Заклинання',
  general: 'Загальний',
};

/** Param names and units for skill changes (passive params plus the ones only levels / supports use). */
const PARAM: Record<AnySkillParam, { name: string; unit: string }> = {
  cooldown: { name: 'кулдаун', unit: ' с' },
  charges: { name: 'заряди', unit: '' },
  buffDuration: { name: 'тривалість бафу', unit: ' с' },
  radius: { name: 'радіус', unit: '' },
  explodeRadius: { name: 'радіус вибуху', unit: '' },
  pierce: { name: 'пробиття', unit: '' },
  range: { name: 'дальність', unit: '' },
  projectileSpeed: { name: 'швидкість снарядів', unit: '' },
  armTime: { name: 'час зведення', unit: ' с' },
  triggerRadius: { name: 'радіус спрацювання', unit: '' },
  statusDuration: { name: 'тривалість ефекту', unit: ' с' },
  angle: { name: 'кут удару', unit: '°' },
  hitRadius: { name: 'ширина смуги ривка', unit: '' },
  projectileCount: { name: 'снаряди', unit: '' },
  spread: { name: 'розкид', unit: '°' },
};

function changeText(c: SkillParamChange<AnySkillParam>): string {
  // Whole-number adds of counts read as sentences.
  if (c.param === 'projectileCount' && c.add !== undefined && c.increased === undefined) {
    return `${signed(c.add)} ${plural(c.add, 'снаряд', 'снаряди', 'снарядів')}`;
  }
  if (c.param === 'pierce' && c.add !== undefined && c.increased === undefined) {
    return `Пробиває ще ${num(c.add)} ${plural(c.add, 'ворога', 'ворогів', 'ворогів')}`;
  }
  const p = PARAM[c.param];
  const parts: string[] = [];
  if (c.add !== undefined) parts.push(`${signed(c.add)}${p.unit}`);
  if (c.increased !== undefined) parts.push(signedPct(c.increased));
  const text = `${p.name} ${parts.join(', ')}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DAMAGE_TYPE_ACC: Record<string, string> = { physical: 'фізичний', fire: 'вогонь', cold: 'холод', lightning: 'блискавку' };
const DAMAGE_TYPE_INSTR: Record<string, string> = { physical: 'фізичним', fire: 'вогнем', cold: 'холодом', lightning: 'блискавкою' };

/** Effect lines of one support tier's bonus (what it adds to the skill it is socketed into). */
export function describeSupportBonus(bonus: SkillBonus, resourceId?: string): string[] {
  const lines: string[] = [];
  for (const c of bonus.changes ?? []) lines.push(changeText(c));
  for (const s of bonus.addOnHit ?? []) {
    const chance = s.chance !== undefined ? `${pct(s.chance)} шанс` : 'Завжди';
    if (s.status === 'stun') lines.push(`${chance} оглушити на ${num(s.duration)} с`);
    else if (s.status === 'bleed') {
      const stacks = s.maxStacks !== undefined ? `, до ${s.maxStacks} ${plural(s.maxStacks, 'стака', 'стаків', 'стаків')}` : '';
      const power = s.magnitude !== undefined ? `${pct(s.magnitude)} урону удару` : 'урон';
      lines.push(`Кровотеча: ${power} за ${num(s.duration)} с на стак${stacks}; ігнорує броню`);
    } else if (s.status === 'ignite') {
      const power = s.magnitude !== undefined ? `: ${pct(s.magnitude)} урону за ${num(s.duration)} с` : ` на ${num(s.duration)} с`;
      lines.push(`${chance} підпалити${power}`);
    } else {
      lines.push(`${chance} накласти «${s.status}» на ${num(s.duration)} с`);
    }
  }
  if (bonus.damageConversion) {
    const to = DAMAGE_TYPE_ACC[bonus.damageConversion.to] ?? bonus.damageConversion.to;
    lines.push(`${pct(bonus.damageConversion.fraction)} урону перетворюється на ${to}`);
  }
  const grants = bonus.grants;
  if (grants?.knockback) {
    const k = grants.knockback;
    const chance = k.chance !== undefined ? `${pct(k.chance)} шанс відкинути` : 'Відкидає';
    lines.push(`${chance} ворогів на ${num(k.distance)} од. (еліти — ×${num(k.eliteMultiplier)}, бос — ні)`);
  }
  if (grants?.chainHit) {
    const c = grants.chainHit;
    const type = DAMAGE_TYPE_INSTR[c.damageType] ?? c.damageType;
    lines.push(`Кожне влучання: блискавка стрибає по ${c.hops} ${plural(c.hops, 'ворогу', 'ворогах', 'ворогах')} (до ${num(c.range)} од.)`);
    lines.push(`Удар блискавки: ${pct(c.effectiveness)} урону скіла ${type}`);
  }
  if (grants?.echo) {
    lines.push(`${pct(grants.echo.chance)} шанс повторити скіл безкоштовно через ${num(grants.echo.delay)} с`);
  }
  if (bonus.leech !== undefined && bonus.leech !== 0) lines.push(`${pct(bonus.leech)} завданого урону лікує`);
  if (bonus.stunBarFillIncreased !== undefined && bonus.stunBarFillIncreased !== 0) {
    lines.push(`${signedPct(bonus.stunBarFillIncreased)} наповнення шкали оглушення`);
  }
  for (const m of bonus.modifiers ?? []) lines.push(formatModifier(m, resourceId));
  return lines;
}

/** Variant names for the "instead" lines of a tier (the passive mechanic that switches the bonus). */
const MECHANIC_LABEL: Record<string, string> = { stunBar: 'Зі шкалою оглушення (Страж)' };

/** All lines of a tier: the regular bonus, then each variant ("Зі шкалою оглушення: … замість цього"). */
export function describeSupportTier(tier: SupportTierDef, resourceId?: string): { lines: string[]; variants: string[] } {
  const lines = describeSupportBonus(tier.bonus, resourceId);
  const variants = (tier.variants ?? []).map((v) => `${MECHANIC_LABEL[v.mechanic] ?? v.mechanic}: ${describeSupportBonus(v.bonus, resourceId).join(', ')} замість цього`);
  return { lines, variants };
}

/** "Вартість скіла ×1.3". */
export function costMultiplierText(multiplier: number): string {
  return `Вартість скіла ×${num(multiplier)}`;
}

/** Names of the class skills a support fits (basic attack has no slots). */
export function compatibleSkillNames(def: SupportDef, classDef: ClassDef): string[] {
  return classDef.skills.filter((s) => supportFits(def, s)).map((s) => s.name ?? SKILL_NAMES.get(s.id) ?? s.id);
}

export const SOCKET_ERRORS: Record<SocketError, string> = {
  'no-support': 'Модифікатор не знайдено.',
  'no-skill': 'У цього скіла немає слотів.',
  'bad-slot': 'Такого слота немає.',
  'unknown-support': 'Невідомий модифікатор.',
  incompatible: 'Цей модифікатор нічого не дасть цьому скілу.',
  duplicate: 'Два однакові модифікатори в один скіл не можна.',
};

export const SALVAGE_SUPPORT_ERRORS: Record<SalvageSupportError, string> = {
  'no-support': 'Модифікатор не знайдено.',
  socketed: 'Спершу витягніть модифікатор зі скіла.',
};

export const supportsWord = (n: number): string => `${n} ${plural(n, 'модифікатор', 'модифікатори', 'модифікаторів')}`;

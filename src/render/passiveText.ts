import type { AllocateError } from '../core/passives/allocation';
import type { RespecError } from '../core/passives/respec';
import type { PassiveCondition, PassiveMechanic, PassiveNodeDef, PassiveNodeType, PassiveStatusId, SkillParam, SkillParamChange } from '../core/passives/types';
import type { Modifier, StatId, Tag } from '../core/stats/types';
import { classes } from '../data/classes';

// Ukrainian text for the passive tree screen. Pure functions (tested), no Phaser.
// Only wording lives here; every number comes from the node data.

export const NODE_TYPE_LABEL: Record<PassiveNodeType, string> = {
  start: 'Стартова точка',
  small: 'Малий вузол',
  notable: 'Значний вузол',
  keystone: 'Ключовий вузол',
  specEntry: 'Вхід спеціалізації',
  specKeystone: 'Ключовий вузол спеціалізації',
  spec: 'Вузол спеціалізації',
};

/** Stat names in the genitive ("+4% життя"). */
const STAT: Record<StatId, string> = {
  life: 'життя',
  lifeRegen: 'регенерації життя/с',
  energyShield: 'енергетичного щита',
  energyShieldRegen: 'регенерації ЕЩ/с',
  mana: 'мани',
  manaRegen: 'регенерації мани/с',
  armour: 'броні',
  fireResistance: 'опору вогню',
  coldResistance: 'опору холоду',
  lightningResistance: 'опору блискавці',
  damage: 'урону',
  critChance: 'шансу криту',
  critMultiplier: 'множника криту',
  attackSpeed: 'швидкості атаки',
  castSpeed: 'швидкості касту',
  cooldownRecovery: 'відновлення кулдаунів',
  movementSpeed: 'швидкості руху',
  damageTaken: 'отриманого урону',
  igniteChance: 'шансу підпалу',
  igniteDamage: 'урону підпалу',
  freezeDuration: 'тривалості заморозки',
};

/** "+8% <damage phrase>" for a single damage tag. */
const DAMAGE_TAG: Record<Tag, string> = {
  physical: 'фізичного урону',
  fire: 'урону вогнем',
  cold: 'урону холодом',
  lightning: 'урону блискавкою',
  melee: 'урону ближнього бою',
  projectile: 'урону снарядами',
  spell: 'урону заклинань',
  area: 'урону по області',
  attack: 'урону атак',
};

/** Tag names for "(для …)" suffixes on non-damage stats. */
const TAG_FOR: Record<Tag, string> = {
  physical: 'фізичного урону',
  fire: 'вогню',
  cold: 'холоду',
  lightning: 'блискавки',
  melee: 'ближнього бою',
  projectile: 'снарядів',
  spell: 'заклинань',
  area: 'ударів по області',
  attack: 'атак',
};

/** Skill display names from the class data. */
export const SKILL_NAMES: ReadonlyMap<string, string> = new Map(
  Object.values(classes).flatMap((c) => [c.basicAttack, ...c.skills].map((a): [string, string] => [a.id, a.name ?? a.id])),
);

const PARAM: Record<SkillParam, { name: string; unit: string }> = {
  cooldown: { name: 'кулдаун', unit: ' с' },
  charges: { name: 'заряди', unit: '' },
  buffDuration: { name: 'тривалість бафу', unit: ' с' },
  radius: { name: 'радіус', unit: '' },
  explodeRadius: { name: 'радіус вибуху', unit: '' },
  pierce: { name: 'пробиття', unit: ' ціль' },
  range: { name: 'дальність', unit: '' },
  projectileSpeed: { name: 'швидкість снарядів', unit: '' },
  armTime: { name: 'час зведення', unit: ' с' },
  triggerRadius: { name: 'радіус спрацювання', unit: '' },
  statusDuration: { name: 'тривалість ефекту', unit: ' с' },
};

const STATUS: Record<PassiveStatusId, string> = { stun: 'оглушення', slow: 'сповільнення', ignite: 'підпал', freeze: 'заморозку' };
/** "тривалість <status>" (genitive). */
const STATUS_GENITIVE: Record<PassiveStatusId, string> = { stun: 'оглушення', slow: 'сповільнення', ignite: 'підпалу', freeze: 'заморозки' };
/** "<adjective> вороги" for target-state conditions. */
const STATUS_TARGET: Record<PassiveStatusId, string> = { stun: 'оглушених', slow: 'сповільнених', ignite: 'підпалених', freeze: 'заморожених' };
const DAMAGE_TYPE: Record<string, string> = { physical: 'фізичний', fire: 'вогняний', cold: 'холодний', lightning: 'блискавичний' };

const MINUS = '−';
/** Up to two decimals, no trailing zeros. */
export const num = (v: number): string => String(Math.round(Math.abs(v) * 100) / 100);
const signed = (v: number): string => `${v < 0 ? MINUS : '+'}${num(v)}`;
const pct = (v: number): string => `${num(v * 100)}%`;
const signedPct = (v: number): string => `${v < 0 ? MINUS : '+'}${pct(v)}`;

const PERCENT_FLAT: ReadonlySet<StatId> = new Set(['fireResistance', 'coldResistance', 'lightningResistance', 'critChance', 'igniteChance']);

function tagSuffix(tags: readonly Tag[] | undefined): string {
  return tags && tags.length > 0 ? ` для ${tags.map((t) => TAG_FOR[t]).join(' і ')}` : '';
}

/** Stat phrase in the genitive, folding a single damage tag into the noun ("урону снарядами"). */
function statPhrase(m: Modifier): string {
  if (m.stat === 'damage' && m.tags?.length === 1) return DAMAGE_TAG[m.tags[0]!];
  return `${STAT[m.stat]}${tagSuffix(m.tags)}`;
}

export function formatModifier(m: Modifier): string {
  // "100% less" switches the stat off (Bloodsucker: no life regen).
  if (m.kind === 'more' && m.value <= -1) return `Немає ${statPhrase(m)}`;
  if (m.kind === 'more') return `${pct(m.value)} ${m.value < 0 ? 'менше' : 'більше'} ${statPhrase(m)} (more)`;
  if (m.kind === 'increased') return `${signedPct(m.value)} ${statPhrase(m)}`;
  if (m.stat === 'damage' && m.damageType) return `${signed(m.value)} ${DAMAGE_TAG[m.damageType]}`;
  if (PERCENT_FLAT.has(m.stat)) return `${signedPct(m.value)} ${statPhrase(m)}`;
  return `${signed(m.value)} ${statPhrase(m)}`;
}

const RESISTANCES: readonly StatId[] = ['fireResistance', 'coldResistance', 'lightningResistance'];

/** One line per modifier; three equal flat resistances collapse into "опору всім стихіям". */
export function formatModifiers(mods: readonly Modifier[]): string[] {
  const res = mods.filter((m) => m.kind === 'flat' && RESISTANCES.includes(m.stat) && !m.tags);
  const allRes = res.length === 3 && new Set(res.map((m) => m.stat)).size === 3 && res.every((m) => m.value === res[0]!.value);
  const lines: string[] = [];
  let resDone = false;
  for (const m of mods) {
    if (allRes && res.includes(m)) {
      if (!resDone) lines.push(`${signedPct(m.value)} опору всім стихіям`);
      resDone = true;
      continue;
    }
    lines.push(formatModifier(m));
  }
  return lines;
}

function conditionText(c: PassiveCondition): string {
  switch (c.kind) {
    case 'movedWithin':
      return `Поки рухаєтеся (рух за останні ${num(c.seconds)} с)`;
    case 'stationaryFor':
      return `Якщо стоїте на місці ≥ ${num(c.seconds)} с`;
    case 'lifeBelow':
      return `Поки життя нижче ${pct(c.fraction)}`;
    case 'targetHasStatus':
      return `Проти ${STATUS_TARGET[c.status]} ворогів`;
  }
}

function changeText(c: SkillParamChange): string {
  const p = PARAM[c.param];
  const parts: string[] = [];
  if (c.add !== undefined) parts.push(`${signed(c.add)}${p.unit}`);
  if (c.increased !== undefined) parts.push(signedPct(c.increased));
  return `${p.name} ${parts.join(', ')}`;
}

function skillTarget(skillIds: readonly string[] | undefined, tags: readonly string[] | undefined): string {
  if (skillIds && skillIds.length > 0) return skillIds.map((id) => SKILL_NAMES.get(id) ?? id).join(', ');
  if (tags && tags.length > 0) return `Скіли (${tags.map((t) => TAG_FOR[t as Tag] ?? t).join(', ')})`;
  return 'Скіли';
}

export function formatMechanic(m: PassiveMechanic): string[] {
  switch (m.kind) {
    case 'bloodMagic':
      return [`Скіли коштують життя замість мани (${num(m.lifePerMana)} життя за 1 ману)`, 'Максимум мани = 0'];
    case 'alwaysCrit':
      return ['Усі влучання критичні', `Множник криту фіксований: ×${num(m.critMultiplier)}, бонуси до множника не діють`];
    case 'lifeToEnergyShield':
      return [
        'Базове життя (клас і рівні) стає енергетичним щитом',
        ...(m.lifeRegenToShield ? ['Регенерація життя відновлює щит'] : []),
        `Максимум життя = ${num(m.maxLife)}`,
      ];
    case 'lifeLeech':
      return [
        `${pct(m.fraction)} завданого урону відновлює життя (вампіризм; лише від ударів, не від підпалу й вибухів)`,
        ...(m.maxPerSecond !== undefined ? [`Не більше ${pct(m.maxPerSecond)} макс. життя за секунду`] : []),
      ];
    case 'lifePotionEffectiveness':
      return [`Зілля здоров'я відновлюють ${pct(m.multiplier)} від звичайного`];
    case 'conditionalModifiers':
      return [`${conditionText(m.condition)}: ${formatModifiers(m.modifiers).join(', ')}`];
    case 'moreDamagePerMissingLife':
      return [`${pct(m.perMissingLife / 100)} більше урону за кожен 1% втраченого життя й ЕЩ, максимум ${pct(m.max)}`];
    case 'skillParams': {
      const target = skillTarget(m.skillIds, m.tags);
      const lines: string[] = [];
      if (m.changes && m.changes.length > 0) lines.push(`${target}: ${m.changes.map(changeText).join(', ')}`);
      for (const c of m.statusDurations ?? []) {
        const parts: string[] = [];
        if (c.add !== undefined) parts.push(`${signed(c.add)} с`);
        if (c.increased !== undefined) parts.push(signedPct(c.increased));
        lines.push(`${target}: тривалість ${STATUS_GENITIVE[c.status as PassiveStatusId] ?? c.status} ${parts.join(', ')}`);
      }
      if (m.buffModifiers && m.buffModifiers.length > 0) lines.push(`${target}: баф також дає ${formatModifiers(m.buffModifiers).join(', ')}`);
      for (const s of m.addOnHit ?? []) {
        const power = s.magnitude !== undefined ? ` на ${pct(s.magnitude)}` : '';
        lines.push(`${target}: влучання накладає ${STATUS[s.status]}${power} на ${num(s.duration)} с`);
      }
      return lines;
    }
    case 'stunBar':
      return [
        `Кожне влучання наповнює шкалу оглушення ворога на ${pct(m.baseFill)} + урон / макс. життя ворога × ${pct(m.damageFill)}`,
        `Повна шкала оглушує на ${num(m.stunDuration)} с (бос: наповнення ×${num(m.bossFillFactor)}, ${num(m.bossStunDuration)} с)`,
        `Без ударів ${num(m.decayDelay)} с шкала спадає на ${pct(m.decayPerSecond)}/с`,
      ];
    case 'stunBonus':
      return [`${signedPct(m.fillIncreased)} наповнення шкали оглушення`, `${signedPct(m.durationIncreased)} тривалості оглушень`];
    case 'counterAttack':
      return [`Коли ворог б'є вас у ближньому бою: удар у відповідь (${pct(m.effectiveness)} базової атаки), не частіше ніж раз на ${num(m.cooldown)} с`];
    case 'distanceDamage':
      return [`Снаряди атак завдають більше урону (more) з пройденою відстанню: від 0% на ${num(m.minDistance)} до ${pct(m.maxMore)} на ${num(m.maxDistance)}+ од.`];
    case 'trapCharges':
      return [
        `Пастка має ${m.charges} ${plural(m.charges, 'заряд', 'заряди', 'зарядів')}, до ${m.maxActive} ${plural(m.maxActive, 'пастки', 'пасток', 'пасток')} одночасно`,
        `Вибух пастки за ${num(m.chainDelay)} с підриває інші ваші пастки в радіусі ${num(m.chainRadius)}`,
      ];
    case 'trapAura':
      return [`Зведена пастка сповільнює ворогів у радіусі ${num(m.radius)} на ${pct(m.slow)}`];
    case 'ignite':
      return [`Влучання (${DAMAGE_TYPE[m.damageType] ?? m.damageType} урон) мають ${pct(m.chance)} шансу підпалити: ${pct(m.damageFraction)} урону влучання за ${num(m.duration)} с`];
    case 'deathExplosion': {
      const extra = m.applyStatus ? `, накладає ${STATUS[m.applyStatus]}` : '';
      return [`Ворог, що помер під дією «${STATUS[m.status]}», вибухає: ${pct(m.lifeFraction)} його макс. життя як ${DAMAGE_TYPE[m.damageType] ?? m.damageType} урон, радіус ${num(m.radius)}${extra}`];
    }
    case 'deathExplosionRadius':
      return [`${signedPct(m.increased)} радіуса вибухів при смерті`];
    case 'freezeSlowed':
      return [`${skillTarget(m.skillIds, undefined)} заморожує вже сповільнених ворогів на ${num(m.duration)} с (бос: ${num(m.bossDuration)} с)`];
  }
}

export const PENDING_EFFECT = 'Ефект ще в розробці';

/** All effect lines of a node: stat modifiers first, then mechanics. */
export function describeNode(node: PassiveNodeDef): string[] {
  return [...formatModifiers(node.modifiers ?? []), ...(node.mechanics ?? []).flatMap(formatMechanic)];
}

export const ALLOCATE_ERRORS: Record<AllocateError, string> = {
  'unknown-node': 'Невідомий вузол.',
  'start-node': 'Стартова точка класу: не береться, з неї ростуть шляхи.',
  'already-allocated': 'Уже взято.',
  'other-class-spec': 'Спеціалізація іншого класу: закрито.',
  'other-spec': 'Ви обрали іншу спеціалізацію. Змініть її, щоб відкрити цю гілку.',
  exclusive: 'Несумісний із уже взятим ключовим вузлом.',
  'not-connected': "Не з'єднано з вашими вузлами.",
  'no-points': 'Бракує очок талантів.',
  'no-spec-points': 'Бракує очок спеціалізації.',
};

export const RESPEC_ERRORS: Record<RespecError, string> = {
  'unknown-node': 'Невідомий вузол.',
  'not-allocated': 'Цей вузол не взято.',
  disconnects: "Не можна зняти: інші вузли втратять зв'язок зі стартом.",
  'nothing-to-reset': 'Нічого скидати.',
  currency: 'Бракує осколків.',
};

/** Ukrainian plural: 1 очко, 2–4 очки, 5+ очок (11–14 → очок). */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export const pointsWord = (n: number): string => `${n} ${plural(n, 'очко', 'очки', 'очок')}`;
export const shardsWord = (n: number): string => `${n} ${plural(n, 'осколок', 'осколки', 'осколків')}`;

/** Banner text: "Маєте 3 очки талантів" (+ spec points when any). */
export function unspentBanner(points: number, specPoints: number): string {
  const parts: string[] = [];
  if (points > 0) parts.push(`${pointsWord(points)} талантів`);
  if (specPoints > 0) parts.push(`${pointsWord(specPoints)} спеціалізації`);
  return `Маєте ${parts.join(' і ')}`;
}

/** Respec price label: "безкоштовно" or "3 осколки". */
export const costLabel = (cost: number): string => (cost > 0 ? shardsWord(cost) : 'безкоштовно');

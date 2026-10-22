import type { PassiveMechanic, PassiveNodeDef, PassiveNodePos, PassiveNodeType, PassiveTreeData, SpecBranchDef } from '../core/passives/types';
import type { Modifier, StatId, Tag } from '../core/stats/types';

// Passive wheel + specialization branches. Transcribed from docs/design/passives-wheel.md (approved 2026-10-22).
// All numbers are PROPOSAL until balance pass.

// ---- Modifier shorthands ----------------------------------------------------------------------

const mod = (stat: StatId, kind: Modifier['kind'], value: number, tags: Tag[]): Modifier =>
  tags.length > 0 ? { stat, kind, value, tags } : { stat, kind, value };
const inc = (stat: StatId, value: number, ...tags: Tag[]): Modifier => mod(stat, 'increased', value, tags);
const flat = (stat: StatId, value: number, ...tags: Tag[]): Modifier => mod(stat, 'flat', value, tags);
const more = (stat: StatId, value: number, ...tags: Tag[]): Modifier => mod(stat, 'more', value, tags);
const dmg = (value: number, ...tags: Tag[]): Modifier => inc('damage', value, ...tags);
const allRes = (value: number): Modifier[] => [flat('fireResistance', value), flat('coldResistance', value), flat('lightningResistance', value)];

/** Standard small-node values ("Стандартні значення малих вузлів"). */
const SMALL = {
  taggedDamage: 0.08,
  damage: 0.05,
  life: 0.04,
  energyShield: 0.08,
  armour: 0.1,
  allRes: 0.05,
  critChance: 0.12,
  critMultiplier: 0.08,
  speed: 0.04,
  movementSpeed: 0.03,
  cooldownRecovery: 0.04,
  resource: 10,
  lifeRegen: 0.6,
  resourceRegen: 1,
} as const;

/** Point cost by node type. Spec node costs are in spec points. */
const COST: Record<PassiveNodeType, number> = {
  start: 0,
  small: 1,
  notable: 2,
  keystone: 3,
  specEntry: 1,
  specKeystone: 1,
  spec: 1,
};

// ---- Layout (render hint only) --------------------------------------------------------------------
// Angles: degrees counter-clockwise from east, y up. Warrior on top, ranger lower right, mage lower left;
// hybrid zones between them, inner ring and keystones in the centre, spec branches outside the starts.

const ANGLE = { warrior: 90, ranger: 330, mage: 210, wr: 30, rm: 270, mw: 150 } as const;
// Six central keystones, one per inner-ring node at the same angle (60° apart).
const R = { keystone: 75, inner: 150, arm3: 210, arm2: 260, arm1: 330, outer: 400, spec1: 480, spec2: 560, spec3: 580, spec4: 640, spec5: 720 } as const;

const at = (angleDeg: number, radius: number): PassiveNodePos => ({ angleDeg: ((angleDeg % 360) + 360) % 360, radius });

/** Class zone slots relative to the class angle; `b` arm goes counter-clockwise (+), `c` arm clockwise (−). */
const CLASS_SLOTS = {
  start: [0, R.outer],
  a1: [0, R.arm1],
  a2: [0, R.arm2],
  a3: [0, R.arm3],
  a4: [11, R.arm2],
  n1: [22, R.arm2],
  b1: [12, R.outer],
  b2: [24, R.outer],
  c1: [-12, R.outer],
  c2: [-24, R.outer],
  d1: [-12, R.arm1],
  n2: [-12, R.arm2],
} as const;

/** Hybrid zone slots relative to the zone angle. */
const HYBRID_SLOTS = {
  1: [-12, R.outer],
  2: [0, R.outer],
  3: [12, R.outer],
  4: [0, 310],
  5: [9, 250],
  n: [18, 200],
} as const;

/** Spec branch slots relative to the class angle; `side` mirrors the two branches of a class. */
const SPEC_SLOTS = {
  entry: [6, R.spec1],
  key: [9, R.spec2],
  a1: [5, R.spec4],
  a2: [4, R.spec5],
  b1: [12, R.spec4],
  b2: [13, R.spec5],
  c1: [16, R.spec3],
} as const;

const classPos = (angle: number) => (slot: keyof typeof CLASS_SLOTS) => at(angle + CLASS_SLOTS[slot][0], CLASS_SLOTS[slot][1]);
const hybridPos = (angle: number) => (slot: keyof typeof HYBRID_SLOTS) => at(angle + HYBRID_SLOTS[slot][0], HYBRID_SLOTS[slot][1]);
const specPos = (angle: number, side: 1 | -1) => (slot: keyof typeof SPEC_SLOTS) => at(angle + side * SPEC_SLOTS[slot][0], SPEC_SLOTS[slot][1]);

const Wp = classPos(ANGLE.warrior);
const Rp = classPos(ANGLE.ranger);
const Mp = classPos(ANGLE.mage);
const MWp = hybridPos(ANGLE.mw);
const WRp = hybridPos(ANGLE.wr);
const RMp = hybridPos(ANGLE.rm);

// ---- Node builders --------------------------------------------------------------------------------

type Extra = Partial<Pick<PassiveNodeDef, 'classId' | 'specId' | 'mechanics' | 'exclusiveGroup'>>;

function node(id: string, name: string, type: PassiveNodeType, pos: PassiveNodePos, modifiers: Modifier[] = [], extra: Extra = {}): PassiveNodeDef {
  return { id, name, type, cost: COST[type], pos, ...(modifiers.length > 0 ? { modifiers } : {}), ...extra };
}
const small = (id: string, name: string, pos: PassiveNodePos, modifiers: Modifier[]): PassiveNodeDef => node(id, name, 'small', pos, modifiers);
const notable = (id: string, name: string, pos: PassiveNodePos, modifiers: Modifier[]): PassiveNodeDef => node(id, name, 'notable', pos, modifiers);
interface KeystoneSpec {
  readonly mechanics?: PassiveMechanic[];
  readonly modifiers?: Modifier[];
  readonly exclusiveGroup?: string;
}
const keystone = (id: string, name: string, pos: PassiveNodePos, { mechanics, modifiers = [], exclusiveGroup }: KeystoneSpec): PassiveNodeDef =>
  node(id, name, 'keystone', pos, modifiers, { ...(mechanics ? { mechanics } : {}), ...(exclusiveGroup ? { exclusiveGroup } : {}) });
const start = (classId: string, name: string, pos: PassiveNodePos): PassiveNodeDef => node(`start_${classId}`, name, 'start', pos, [], { classId });

/** Keystones that cannot be taken together: with 1 life the hero cannot pay skills in life. */
const LIFE_POOL_GROUP = 'lifePool';

// ---- Wheel ----------------------------------------------------------------------------------------

const wheel: PassiveNodeDef[] = [
  start('warrior', 'Воїн', Wp('start')),
  start('ranger', 'Рейнджер', Rp('start')),
  start('mage', 'Маг', Mp('start')),

  // Warrior zone (11 nodes, 13 points)
  small('w_a1', 'Гострий клинок', Wp('a1'), [dmg(SMALL.taggedDamage, 'melee')]),
  small('w_a2', 'Міцне тіло', Wp('a2'), [inc('life', SMALL.life)]),
  small('w_a3', 'Важкий удар', Wp('a3'), [dmg(SMALL.taggedDamage, 'physical')]),
  small('w_a4', 'Темп бою', Wp('a4'), [inc('attackSpeed', SMALL.speed)]),
  notable('w_n1', 'Майстер клинка', Wp('n1'), [dmg(0.16, 'melee'), inc('attackSpeed', 0.06)]),
  small('w_b1', 'Латні пластини', Wp('b1'), [inc('armour', SMALL.armour)]),
  small('w_b2', 'Витривалість', Wp('b2'), [inc('life', SMALL.life)]),
  small('w_c1', 'Друге дихання', Wp('c1'), [flat('lifeRegen', SMALL.lifeRegen)]),
  small('w_c2', 'Бойова виучка', Wp('c2'), [dmg(SMALL.taggedDamage, 'attack')]),
  small('w_d1', 'Кольчуга', Wp('d1'), [inc('armour', SMALL.armour)]),
  notable('w_n2', 'Залізна шкіра', Wp('n2'), [inc('armour', 0.2), inc('life', 0.06), flat('lifeRegen', 1)]),

  // Ranger zone (11 nodes, 13 points)
  small('r_a1', 'Тугий лук', Rp('a1'), [dmg(SMALL.taggedDamage, 'projectile')]),
  small('r_a2', 'Пильне око', Rp('a2'), [inc('critChance', SMALL.critChance)]),
  small('r_a3', 'Швидка рука', Rp('a3'), [inc('attackSpeed', SMALL.speed)]),
  small('r_a4', 'Слабке місце', Rp('a4'), [flat('critMultiplier', SMALL.critMultiplier)]),
  notable('r_n1', 'Влучне око', Rp('n1'), [inc('critChance', 0.25), flat('critMultiplier', 0.15), dmg(0.1, 'projectile')]),
  small('r_b1', 'Легкі ноги', Rp('b1'), [inc('movementSpeed', SMALL.movementSpeed)]),
  small('r_b2', 'Точний приціл', Rp('b2'), [dmg(SMALL.taggedDamage, 'projectile')]),
  small('r_c1', 'Загартованість', Rp('c1'), [inc('life', SMALL.life)]),
  small('r_c2', 'Мандрівник', Rp('c2'), allRes(SMALL.allRes)),
  small('r_d1', 'Слідопит', Rp('d1'), [inc('movementSpeed', SMALL.movementSpeed)]),
  notable('r_n2', 'Мисливський інстинкт', Rp('n2'), [inc('movementSpeed', 0.06), inc('life', 0.06), flat('lifeRegen', 0.8)]),

  // Mage zone (11 nodes, 13 points)
  small('m_a1', 'Іскра', Mp('a1'), [dmg(SMALL.taggedDamage, 'spell')]),
  small('m_a2', 'Мерехтливий щит', Mp('a2'), [inc('energyShield', SMALL.energyShield)]),
  small('m_a3', 'Швидкі слова', Mp('a3'), [inc('castSpeed', SMALL.speed)]),
  small('m_a4', 'Широкий жест', Mp('a4'), [dmg(SMALL.taggedDamage, 'area')]),
  notable('m_n1', 'Архімаг', Mp('n1'), [dmg(0.16, 'spell'), inc('castSpeed', 0.06)]),
  small('m_b1', 'Подих зими', Mp('b1'), [dmg(SMALL.taggedDamage, 'cold')]),
  small('m_b2', 'Жар', Mp('b2'), [dmg(SMALL.taggedDamage, 'fire')]),
  small('m_c1', 'Глибокий колодязь', Mp('c1'), [flat('resource', SMALL.resource)]),
  small('m_c2', 'Розряд', Mp('c2'), [dmg(SMALL.taggedDamage, 'lightning')]),
  small('m_d1', 'Ясна думка', Mp('d1'), [flat('resourceRegen', SMALL.resourceRegen)]),
  notable('m_n2', 'Тиха течія', Mp('n2'), [inc('energyShield', 0.16), flat('energyShieldRegen', 2), flat('resourceRegen', 1.5)]),

  // Mage + Warrior hybrid (6 nodes, 7 points)
  small('mw_1', 'Розмах', MWp(1), [dmg(SMALL.taggedDamage, 'area')]),
  small('mw_2', 'Стійкість', MWp(2), [inc('life', SMALL.life)]),
  small('mw_3', 'Вогняна зброя', MWp(3), [dmg(SMALL.taggedDamage, 'fire')]),
  small('mw_4', 'Рунна броня', MWp(4), [inc('energyShield', SMALL.energyShield)]),
  small('mw_5', 'Стихійний захист', MWp(5), allRes(SMALL.allRes)),
  notable('mw_n', 'Бойовий маг', MWp('n'), [inc('life', 0.06), inc('energyShield', 0.12), dmg(0.12, 'area')]),

  // Warrior + Ranger hybrid (6 nodes, 7 points)
  small('wr_1', 'Мисливська зброя', WRp(1), [dmg(SMALL.taggedDamage, 'attack')]),
  small('wr_2', 'Холодний розрахунок', WRp(2), [inc('critChance', SMALL.critChance)]),
  small('wr_3', 'Ритм', WRp(3), [inc('attackSpeed', SMALL.speed)]),
  small('wr_4', 'Глибока рана', WRp(4), [flat('critMultiplier', SMALL.critMultiplier)]),
  small('wr_5', 'Рухливість', WRp(5), [inc('movementSpeed', SMALL.movementSpeed)]),
  notable('wr_n', 'Бойовий азарт', WRp('n'), [inc('critChance', 0.2), dmg(0.1, 'attack'), inc('movementSpeed', 0.03)]),

  // Ranger + Mage hybrid (6 nodes, 7 points)
  small('rm_1', 'Плавний жест', RMp(1), [inc('castSpeed', SMALL.speed)]),
  small('rm_2', 'Вітер у спину', RMp(2), [inc('movementSpeed', SMALL.movementSpeed)]),
  small('rm_3', 'Летючий снаряд', RMp(3), [dmg(SMALL.taggedDamage, 'projectile')]),
  small('rm_4', "Тонкий бар'єр", RMp(4), [inc('energyShield', SMALL.energyShield)]),
  small('rm_5', 'Статика', RMp(5), [dmg(SMALL.taggedDamage, 'lightning')]),
  notable('rm_n', 'Буревій', RMp('n'), [dmg(0.12, 'projectile'), dmg(0.12, 'lightning'), inc('movementSpeed', 0.05)]),

  // Inner ring (6 small nodes)
  small('i_w', 'Серце воїна', at(ANGLE.warrior, R.inner), [dmg(SMALL.damage)]),
  small('i_wr', 'Загартування', at(ANGLE.wr, R.inner), [inc('life', SMALL.life)]),
  small('i_r', 'Серце мисливця', at(ANGLE.ranger, R.inner), [dmg(SMALL.damage)]),
  small('i_rm', 'Потік', at(ANGLE.rm, R.inner), [inc('cooldownRecovery', SMALL.cooldownRecovery)]),
  small('i_m', 'Серце мага', at(ANGLE.mage, R.inner), [dmg(SMALL.damage)]),
  small('i_mw', 'Життєва сила', at(ANGLE.mw, R.inner), [inc('life', SMALL.life)]),

  // Keystones (dead ends off the inner ring)
  keystone('k_blood', 'Кровова жертва', at(ANGLE.mw, R.keystone), { mechanics: [{ kind: 'bloodMagic', lifePerResource: 1 }], exclusiveGroup: LIFE_POOL_GROUP }),
  keystone('k_precise', 'Точна рука', at(ANGLE.wr, R.keystone), { mechanics: [{ kind: 'alwaysCrit', critMultiplier: 1.3 }] }),
  keystone('k_crystal', 'Кришталевий панцир', at(ANGLE.rm, R.keystone), {
    mechanics: [{ kind: 'lifeToEnergyShield', maxLife: 1, lifeRegenToShield: true }],
    exclusiveGroup: LIFE_POOL_GROUP,
  }),
  keystone('k_swift', 'Швидкі ноги', at(ANGLE.ranger, R.keystone), {
    mechanics: [
      { kind: 'conditionalModifiers', condition: { kind: 'movedWithin', seconds: 0.5 }, modifiers: [more('damage', 0.3)] },
      { kind: 'conditionalModifiers', condition: { kind: 'stationaryFor', seconds: 0.5 }, modifiers: [more('damage', -0.3)] },
    ],
  }),
  // Keystones #5-6 (interview 2026-10-22). PROPOSAL numbers: balance-analyst to tune.
  // Bloodsucker: leech 5% of all hit damage, capped at 20% of max life (ES under Crystal Shell) per second;
  // no life regen (-100% more, also removes the life regen Crystal Shell turns into ES regen);
  // life potions heal ×0.5 (consumed when potions are implemented, 0.4).
  keystone('k_leech', 'Кровопивець', at(ANGLE.warrior, R.keystone), {
    modifiers: [more('lifeRegen', -1)],
    mechanics: [
      { kind: 'lifeLeech', fraction: 0.05, maxPerSecond: 0.2 },
      { kind: 'lifePotionEffectiveness', multiplier: 0.5 },
    ],
  }),
  // Glass Cannon: +40% more damage dealt, +40% more damage taken.
  keystone('k_glass', 'Скляна гармата', at(ANGLE.mage, R.keystone), { modifiers: [more('damage', 0.4), more('damageTaken', 0.4)] }),
];

/** Standard class zone shape; `bHybrid` / `cHybrid` are the hybrid zones the b / c arms lead to. */
function classEdges(x: string, bHybrid: string, cHybrid: string): [string, string][] {
  const s = `start_${{ w: 'warrior', r: 'ranger', m: 'mage' }[x]}`;
  return [
    [s, `${x}_a1`],
    [`${x}_a1`, `${x}_a2`],
    [`${x}_a2`, `${x}_a3`],
    [`${x}_a2`, `${x}_a4`],
    [`${x}_a4`, `${x}_n1`],
    [`${x}_a3`, `i_${x}`],
    [s, `${x}_b1`],
    [`${x}_b1`, `${x}_b2`],
    [`${x}_b2`, `${bHybrid}_1`],
    [s, `${x}_c1`],
    [`${x}_c1`, `${x}_c2`],
    [`${x}_c1`, `${x}_d1`],
    [`${x}_d1`, `${x}_n2`],
    [`${x}_c2`, `${cHybrid}_3`],
  ];
}

/** Standard hybrid zone shape (outer arc 1-2-3, stem 4 to the inner ring, 4-5-n). */
function hybridEdges(h: string): [string, string][] {
  return [
    [`${h}_1`, `${h}_2`],
    [`${h}_2`, `${h}_3`],
    [`${h}_2`, `${h}_4`],
    [`${h}_4`, `i_${h}`],
    [`${h}_4`, `${h}_5`],
    [`${h}_5`, `${h}_n`],
  ];
}

const wheelEdges: [string, string][] = [
  ...classEdges('w', 'mw', 'wr'),
  ...classEdges('r', 'wr', 'rm'),
  ...classEdges('m', 'rm', 'mw'),
  ...hybridEdges('mw'),
  ...hybridEdges('wr'),
  ...hybridEdges('rm'),
  ['i_w', 'i_wr'],
  ['i_wr', 'i_r'],
  ['i_r', 'i_rm'],
  ['i_rm', 'i_m'],
  ['i_m', 'i_mw'],
  ['i_mw', 'i_w'],
  ['i_mw', 'k_blood'],
  ['i_wr', 'k_precise'],
  ['i_r', 'k_swift'],
  ['i_rm', 'k_crystal'],
  ['i_w', 'k_leech'],
  ['i_m', 'k_glass'],
];

// ---- Specialization branches -----------------------------------------------------------------------
// Shape: start - entry - keystone -+- a1 - a2
//                                  +- b1 - b2
//                                  +- c1

interface SpecNodeSpec {
  readonly name: string;
  readonly modifiers?: Modifier[];
  readonly mechanics?: PassiveMechanic[];
}

interface SpecSpec {
  readonly id: string;
  readonly name: string;
  readonly classId: 'warrior' | 'ranger' | 'mage';
  readonly prefix: string;
  readonly side: 1 | -1;
  readonly nodes: Record<'entry' | 'key' | 'a1' | 'a2' | 'b1' | 'b2' | 'c1', SpecNodeSpec>;
}

const SPEC_NODE_TYPE = { entry: 'specEntry', key: 'specKeystone', a1: 'spec', a2: 'spec', b1: 'spec', b2: 'spec', c1: 'spec' } as const;

const specDefs: SpecSpec[] = [
  {
    id: 'berserker',
    name: 'Берсерк',
    classId: 'warrior',
    prefix: 'bz',
    side: 1,
    nodes: {
      entry: { name: 'Жага бою', modifiers: [dmg(0.15, 'melee'), inc('attackSpeed', 0.05)] },
      key: { name: 'Безумство', mechanics: [{ kind: 'moreDamagePerMissingLife', perMissingLife: 0.6, max: 0.45 }] },
      a1: { name: 'Товста шкура', modifiers: [inc('life', 0.1), flat('lifeRegen', 1)] },
      a2: {
        name: 'Невгамовність',
        mechanics: [{ kind: 'conditionalModifiers', condition: { kind: 'lifeBelow', fraction: 0.5 }, modifiers: [inc('attackSpeed', 0.15), inc('movementSpeed', 0.1)] }],
      },
      b1: { name: 'Різанина', modifiers: [flat('critMultiplier', 0.25, 'melee')] },
      b2: {
        name: 'Кривавий клич',
        mechanics: [{ kind: 'skillParams', skillIds: ['battle_cry'], changes: [{ param: 'buffDuration', add: 3 }], buffModifiers: [inc('attackSpeed', 0.2)] }],
      },
      c1: { name: 'Загартування', modifiers: allRes(0.1) },
    },
  },
  {
    id: 'guardian',
    name: 'Страж',
    classId: 'warrior',
    prefix: 'gd',
    side: -1,
    nodes: {
      entry: { name: 'Залізна стіна', modifiers: [inc('armour', 0.25), inc('life', 0.05)] },
      key: {
        name: 'Шкала оглушення',
        // Decay (designer decision 2026-10-22, PROPOSAL numbers): after 2 s without hero hits the bar drains 25% of the bar per second.
        mechanics: [{ kind: 'stunBar', baseFill: 0.1, damageFill: 1, stunDuration: 1, bossFillFactor: 0.5, bossStunDuration: 0.4, decayDelay: 2, decayPerSecond: 0.25 }],
      },
      a1: { name: 'Важка рука', mechanics: [{ kind: 'stunBonus', fillIncreased: 0.3, durationIncreased: 0.3 }] },
      a2: { name: 'Контратака', mechanics: [{ kind: 'counterAttack', effectiveness: 1, cooldown: 1 }] },
      b1: { name: 'Бастіон', modifiers: [inc('armour', 0.2), ...allRes(0.08)] },
      b2: {
        name: 'Добити лежачого',
        mechanics: [{ kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'stun' }, modifiers: [more('damage', 0.25)] }],
      },
      c1: { name: 'Щит наготові', mechanics: [{ kind: 'skillParams', skillIds: ['shield_charge'], changes: [{ param: 'cooldown', add: -1 }] }] },
    },
  },
  {
    id: 'sniper',
    name: 'Снайпер',
    classId: 'ranger',
    prefix: 'sn',
    side: 1,
    nodes: {
      entry: { name: 'Око яструба', modifiers: [inc('critChance', 0.25), dmg(0.1, 'projectile')] },
      key: {
        name: 'Далекий постріл',
        mechanics: [{ kind: 'distanceDamage', tags: ['attack', 'projectile'], minDistance: 150, maxDistance: 450, maxMore: 0.5 }],
      },
      a1: { name: 'Пробивний болт', mechanics: [{ kind: 'skillParams', tags: ['projectile'], changes: [{ param: 'pierce', add: 1 }] }] },
      a2: { name: 'Смертельна точність', modifiers: [flat('critMultiplier', 0.3, 'projectile')] },
      b1: { name: 'Холоднокровність', modifiers: [dmg(0.15, 'projectile'), inc('attackSpeed', 0.05)] },
      b2: {
        name: 'Далекобійність',
        mechanics: [
          {
            kind: 'skillParams',
            tags: ['projectile'],
            changes: [
              { param: 'range', increased: 0.25 },
              { param: 'projectileSpeed', increased: 0.2 },
            ],
          },
        ],
      },
      c1: { name: 'Відступ', modifiers: [inc('movementSpeed', 0.06), inc('life', 0.06)] },
    },
  },
  {
    id: 'trapper',
    name: 'Трапер',
    classId: 'ranger',
    prefix: 'tr',
    side: -1,
    nodes: {
      entry: { name: 'Сапер', modifiers: [dmg(0.2, 'area'), inc('cooldownRecovery', 0.1)] },
      key: { name: 'Мінне поле', mechanics: [{ kind: 'trapCharges', charges: 3, maxActive: 3, chainDelay: 0.15, chainRadius: 250 }] },
      a1: {
        name: 'Швидке зведення',
        mechanics: [
          {
            kind: 'skillParams',
            skillIds: ['explosive_trap'],
            changes: [
              { param: 'armTime', add: -0.25 },
              { param: 'triggerRadius', increased: 0.25 },
            ],
          },
        ],
      },
      a2: { name: 'Шрапнель', mechanics: [{ kind: 'skillParams', skillIds: ['explosive_trap'], changes: [{ param: 'explodeRadius', increased: 0.25 }] }] },
      b1: { name: 'Запальна суміш', modifiers: [dmg(0.2, 'fire')] },
      b2: { name: 'Приманка', mechanics: [{ kind: 'trapAura', radius: 150, slow: 0.3 }] },
      c1: {
        name: 'Легкий крок',
        modifiers: [inc('movementSpeed', 0.06)],
        mechanics: [{ kind: 'skillParams', skillIds: ['roll'], changes: [{ param: 'cooldown', add: -0.5 }] }],
      },
    },
  },
  {
    id: 'pyromancer',
    name: 'Піромант',
    classId: 'mage',
    prefix: 'py',
    side: 1,
    nodes: {
      entry: { name: 'Жар', mechanics: [{ kind: 'ignite', damageType: 'fire', chance: 0.3, damageFraction: 0.5, duration: 3 }] },
      key: {
        name: 'Погребальне вогнище',
        mechanics: [{ kind: 'deathExplosion', status: 'ignite', radius: 100, lifeFraction: 0.3, damageType: 'fire', applyStatus: 'ignite' }],
      },
      a1: { name: 'Розпал', modifiers: [flat('igniteChance', 0.2), inc('igniteDamage', 0.3)] },
      a2: {
        name: 'Пекло',
        mechanics: [
          { kind: 'skillParams', skillIds: ['fireball'], changes: [{ param: 'explodeRadius', increased: 0.2 }] },
          { kind: 'deathExplosionRadius', increased: 0.2 },
        ],
      },
      b1: { name: "Полум'яне серце", modifiers: [dmg(0.2, 'fire'), inc('castSpeed', 0.06)] },
      b2: {
        name: 'Попіл до попелу',
        mechanics: [{ kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'ignite' }, modifiers: [more('damage', 0.15)] }],
      },
      c1: { name: 'Вогняна шкіра', modifiers: [flat('fireResistance', 0.2), inc('energyShield', 0.12)] },
    },
  },
  {
    id: 'cryomancer',
    name: 'Кріомант',
    classId: 'mage',
    prefix: 'cr',
    side: -1,
    nodes: {
      entry: {
        name: 'Крижана хватка',
        mechanics: [
          { kind: 'freezeSlowed', skillIds: ['frost_nova'], duration: 1, bossDuration: 0.3 },
          // Only the nova's slow is extended (the design says "сповільнення нови"), not the freeze.
          { kind: 'skillParams', skillIds: ['frost_nova'], statusDurations: [{ status: 'slow', increased: 0.4 }] },
        ],
      },
      key: {
        name: 'Розбиття',
        mechanics: [
          { kind: 'conditionalModifiers', condition: { kind: 'targetHasStatus', status: 'freeze' }, modifiers: [more('damage', 0.25)] },
          { kind: 'deathExplosion', status: 'freeze', radius: 90, lifeFraction: 0.2, damageType: 'cold' },
        ],
      },
      a1: { name: 'Вічна мерзлота', modifiers: [inc('freezeDuration', 0.5)] },
      a2: { name: 'Холодна кров', mechanics: [{ kind: 'skillParams', skillIds: ['wand_bolt'], addOnHit: [{ status: 'slow', duration: 2, magnitude: 0.2 }] }] },
      b1: { name: 'Холодне серце', modifiers: [dmg(0.2, 'cold'), inc('energyShield', 0.1)] },
      b2: {
        name: 'Хуртовина',
        mechanics: [
          {
            kind: 'skillParams',
            skillIds: ['frost_nova'],
            changes: [
              { param: 'radius', increased: 0.2 },
              { param: 'cooldown', add: -0.5 },
            ],
          },
        ],
      },
      c1: { name: 'Іній', modifiers: [flat('resource', 15), flat('resourceRegen', 1)] },
    },
  },
];

const specNodes: PassiveNodeDef[] = specDefs.flatMap((spec) => {
  const pos = specPos(ANGLE[spec.classId], spec.side);
  return (Object.keys(spec.nodes) as (keyof SpecSpec['nodes'])[]).map((slot) => {
    const def = spec.nodes[slot];
    return node(`${spec.prefix}_${slot}`, def.name, SPEC_NODE_TYPE[slot], pos(slot), def.modifiers ?? [], {
      specId: spec.id,
      ...(def.mechanics ? { mechanics: def.mechanics } : {}),
    });
  });
});

const specEdges: [string, string][] = specDefs.flatMap(({ classId, prefix: p }) => [
  [`start_${classId}`, `${p}_entry`],
  [`${p}_entry`, `${p}_key`],
  [`${p}_key`, `${p}_a1`],
  [`${p}_a1`, `${p}_a2`],
  [`${p}_key`, `${p}_b1`],
  [`${p}_b1`, `${p}_b2`],
  [`${p}_key`, `${p}_c1`],
]);

const specs: Record<string, SpecBranchDef> = Object.fromEntries(specDefs.map(({ id, name, classId }) => [id, { id, name, classId }]));

export const passiveTree: PassiveTreeData = {
  nodes: Object.fromEntries([...wheel, ...specNodes].map((n) => [n.id, n])),
  edges: [...wheelEdges, ...specEdges],
  specs,
  points: { perLevel: 1, specMilestones: [6, 14, 22, 30, 40] },
  respec: {
    currency: 'shards',
    freeBelowLevel: 10,
    // 1 + floor(level / 10): 3 at level 20, 5 at level 40.
    node: { base: 1, perLevel: 0.1 },
    wheel: { base: 0, perLevel: 1 },
    spec: { base: 0, perLevel: 1.5 },
  },
};

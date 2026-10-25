import type { AllocateError } from '../core/passives/allocation';
import type { RespecError } from '../core/passives/respec';
import type { PassiveCondition, PassiveMechanic, PassiveNodeDef, PassiveNodeType, SkillParam, SkillParamChange } from '../core/passives/types';
import { listAnd, t, type MessageKey } from '../i18n';
import { skillName, statusText } from './contentText';
import { resourceText } from './resourceText';
import { damageTypeText, formatModifiers, num, pct, signed, signedPct, tagName } from './statText';

// Passive tree text (node effects, errors, points). Pure functions (tested), no Phaser.
// Only wording lives in the locale files; every number comes from the node data.
// `resourceId` (ClassDef.resource.id of the hero viewing the tree) names the resource; neutral wording without it.

export { formatModifier, formatModifiers, num } from './statText';

const NODE_TYPE_KEY: Readonly<Record<PassiveNodeType, MessageKey>> = {
  start: 'nodeType.start',
  small: 'nodeType.small',
  notable: 'nodeType.notable',
  keystone: 'nodeType.keystone',
  specEntry: 'nodeType.specEntry',
  specKeystone: 'nodeType.specKeystone',
  spec: 'nodeType.spec',
};

export const nodeTypeLabel = (type: PassiveNodeType): string => t(NODE_TYPE_KEY[type]);

/** Skill param names and units (passive params; supports add their own, see supportText). */
export const PARAM_KEY: Readonly<Record<SkillParam, MessageKey>> = {
  cooldown: 'param.cooldown',
  charges: 'param.charges',
  buffDuration: 'param.buffDuration',
  radius: 'param.radius',
  explodeRadius: 'param.explodeRadius',
  pierce: 'param.pierce',
  range: 'param.range',
  projectileSpeed: 'param.projectileSpeed',
  armTime: 'param.armTime',
  triggerRadius: 'param.triggerRadius',
  statusDuration: 'param.statusDuration',
};

/** Params counted in seconds get the seconds unit; pierce counts targets. */
const SECONDS: ReadonlySet<string> = new Set(['cooldown', 'buffDuration', 'armTime', 'statusDuration']);

function conditionText(c: PassiveCondition): string {
  switch (c.kind) {
    case 'movedWithin':
      return t('cond.movedWithin', { seconds: num(c.seconds) });
    case 'stationaryFor':
      return t('cond.stationaryFor', { seconds: num(c.seconds) });
    case 'lifeBelow':
      return t('cond.lifeBelow', { pct: pct(c.fraction) });
    case 'soulsAtMost':
      return t('cond.soulsAtMost', { value: num(c.value) });
    case 'cheatDeathRecharging':
      return t('cond.cheatDeathRecharging');
    case 'targetHasStatus':
      return t('cond.targetHasStatus', { status: statusText(c.status, 'target') });
  }
}

function changeText(c: SkillParamChange): string {
  const parts: string[] = [];
  if (c.add !== undefined) {
    if (c.param === 'pierce') parts.push(t('unit.targets', { count: Math.abs(c.add), sign: signed(c.add) }));
    else parts.push(SECONDS.has(c.param) ? t('unit.seconds', { value: signed(c.add) }) : signed(c.add));
  }
  if (c.increased !== undefined) parts.push(signedPct(c.increased));
  return t('change.param', { param: t(PARAM_KEY[c.param]), values: parts.join(t('list.separator')) });
}

function skillTarget(skillIds: readonly string[] | undefined, tags: readonly string[] | undefined): string {
  if (skillIds && skillIds.length > 0) return skillIds.map(skillName).join(t('list.separator'));
  if (tags && tags.length > 0) return t('target.taggedSkills', { tags: tags.map(tagName).join(t('list.separator')) });
  return t('target.skills');
}

export function formatMechanic(m: PassiveMechanic, resourceId?: string): string[] {
  switch (m.kind) {
    case 'bloodMagic': {
      const resGen = resourceText(resourceId, 'gen');
      const resAcc = resourceText(resourceId, 'acc');
      return [t('mech.bloodMagic.cost', { resGen, resAcc, life: num(m.lifePerResource) }), t('mech.bloodMagic.noResource', { resGen })];
    }
    case 'alwaysCrit':
      return [t('mech.alwaysCrit.all'), t('mech.alwaysCrit.fixed', { mult: num(m.critMultiplier) })];
    case 'lifeToEnergyShield':
      return [t('mech.crystal.convert'), ...(m.lifeRegenToShield ? [t('mech.crystal.regen')] : []), t('mech.crystal.maxLife', { value: num(m.maxLife) })];
    case 'lifeLeech':
      return [t('mech.leech', { pct: pct(m.fraction) }), ...(m.maxPerSecond !== undefined ? [t('mech.leech.cap', { pct: pct(m.maxPerSecond) })] : [])];
    case 'lifePotionEffectiveness':
      return [t('mech.potion', { pct: pct(m.multiplier) })];
    case 'conditionalModifiers':
      return [t('mech.conditional', { condition: conditionText(m.condition), mods: formatModifiers(m.modifiers, resourceId).join(t('list.separator')) })];
    case 'moreDamagePerMissingLife':
      return [t('mech.missingLife', { pct: pct(m.perMissingLife / 100), max: pct(m.max) })];
    case 'skillParams': {
      const target = skillTarget(m.skillIds, m.tags);
      const lines: string[] = [];
      if (m.changes && m.changes.length > 0) lines.push(t('mech.skill.changes', { target, changes: m.changes.map(changeText).join(t('list.separator')) }));
      for (const c of m.statusDurations ?? []) {
        const parts: string[] = [];
        if (c.add !== undefined) parts.push(t('unit.seconds', { value: signed(c.add) }));
        if (c.increased !== undefined) parts.push(signedPct(c.increased));
        lines.push(t('mech.skill.statusDuration', { target, status: statusText(c.status, 'gen'), values: parts.join(t('list.separator')) }));
      }
      if (m.buffModifiers && m.buffModifiers.length > 0) lines.push(t('mech.skill.buff', { target, mods: formatModifiers(m.buffModifiers, resourceId).join(t('list.separator')) }));
      for (const s of m.addOnHit ?? []) {
        const power = s.magnitude !== undefined ? t('mech.skill.power', { pct: pct(s.magnitude) }) : '';
        lines.push(t('mech.skill.addOnHit', { target, status: statusText(s.status, 'acc'), power, seconds: num(s.duration) }));
      }
      return lines;
    }
    case 'stunBar':
      return [
        t('mech.stunBar.fill', { base: pct(m.baseFill), damage: pct(m.damageFill) }),
        t('mech.stunBar.stun', { seconds: num(m.stunDuration), bossFill: num(m.bossFillFactor), bossSeconds: num(m.bossStunDuration) }),
        t('mech.stunBar.decay', { seconds: num(m.decayDelay), pct: pct(m.decayPerSecond) }),
      ];
    case 'stunBonus':
      return [t('mech.stunBonus.fill', { value: signedPct(m.fillIncreased) }), t('mech.stunBonus.duration', { value: signedPct(m.durationIncreased) })];
    case 'counterAttack':
      return [t('mech.counterAttack', { pct: pct(m.effectiveness), seconds: num(m.cooldown) })];
    case 'distanceDamage':
      return [t('mech.distanceDamage', { min: num(m.minDistance), max: pct(m.maxMore), maxDistance: num(m.maxDistance) })];
    case 'trapCharges':
      return [
        t('mech.trapCharges', { charges: t('unit.charges', { count: m.charges }), traps: t('unit.trapsUpTo', { count: m.maxActive }) }),
        t('mech.trapChain', { seconds: num(m.chainDelay), radius: num(m.chainRadius) }),
      ];
    case 'trapAura':
      return [t('mech.trapAura', { radius: num(m.radius), pct: pct(m.slow) })];
    case 'ignite':
      return [t('mech.ignite', { type: damageTypeText(m.damageType, 'adj'), pct: pct(m.chance), fraction: pct(m.damageFraction), seconds: num(m.duration) })];
    case 'deathExplosion': {
      const extra = m.applyStatus ? t('mech.deathExplosion.applies', { status: statusText(m.applyStatus, 'acc') }) : '';
      return [
        t('mech.deathExplosion', {
          statusAcc: statusText(m.status, 'acc'),
          statusTarget: statusText(m.status, 'target'),
          pct: pct(m.lifeFraction),
          type: damageTypeText(m.damageType, 'adj'),
          radius: num(m.radius),
          extra,
        }),
      ];
    }
    case 'deathExplosionRadius':
      return [t('mech.deathExplosionRadius', { value: signedPct(m.increased) })];
    case 'freezeSlowed':
      return [t('mech.freezeSlowed', { target: skillTarget(m.skillIds, undefined), seconds: num(m.duration), bossSeconds: num(m.bossDuration) })];
    // Unique-item mechanics: no passive node has them; the item's own effect text (unique.<id>.effect) describes them.
    case 'elementalArmour':
    case 'lifeOnCrit':
    case 'critAfterSkill':
    case 'souls':
    case 'cheatDeath':
    case 'raiseAllies':
    case 'allyOnlyResource':
      return [];
  }
}

export const pendingEffect = (): string => t('tree.pendingEffect');

/** All effect lines of a node: stat modifiers first, then mechanics. */
export function describeNode(node: PassiveNodeDef, resourceId?: string): string[] {
  return [...formatModifiers(node.modifiers ?? [], resourceId), ...(node.mechanics ?? []).flatMap((m) => formatMechanic(m, resourceId))];
}

const ALLOCATE_ERROR_KEY: Readonly<Record<AllocateError, MessageKey>> = {
  'unknown-node': 'tree.error.unknownNode',
  'start-node': 'tree.error.startNode',
  'already-allocated': 'tree.error.alreadyAllocated',
  'other-class-spec': 'tree.error.otherClassSpec',
  'other-spec': 'tree.error.otherSpec',
  exclusive: 'tree.error.exclusive',
  'not-connected': 'tree.error.notConnected',
  'no-points': 'tree.error.noPoints',
  'no-spec-points': 'tree.error.noSpecPoints',
};

const RESPEC_ERROR_KEY: Readonly<Record<RespecError, MessageKey>> = {
  'unknown-node': 'tree.error.unknownNode',
  'not-allocated': 'tree.error.notAllocated',
  disconnects: 'tree.error.disconnects',
  'nothing-to-reset': 'tree.error.nothingToReset',
  currency: 'tree.error.currency',
};

export const allocateError = (error: AllocateError): string => t(ALLOCATE_ERROR_KEY[error]);
export const respecError = (error: RespecError): string => t(RESPEC_ERROR_KEY[error]);

export const pointsWord = (n: number): string => t('unit.points', { count: n });
export const shardsWord = (n: number): string => t('unit.shards', { count: n });
export const nodesWord = (n: number): string => t('unit.nodes', { count: n });

/** Banner text: "You have 3 talent points" (+ spec points when any). */
export function unspentBanner(points: number, specPoints: number): string {
  const parts: string[] = [];
  if (points > 0) parts.push(t('banner.talentPoints', { count: points }));
  if (specPoints > 0) parts.push(t('banner.specPoints', { count: specPoints }));
  return t('banner.unspent', { points: listAnd(parts) });
}

/** Respec price label: "free" or "3 shards". */
export const costLabel = (cost: number): string => (cost > 0 ? shardsWord(cost) : t('common.free'));

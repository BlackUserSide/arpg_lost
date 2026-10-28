import type { QaPreset } from '../core/qa/qa';

// QA / closed-beta test mode (ZBT-1): "late game in one tap". Not balance: these only pick where a tester lands.
// PROPOSAL (agent): level 30 = 4th spec milestone, 29 passive points; maps up to 30 (of 40 linear); uniques rolled
// at item level 30, so the hero (level 30) can wear all of them.
export const qaPreset: QaPreset = {
  level: 30,
  mapsUpTo: 30,
  itemLevel: 30,
  // Coordinator request 2026-10-27: the preset also maxes every class skill.
  maxSkills: true,
};

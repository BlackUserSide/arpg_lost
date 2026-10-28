import type * as Phaser from 'phaser';
import type { CharacterRecord, Profile } from '../core/progression/profile';
import { qaApplyPreset, qaGrantUniques, qaMaxSkills, qaSetLevel, qaUnlockMaps, type QaData, type QaGrantResult, type QaLevelResult } from '../core/qa/qa';
import { createRng } from '../core/rng';
import { classes } from '../data/classes';
import { itemsData } from '../data/items';
import { mapsData } from '../data/maps';
import { passiveTree } from '../data/passives';
import { progression } from '../data/progression';
import { qaPreset } from '../data/qa';
import { skillLevels } from '../data/skillLevels';
import { t } from '../i18n';
import { className } from './contentText';
import { fitText, heading, label, makeButton, makeFrame, UI } from './ui';

// Closed-beta QA panel (main menu, hidden behind the secret unlock on the version label): one-tap shortcuts from
// src/core/qa on the selected hero. The panel only picks which helper to call; the caller saves and rebuilds.

const QA_DATA: QaData = { progression, tree: passiveTree, maps: mapsData.rules, items: itemsData, classes, skillRules: skillLevels.rules };

/** Tester shortcuts, not balance: where a tester lands (the core helpers clamp to the real limits). */
const LEVEL_CHOICES = [10, 20, 30, 40] as const;
const MAP_CHOICES = [10, 20, 30, 40] as const;

/** One line of the last action's result; `warn` lines are drawn in the danger colour. */
export interface QaResultLine {
  readonly text: string;
  readonly warn?: boolean;
}

const levelLines = (r: QaLevelResult): QaResultLine[] => [
  { text: t('qa.levelSet', { level: r.level }) },
  ...(r.passivesReset ? [{ text: t('qa.passivesReset'), warn: true }] : []),
];

const itemLines = (r: QaGrantResult): QaResultLine[] => [
  { text: t('qa.items', { stash: r.stash, mail: r.overflow, lost: r.lost }) },
  ...(r.lost > 0 ? [{ text: t('qa.itemsLost', { lost: r.lost }), warn: true }] : []),
];

const rng = (): ReturnType<typeof createRng> => createRng(Date.now() >>> 0);

function applyLateGame(profile: Profile, hero: CharacterRecord): QaResultLine[] {
  const r = qaApplyPreset(profile, hero.id, rng(), qaPreset, QA_DATA);
  return [
    { text: t('qa.presetDone') },
    ...levelLines(r.level),
    { text: t('qa.mapsSet', { map: r.mapsUnlocked }) },
    ...itemLines(r.items),
    ...(r.maxedSkills.length > 0 ? [{ text: t('qa.skillsMaxed', { count: r.maxedSkills.length }) }] : []),
  ];
}

export interface QaPanelOptions {
  readonly profile: Profile;
  /** Selected hero; none = only a hint is shown. */
  readonly hero: CharacterRecord | undefined;
  readonly compact: boolean;
  /** Result of the last action (shown under the buttons). */
  readonly lines: readonly QaResultLine[];
  /** After an action mutated the profile: save, remember the lines, rebuild the menu. */
  readonly onApplied: (lines: QaResultLine[]) => void;
  readonly onClose: () => void;
  /** Screen / viewport sizes (render/viewport.ts), refreshed while the panel is open: testers screenshot it. */
  readonly diagnostics?: () => string;
}

/** How often the size readout refreshes (ms). */
const DIAGNOSTICS_REFRESH_MS = 500;

/** Builds the modal QA panel into `root` (centred, sized to the screen; tapping the shade closes it). */
export function buildQaPanel(scene: Phaser.Scene, root: Phaser.GameObjects.Container, o: QaPanelOptions): void {
  const { width, height } = scene.scale;
  const { compact, hero, profile } = o;
  const shade = scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.6).setInteractive();
  shade.on('pointerup', o.onClose);

  const pad = compact ? 12 : 20;
  const gap = compact ? 6 : 10;
  const headerH = compact ? 40 : 56;
  const heroH = compact ? 22 : 34;
  const lineH = compact ? 17 : 20;
  const panelW = Math.min(compact ? 560 : 600, width - 16);
  const innerW = panelW - pad * 2;
  // The last result as two wrapped paragraphs (plain, then warnings), measured first: the buttons get what is left.
  const resultSize = compact ? 12 : UI.size.small;
  const paragraph = (warn: boolean): Phaser.GameObjects.Text | undefined => {
    const text = o.lines.filter((l) => (l.warn ?? false) === warn).map((l) => l.text).join(' ');
    if (!hero || !text) return undefined;
    return label(scene, width / 2, 0, text, resultSize, warn ? UI.danger : UI.muted).setOrigin(0.5, 0).setWordWrapWidth(innerW).setAlign('center');
  };
  const results = [paragraph(false), paragraph(true)].filter((p): p is Phaser.GameObjects.Text => p !== undefined);
  const resultH = Math.max(lineH * 2, results.reduce((h, p) => h + p.height, 0)) + 4;
  // Size readout under the title (technical, not translated), measured with its wrapping.
  const diag = o.diagnostics
    ? label(scene, width / 2, 0, o.diagnostics(), compact ? 10 : 12, UI.muted).setOrigin(0.5, 0).setWordWrapWidth(innerW).setAlign('center')
    : undefined;
  const diagH = diag ? diag.height + 2 : 0;
  const rows = hero ? 4 : 0;
  // Buttons shrink to whatever the screen has left (phones in landscape), but stay a comfortable touch size.
  const fixedH = headerH + diagH + heroH + (hero ? resultH : 0) + pad * 2 + (hero ? gap * (rows - 1) + gap / 2 + 2 : 0);
  const btnH = hero ? Math.max(32, Math.min(compact ? 40 : 48, (height - 8 - fixedH) / rows)) : 0;
  const panelH = Math.min(height - 8, fixedH + btnH * rows + (hero ? 0 : lineH * 2));
  const top = height / 2 - panelH / 2;
  const left = width / 2 - panelW / 2 + pad;
  const panel = makeFrame(scene, width / 2, height / 2, panelW, panelH, 'panel').setInteractive();
  root.add([shade, panel]);

  const closeSize = compact ? 34 : 40;
  root.add(fitText(heading(scene, width / 2, top + headerH / 2 + 4, t('qa.title'), compact ? 22 : 28).setOrigin(0.5), panelW - closeSize * 2 - 40));
  root.add(makeButton(scene, width / 2 + panelW / 2 - closeSize / 2 - 10, top + closeSize / 2 + 10, closeSize, closeSize, '✕', o.onClose));

  if (diag && o.diagnostics) {
    const read = o.diagnostics;
    root.add(diag.setY(top + headerH));
    const timer = scene.time.addEvent({ delay: DIAGNOSTICS_REFRESH_MS, loop: true, callback: () => diag.setText(read()) });
    diag.once('destroy', () => timer.remove());
  }

  let y = top + headerH + diagH + heroH / 2;
  if (!hero) {
    root.add(fitText(label(scene, width / 2, y + lineH, t('qa.noHero'), UI.size.body, UI.muted).setOrigin(0.5), innerW));
    return;
  }
  const heroLine = `${hero.name} · ${t('menu.heroLine', { class: className(hero.classId), level: hero.level })}`;
  root.add(fitText(label(scene, width / 2, y, heroLine, UI.size.small, UI.goldBrightText, true).setOrigin(0.5), innerW));
  y += heroH / 2 + btnH / 2;

  const act = (run: () => QaResultLine[]) => () => o.onApplied(run());
  root.add(makeButton(scene, width / 2, y, Math.min(innerW, 320), btnH, t('qa.lateGame'), act(() => applyLateGame(profile, hero)), 'primary'));
  y += btnH + gap;

  // A caption on the left, four choice buttons on the right.
  const choiceRow = (caption: string, choices: readonly number[], pick: (value: number) => QaResultLine[]): void => {
    const captionW = Math.min(170, innerW * 0.34);
    root.add(fitText(label(scene, left, y, caption, compact ? UI.size.small : UI.size.body, UI.text, true).setOrigin(0, 0.5), captionW - 8));
    const bw = (innerW - captionW - gap * (choices.length - 1)) / choices.length;
    choices.forEach((value, i) => {
      const x = left + captionW + i * (bw + gap) + bw / 2;
      root.add(makeButton(scene, x, y, bw, btnH, String(value), act(() => pick(value))));
    });
    y += btnH + gap;
  };
  choiceRow(t('qa.heroLevel'), LEVEL_CHOICES, (level) => levelLines(qaSetLevel(profile, hero.id, level, QA_DATA)));
  choiceRow(t('qa.mapsUpTo'), MAP_CHOICES, (map) => [{ text: t('qa.mapsSet', { map: qaUnlockMaps(profile, hero.id, map, QA_DATA) }) }]);

  const halfW = (innerW - gap) / 2;
  root.add(makeButton(scene, left + halfW / 2, y, halfW, btnH, t('qa.uniques'), act(() => itemLines(qaGrantUniques(profile, hero.id, rng(), Math.max(1, hero.level), QA_DATA)))));
  root.add(
    makeButton(scene, left + halfW * 1.5 + gap, y, halfW, btnH, t('qa.maxSkills'), act(() => [{ text: t('qa.skillsMaxed', { count: qaMaxSkills(profile, hero.id, QA_DATA).length }) }])),
  );
  y += btnH / 2 + gap / 2 + 2;

  for (const text of results) {
    root.add(text.setY(y));
    y += text.height;
  }
}

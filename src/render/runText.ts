import type { MapsData, RunState } from '../core/run/types';
import { t } from '../i18n';

// Map run HUD text (docs/design/maps.md). Pure functions over core run state (tested), no Phaser.

/** "m:ss" for a countdown: rounded up, so the clock shows 0:00 only when the time is really out. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "m:ss" for elapsed time (rounded down). */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Combat rooms of the run (every planned room but the boss room). */
export function combatRoomCount(run: RunState): number {
  return run.rooms.filter((r) => r.kind === 'combat').length;
}

/** "Room 2/3" or "Boss room". */
export function roomLabel(run: RunState): string {
  const plan = run.rooms[run.room];
  if (!plan || plan.kind === 'boss') return t('run.bossRoom');
  return t('run.room', { room: run.room + 1, rooms: combatRoomCount(run) });
}

/** What the current room asks of the player: the wave count, the open door, the altar. */
export function phaseLabel(run: RunState): string {
  const plan = run.rooms[run.room];
  switch (run.phase) {
    case 'waves':
      return run.wavesSpawned === 0 ? t('run.getReady') : t('run.wave', { wave: run.wavesSpawned, waves: plan?.waves.length ?? run.wavesSpawned });
    case 'cleared':
      return t('run.doorOpen');
    case 'altar':
      return t('run.findAltar');
    case 'summoning':
      return t('run.summoning');
    case 'boss':
      return '';
  }
}

/** The line under the timer: "Map 7 · Room 2/3 · Wave 1/3". */
export function runInfoLine(run: RunState): string {
  const parts = [t('run.map', { map: run.mapLevel }), roomLabel(run), phaseLabel(run)].filter((p) => p !== '');
  return parts.join('  ·  ');
}

/** Seconds left from which the timer reads as urgent: the first (highest) time warning (RunRules.timeWarnings). */
export function urgentFrom(maps: MapsData): number {
  let first = 0;
  for (const s of maps.rules.timeWarnings) if (s > first) first = s;
  return first;
}

/** The timer reads as urgent from the first time warning on. */
export function timerUrgent(secondsLeft: number, maps: MapsData): boolean {
  return secondsLeft <= urgentFrom(maps) + 1e-6;
}

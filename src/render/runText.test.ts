import { afterEach, describe, expect, it } from 'vitest';
import { createRun } from '../core/run/run';
import type { RunState } from '../core/run/types';
import { content } from '../data';
import { mapsData } from '../data/maps';
import { setLocale } from '../i18n';
import { formatCountdown, formatElapsed, roomLabel, runInfoLine, timerUrgent } from './runText';

describe('run text', () => {
  afterEach(() => setLocale('en'));

  const run = (): RunState => createRun(content, mapsData, 'warrior', 7, {}, 7);

  it('formats the countdown rounded up and the elapsed time rounded down', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(299.2)).toBe('5:00');
    expect(formatCountdown(59.01)).toBe('1:00');
    expect(formatCountdown(9.5)).toBe('0:10');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3)).toBe('0:00');
    expect(formatElapsed(192.9)).toBe('3:12');
  });

  it('names the room and what it asks of the player', () => {
    const r = run();
    expect(runInfoLine(r)).toBe('Map 7  ·  Room 1/3  ·  Get ready');
    r.wavesSpawned = 1;
    expect(runInfoLine(r)).toBe(`Map 7  ·  Room 1/3  ·  Wave 1/${r.rooms[0]!.waves.length}`);
    r.phase = 'cleared';
    expect(runInfoLine(r)).toBe('Map 7  ·  Room 1/3  ·  The door is open');
    r.room = r.rooms.length - 1;
    r.phase = 'altar';
    expect(roomLabel(r)).toBe('Boss room');
    expect(runInfoLine(r)).toBe('Map 7  ·  Boss room  ·  Awaken the altar');
    r.phase = 'boss';
    expect(runInfoLine(r)).toBe('Map 7  ·  Boss room');
    setLocale('uk');
    expect(runInfoLine(r)).toBe('Карта 7  ·  Кімната боса');
  });

  it('turns the timer urgent from the first warning on', () => {
    expect(timerUrgent(61, mapsData)).toBe(false);
    expect(timerUrgent(60, mapsData)).toBe(true);
    expect(timerUrgent(5, mapsData)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { EventGuardPlatform } from './eventGuard';
import type { Platform } from './platform';

function recorder(): { platform: Platform; calls: string[] } {
  const calls: string[] = [];
  const platform: Platform = {
    name: 'test',
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    init: async () => {},
    getUser: async () => null,
    isLoginAvailable: () => false,
    showLogin: async () => null,
    onAuthChange: () => {},
    getLanguages: () => ['en'],
    loadingStart: () => calls.push('loadingStart'),
    loadingStop: () => calls.push('loadingStop'),
    gameplayStart: () => calls.push('gameplayStart'),
    gameplayStop: () => calls.push('gameplayStop'),
  };
  return { platform, calls };
}

describe('EventGuardPlatform', () => {
  it('drops a repeated gameplayStop (pause, then leaving the run)', () => {
    const { platform, calls } = recorder();
    const guarded = new EventGuardPlatform(platform);
    guarded.gameplayStart();
    guarded.gameplayStop();
    guarded.gameplayStop();
    guarded.gameplayStart();
    guarded.gameplayStart();
    guarded.gameplayStop();
    expect(calls).toEqual(['gameplayStart', 'gameplayStop', 'gameplayStart', 'gameplayStop']);
  });

  it('sends no gameplayStop before any gameplayStart', () => {
    const { platform, calls } = recorder();
    new EventGuardPlatform(platform).gameplayStop();
    expect(calls).toEqual([]);
  });

  it('pairs loading events the same way', () => {
    const { platform, calls } = recorder();
    const guarded = new EventGuardPlatform(platform);
    guarded.loadingStop();
    guarded.loadingStart();
    guarded.loadingStart();
    guarded.loadingStop();
    guarded.loadingStop();
    expect(calls).toEqual(['loadingStart', 'loadingStop']);
  });

  it('passes everything else through', () => {
    const { platform } = recorder();
    const guarded = new EventGuardPlatform(platform);
    expect(guarded.name).toBe('test');
    expect(guarded.storage).toBe(platform.storage);
    expect(guarded.getLanguages()).toEqual(['en']);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BETA_ACCESS_KEY, betaCodeHash, betaHashInput, checkBetaCode, hasBetaAccess, normalizeBetaCode, rememberBetaAccess } from './betaAccess';
import type { KeyValueStorage } from './platform';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The build-time recipe (vite.config.ts, Node crypto). */
const buildHash = (code: string): string => createHash('sha256').update(betaHashInput(code), 'utf8').digest('hex');

describe('beta access code', () => {
  it('ignores case and whitespace', () => {
    expect(normalizeBetaCode('  Ember Gate\t')).toBe('embergate');
    expect(normalizeBetaCode('ЖАР птиця')).toBe('жарптиця');
  });

  it('hashes in the browser exactly as the build does', async () => {
    for (const code of ['embergate', ' Ember Gate ', 'Жар-птиця 2026']) {
      expect(await betaCodeHash(code)).toBe(buildHash(code));
    }
  });

  it('accepts the right code in any case or spacing and rejects others', async () => {
    const hash = buildHash('Ember Gate');
    expect(await checkBetaCode('embergate', hash)).toBe(true);
    expect(await checkBetaCode(' EMBER  GATE ', hash)).toBe(true);
    expect(await checkBetaCode('ember', hash)).toBe(false);
    expect(await checkBetaCode('   ', hash)).toBe(false);
    expect(await checkBetaCode('embergate', '')).toBe(false);
  });

  it('remembers the unlocked hash; a new code asks again', () => {
    const storage = memoryStorage();
    const hash = buildHash('one');
    expect(hasBetaAccess(storage, hash)).toBe(false);
    rememberBetaAccess(storage, hash);
    expect(storage.data.get(BETA_ACCESS_KEY)).toBe(hash);
    expect(hasBetaAccess(storage, hash)).toBe(true);
    expect(hasBetaAccess(storage, buildHash('two'))).toBe(false);
    expect(hasBetaAccess(storage, '')).toBe(false);
  });

  it('survives storage that throws', () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    expect(() => rememberBetaAccess(broken, 'abc')).not.toThrow();
    expect(hasBetaAccess(broken, 'abc')).toBe(false);
  });
});

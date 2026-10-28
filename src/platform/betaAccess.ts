import { betaHashInput, normalizeBetaCode } from './betaHash';
import type { KeyValueStorage } from './platform';

export { BETA_SALT, betaHashInput, normalizeBetaCode } from './betaHash';

// Closed-beta access code for the public test build (GitHub Pages). This is a lock against casual visitors who got
// the link, NOT security: the repository is public, anyone can build the game without the gate, and a determined
// visitor can patch the check in the browser. It only keeps the test build out of reach of people who just open a
// shared URL.
//
// The code itself never enters the repository or the bundle. CI passes it as the BETA_CODE env var (a GitHub Actions
// secret) to `vite build`; vite.config.ts hashes it with the recipe of betaHash.ts (salt + normalised code, SHA-256) and
// bakes only the hex hash into the build as __BETA_CODE_HASH__. No BETA_CODE (local dev, the CrazyGames release ZIP)
// → an empty hash → no gate, and the gate's code is not even in the bundle (main.ts imports it behind that check).
// The player's input goes through the same recipe in the browser (crypto.subtle) and is compared with the baked hash.

/** Storage key of the remembered access: the hash that was unlocked (a new code in a new build asks again). */
export const BETA_ACCESS_KEY = 'arpg.betaAccess';

/** SHA-256 of the salted, normalised code as lower-case hex (Web Crypto: browsers and Node). */
export async function betaCodeHash(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(betaHashInput(code));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether `input` is the code behind `expectedHash`. Blank input is never accepted. */
export async function checkBetaCode(input: string, expectedHash: string): Promise<boolean> {
  if (normalizeBetaCode(input) === '' || expectedHash === '') return false;
  return (await betaCodeHash(input)) === expectedHash.toLowerCase();
}

/** This device already unlocked the build with this hash (storage errors read as "no"). */
export function hasBetaAccess(storage: KeyValueStorage, expectedHash: string): boolean {
  try {
    return expectedHash !== '' && storage.getItem(BETA_ACCESS_KEY) === expectedHash.toLowerCase();
  } catch {
    return false;
  }
}

/** Remembers the unlock on this device (best effort: blocked storage just asks again next launch). */
export function rememberBetaAccess(storage: KeyValueStorage, expectedHash: string): void {
  try {
    storage.setItem(BETA_ACCESS_KEY, expectedHash.toLowerCase());
  } catch {
    // Storage blocked (Safari private mode, partitioned iframe): the unlock lasts for this session only.
  }
}

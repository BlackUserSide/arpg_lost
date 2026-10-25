import type { KeyValueStorage } from '../platform/platform';

// Save checksum (roadmap 0.4 «Контрольна сума сейву», designer decision 2026-10-22): stored payloads are wrapped as
// {data, sig}, sig = hash(canonical JSON of data + a salt kept in code). Works over any KeyValueStorage (localStorage
// now, the CrazyGames Data module later: same interface), so local and cloud saves get the same protection.
// It only stops casual edits (devtools, save editors): the salt ships with the game. Real protection needs a server.

/** Changing it invalidates every stored signature (all saves would roll back / load unverified): never change. */
const SIG_SALT = 'arpg-lost/save-sig/v1:9f3c1e7a-52b4-4d0e-8a61-c7d2e4b90f15';

/** What a stored key holds. */
export type SignedRead =
  | { readonly kind: 'missing' }
  /** Not JSON or not an object: nothing to read. */
  | { readonly kind: 'corrupt'; readonly raw: string }
  /** An envelope whose signature matches. */
  | { readonly kind: 'signed'; readonly raw: string; readonly data: unknown }
  /** An envelope whose signature is missing or does not match (edited by hand). */
  | { readonly kind: 'tampered'; readonly raw: string; readonly data: unknown }
  /** A payload from before signatures (no envelope): the whole object is the data. */
  | { readonly kind: 'unsigned'; readonly raw: string; readonly data: unknown };

/**
 * 53-bit string hash (cyrb53: two multiplicative 32-bit lanes, mixed at the end) as 14 hex digits. Deterministic,
 * dependency-free and fast enough for a few hundred KB; not cryptographic.
 */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (2097151 & h2).toString(16).padStart(6, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * JSON with object keys sorted (recursively), so the same data always hashes the same no matter the key order it was
 * built or parsed in. Values follow JSON.stringify: undefined / functions are skipped in objects and null in arrays,
 * non-finite numbers are null.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    // An index loop, not map: holes of sparse arrays are null, as in JSON.stringify.
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i];
      items.push(v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v));
    }
    return `[${items.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v === undefined || typeof v === 'function') continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}

export function signData(data: unknown): string {
  return hashString(canonicalJson(data) + SIG_SALT);
}

/** Reads `key` and checks its signature. Never throws. */
export function readSigned(storage: KeyValueStorage, key: string): SignedRead {
  const raw = storage.getItem(key);
  if (raw === null || raw === '') return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', raw };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'corrupt', raw };
  const record = parsed as Record<string, unknown>;
  // An envelope (also one whose sig was deleted by hand); anything else is a payload from before signatures.
  if (!('sig' in record) && !('data' in record)) return { kind: 'unsigned', raw, data: record };
  const ok = typeof record.sig === 'string' && record.sig === signData(record.data);
  return { kind: ok ? 'signed' : 'tampered', raw, data: record.data };
}

/** Writes `data` signed to every key (the save and its backup). */
export function writeSigned(storage: KeyValueStorage, keys: readonly string[], data: unknown): void {
  const text = JSON.stringify({ data, sig: signData(data) });
  for (const key of keys) storage.setItem(key, text);
}

import type { KeyValueStorage, Platform, PlatformUser } from './platform';

const DEV_USER_KEY = 'dev.platformUser';

/**
 * Local stand-in for the portal. Starts as a guest; "login" creates a fake persistent user.
 * `?logout` in the URL clears it (the real portal reloads the page on logout too).
 */
export class LocalPlatform implements Platform {
  readonly name = 'local';
  readonly storage: KeyValueStorage = createSafeStorage();
  private listeners: Array<(user: PlatformUser | null) => void> = [];

  async init(): Promise<void> {
    if (new URLSearchParams(window.location.search).has('logout')) this.storage.removeItem(DEV_USER_KEY);
  }

  async getUser(): Promise<PlatformUser | null> {
    const raw = this.storage.getItem(DEV_USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PlatformUser;
    } catch {
      return null;
    }
  }

  isLoginAvailable(): boolean {
    return true;
  }

  async showLogin(): Promise<PlatformUser | null> {
    const existing = await this.getUser();
    if (existing) return existing;
    const user: PlatformUser = { id: 'local-user', username: 'DevPlayer', avatarUrl: '' };
    this.storage.setItem(DEV_USER_KEY, JSON.stringify(user));
    for (const listener of this.listeners) listener(user);
    return user;
  }

  onAuthChange(listener: (user: PlatformUser | null) => void): void {
    this.listeners.push(listener);
  }

  getLanguages(): readonly string[] {
    if (typeof navigator === 'undefined') return [];
    return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  }

  loadingStart(): void {}
  loadingStop(): void {}
  gameplayStart(): void {}
  gameplayStop(): void {}
}

/** localStorage with an in-memory fallback: storage can be blocked or partitioned inside iframes. */
export function createSafeStorage(): KeyValueStorage {
  const memory = new Map<string, string>();
  const tryLocal = <T>(fn: (ls: Storage) => T): T | undefined => {
    try {
      return fn(window.localStorage);
    } catch {
      return undefined;
    }
  };
  return {
    getItem: (key) => tryLocal((ls) => ls.getItem(key)) ?? memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
      tryLocal((ls) => ls.setItem(key, value));
    },
    removeItem: (key) => {
      memory.delete(key);
      tryLocal((ls) => ls.removeItem(key));
    },
  };
}

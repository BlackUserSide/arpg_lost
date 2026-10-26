import type { KeyValueStorage, Platform, PlatformUser } from './platform';

/**
 * Wraps a platform so the portal's state events only go out on a change: gameplayStart / gameplayStop and
 * loadingStart / loadingStop alternate, a repeated call is dropped (the CrazyGames SDK treats a second gameplayStop
 * as an error, and several screens can end gameplay at once: pause then leaving the run, run end, menus).
 * Every platform the game uses goes through this, so screens never need their own bookkeeping.
 */
export class EventGuardPlatform implements Platform {
  private gameplay = false;
  private loading = false;

  constructor(private readonly inner: Platform) {}

  get name(): string {
    return this.inner.name;
  }

  get storage(): KeyValueStorage {
    return this.inner.storage;
  }

  init(): Promise<void> {
    return this.inner.init();
  }

  getUser(): Promise<PlatformUser | null> {
    return this.inner.getUser();
  }

  isLoginAvailable(): boolean {
    return this.inner.isLoginAvailable();
  }

  showLogin(): Promise<PlatformUser | null> {
    return this.inner.showLogin();
  }

  onAuthChange(listener: (user: PlatformUser | null) => void): void {
    this.inner.onAuthChange(listener);
  }

  getLanguages(): readonly string[] {
    return this.inner.getLanguages();
  }

  loadingStart(): void {
    if (this.loading) return;
    this.loading = true;
    this.inner.loadingStart();
  }

  loadingStop(): void {
    if (!this.loading) return;
    this.loading = false;
    this.inner.loadingStop();
  }

  gameplayStart(): void {
    if (this.gameplay) return;
    this.gameplay = true;
    this.inner.gameplayStart();
  }

  gameplayStop(): void {
    if (!this.gameplay) return;
    this.gameplay = false;
    this.inner.gameplayStop();
  }
}

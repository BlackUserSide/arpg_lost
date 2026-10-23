// The only boundary between the game and the hosting portal. The CrazyGames SDK implementation
// plugs in here later (M5); until then LocalPlatform emulates guest / logged-in flows.

export interface PlatformUser {
  /** Stable id; link data by this, never by username. */
  readonly id: string;
  readonly username: string;
  /** May be empty; UI falls back to an initial. */
  readonly avatarUrl: string;
}

/** Same shape as the CrazyGames Data module (and localStorage). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Platform {
  readonly name: string;
  init(): Promise<void>;
  /** Null for guests. Re-read on every launch: username/avatar can change. */
  getUser(): Promise<PlatformUser | null>;
  /** Whether accounts are supported at all (show the login button only if true). */
  isLoginAvailable(): boolean;
  /** Opens the portal login popup. Resolves with the user, or null if cancelled. Never call automatically. */
  showLogin(): Promise<PlatformUser | null>;
  onAuthChange(listener: (user: PlatformUser | null) => void): void;
  /**
   * The user's language preferences, best first, as BCP 47 tags ("uk-UA"). Locally the browser's; with the
   * CrazyGames SDK the portal's user language should come first.
   */
  getLanguages(): readonly string[];
  readonly storage: KeyValueStorage;
  loadingStart(): void;
  loadingStop(): void;
  gameplayStart(): void;
  gameplayStop(): void;
}

import type * as Phaser from 'phaser';
import type { Profile } from '../core/progression/profile';
import { resolveLocale, setLocale, type Locale } from '../i18n';
import type { Platform, PlatformUser } from '../platform/platform';
import { loadProfile, saveProfile } from '../save/profileStore';
import { loadSettings, saveSettings, type Settings } from '../save/settingsStore';
import { loadFonts } from './fonts';

/** Session-wide state shared by scenes (stored in the game registry). */
export interface App {
  readonly platform: Platform;
  user: PlatformUser | null;
  profile: Profile;
  settings: Settings;
  selectedCharacterId: string | undefined;
  /** Guest login hint: shown at most once per session after a meaningful moment. */
  loginHint: 'none' | 'pending' | 'shown';
  save(): void;
  /** Re-reads profile and settings (after login / cloud sync); resolves once the language and its fonts are ready. */
  reloadProfile(): Promise<void>;
  /**
   * Manual language choice: saved at once (it wins over the browser language from now on); the locale switches once
   * its fonts are loaded. When choices overlap, only the latest one is applied.
   */
  setLanguage(locale: Locale): Promise<void>;
}

export const APP_KEY = 'app';

/** Number of the latest locale switch: a slower, older font load must not switch the locale back. */
let localeRequest = 0;

/**
 * Switches the locale after its glyphs are loaded (Polish needs the latin-ext subsets, Ukrainian the Cyrillic ones),
 * so a screen rebuilt afterwards never bakes fallback fonts. Resolves false when a newer switch superseded this one.
 */
async function switchLocale(locale: Locale): Promise<boolean> {
  const request = ++localeRequest;
  await loadFonts(locale);
  if (request !== localeRequest) return false;
  setLocale(locale);
  document.documentElement.lang = locale;
  return true;
}

/** The saved choice, or the user's language as the platform reports it (browser now, CrazyGames SDK later). */
const applySettings = (platform: Platform, settings: Settings): Promise<boolean> => switchLocale(resolveLocale(settings.language, platform.getLanguages()));

export async function createApp(platform: Platform): Promise<App> {
  await platform.init();
  const settings = loadSettings(platform.storage);
  await applySettings(platform, settings);
  const app: App = {
    platform,
    user: await platform.getUser(),
    profile: loadProfile(platform.storage).profile,
    settings,
    selectedCharacterId: undefined,
    loginHint: 'none',
    save: () => saveProfile(platform.storage, app.profile),
    // After login the portal may sync cloud data into storage, so re-read it (settings too).
    reloadProfile: async () => {
      app.profile = loadProfile(platform.storage).profile;
      app.settings = loadSettings(platform.storage);
      await applySettings(platform, app.settings);
    },
    setLanguage: async (locale) => {
      app.settings = { ...app.settings, language: locale };
      saveSettings(platform.storage, app.settings);
      await switchLocale(locale);
    },
  };
  app.selectedCharacterId = app.profile.characters[0]?.id;
  return app;
}

export function getApp(scene: Phaser.Scene): App {
  return scene.registry.get(APP_KEY) as App;
}

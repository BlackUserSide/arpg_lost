import type { KeyValueStorage } from '../platform/platform';

// Device / user settings (language today; sound, etc. later), stored under their own key through the same storage
// adapter as the profile (localStorage now, CrazyGames cloud data later). Kept apart from the profile on purpose:
// settings are not game progress, must be readable before (or without) a valid profile, and a settings change never
// needs a profile save-version bump or migration. Unknown fields are kept so older builds do not drop newer settings.

export const SETTINGS_KEY = 'arpg.settings';
export const SETTINGS_VERSION = 1;

export interface Settings {
  /** Manually chosen UI language (a locale code such as "uk"); absent = follow the browser / portal language. */
  language?: string;
  /** Closed-beta QA mode (secret unlock in the main menu): shows the QA panel. Absent = off. */
  qa?: boolean;
  readonly [key: string]: unknown;
}

interface SettingsFile {
  version: number;
  settings: Settings;
}

/** Stored settings; empty when nothing is stored or the stored copy is unreadable (settings are never critical). */
export function loadSettings(storage: KeyValueStorage): Settings {
  const raw = storage.getItem(SETTINGS_KEY);
  if (!raw) return {};
  try {
    const file = JSON.parse(raw) as Partial<SettingsFile> | null;
    if (typeof file !== 'object' || file === null || typeof file.settings !== 'object' || file.settings === null) return {};
    const settings: Settings = { ...file.settings };
    if (settings.language !== undefined && typeof settings.language !== 'string') delete settings.language;
    if (settings.qa !== undefined && typeof settings.qa !== 'boolean') delete settings.qa;
    return settings;
  } catch {
    return {};
  }
}

export function saveSettings(storage: KeyValueStorage, settings: Settings): void {
  const file: SettingsFile = { version: SETTINGS_VERSION, settings };
  storage.setItem(SETTINGS_KEY, JSON.stringify(file));
}

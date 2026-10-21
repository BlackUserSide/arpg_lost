import type * as Phaser from 'phaser';
import type { Profile } from '../core/progression/profile';
import type { Platform, PlatformUser } from '../platform/platform';
import { loadProfile, saveProfile } from '../save/profileStore';

/** Session-wide state shared by scenes (stored in the game registry). */
export interface App {
  readonly platform: Platform;
  user: PlatformUser | null;
  profile: Profile;
  selectedCharacterId: string | undefined;
  /** Guest login hint: shown at most once per session after a meaningful moment. */
  loginHint: 'none' | 'pending' | 'shown';
  save(): void;
  reloadProfile(): void;
}

export const APP_KEY = 'app';

export async function createApp(platform: Platform): Promise<App> {
  await platform.init();
  const app: App = {
    platform,
    user: await platform.getUser(),
    profile: loadProfile(platform.storage).profile,
    selectedCharacterId: undefined,
    loginHint: 'none',
    save: () => saveProfile(platform.storage, app.profile),
    // After login the portal may sync cloud data into storage, so re-read it.
    reloadProfile: () => {
      app.profile = loadProfile(platform.storage).profile;
    },
  };
  app.selectedCharacterId = app.profile.characters[0]?.id;
  return app;
}

export function getApp(scene: Phaser.Scene): App {
  return scene.registry.get(APP_KEY) as App;
}

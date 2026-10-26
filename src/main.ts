import * as Phaser from 'phaser';
import { EventGuardPlatform } from './platform/eventGuard';
import { LocalPlatform } from './platform/localPlatform';
import { APP_KEY, createApp } from './render/app';
import { CreateCharacterScene } from './render/CreateCharacterScene';
import { InventoryScene } from './render/InventoryScene';
import { RunScene } from './render/RunScene';
import { MainMenuScene } from './render/MainMenuScene';
import { PassiveTreeScene } from './render/PassiveTreeScene';
import { SupportsScene } from './render/SupportsScene';

async function boot(): Promise<void> {
  // Portal state events go out only on a change (eventGuard.ts).
  const platform = new EventGuardPlatform(new LocalPlatform());
  // Resolves the language and loads its fonts before the first scene draws text.
  const app = await createApp(platform);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#0b0a0e',
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
    // Touch pointers: pinch zoom on the passive tree; in a run the stick, the attack button and a skill / the potion at once.
    input: { activePointers: 4 },
    scene: [MainMenuScene, CreateCharacterScene, InventoryScene, RunScene, PassiveTreeScene, SupportsScene],
    callbacks: { preBoot: (g) => g.registry.set(APP_KEY, app) },
  });

  // Dev-only handle for debugging from the console.
  if (import.meta.env.DEV) (window as unknown as { __game: Phaser.Game }).__game = game;

  platform.onAuthChange((user) => {
    app.user = user;
    game.events.emit('auth-changed');
  });
}

void boot();

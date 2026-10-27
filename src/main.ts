import * as Phaser from 'phaser';
import { EventGuardPlatform } from './platform/eventGuard';
import { LocalPlatform } from './platform/localPlatform';
import { APP_KEY, createApp } from './render/app';
import { CreateCharacterScene } from './render/CreateCharacterScene';
import { InventoryScene } from './render/InventoryScene';
import { RunScene } from './render/RunScene';
import { MainMenuScene } from './render/MainMenuScene';
import { installOrientationGate } from './render/orientationGate';
import { PassiveTreeScene } from './render/PassiveTreeScene';
import { SupportsScene } from './render/SupportsScene';
import { fitViewport } from './render/viewport';

async function boot(): Promise<void> {
  // The page shell gets its size before the canvas does (iOS layout box quirks, render/viewport.ts).
  const keepViewportFit = fitViewport();
  // Portal state events go out only on a change (eventGuard.ts).
  const platform = new EventGuardPlatform(new LocalPlatform());
  // Resolves the language and loads its fonts before the first scene draws text.
  const app = await createApp(platform);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#0b0a0e',
    // Full screen takes the page shell around the game (index.html), so DOM overlays such as the name input go with it.
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%', fullscreenTarget: 'shell' },
    // Touch pointers: pinch zoom on the passive tree; in a run the stick, the attack button and a skill / the potion at once.
    input: { activePointers: 4 },
    scene: [MainMenuScene, CreateCharacterScene, InventoryScene, RunScene, PassiveTreeScene, SupportsScene],
    callbacks: { preBoot: (g) => g.registry.set(APP_KEY, app) },
  });

  keepViewportFit(game);
  // Phones play in landscape only: a cover asks to turn the phone while it is held upright.
  installOrientationGate(game);

  // Dev-only handle for debugging from the console.
  if (import.meta.env.DEV) (window as unknown as { __game: Phaser.Game }).__game = game;

  platform.onAuthChange((user) => {
    app.user = user;
    game.events.emit('auth-changed');
  });
}

void boot();

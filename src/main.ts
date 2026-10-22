import * as Phaser from 'phaser';
import { LocalPlatform } from './platform/localPlatform';
import { loadFonts } from './render/fonts';
import { APP_KEY, createApp } from './render/app';
import { CreateCharacterScene } from './render/CreateCharacterScene';
import { InventoryScene } from './render/InventoryScene';
import { IsoArenaScene } from './render/IsoArenaScene';
import { MainMenuScene } from './render/MainMenuScene';
import { PassiveTreeScene } from './render/PassiveTreeScene';

async function boot(): Promise<void> {
  const platform = new LocalPlatform();
  await loadFonts();
  const app = await createApp(platform);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#0b0a0e',
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
    // Two touch pointers for pinch zoom on the passive tree.
    input: { activePointers: 2 },
    scene: [MainMenuScene, CreateCharacterScene, InventoryScene, IsoArenaScene, PassiveTreeScene],
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

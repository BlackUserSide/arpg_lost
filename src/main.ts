import * as Phaser from 'phaser';
import { ClassSelectScene } from './render/ClassSelectScene';
import { IsoArenaScene } from './render/IsoArenaScene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#111111',
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [ClassSelectScene, IsoArenaScene],
});

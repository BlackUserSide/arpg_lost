import * as Phaser from 'phaser';
import { ArenaScene } from './render/ArenaScene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#111111',
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [ArenaScene],
});

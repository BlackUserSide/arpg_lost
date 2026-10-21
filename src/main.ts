import * as Phaser from 'phaser';
import { ArenaScene } from './render/ArenaScene';
import { IsoArenaScene } from './render/IsoArenaScene';

// ?view=flat — debug top-down view with shapes; default — isometric art test.
const flat = new URLSearchParams(window.location.search).get('view') === 'flat';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#111111',
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [flat ? ArenaScene : IsoArenaScene],
});

import * as Phaser from 'phaser';

class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create(): void {
    this.add
      .text(this.scale.width / 2, this.scale.height / 2, 'ARPG Lost — M1 scaffold', { color: '#ddd', fontSize: '24px' })
      .setOrigin(0.5);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#1a1a1a',
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [BootScene],
});

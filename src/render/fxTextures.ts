import type * as Phaser from 'phaser';

// Tiny procedural textures shared by visual effects (menu campfire, combat VFX). Generated once per game.

/** Soft white radial dot (64 px); tint it for glows, flames and puffs. */
export function softDotTexture(scene: Phaser.Scene): string {
  const key = 'fx:soft-dot';
  if (scene.textures.exists(key)) return key;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  scene.textures.addCanvas(key, canvas);
  return key;
}

/** 6 px white cross spark; tint it for embers. */
export function sparkTexture(scene: Phaser.Scene): string {
  const key = 'fx:spark';
  if (scene.textures.exists(key)) return key;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 6;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(2, 0, 2, 6);
  ctx.fillRect(0, 2, 6, 2);
  scene.textures.addCanvas(key, canvas);
  return key;
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toWorld } from '../../src/render/iso';
import { BAKE, CHARACTERS, type BakeAnim, type BakeCharacter } from './config';

// Rows in Flare order: W, NW, N, NE, E, SE, S, SW (screen directions). Must match render/iso directionRow.
const SCREEN_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];
const PITCH = Math.PI / 6; // 30°: ground compresses 2:1, matching render/iso.

const FRAME = BAKE.frameSize;
const INNER = FRAME / BAKE.pixelScale;

const logEl = document.getElementById('log')!;
const sheetsEl = document.getElementById('sheets')!;
const log = (msg: string): void => {
  logEl.textContent = msg;
  console.log(msg);
};

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(INNER, INNER);
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
sun.position.set(-1, 2.2, 1.2);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x8fa8ff, 0.8);
rim.position.set(-1, 0.6, -1.4);
scene.add(rim);

// Ortho camera: 1 world unit = 1 px along screen x; feet (origin) land at (FRAME/2, originY).
const camera = new THREE.OrthographicCamera(-FRAME / 2, FRAME / 2, BAKE.originY, BAKE.originY - FRAME, 1, 5000);
const dist = 2000;
camera.position.set((Math.cos(PITCH) / Math.SQRT2) * dist, Math.sin(PITCH) * dist, (Math.cos(PITCH) / Math.SQRT2) * dist);
camera.lookAt(0, 0, 0);

interface ManifestAnim {
  file: string;
  frames: number;
  fps: number;
  loop: boolean;
}

async function bakeCharacter(def: BakeCharacter): Promise<Record<string, ManifestAnim>> {
  const gltf = await new GLTFLoader().loadAsync(`/${def.model}`);
  const model = gltf.scene;
  model.traverse((obj) => {
    if (def.hide.includes(obj.name)) obj.visible = false;
    if ((obj as THREE.Mesh).isMesh) obj.frustumCulled = false;
  });
  for (const attachment of def.attach ?? []) {
    // GLTFLoader strips characters like '.' from node names.
    const bone = model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(attachment.bone));
    if (!bone) throw new Error(`Bone not found: ${attachment.bone}`);
    const prop = (await new GLTFLoader().loadAsync(`/${attachment.model}`)).scene;
    prop.traverse((obj) => (obj.frustumCulled = false));
    const [rx, ry, rz] = (attachment.rotation ?? [0, 0, 0]).map(THREE.MathUtils.degToRad) as [number, number, number];
    prop.rotation.set(rx, ry, rz);
    bone.add(prop);
  }

  const box = new THREE.Box3().setFromObject(model);
  const scale = def.height / Math.cos(PITCH) / (box.max.y - box.min.y);
  model.scale.setScalar(scale);
  model.position.y = -box.min.y * scale;
  scene.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const result: Record<string, ManifestAnim> = {};
  for (const anim of def.anims) {
    const file = `${def.id}_${anim.id}.png`;
    log(`Baking ${def.id} / ${anim.id}…`);
    const sheet = bakeAnim(model, mixer, gltf.animations, anim);
    outline(sheet);
    sheetsEl.append(document.createTextNode(`${file} `), sheet, document.createElement('br'));
    await save(`public/assets/sprites/${file}`, sheet.toDataURL('image/png').split(',')[1]!, 'base64');
    const clip = THREE.AnimationClip.findByName(gltf.animations, anim.clip)!;
    // Loops without explicit fps play at the clip's natural speed.
    const fps = anim.fps ?? Math.round((anim.frames / clip.duration) * 100) / 100;
    result[anim.id] = { file, frames: anim.frames, fps, loop: anim.loop };
  }
  scene.remove(model);
  return result;
}

function bakeAnim(model: THREE.Object3D, mixer: THREE.AnimationMixer, clips: THREE.AnimationClip[], anim: BakeAnim): HTMLCanvasElement {
  const clip = THREE.AnimationClip.findByName(clips, anim.clip);
  if (!clip) throw new Error(`Clip not found: ${anim.clip}`);
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(anim.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  action.clampWhenFinished = !anim.loop;
  action.play();

  const sheet = document.createElement('canvas');
  sheet.width = FRAME * anim.frames;
  sheet.height = FRAME * SCREEN_DIRS.length;
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  SCREEN_DIRS.forEach(([sx, sy], row) => {
    const w = toWorld({ x: sx, y: sy });
    // Ground plane is (x, z) = core world (x, y); glTF models face +Z.
    model.rotation.y = Math.atan2(w.x, w.y);
    for (let i = 0; i < anim.frames; i++) {
      const t = anim.loop ? (clip.duration * i) / anim.frames : Math.min(clip.duration - 1e-3, (clip.duration * i) / (anim.frames - 1));
      mixer.setTime(t);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, 0, 0, INNER, INNER, i * FRAME, row * FRAME, FRAME, FRAME);
    }
  });
  return sheet;
}

/** Hard alpha + 1px dark outline so characters read on dark floors and small screens. */
function outline(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = img;
  const solid = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) solid[i] = data[i * 4 + 3]! >= 128 ? 1 : 0;
  const [r, g, b] = BAKE.outlineColor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (solid[i]) {
        data[i * 4 + 3] = 255;
        continue;
      }
      const edge =
        (x > 0 && solid[i - 1]) || (x < width - 1 && solid[i + 1]) || (y > 0 && solid[i - width]) || (y < height - 1 && solid[i + width]);
      if (edge) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255;
      } else {
        data[i * 4 + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

async function save(file: string, data: string, encoding: 'base64' | 'utf8'): Promise<void> {
  const res = await fetch('/__save', { method: 'POST', body: JSON.stringify({ file, data, encoding }) });
  if (!res.ok) throw new Error(`Save failed for ${file}: ${await res.text()}`);
}

async function main(): Promise<void> {
  // ?only=<id> re-bakes one character and keeps the existing manifest (its animation list must not change).
  const only = new URLSearchParams(location.search).get('only');
  if (only) {
    const def = CHARACTERS.find((c) => c.id === only);
    if (!def) throw new Error(`Unknown character: ${only}`);
    await bakeCharacter(def);
    log('Done');
    (window as unknown as { bakeDone: boolean }).bakeDone = true;
    return;
  }
  const characters: Record<string, Record<string, ManifestAnim>> = {};
  for (const def of CHARACTERS) characters[def.id] = await bakeCharacter(def);
  const manifest = { frameSize: FRAME, originY: BAKE.originY, characters };
  await save('src/render/sprites.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  log('Done');
  (window as unknown as { bakeDone: boolean }).bakeDone = true;
}

main().catch((err: unknown) => {
  log(`Error: ${String(err)}`);
  (window as unknown as { bakeError: string }).bakeError = String(err);
});

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

// Frame layout of the character being baked (bosses may use a bigger frame, see BakeCharacter.frameSize).
let FRAME = BAKE.frameSize;
let INNER = FRAME / BAKE.pixelScale;

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

/** Keeps y >= 0: the floor the character stands on (feet at the origin). */
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function setFrame(frameSize: number, originY: number): void {
  FRAME = frameSize;
  INNER = FRAME / BAKE.pixelScale;
  renderer.setSize(INNER, INNER);
  camera.left = -FRAME / 2;
  camera.right = FRAME / 2;
  camera.top = originY;
  camera.bottom = originY - FRAME;
  camera.updateProjectionMatrix();
}

interface ManifestLayout {
  frameSize: number;
  originY: number;
  nativeScale: number;
}

interface Manifest {
  frameSize: number;
  originY: number;
  /** Per-character frame layout for sheets that differ from the defaults above (bosses). */
  layouts?: Record<string, ManifestLayout>;
  characters: Record<string, Record<string, ManifestAnim>>;
}

interface ManifestAnim {
  file: string;
  frames: number;
  fps: number;
  loop: boolean;
  /** Baked direction rows when only a subset is in the sheet (sheet row i = rows[i]). */
  rows?: number[];
  /** Trimmed atlas (Phaser JSON hash) instead of a grid: frame i of the grid is atlas frame "i". */
  atlas?: string;
}

interface AtlasJson {
  frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated: false;
      trimmed: true;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
    }
  >;
  meta: { image: string; size: { w: number; h: number }; scale: 1 };
}

const ATLAS_MAX_WIDTH = 2048;

/**
 * Cuts every grid cell down to its opaque bounds and shelf-packs the pieces (1 px gap, no bleeding with
 * nearest filtering). The grid frame stays the logical frame (sourceSize), so origins and frame indices
 * work exactly as with the plain sheets — only the empty margins are gone from the texture.
 */
function trimToAtlas(sheet: HTMLCanvasElement, image: string, label: string): { canvas: HTMLCanvasElement; json: AtlasJson } {
  const ctx = sheet.getContext('2d')!;
  const { data, width } = ctx.getImageData(0, 0, sheet.width, sheet.height);
  const cols = sheet.width / FRAME;
  const rows = sheet.height / FRAME;
  const cells: { i: number; sx: number; sy: number; x0: number; y0: number; w: number; h: number; ax: number; ay: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let x0 = FRAME;
      let y0 = FRAME;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < FRAME; y++) {
        const rowStart = ((r * FRAME + y) * width + c * FRAME) * 4 + 3;
        for (let x = 0; x < FRAME; x++) {
          if (data[rowStart + x * 4]! === 0) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) {
        [x0, y0, x1, y1] = [0, 0, 0, 0]; // empty frame (spawn start): keep a 1 px transparent piece
      } else if (x0 === 0 || y0 === 0 || x1 === FRAME - 1 || y1 === FRAME - 1) {
        warn(`${label}: frame ${r * cols + c} touches the frame edge (clipped), enlarge frameSize/originY`);
      }
      cells.push({ i: r * cols + c, sx: c * FRAME, sy: r * FRAME, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, ax: 0, ay: 0 });
    }
  }
  // Shelf packing, tallest first: rows of pieces left to right.
  const order = [...cells].sort((a, b) => b.h - a.h);
  let x = 0;
  let y = 0;
  let shelf = 0;
  let usedW = 0;
  for (const cell of order) {
    if (x + cell.w > ATLAS_MAX_WIDTH) {
      x = 0;
      y += shelf + 1;
      shelf = 0;
    }
    cell.ax = x;
    cell.ay = y;
    x += cell.w + 1;
    shelf = Math.max(shelf, cell.h);
    usedW = Math.max(usedW, x - 1);
  }
  const canvas = document.createElement('canvas');
  canvas.width = usedW;
  canvas.height = y + shelf;
  const out = canvas.getContext('2d')!;
  const json: AtlasJson = { frames: {}, meta: { image, size: { w: canvas.width, h: canvas.height }, scale: 1 } };
  for (const cell of cells) {
    out.drawImage(sheet, cell.sx + cell.x0, cell.sy + cell.y0, cell.w, cell.h, cell.ax, cell.ay, cell.w, cell.h);
    json.frames[String(cell.i)] = {
      frame: { x: cell.ax, y: cell.ay, w: cell.w, h: cell.h },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: cell.x0, y: cell.y0, w: cell.w, h: cell.h },
      sourceSize: { w: FRAME, h: FRAME },
    };
  }
  return { canvas, json };
}

const warnings: string[] = [];
function warn(msg: string): void {
  warnings.push(msg);
  console.warn(msg);
}

async function bakeCharacter(def: BakeCharacter): Promise<Record<string, ManifestAnim>> {
  setFrame(def.frameSize ?? BAKE.frameSize, def.originY ?? BAKE.originY);
  const gltf = await new GLTFLoader().loadAsync(`/${def.model}`);
  const model = gltf.scene;
  model.traverse((obj) => {
    if (def.hide.includes(obj.name)) obj.visible = false;
    if ((obj as THREE.Mesh).isMesh) obj.frustumCulled = false;
  });
  // Measured before attachments: `height` is the character's, a long staff must not shrink it.
  const box = new THREE.Box3().setFromObject(model);
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
    let atlas: string | undefined;
    let image = sheet;
    if (def.trim) {
      const packed = trimToAtlas(sheet, file, `${def.id}/${anim.id}`);
      image = packed.canvas;
      atlas = file.replace(/\.png$/, '.json');
      await save(`public/assets/sprites/${atlas}`, JSON.stringify(packed.json) + '\n', 'utf8');
    }
    sheetsEl.append(document.createTextNode(`${file} `), image, document.createElement('br'));
    await save(`public/assets/sprites/${file}`, image.toDataURL('image/png').split(',')[1]!, 'base64');
    const clip = THREE.AnimationClip.findByName(gltf.animations, anim.clip)!;
    // Loops without explicit fps play at the clip's natural speed.
    const fps = anim.fps ?? Math.round((anim.frames / clip.duration) * 100) / 100;
    result[anim.id] = {
      file,
      ...(atlas ? { atlas } : {}),
      frames: anim.frames,
      fps,
      loop: anim.loop,
      ...(anim.rows ? { rows: [...anim.rows] } : {}),
    };
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
  const hidden: THREE.Object3D[] = [];
  model.traverse((obj) => {
    if (anim.hide?.includes(obj.name) && obj.visible) {
      obj.visible = false;
      hidden.push(obj);
    }
  });

  renderer.clippingPlanes = anim.clipBelowGround ? [GROUND] : [];

  const sheet = document.createElement('canvas');
  sheet.width = FRAME * anim.frames;
  const rows = anim.rows ?? SCREEN_DIRS.map((_, row) => row);
  sheet.height = FRAME * rows.length;
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  rows.forEach((dir, row) => {
    const [sx, sy] = SCREEN_DIRS[dir]!;
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
  for (const obj of hidden) obj.visible = true;
  renderer.clippingPlanes = [];
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

function layoutOf(def: BakeCharacter): ManifestLayout | undefined {
  if (def.frameSize === undefined && def.originY === undefined && def.nativeScale === undefined) return undefined;
  return { frameSize: def.frameSize ?? BAKE.frameSize, originY: def.originY ?? BAKE.originY, nativeScale: def.nativeScale ?? 1 };
}

async function main(): Promise<void> {
  // ?only=<id> re-bakes one character and updates just its entries in the existing manifest.
  const only = new URLSearchParams(location.search).get('only');
  let manifest: Manifest;
  if (only) {
    const def = CHARACTERS.find((c) => c.id === only);
    if (!def) throw new Error(`Unknown character: ${only}`);
    manifest = (await (await fetch('/__manifest')).json()) as Manifest;
    manifest.characters[def.id] = await bakeCharacter(def);
    const layouts = { ...manifest.layouts };
    delete layouts[def.id];
    if (layoutOf(def)) layouts[def.id] = layoutOf(def)!;
    manifest.layouts = layouts;
  } else {
    manifest = { frameSize: BAKE.frameSize, originY: BAKE.originY, layouts: {}, characters: {} };
    for (const def of CHARACTERS) {
      manifest.characters[def.id] = await bakeCharacter(def);
      if (layoutOf(def)) manifest.layouts![def.id] = layoutOf(def)!;
    }
  }
  await save('src/render/sprites.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  log(warnings.length ? `Done with ${warnings.length} warnings:\n${warnings.join('\n')}` : 'Done');
  (window as unknown as { bakeDone: boolean }).bakeDone = true;
}

main().catch((err: unknown) => {
  log(`Error: ${String(err)}`);
  (window as unknown as { bakeError: string }).bakeError = String(err);
});

// Palette compression of baked sprite sheets (libimagequant via sharp, dev-only; nothing here ships in the game).
// The baker's save endpoint runs every PNG it writes through optimizePng; the CLI re-compresses existing files:
//   npm run sprites:optimize                  (public/assets/**.png)
//   npm run sprites:optimize -- <file.png> …
// Sheets that are already palette PNGs are skipped, so re-running never stacks lossy passes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

/**
 * Baked sheets have hard alpha (0 / 255, see the baker's outline pass) and a few thousand colours of flat-shaded
 * KayKit textures: 256 colours without dithering keep them visually identical at game scale (checked side by side)
 * and the files ~4x smaller than the canvas PNGs. GPU memory is unaffected (textures decode to RGBA).
 */
const PALETTE = { palette: true, colours: 256, quality: 100, dither: 0, effort: 10, compressionLevel: 9 } as const;

/** PNG colour type byte (IHDR): 3 = indexed (palette). */
function isPalettePng(png: Buffer): boolean {
  return png.length > 25 && png.readUInt32BE(12) === 0x49484452 && png[25] === 3;
}

/** Palette-compressed copy of a PNG; the input itself if it is already indexed or the result is not smaller. */
export async function optimizePng(png: Buffer): Promise<Buffer> {
  if (isPalettePng(png)) return png;
  const out = await sharp(png).png(PALETTE).toBuffer();
  return out.length < png.length ? out : png;
}

function pngsUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return pngsUnder(full);
    return e.name.endsWith('.png') ? [full] : [];
  });
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((f) => path.resolve(f)) : pngsUnder(path.join(root, 'public/assets'));
  let before = 0;
  let after = 0;
  for (const file of files) {
    const src = fs.readFileSync(file);
    const out = await optimizePng(src);
    before += src.length;
    after += out.length;
    if (out !== src) {
      fs.writeFileSync(file, out);
      console.log(`${path.relative(root, file)}: ${(src.length / 1024).toFixed(0)} -> ${(out.length / 1024).toFixed(0)} KiB`);
    }
  }
  console.log(`${files.length} files: ${(before / 1e6).toFixed(2)} -> ${(after / 1e6).toFixed(2)} MB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

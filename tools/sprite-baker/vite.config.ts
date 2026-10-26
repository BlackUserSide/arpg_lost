import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { optimizePng } from './optimize';

const here = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(here, '../..');

/** Dev-only endpoint: the baker page POSTs finished sheets here and they land in the repo (PNGs palette-compressed). */
function saveFiles(): Plugin {
  return {
    name: 'sprite-baker-save',
    configureServer(server) {
      // The current manifest, read without importing it: an import would make Vite reload the page
      // (and start a new bake) every time the baker rewrites it.
      server.middlewares.use('/__manifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(fs.readFileSync(path.resolve(root, 'src/render/sprites.json')));
      });
      server.middlewares.use('/__save', (req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', async () => {
          const { file, data, encoding } = JSON.parse(body) as { file: string; data: string; encoding: 'base64' | 'utf8' };
          const allowed = ['public/assets/sprites/', 'src/render/'];
          const target = path.resolve(root, file);
          if (!allowed.some((dir) => target.startsWith(path.resolve(root, dir)))) {
            res.statusCode = 400;
            res.end('path not allowed');
            return;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const bytes = Buffer.from(data, encoding);
          // Sheets land palette-compressed (optimize.ts).
          fs.writeFileSync(target, target.endsWith('.png') ? await optimizePng(bytes) : bytes);
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  root: here,
  publicDir: path.resolve(root, 'art_src'),
  plugins: [saveFiles()],
  server: { port: 5180, strictPort: true },
});

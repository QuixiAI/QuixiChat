import { build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(import.meta.dirname, 'build');
await mkdir(output, { recursive: true });
// `public/archive.portable` (written by run.mjs from the web export) is copied into dist verbatim.
await build({ configFile: false, root: import.meta.dirname, publicDir: resolve(import.meta.dirname, 'public'), worker: { format: 'es' }, logLevel: 'warn', build: { outDir: resolve(output, 'dist'), emptyOutDir: true, assetsInlineLimit: 0 } });
const production = JSON.parse(await readFile(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const proof = {
  ...production,
  productName: 'Quixi Archive Cross-Host Proof', identifier: 'ai.quixi.chat.archive-cross-host-proof',
  build: { frontendDist: './dist' },
  app: { ...production.app, windows: [], security: { ...production.app.security } },
  bundle: { ...production.bundle, active: false, icon: production.bundle.icon.map(name => resolve(root, 'apps/desktop/src-tauri', name)) },
};
if (proof.app.security.csp !== production.app.security.csp) throw new Error('Production CSP changed in proof');
await writeFile(resolve(output, 'tauri.conf.json'), JSON.stringify(proof, null, 2) + '\n');

// Explicit one-time capture. Acceptance runs verify/reuse this bundle, never rebuild it.
import { build } from 'vite';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { CANONICAL_MIGRATIONS } from '../../../migrations/index.ts';
const root = resolve(import.meta.dirname, '../../../../..');
const outDir = resolve(import.meta.dirname, 'frozen');
const manifestPath = resolve(outDir, 'manifest.json');
try { await access(manifestPath); throw new Error('Frozen bundle already exists; do not overwrite compatibility evidence.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (CANONICAL_MIGRATIONS.length !== 8) throw new Error('Only the actual schema-8 worker can be captured here.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { capturedAt: new Date().toISOString(), schemaVersion: 8, node: process.version, entry: 'packages/storage/src/worker/archive.ts', sourceSha256: {}, artifacts: {} };
await mkdir(outDir, { recursive: true });
await build({ configFile: false, root, base: './', logLevel: 'warn', plugins: [{
  name: 'capture-worker-inputs',
  async generateBundle(_options, bundle) {
    for (const moduleId of this.getModuleIds()) {
      const file = moduleId.split('?')[0];
      if (file.startsWith(root + '/')) {
        try { manifest.sourceSha256[relative(root, file)] = hash(await readFile(file)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    for (const [file, value] of Object.entries(bundle)) manifest.artifacts[file] = hash(value.type === 'chunk' ? value.code : value.source);
  },
}], build: { outDir, emptyOutDir: false, target: 'es2022', minify: false, rollupOptions: {
  input: resolve(root, manifest.entry), output: { format: 'es', entryFileNames: 'archive-schema8.mjs', assetFileNames: '[name]-[hash][extname]' },
} } });
for (const file of ['package-lock.json', 'packages/storage/sqlite/manifest.json', relative(root, import.meta.filename)]) {
  try { manifest.sourceSha256[file] = hash(await readFile(resolve(root, file))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ manifestPath, artifacts: manifest.artifacts }, null, 2));

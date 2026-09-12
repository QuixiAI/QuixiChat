import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { patchedSha256 } from '../tooling/pdfjs-range-patch.mjs';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(metadata.version, '6.3.289');
assert.equal(metadata.license, 'Apache-2.0');
assert.equal(metadata.engines.node, '>=22.13.0 || >=24');
for (const [file, expected] of Object.entries({ 'build/pdf.mjs': '495588717f62303a839e91a5343deebf1b41f52e2f9f6361e73dee6ea6a4355e', 'build/pdf.worker.mjs': patchedSha256 })) {
  assert.equal(createHash('sha256').update(await readFile(resolve(root, file))).digest('hex'), expected, file);
}
const registry = await readFile(new URL('../src/worker/assets.ts', import.meta.url), 'utf8');
let assets = 0;
for (const folder of ['cmaps', 'standard_fonts']) for (const filename of await readdir(resolve(root, folder))) if (/\.(bcmap|pfb|ttf)$/.test(filename)) {
  assert.ok(registry.includes(`'pdfjs-dist/${folder}/${filename}?url'`), `Missing local ${filename}`); assets++;
}
const fixtures = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'));
for (const [name, entry] of Object.entries(fixtures)) {
  const bytes = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  assert.equal(bytes.length, entry.bytes, name);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, name);
}
console.log(`Pinned PDF.js display/parser, ${assets} local assets, ${Object.keys(fixtures).length} actual source fixtures verified.`);

const provenance = JSON.parse(await readFile(new URL('../third-party/manifest.json', import.meta.url), 'utf8'));
for (const item of provenance.assets) {
  const bytes = await readFile(resolve(root, item.path));
  assert.equal(bytes.length, item.bytes, item.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.path);
}
for (const item of provenance.licenses) assert.equal(createHash('sha256').update(await readFile(new URL(`../third-party/${item.path}`, import.meta.url))).digest('hex'), item.sha256, item.path);
console.log('Asset-specific licenses, pinned asset hashes, and retained fixture-tool notices verified.');

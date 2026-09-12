import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sqlite3InitModule from './dist/sqlite3.mjs';

const root = new URL('./', import.meta.url);
const sources = JSON.parse(await readFile(new URL('sources.json', root), 'utf8'));
const artifacts = {};
for (const name of ['sqlite3.mjs', 'sqlite3.wasm', 'sqlite3.d.mts']) {
  const contents = await readFile(new URL(`dist/${name}`, root));
  artifacts[name] = { bytes: contents.byteLength, sha256: createHash('sha256').update(contents).digest('hex') };
}
const recording = process.argv.includes('--record');
if (!recording) {
  const expected = JSON.parse(await readFile(new URL('artifacts.json', root), 'utf8'));
  assert.deepEqual(artifacts, expected.artifacts, 'Artifact differs from the reviewed pinned build');
}
const start = performance.now();
const wasmBinary = await readFile(new URL('dist/sqlite3.wasm', root));
// Only SAH-pool is used by Quixi; disable auto-starting the other OPFS VFSes.
globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
const sqlite3 = await sqlite3InitModule({
  instantiateWasm: async (imports, success) => {
    const {instance, module} = await WebAssembly.instantiate(wasmBinary, imports);
    success(instance, module);
  },
  print: () => {}, printErr: () => {},
});
assert.equal(typeof sqlite3.installOpfsSAHPoolVfs, 'function');
let db = new sqlite3.oo1.DB('/distribution-smoke.sqlite3', 'c');
const sqliteVersion = db.selectValue('SELECT sqlite_version()');
const sqliteVecVersion = db.selectValue('SELECT vec_version()');
assert.equal(sqliteVersion, sources.sqliteVersion);
assert.equal(sqliteVecVersion, sources.sqliteVecVersion);
assert.equal(db.selectValue("SELECT sqlite_compileoption_used('ENABLE_FTS5')"), 1);
db.exec(`
  CREATE TABLE history(id INTEGER PRIMARY KEY, text TEXT NOT NULL);
  BEGIN IMMEDIATE;
  INSERT INTO history VALUES (1, 'committed');
  COMMIT;
  BEGIN IMMEDIATE;
  INSERT INTO history VALUES (2, 'rolled back');
  ROLLBACK;
  CREATE VIRTUAL TABLE search USING fts5(text);
  INSERT INTO search(rowid, text) VALUES (1, 'Café Quixi permanent archive');
  CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3]);
  INSERT INTO vectors(rowid, embedding) VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0,0,1]');
`);
assert.equal(db.selectValue('SELECT count(*) FROM history'), 1);
assert.equal(db.selectValue("SELECT rowid FROM search WHERE search MATCH 'cafe archive'"), 1);
const nearest = db.selectObjects("SELECT rowid, distance FROM vectors WHERE embedding MATCH '[0.9,0.1,0]' AND k = 2 ORDER BY distance");
assert.deepEqual(nearest.map((row) => row.rowid), [1, 2]);
assert.ok(Math.abs(nearest[0].distance - Math.sqrt(0.02)) < 1e-6);
assert.equal(db.selectValue("SELECT vec_distance_l2('[1,2,3]', '[4,6,3]')"), 5);
assert.equal(db.selectValue("SELECT vec_distance_hamming(vec_bit(x'00ff'), vec_bit(x'ffff'))"), 8);
assert.equal(db.selectValue("SELECT vec_distance_l2(vec_int8(x'010203'), vec_int8(x'040603'))"), 5);
assert.equal(db.selectValue('PRAGMA integrity_check'), 'ok');
const compileOptions = db.selectValues('PRAGMA compile_options');
const sqliteSourceId = db.selectValue('SELECT sqlite_source_id()');
db.close();
db = new sqlite3.oo1.DB('/distribution-smoke.sqlite3', 'w');
assert.equal(db.selectValue('SELECT text FROM history WHERE id=1'), 'committed');
assert.equal(db.selectValue('SELECT count(*) FROM vectors'), 3);
db.close();
const result = {
  sqliteVersion, sqliteVecVersion, sqliteSourceId,
  checks: ['artifact checksums', 'official OO API', 'SAH-pool API present', 'commit and rollback', 'FTS5 diacritic search', 'vec0 float32 KNN', 'int8 L2', 'bit Hamming', 'integrity', 'close/reopen'],
  environment: `Node ${process.version} ${process.platform}/${process.arch}`,
  limitation: 'Node smoke uses Emscripten memory filesystem. OPFS durability and browser support require the Storage Worker host proof.',
  elapsedMs: Math.round(performance.now() - start),
};
if (recording) {
  await writeFile(new URL('artifacts.json', root), `${JSON.stringify({schemaVersion: 1, sqliteVersion, sqliteVecVersion, sqliteSourceId, toolchain: sources.toolchain, artifacts, compileOptions}, null, 2)}\n`);
}
await writeFile(new URL('dist/verification.json', root), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

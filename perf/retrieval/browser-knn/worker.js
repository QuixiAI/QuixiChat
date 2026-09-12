/** Browser-side half of the ADR 0036 measurement. The rerank joins the coarse
 * rows to the float table (vec0 point lookups); `rowid IN (subquery)` makes
 * vec0 scan the whole float table (measured: 20k page misses per query at 100k).
 *: the pinned SQLite WASM with
 * sqlite-vec on the OPFS SAHPool VFS (the storage worker's configuration),
 * vec0 float[384] and int8[384] tables, brute-force KNN. Runs as a dedicated
 * worker like the Storage Worker; the page only forwards commands. */
import initialize from "./sqlite3.mjs";
const D = 384, SCALE = 0.4 / 127;
let sqlite, pool, db;
let seed = 20260912;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const vector = () => { const v = new Float32Array(D); let n = 0; for (let d = 0; d < D; d++) { v[d] = rand() - 0.5; n += v[d] * v[d]; } n = Math.sqrt(n); for (let d = 0; d < D; d++) v[d] = v[d] / n * 0.9; v[0] = Math.sqrt(1 - 0.81); return v; };
const int8 = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x / SCALE))));
const bytes = (typed) => new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
const log = (text) => postMessage({ log: text });
const stats = (samples) => { const s = [...samples].sort((a, b) => a - b); return { samples: s.length, medianMs: s[Math.floor(s.length / 2)], p95Ms: s[Math.floor(s.length * 0.95)], maxMs: s[s.length - 1] }; };
/** Page-cache misses since the last call (SQLITE_DBSTATUS_CACHE_MISS = 8), i.e. pages read from OPFS. */
function cacheMisses(reset) {
  const capi = sqlite.capi, wasm = sqlite.wasm;
  if (typeof capi.sqlite3_db_status !== "function") return null;
  const stack = wasm.pstack.pointer;
  try {
    const current = wasm.pstack.alloc(8), highwater = wasm.pstack.alloc(8);
    const rc = capi.sqlite3_db_status(db.pointer, 8, current, highwater, reset ? 1 : 0);
    if (rc !== 0) return null;
    return wasm.peek32(current);
  } finally { wasm.pstack.restore(stack); }
}
/** SQLITE_STATUS_MEMORY_USED (0): current and high-water bytes SQLite holds, plus the WASM heap size. */
function memory() {
  const capi = sqlite.capi, wasm = sqlite.wasm;
  const stack = wasm.pstack.pointer;
  try {
    const current = wasm.pstack.alloc(8), highwater = wasm.pstack.alloc(8);
    const rc = typeof capi.sqlite3_status === "function" ? capi.sqlite3_status(0, current, highwater, 0) : -1;
    return { sqliteMemoryUsedBytes: rc === 0 ? wasm.peek32(current) : null, sqliteMemoryHighwaterBytes: rc === 0 ? wasm.peek32(highwater) : null, wasmHeapBytes: wasm.heap8u().byteLength };
  } finally { wasm.pstack.restore(stack); }
}
let directory = "";
/** Bytes under this measurement's own pool directory only (WebKit shares one
 * OPFS across Playwright profiles, so other runs' files must not count). */
async function opfsBytes() {
  let total = 0, dir = await navigator.storage.getDirectory();
  for (const segment of directory.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(segment);
  const walk = async (d) => { for await (const [, handle] of d) { if (handle.kind === "file") total += (await handle.getFile()).size; else await walk(handle); } };
  await walk(dir);
  return total;
}
const commands = {
  async open({ name, floatChunkSize, fresh }) {
    if (!sqlite) {
      globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
      sqlite = await initialize({ locateFile: (file) => file.endsWith(".wasm") ? new URL("./sqlite3.wasm", import.meta.url).href : file, print: () => {}, printErr: () => {} });
    }
    directory = `/quixi/perf/${name}`;
    if (!pool) pool = await sqlite.installOpfsSAHPoolVfs({ name: "quixi-knn", directory, initialCapacity: 6 });
    if (fresh) for (const file of pool.getFileNames()) pool.unlink(file);
    db = new pool.OpfsSAHPoolDb("/knn.sqlite3");
    // The storage worker's journal and sync settings; default page cache.
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    // vec0 stores vectors in chunk blobs; a point lookup reads a whole chunk,
    // so the float table's chunk_size decides how many pages a rerank touches.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS f USING vec0(embedding float[${D}]${floatChunkSize ? `, chunk_size=${floatChunkSize}` : ""}); CREATE VIRTUAL TABLE IF NOT EXISTS q8 USING vec0(embedding int8[${D}]);`);
    return { floatChunkSize: floatChunkSize ?? "default", vecVersion: db.selectValue("SELECT vec_version()"), sqliteVersion: db.selectValue("SELECT sqlite_version()"), pageSize: db.selectValue("PRAGMA page_size"), cacheSize: db.selectValue("PRAGMA cache_size"), rows: db.selectValue("SELECT count(*) FROM f"), cacheMissCounter: cacheMisses(true) !== null };
  },
  /** Inserts [from, to) in one transaction, the way a publication batch does. */
  insert({ from, to }) {
    const started = performance.now();
    db.exec("BEGIN IMMEDIATE");
    const insF = db.prepare("INSERT INTO f(rowid,embedding) VALUES(?,?)"), insQ = db.prepare("INSERT INTO q8(rowid,embedding) VALUES(?,vec_int8(?))");
    try { for (let i = from; i < to; i++) { const v = vector(); insF.bind([i, bytes(v)]).stepReset(); insQ.bind([i, bytes(int8(v))]).stepReset(); } }
    finally { insF.finalize(); insQ.finalize(); }
    db.exec("COMMIT");
    return { ms: performance.now() - started, rows: db.selectValue("SELECT count(*) FROM f") };
  },
  async measure({ queries: count, repetitions }) {
    const queries = Array.from({ length: count }, vector);
    const run = (fn) => { const samples = [], misses = []; for (let rep = 0; rep < repetitions; rep++) for (const q of queries) { cacheMisses(true); const t = performance.now(); fn(q); samples.push(performance.now() - t); misses.push(cacheMisses(false)); } return { ...stats(samples), pageCacheMissesPerQuery: misses.some((m) => m === null) ? null : misses.reduce((a, b) => a + b, 0) / misses.length }; };
    const quantize = run((q) => int8(q));
    const floatKnn = run((q) => db.exec({ sql: "SELECT rowid,distance FROM f WHERE embedding MATCH ? AND k=64", bind: [bytes(q)], returnValue: "resultRows" }));
    const int8Knn = run((q) => db.exec({ sql: "SELECT rowid FROM q8 WHERE embedding MATCH vec_int8(?) AND k=500", bind: [bytes(int8(q))], returnValue: "resultRows" }));
    const coarseRerank = run((q) => db.exec({ sql: "SELECT v.rowid,vec_distance_L2(v.embedding,?) AS d FROM (SELECT rowid FROM q8 WHERE embedding MATCH vec_int8(?) AND k=500) c CROSS JOIN f v ON v.rowid=c.rowid ORDER BY d LIMIT 64", bind: [bytes(q), bytes(int8(q))], returnValue: "resultRows" }));
    let agree = 0;
    for (const q of queries) {
      const a = db.exec({ sql: "SELECT rowid FROM f WHERE embedding MATCH ? AND k=64", bind: [bytes(q)], returnValue: "resultRows" }).map((r) => r[0]);
      const b = new Set(db.exec({ sql: "SELECT v.rowid FROM (SELECT rowid FROM q8 WHERE embedding MATCH vec_int8(?) AND k=500) c CROSS JOIN f v ON v.rowid=c.rowid ORDER BY vec_distance_L2(v.embedding,?) LIMIT 64", bind: [bytes(int8(q)), bytes(q)], returnValue: "resultRows" }).map((r) => r[0]));
      agree += a.filter((id) => b.has(id)).length / a.length;
    }
    return { rows: db.selectValue("SELECT count(*) FROM f"), pageSize: db.selectValue("PRAGMA page_size"), queryQuantization: quantize, floatKnnTop64: floatKnn, int8CoarseTop500: int8Knn, int8CoarseThenFloatRerankTop64: coarseRerank, top64AgreementWithFloat: agree / queries.length, memory: memory(), opfsBytes: await opfsBytes() };
  },
  /** Foreground queries interleaved with backfill batches: one batch insert,
   * then one coarse→rerank query, repeated; reports the query latency seen
   * right after each write (product §112 foreground-under-backfill). */
  async underBackfill({ from, batch, batches }) {
    const samples = [], writes = [];
    for (let b = 0; b < batches; b++) {
      const write = commands.insert({ from: from + b * batch, to: from + (b + 1) * batch });
      writes.push(write.ms);
      const q = vector();
      const t = performance.now();
      db.exec({ sql: "SELECT v.rowid,vec_distance_L2(v.embedding,?) AS d FROM (SELECT rowid FROM q8 WHERE embedding MATCH vec_int8(?) AND k=500) c CROSS JOIN f v ON v.rowid=c.rowid ORDER BY d LIMIT 64", bind: [bytes(q), bytes(int8(q))], returnValue: "resultRows" });
      samples.push(performance.now() - t);
    }
    return { batch, batches, rowsAfter: db.selectValue("SELECT count(*) FROM f"), writeMs: stats(writes), coarseRerankAfterWrite: stats(samples), memory: memory() };
  },
  /** Closes the connection (drops its page cache); the files stay for a cold reopen. */
  close() { db?.close(); db = undefined; return { closed: true }; },
  async wipe() { db?.close(); db = undefined; if (pool) { await pool.wipeFiles(); await pool.removeVfs(); } pool = undefined; return { wiped: true }; },
};
onmessage = async (event) => {
  const { id, command, ...args } = event.data;
  try { postMessage({ id, result: await commands[command](args) }); }
  catch (error) { postMessage({ id, error: `${error?.message ?? error}${error?.resultCode !== undefined ? ` (sqlite rc ${error.resultCode})` : ""}\n${error?.stack ?? ""}` }); }
};

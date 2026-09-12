/** Plan 23: the blob hash audit walks the catalog in bounded blocks through a
 * verified-read store and names hash, size, missing and read faults by digest. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import initialize from "../../sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../src/worker/canonical/index.ts";
import type { CanonicalSqlite } from "../../src/worker/canonical/index.ts";
import { BlobHashAuditRepository, BLOB_HASH_AUDIT_STEP_BYTES } from "../../src/worker/blob-hash-audit.ts";
import { BlobStorageError } from "../../src/worker/blobs.ts";
import type { BlobHashAuditFinding, BlobHashAuditStatus } from "@quixi/core/contracts";

const wasm = await readFile(new URL("../../sqlite/dist/sqlite3.wasm", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../../sqlite/artifacts.json", import.meta.url), "utf8"));
assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.artifacts["sqlite3.wasm"].sha256);
(globalThis as any).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const initOptions = {
  instantiateWasm: async (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => { const result = await WebAssembly.instantiate(wasm, imports); success(result.instance, result.module); },
  print: () => {}, printErr: () => {},
};
const sqlite = (await initialize(initOptions)) as { oo1: { DB: new (name: string, flags: string) => CanonicalSqlite & { close(): void } } };
const id = () => randomUUID();
const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Mirrors OpfsBlobStore's verified read: hashes as it reads, fails at the last block on a digest mismatch. */
class Store {
  files = new Map<string, Uint8Array>();
  inventoryEpoch = 0;
  reads = new Map<string, { digest: string; verified: number; hash: ReturnType<typeof createHash> }>();
  opened = 0; discarded = 0; blocks: number[] = [];
  async beginVerifiedRead(transferId: string, digest: string) {
    const bytes = this.files.get(digest);
    if (!bytes) throw new BlobStorageError("NOT_FOUND", "Referenced blob bytes are missing");
    if (digest.startsWith("00")) throw new BlobStorageError("IO_ERROR", "Synthetic open failure");
    this.opened++;
    this.reads.set(transferId, { digest, verified: 0, hash: createHash("sha256") });
    return { transferId, byteLength: bytes.byteLength, verifiedBytes: 0, complete: bytes.byteLength === 0 };
  }
  async advanceVerifiedRead(transferId: string, maxBytes: number) {
    const read = this.reads.get(transferId)!, bytes = this.files.get(read.digest)!;
    const block = bytes.subarray(read.verified, Math.min(bytes.byteLength, read.verified + maxBytes));
    this.blocks.push(block.byteLength);
    read.hash.update(block); read.verified += block.byteLength;
    if (read.verified === bytes.byteLength && read.hash.digest("hex") !== read.digest) throw new BlobStorageError("IO_ERROR", "Blob content no longer matches its SHA-256");
    return { transferId, byteLength: bytes.byteLength, verifiedBytes: read.verified, complete: read.verified === bytes.byteLength };
  }
  async discard(transferId: string) { this.discarded++; return this.reads.delete(transferId); }
}
function open() {
  const db = new sqlite.oo1.DB(`/hash-audit-${id()}.sqlite3`, "c");
  new CanonicalRepository(db, { assertBlobAvailable: () => {} }).migrate();
  const store = new Store();
  const catalog = (sha256: string, byteLength: number) => db.exec({ sql: "INSERT INTO quixi_blob_catalog(sha256,byte_length,utf8_verified,availability,verification_epoch) VALUES(?,?,0,'verified',0)", bind: [sha256, byteLength] });
  const plant = (bytes: Uint8Array, options: { store?: Uint8Array | null; catalogBytes?: number; digest?: string } = {}) => {
    const sha256 = options.digest ?? digestOf(bytes);
    catalog(sha256, options.catalogBytes ?? bytes.byteLength);
    if (options.store !== null) store.files.set(sha256, options.store ?? bytes);
    return sha256;
  };
  return { db, store, plant, audit: new BlobHashAuditRepository(db, store) };
}
async function run(audit: BlobHashAuditRepository, maxItems = 64) {
  const scanId = id();
  let status = await audit.begin(scanId), advances = 0;
  while (status.state === "running") { status = await audit.advance(scanId, maxItems); if (++advances > 10_000) throw new Error("no finish"); }
  const findings: BlobHashAuditFinding[] = [];
  let cursor: string | null = null;
  do { const page = await audit.findings(scanId, { maxItems: 8, maxBytes: 8192, cursor }); findings.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return { scanId, status, findings, advances };
}
const counts = (status: BlobHashAuditStatus) => Object.fromEntries(Object.entries(status.counts).filter(([, value]) => value > 0));

test("intact files verify in bounded blocks and a large file spans advances; every open read is discarded", async () => {
  const { db, store, plant, audit } = open();
  const small = new TextEncoder().encode("Synthetic small blob"), large = new Uint8Array(BLOB_HASH_AUDIT_STEP_BYTES * 3 + 17).map((_, index) => index % 251);
  plant(small); plant(large); plant(new Uint8Array(0));
  const { status, findings, advances } = await run(audit, 2);
  assert.equal(status.state, "complete"); assert.deepEqual(counts(status), {}); assert.equal(findings.length, 0);
  assert.equal(status.totalFiles, 3); assert.equal(status.scannedFiles, 3);
  assert.equal(status.verifiedBytes, small.byteLength + large.byteLength); assert.equal(status.totalBytes, status.verifiedBytes);
  assert.ok(Math.max(...store.blocks) <= BLOB_HASH_AUDIT_STEP_BYTES); assert.ok(store.blocks.length >= 5, `blocks ${store.blocks.length}`);
  assert.ok(advances >= 4, `advances ${advances}`);
  assert.equal(store.discarded, store.opened);
  db.close();
});

test("altered bytes, a shorter file, a missing file and an unreadable file are found by digest with sizes, never content", async () => {
  const { db, store, plant, audit } = open();
  const original = new TextEncoder().encode("Synthetic original bytes that must stay private");
  const tampered = plant(original, { store: new TextEncoder().encode("Synthetic altered  bytes that must stay private") });
  const short = plant(new TextEncoder().encode("Synthetic full length"), { store: new TextEncoder().encode("short") });
  const missing = plant(new TextEncoder().encode("Synthetic missing"), { store: null });
  const unreadable = plant(new TextEncoder().encode("Synthetic unreadable"), { digest: "00" + "a".repeat(62) });
  const intact = plant(new TextEncoder().encode("Synthetic intact"));
  const { status, findings } = await run(audit);
  assert.equal(status.state, "complete");
  assert.deepEqual(counts(status), { hash_mismatch: 1, size_mismatch: 1, missing_blob: 1, read_error: 1 });
  const byKind = Object.fromEntries(findings.map(finding => [finding.kind, finding]));
  assert.equal(byKind.hash_mismatch!.sha256, tampered); assert.equal(byKind.hash_mismatch!.path, `blobs/${tampered.slice(0, 2)}/${tampered}`);
  assert.equal(byKind.size_mismatch!.sha256, short); assert.deepEqual([byKind.size_mismatch!.expectedBytes, byKind.size_mismatch!.actualBytes], [21, 5]);
  assert.equal(byKind.missing_blob!.sha256, missing); assert.equal(byKind.missing_blob!.actualBytes, null);
  assert.equal(byKind.read_error!.sha256, unreadable);
  assert.ok(!findings.some(finding => finding.sha256 === intact));
  assert.ok(!JSON.stringify(findings).includes("Synthetic"));
  assert.equal(store.discarded, store.opened);
  db.close();
});

test("a completed audit turns stale when the catalog or the files change; cancellation releases the open read", async () => {
  const { db, store, plant, audit } = open();
  plant(new Uint8Array(BLOB_HASH_AUDIT_STEP_BYTES * 2));
  const { scanId } = await run(audit);
  assert.equal((await audit.status(scanId)).state, "complete");
  store.inventoryEpoch++;
  assert.equal((await audit.status(scanId)).state, "stale");
  const second = id();
  await audit.begin(second);
  await audit.advance(second, 3);
  assert.equal(store.reads.size, 1, "one block into the file, the read is open");
  assert.equal((await audit.cancel(second)).state, "cancelled");
  assert.equal(store.reads.size, 0);
  const third = id(); await audit.begin(third); await audit.advance(third, 64);
  db.exec("INSERT INTO quixi_blob_catalog(sha256,byte_length,utf8_verified,availability,verification_epoch) VALUES('ff" + "0".repeat(62) + "',1,0,'verified',0)");
  assert.equal((await audit.status(third)).state, "stale");
  await audit.close();
  await assert.rejects(() => audit.begin(id()), /closed/);
  db.close();
});

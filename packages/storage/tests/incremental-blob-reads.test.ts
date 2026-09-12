import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BlobStorageError, OpfsBlobStore } from "../src/worker/blobs.ts";
import { BlobCatalog } from "../src/worker/blob-catalog.ts";

const id = () => randomUUID();
const code = (expected: string) => (error: unknown) => error instanceof BlobStorageError && error.code === expected;

// Enforce OPFS's exclusive-handle rule and record actual bytes read, so a test
// cannot pass by doing a hidden whole-file hash or opening a competing handle.
async function fixture(length = 400_003) {
  const content = Uint8Array.from({ length }, (_, i) => i % 251);
  const digest = bytesToHex(sha256(content));
  const state = { content, reads: 0, opens: 0, closes: 0, live: false };
  const file = {
    getSize: () => state.content.length,
    read(buffer: Uint8Array, { at }: { at: number }) {
      assert.equal(state.live, true);
      const part = state.content.subarray(at, at + buffer.length);
      buffer.set(part); state.reads += part.length; return part.length;
    },
    write() { throw new Error("read fixture must not write"); },
    truncate() { throw new Error("read fixture must not truncate"); },
    flush() {},
    close() { assert.equal(state.live, true); state.live = false; state.closes++; },
  };
  const stages = new Map<string, { content: Uint8Array; live: boolean }>();
  const directory = {
    async removeEntry(name: string) {
      if (!name.endsWith(".stage")) throw new Error("published bytes must never be removed by these read tests");
      stages.delete(name);
    },
    async getDirectoryHandle() { return directory; },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (name.endsWith(".stage")) {
        if (!stages.has(name) && options?.create) stages.set(name, { content: new Uint8Array(), live: false });
        const stage = stages.get(name);
        if (!stage) throw new DOMException("missing", "NotFoundError");
        return { async createSyncAccessHandle() {
          assert.equal(stage.live, false); stage.live = true;
          return {
            getSize: () => stage.content.length,
            read(buffer: Uint8Array, { at }: { at: number }) {
              const part = stage.content.subarray(at, at + buffer.length); buffer.set(part); return part.length;
            },
            write(buffer: Uint8Array, { at }: { at: number }) {
              const content = new Uint8Array(Math.max(stage.content.length, at + buffer.length));
              content.set(stage.content); content.set(buffer, at); stage.content = content; return buffer.length;
            },
            truncate(size: number) { stage.content = stage.content.slice(0, size); },
            flush() {}, close() { assert.equal(stage.live, true); stage.live = false; },
          };
        } };
      }
      if (name !== digest) throw new DOMException("missing", "NotFoundError");
      return { async createSyncAccessHandle() {
        assert.equal(state.live, false, "a second exclusive handle must never open");
        state.live = true; state.opens++; return file;
      } };
    },
  };
  const bytes = await OpfsBlobStore.open(directory as unknown as FileSystemDirectoryHandle);
  const row = { byte_length: length, availability: "unverified", verification_epoch: "", utf8_verified: 1 };
  let present = true;
  let quarantineCount = 0;
  const db = {
    exec(options: string | { sql: string; bind?: (string | number | null)[] }) {
      assert.notEqual(typeof options, "string");
      if (typeof options === "string") return [];
      const { sql, bind = [] } = options;
      if (sql.startsWith("SELECT byte_length")) return present && bind[0] === digest ? [{ ...row }] : [];
      if (sql.startsWith("SELECT state FROM quixi_blob_transfers")) return [];
      if (sql.startsWith("UPDATE quixi_blob_catalog SET availability='verified'")) {
        row.availability = "verified"; row.verification_epoch = String(bind[0]); return [];
      }
      if (sql.startsWith("UPDATE quixi_blob_catalog SET availability='unverified'")) {
        row.availability = "unverified"; row.verification_epoch = ""; quarantineCount++; return [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { bytes, catalog: new BlobCatalog(db, bytes), state, digest, row,
    removeMetadata: () => { present = false; }, quarantineCount: () => quarantineCount };
}

test("incremental begin reads zero bytes; each advance respects budget and forbids premature reads/slices", async () => {
  const f = await fixture(); const transferId = id();
  try {
    let p = await f.bytes.beginVerifiedRead(transferId, f.digest);
    assert.deepEqual(p, { transferId, byteLength: 400_003, verifiedBytes: 0, complete: false });
    assert.equal(f.state.reads, 0);
    assert.throws(() => f.bytes.readChunk(transferId), code("CONFLICT"));
    assert.throws(() => f.bytes.sliceRead(transferId, id(), { offset: 0, byteLength: 2 }), code("CONFLICT"));
    for (const budget of [1, 17, 131072, 65537, 131072, 131072]) {
      const before = f.state.reads;
      p = await f.bytes.advanceVerifiedRead(transferId, budget);
      assert.ok(f.state.reads - before <= budget);
      assert.equal(p.verifiedBytes, f.state.reads);
    }
    assert.equal(p.complete, true); assert.equal(f.state.reads, 400_003);
    const child = f.bytes.sliceRead(transferId, id(), { offset: 101, byteLength: 15 });
    const chunk = f.bytes.readChunk(child.transferId);
    assert.deepEqual(chunk.bytes, f.state.content.subarray(101, 116));
    await f.bytes.discard(transferId); assert.equal(f.state.live, true);
    f.bytes.acknowledge({ transferId: child.transferId, sequence: chunk.sequence, committedOffset: 15 });
    assert.equal(f.state.live, false); assert.equal(f.state.closes, 1);
  } finally { f.bytes.close(); }
});

test("foreground openRead finishes a pending shared digest exactly once and promotes the original parent", async () => {
  const f = await fixture(); const pending = id();
  try {
    await f.bytes.beginVerifiedRead(pending, f.digest);
    await f.bytes.advanceVerifiedRead(pending, 31);
    const foreground = await f.bytes.openRead(id(), f.digest);
    assert.equal(f.state.opens, 1); assert.equal(f.state.reads, 400_003);
    assert.equal((await f.bytes.advanceVerifiedRead(pending, 1)).complete, true);
    const cached = await f.bytes.beginVerifiedRead(id(), f.digest);
    assert.equal(cached.complete, true); assert.equal(f.state.reads, 400_003);
    await f.bytes.discard(foreground.transferId); await f.bytes.discard(cached.transferId);
    assert.equal(f.state.live, true); assert.equal(f.bytes.readChunk(pending, 7).bytes.length, 7);
  } finally { f.bytes.close(); }
  assert.equal(f.state.closes, 1);
});

test("foreground cancellation preserves another pending verifier and its existing hash progress", async () => {
  const f = await fixture(); const pending = id();
  try {
    await f.bytes.beginVerifiedRead(pending, f.digest);
    await f.bytes.advanceVerifiedRead(pending, 31);
    const abort = new AbortController();
    const foreground = f.bytes.openRead(id(), f.digest, abort.signal);
    setTimeout(() => abort.abort(), 0);
    await assert.rejects(foreground, code("CANCELLED"));
    assert.equal(f.state.live, true); assert.equal(f.state.opens, 1);
    let p = await f.bytes.advanceVerifiedRead(pending, 131072);
    while (!p.complete) p = await f.bytes.advanceVerifiedRead(pending, 131072);
    assert.equal(f.state.reads, 400_003);
  } finally { f.bytes.close(); }
});

test("bad digest invalidates every shared waiter and never exposes bytes", async () => {
  const f = await fixture(100); const one = id(); const two = id();
  f.state.content[50] = f.state.content[50]! ^ 1;
  try {
    await f.bytes.beginVerifiedRead(one, f.digest); await f.bytes.beginVerifiedRead(two, f.digest);
    await assert.rejects(f.bytes.advanceVerifiedRead(one, 100), code("IO_ERROR"));
    await assert.rejects(f.bytes.advanceVerifiedRead(two, 100), code("NOT_FOUND"));
    assert.throws(() => f.bytes.readChunk(two), code("NOT_FOUND"));
    assert.throws(() => f.bytes.sliceRead(two, id(), { offset: 0, byteLength: 1 }), code("NOT_FOUND"));
    assert.equal(f.state.live, false); assert.equal(f.state.closes, 1);
    assert.equal(await f.bytes.discard(two), false);
  } finally { f.bytes.close(); }
});

test("eight pending reservations enforce slot limit; discard and close release all shared references", async () => {
  const f = await fixture(); const ids = Array.from({ length: 8 }, id);
  for (const transferId of ids) await f.bytes.beginVerifiedRead(transferId, f.digest);
  await assert.rejects(f.bytes.beginVerifiedRead(id(), f.digest), code("OVERLOADED"));
  await assert.rejects(f.bytes.openRead(id(), f.digest), code("OVERLOADED"));
  assert.equal(f.state.reads, 0); assert.equal(f.state.opens, 1);
  await f.bytes.discard(ids[0]!);
  await f.bytes.beginVerifiedRead(id(), f.digest);
  f.bytes.close(); f.bytes.close();
  assert.equal(f.state.closes, 1); assert.equal(f.state.live, false);
});

test("zero-length content requires one digest finalization step without disk reads", async () => {
  const f = await fixture(0);
  try {
    const p = await f.bytes.beginVerifiedRead(id(), f.digest);
    assert.equal(p.complete, false);
    assert.equal((await f.bytes.advanceVerifiedRead(p.transferId, 1)).complete, true);
    assert.equal(f.state.reads, 0);
  } finally { f.bytes.close(); }
});

test("invalid budgets do not advance or discard a valid pending transfer", async () => {
  const f = await fixture(17);
  try {
    const p = await f.bytes.beginVerifiedRead(id(), f.digest);
    for (const max of [0, -1, 1.5, 131073, NaN, Infinity]) await assert.rejects(f.bytes.advanceVerifiedRead(p.transferId, max), code("INVALID_REQUEST"));
    assert.equal(f.state.reads, 0);
    assert.equal((await f.bytes.advanceVerifiedRead(p.transferId, 17)).complete, true);
  } finally { f.bytes.close(); }
});

test("catalog trusts only completed verification and retains promoted parent for ranged reads", async () => {
  const f = await fixture(100);
  try {
    let p = await f.catalog.beginVerifiedRead(f.digest, id);
    assert.equal(f.row.availability, "unverified"); assert.equal(f.state.reads, 0);
    p = await f.catalog.advanceVerifiedRead(p.transferId, 23);
    assert.equal(p.complete, false); assert.equal(f.row.availability, "unverified");
    p = await f.catalog.advanceVerifiedRead(p.transferId, 100);
    assert.equal(p.complete, true); assert.equal(f.row.availability, "verified");
    assert.ok(f.row.verification_epoch);
    const child = f.catalog.sliceRead(p.transferId, id, { offset: 5, byteLength: 3 });
    assert.deepEqual(f.catalog.readChunk(child.transferId).bytes, f.state.content.subarray(5, 8));
    await f.catalog.discard(child.transferId); await f.catalog.discard(p.transferId);
    assert.equal(f.state.live, false);
  } finally { f.bytes.close(); }
});

test("catalog incremental reader observes foreground shared verification without rehash", async () => {
  const f = await fixture(100);
  try {
    const p = await f.catalog.beginVerifiedRead(f.digest, id);
    await f.catalog.advanceVerifiedRead(p.transferId, 9);
    const foreground = await f.catalog.openRead(f.digest, id);
    assert.equal(f.state.reads, 100); assert.equal(f.state.opens, 1);
    assert.equal((await f.catalog.advanceVerifiedRead(p.transferId, 1)).complete, true);
    assert.equal(f.state.reads, 100);
    await f.catalog.discard(foreground.transferId); await f.catalog.discard(p.transferId);
  } finally { f.bytes.close(); }
});

test("catalog length changes quarantine without spending another byte budget", async () => {
  const f = await fixture(100);
  try {
    const p = await f.catalog.beginVerifiedRead(f.digest, id);
    await f.catalog.advanceVerifiedRead(p.transferId, 9);
    f.row.byte_length = 101;
    await assert.rejects(f.catalog.advanceVerifiedRead(p.transferId, 50), code("IO_ERROR"));
    assert.equal(f.state.reads, 9); assert.equal(f.quarantineCount(), 1); assert.equal(f.state.live, false);
  } finally { f.bytes.close(); }
});

test("catalog corrupt content and changed physical size quarantine and release handles", async () => {
  for (const physicalSize of [false, true]) {
    const f = await fixture(100);
    try {
      const p = await f.catalog.beginVerifiedRead(f.digest, id);
      if (physicalSize) f.state.content = f.state.content.subarray(0, 50); else f.state.content[50] = f.state.content[50]! ^ 1;
      await assert.rejects(f.catalog.advanceVerifiedRead(p.transferId, 100), code("IO_ERROR"));
      assert.equal(f.quarantineCount(), 1); assert.equal(f.state.live, false);
    } finally { f.bytes.close(); }
  }
});

test("catalog cancellation, overload, duplicate IDs, and invalid budgets never quarantine good bytes", async () => {
  const f = await fixture(100);
  try {
    const p = await f.catalog.beginVerifiedRead(f.digest, id);
    await assert.rejects(f.catalog.beginVerifiedRead(f.digest, () => p.transferId), code("CONFLICT"));
    await assert.rejects(f.catalog.openRead(f.digest, () => "invalid-id"), code("INVALID_REQUEST"));
    await assert.rejects(f.catalog.advanceVerifiedRead(p.transferId, 0), code("INVALID_REQUEST"));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.catalog.advanceVerifiedRead(p.transferId, 10, abort.signal), code("CANCELLED"));
    assert.equal(f.state.live, false);
    for (let i = 0; i < 8; i++) await f.catalog.beginVerifiedRead(f.digest, id);
    await assert.rejects(f.catalog.beginVerifiedRead(f.digest, id), code("OVERLOADED"));
    await assert.rejects(f.catalog.openRead(f.digest, id), code("OVERLOADED"));
    assert.equal(f.quarantineCount(), 0);
  } finally { f.bytes.close(); }
});

test("catalog discard removes cursor ownership and removed metadata fails before further hashing", async () => {
  const f = await fixture(100);
  try {
    const p = await f.catalog.beginVerifiedRead(f.digest, id);
    await f.catalog.discard(p.transferId);
    await assert.rejects(f.catalog.advanceVerifiedRead(p.transferId, 10), code("NOT_FOUND"));
    const next = await f.catalog.beginVerifiedRead(f.digest, id);
    f.removeMetadata();
    await assert.rejects(f.catalog.advanceVerifiedRead(next.transferId, 10), code("NOT_FOUND"));
    assert.equal(f.state.reads, 0); assert.equal(f.state.live, false);
  } finally { f.bytes.close(); }
});

test("cached verified reuse detects changed physical size and invalidates existing readers", async () => {
  const f = await fixture(100);
  try {
    const verified = await f.catalog.openRead(f.digest, id);
    f.state.content = f.state.content.subarray(0, 99);
    await assert.rejects(f.catalog.beginVerifiedRead(f.digest, id), code("IO_ERROR"));
    assert.throws(() => f.catalog.readChunk(verified.transferId), code("NOT_FOUND"));
    assert.equal(f.quarantineCount(), 1); assert.equal(f.state.live, false);
  } finally { f.bytes.close(); }
});

test("foreground digest failure invalidates a pending catalog reader without any readable fallback", async () => {
  const f = await fixture(100);
  try {
    const pending = await f.catalog.beginVerifiedRead(f.digest, id);
    await f.catalog.advanceVerifiedRead(pending.transferId, 10);
    f.state.content[50] = f.state.content[50]! ^ 1;
    await assert.rejects(f.catalog.openRead(f.digest, id), code("IO_ERROR"));
    await assert.rejects(f.catalog.advanceVerifiedRead(pending.transferId, 10), code("NOT_FOUND"));
    assert.throws(() => f.catalog.readChunk(pending.transferId), code("NOT_FOUND"));
    assert.equal(f.row.availability, "unverified"); assert.equal(f.state.live, false);
  } finally { f.bytes.close(); }
});

test("publication hashes pending shared bytes without replacing or trusting their unfinished hash", async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture(100);
    try {
      const upload = id();
      await f.bytes.begin(upload, 100, f.digest);
      f.bytes.append({ transferId: upload, sequence: 0, offset: 0, bytes: f.state.content.slice(), final: true });
      await f.bytes.finish(upload, 100, f.digest);
      const pending = await f.bytes.beginVerifiedRead(id(), f.digest);
      await f.bytes.advanceVerifiedRead(pending.transferId, 10);
      if (corrupt) f.state.content[50] = f.state.content[50]! ^ 1;
      const before = f.state.content.slice();
      if (corrupt) {
        await assert.rejects(f.bytes.publish(upload, undefined, { replaceUnpublished: true }), code("IO_ERROR"));
        assert.throws(() => f.bytes.readChunk(pending.transferId), code("NOT_FOUND"));
        assert.equal(f.state.live, false);
      } else {
        await f.bytes.publish(upload, undefined, { replaceUnpublished: true });
        assert.equal(f.state.reads, 110, "publication independently verifies all actual bytes");
        assert.throws(() => f.bytes.readChunk(pending.transferId), code("CONFLICT"));
        assert.equal((await f.bytes.advanceVerifiedRead(pending.transferId, 100)).complete, true);
      }
      assert.deepEqual(f.state.content, before, "publication cannot repair a file under a live shared hash");
      assert.equal(f.state.opens, 1);
    } finally { f.bytes.close(); }
  }
});

test("shared corruption clears every catalog cursor so abandoned sibling failures cannot accumulate", async () => {
  const f = await fixture(100);
  const bookkeeping = f.catalog as unknown as { pendingReads: Map<string, unknown> };
  try {
    for (let round = 0; round < 3; round++) {
      const reads = [];
      for (let i = 0; i < 8; i++) reads.push(await f.catalog.beginVerifiedRead(f.digest, id));
      assert.equal(bookkeeping.pendingReads.size, 8);
      f.state.content[50] = f.state.content[50]! ^ 1;
      await assert.rejects(f.catalog.advanceVerifiedRead(reads[0]!.transferId, 100), code("IO_ERROR"));
      assert.equal(bookkeeping.pendingReads.size, 0);
      for (const sibling of reads.slice(1)) await assert.rejects(f.catalog.advanceVerifiedRead(sibling.transferId, 1), code("NOT_FOUND"));
      assert.equal(f.state.live, false);
      f.state.content[50] = f.state.content[50]! ^ 1;
    }
  } finally { f.bytes.close(); }
});

test("consuming a foreground-promoted incremental parent retires its catalog cursor", async () => {
  const f = await fixture(100);
  const bookkeeping = f.catalog as unknown as { pendingReads: Map<string, unknown> };
  try {
    const pending = await f.catalog.beginVerifiedRead(f.digest, id);
    const foreground = await f.catalog.openRead(f.digest, id);
    await f.catalog.discard(foreground.transferId);
    const chunk = f.catalog.readChunk(pending.transferId);
    f.catalog.acknowledge({ transferId: pending.transferId, sequence: chunk.sequence, committedOffset: chunk.bytes.length });
    assert.equal(bookkeeping.pendingReads.size, 0); assert.equal(f.state.live, false);
  } finally { f.bytes.close(); }
});

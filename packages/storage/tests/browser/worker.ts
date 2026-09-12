import { searchVerificationAcceptance } from "./search-verification.ts";
import { OpfsBlobStore, BlobStorageError } from "../../src/worker/blobs.ts";
import { MAX_TRANSFER_BYTES } from "@quixi/core/contracts";
import type { ByteChunk } from "@quixi/core/contracts";
import type { BlobPurpose } from "@quixi/core/contracts";
import { catalogAcceptance } from "./catalog.ts";

const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (value: unknown) => void };
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
async function rejects(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try { await fn(); } catch (error) {
    assert(error instanceof BlobStorageError && error.code === code, `Expected ${code}, received ${String(error)}`); return;
  }
  throw new Error(`Expected ${code} rejection`);
}
const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
function fixture(size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 17 + (i >>> 8)) & 255;
  return data;
}
const SIZE = MAX_TRANSFER_BYTES * 5 + 17;
let interruptedStore: OpfsBlobStore | undefined;

async function leaveOpen(namespace: string): Promise<unknown> {
  const root = await navigator.storage.getDirectory();
  interruptedStore = await OpfsBlobStore.open(await root.getDirectoryHandle(namespace));
  const transferId = crypto.randomUUID(); await interruptedStore.begin(transferId, null, null);
  interruptedStore.append({ transferId, sequence: 0, offset: 0, bytes: new Uint8Array([7, 8, 9]), final: false });
  // Keep actual access handles live until the harness closes this browser process.
  return { transferId, checks: ["unfinished upload left open for browser termination"] };
}

async function exercise(operation: string, namespace: string): Promise<unknown> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(namespace, { create: true });
  let store = await OpfsBlobStore.open(directory);
  const checks: string[] = [];
  const data = fixture(SIZE);
  const expected = await digest(data);
  const upload = async (bytes: Uint8Array<ArrayBuffer>, hash: string, purpose: BlobPurpose = "attachment"): Promise<string> => {
    const id = crypto.randomUUID(); await store.begin(id, bytes.length, hash, purpose);
    let sequence = 0;
    do {
      const offset = sequence * MAX_TRANSFER_BYTES;
      const block = bytes.slice(offset, offset + MAX_TRANSFER_BYTES);
      const ack = store.append({ transferId: id, sequence, offset, bytes: block, final: offset + block.length === bytes.length });
      assert(ack.committedOffset === offset + block.length, "Upload acknowledgement has wrong offset"); sequence++;
    } while (sequence * MAX_TRANSFER_BYTES < bytes.length);
    await store.finish(id, bytes.length, hash); return id;
  };
  const read = async (): Promise<void> => {
    const id = crypto.randomUUID();
    const info = await store.openRead(id, expected);
    assert(info.byteLength === SIZE, "Published length changed");
    const chunks: ByteChunk[] = [];
    for (let i = 0; i < 4; i++) chunks.push(store.readChunk(id));
    await rejects(() => store.readChunk(id), "OVERLOADED");
    // Out-of-order acknowledgements free individual slots, not whole streams.
    for (const chunk of [chunks[2]!, chunks[0]!, chunks[3]!, chunks[1]!]) store.acknowledge({ transferId: id, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
    let final = false;
    while (!final) {
      const chunk = store.readChunk(id); chunks.push(chunk); final = chunk.final;
      store.acknowledge({ transferId: id, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
    }
    const restored = new Uint8Array(SIZE);
    for (const chunk of chunks) restored.set(chunk.bytes, chunk.offset);
    assert(await digest(restored) === expected, "Read stream differs from independent WebCrypto digest");
    await rejects(() => store.readChunk(id), "NOT_FOUND");
  };
  try {
    if (operation === "restart" || operation === "after_quota") {
      if (operation === "after_quota") {
        const recovered = new Uint8Array([15, 16, 17]); const recoveredHash = await digest(recovered);
        const transfer = await upload(recovered, recoveredHash); await store.publish(transfer); await store.discard(transfer);
        checks.push("new verified publication succeeds after quota is restored");
      }
      await read(); checks.push("published bytes survive browser process restart");
      const inventory = []; for await (const item of store.inventory()) inventory.push(item);
      assert(inventory.some(item => item.kind === "staged"), "Interrupted staging file disappeared");
      checks.push("interrupted staging remains visible for SQL reconciliation");
      return { checks, digest: expected, byteLength: SIZE, stagedFiles: inventory.filter(item => item.kind === "staged") };
    }
    if (operation === "quota") {
      const id = crypto.randomUUID(); await store.begin(id, null, null);
      let errorCode = "";
      for (let sequence = 0; sequence < 8; sequence++) {
        try { store.append({ transferId: id, sequence, offset: sequence * MAX_TRANSFER_BYTES, bytes: data.slice(0, MAX_TRANSFER_BYTES), final: false }); }
        catch (error) { if (!(error instanceof BlobStorageError)) throw error; errorCode = error.code; break; }
      }
      assert(errorCode === "QUOTA_EXCEEDED", `Real OPFS quota exhaustion was not observed: ${errorCode}`);
      await rejects(() => store.append({ transferId: id, sequence: 0, offset: 0, bytes: new Uint8Array([1]), final: true }), "INVALID_REQUEST");
      await store.discard(id);
      return { checks: ["real quota failure reported", "failed write cannot continue", "failed staging cleaned"], errorCode };
    }

    const id = await upload(data, expected);
    await rejects(() => store.openRead(crypto.randomUUID(), expected), "NOT_FOUND");
    checks.push("verified staging is invisible to published reads");
    const published = await store.publish(id);
    assert(published.sha256 === expected && published.byteLength === SIZE, "Publication identity changed");
    await store.publish(id); await store.finish(id, SIZE, expected);
    checks.push("publication and finalization retries preserve identity");
    await store.discard(id); await read();
    checks.push("bounded reads round-trip 5 MiB with four-chunk backpressure");

    const duplicate = await upload(data, expected);
    const readers = [crypto.randomUUID(), crypto.randomUUID()];
    for (const reader of readers) await store.openRead(reader, expected);
    await store.publish(duplicate); await store.discard(duplicate);
    await store.discard(readers[0]!);
    const siblingChunk = store.readChunk(readers[1]!);
    assert(siblingChunk.bytes[0] === data[0], "Closing one reader invalidated another");
    await store.discard(readers[1]!);
    checks.push("concurrent reads and deduplication share one immutable file handle");
    const publishedFiles = []; for await (const item of store.inventory()) if (item.kind === "blob") publishedFiles.push(item);
    assert(publishedFiles.length === 1, "Deduplication created another blob");
    checks.push("duplicate content shares one verified file");

    const bad = crypto.randomUUID(); await store.begin(bad, 3, null);
    await rejects(() => store.append({ transferId: bad, sequence: 1, offset: 0, bytes: new Uint8Array([1]), final: false }), "INVALID_REQUEST");
    await rejects(() => store.append({ transferId: bad, sequence: 0, offset: 0, bytes: new Uint8Array(MAX_TRANSFER_BYTES + 1), final: false }), "INVALID_REQUEST");
    await rejects(() => store.finish(bad, 3, "0".repeat(64)), "CONFLICT");
    store.append({ transferId: bad, sequence: 0, offset: 0, bytes: new Uint8Array([1, 2, 3]), final: true });
    await rejects(() => store.finish(bad, 3, "0".repeat(64)), "CONFLICT");
    await rejects(() => store.publish(bad), "CONFLICT"); await store.discard(bad);
    checks.push("sequence, oversize, incomplete and incorrect digest rejection");

    const emptyHash = await digest(new Uint8Array());
    const empty = await upload(new Uint8Array(), emptyHash); await store.publish(empty); await store.discard(empty);
    const emptyRead = crypto.randomUUID(); await store.openRead(emptyRead, emptyHash);
    const emptyChunk = store.readChunk(emptyRead); assert(emptyChunk.final && !emptyChunk.bytes.length, "Empty blob did not terminate");
    store.acknowledge({ transferId: emptyRead, sequence: 0, committedOffset: 0 });
    checks.push("empty blob has an acknowledged terminal chunk");

    const text = new Uint8Array(MAX_TRANSFER_BYTES + 3).fill(97);
    text.set([0xf0, 0x9f, 0x92, 0xa9], MAX_TRANSFER_BYTES - 1);
    const textHash = await digest(text); const textUpload = await upload(text, textHash, "canonical_text");
    assert((await store.publish(textUpload)).utf8Verified, "Text publication lacks UTF-8 verification");
    await store.discard(textUpload);
    for (const invalidBytes of [new Uint8Array([0xff]), new Uint8Array([0xf0, 0x9f])]) {
      const invalidHash = await digest(invalidBytes); const invalid = crypto.randomUUID();
      await store.begin(invalid, invalidBytes.length, invalidHash, "canonical_text");
      store.append({ transferId: invalid, sequence: 0, offset: 0, bytes: invalidBytes, final: true });
      await rejects(() => store.finish(invalid, invalidBytes.length, invalidHash), "INVALID_REQUEST");
      await rejects(() => store.publish(invalid), "CONFLICT"); await store.discard(invalid);
    }
    checks.push("canonical UTF-8 validates across chunks and rejects invalid or truncated sequences");

    const cancelData = new Uint8Array([8, 9]); const cancelHash = await digest(cancelData);
    const cancelled = await upload(cancelData, cancelHash);
    const controller = new AbortController(); controller.abort();
    await rejects(() => store.publish(cancelled, controller.signal), "CANCELLED");
    await rejects(() => store.openRead(crypto.randomUUID(), cancelHash), "NOT_FOUND");
    await store.discard(cancelled); checks.push("cancelled publication leaves no visible partial file");

    const midCopyData = data.slice(); midCopyData[0] = 99;
    const midCopyHash = await digest(midCopyData); const midCopy = await upload(midCopyData, midCopyHash);
    const midCopyController = new AbortController();
    const timer = setTimeout(() => midCopyController.abort(), 0);
    try { await rejects(() => store.publish(midCopy, midCopyController.signal), "CANCELLED"); } finally { clearTimeout(timer); }
    await rejects(() => store.openRead(crypto.randomUUID(), midCopyHash), "NOT_FOUND");
    await store.publish(midCopy); await store.discard(midCopy);
    checks.push("cancellation during publication cleans partial output and permits verified retry");

    const corruptData = new Uint8Array([4, 5]); const corruptHash = await digest(corruptData);
    const corrupt = await upload(corruptData, corruptHash); await store.publish(corrupt);
    const prefix = await (await directory.getDirectoryHandle("blobs")).getDirectoryHandle(corruptHash.slice(0, 2));
    const file = await prefix.getFileHandle(corruptHash);
    const handle = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ write(bytes: Uint8Array): number; flush(): void; close(): void }> }).createSyncAccessHandle();
    handle.write(new Uint8Array([7, 7])); handle.flush(); handle.close();
    await rejects(() => store.openRead(crypto.randomUUID(), corruptHash), "IO_ERROR");
    await rejects(() => store.publish(corrupt), "IO_ERROR");
    assert((await (await prefix.getFileHandle(corruptHash)).getFile()).size === 2, "Corrupt referenced file was destroyed");
    await store.discard(corrupt); checks.push("corruption rejected and preserved for recovery");

    const slots = [];
    for (let i = 0; i < 8; i++) { const slot = crypto.randomUUID(); await store.begin(slot, null, null); slots.push(slot); }
    await rejects(() => store.begin(crypto.randomUUID(), null, null), "OVERLOADED");
    for (const slot of slots) await store.discard(slot);
    checks.push("open transfer count is bounded");

    const interrupted = crypto.randomUUID(); await store.begin(interrupted, null, null);
    store.append({ transferId: interrupted, sequence: 0, offset: 0, bytes: new Uint8Array([1]), final: false });
    store.close(); store = await OpfsBlobStore.open(directory);
    await rejects(() => store.begin(interrupted, null, null), "CONFLICT");
    await read(); checks.push("owner restart preserves published data and fences interrupted transfer IDs");
    return { checks, digest: expected, byteLength: SIZE, chunkBytes: MAX_TRANSFER_BYTES, maxOpenTransfers: 8 };
  } finally { store.close(); }
}
scope.onmessage = event => {
  const { id, operation, namespace } = event.data;
  const task = operation.startsWith("search_verification_") ? searchVerificationAcceptance(namespace, operation === "search_verification_restart") : operation.startsWith("catalog_") ? catalogAcceptance(namespace, operation === "catalog_restart") : operation === "leave_open" ? leaveOpen(namespace) : exercise(operation, namespace);
  void task.then(result => scope.postMessage({ id, result }), error => scope.postMessage({ id, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }));
};

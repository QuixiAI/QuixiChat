import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { TransferWindow } from "@quixi/core/contracts";
import type {
  ByteChunk,
  ChunkAcknowledgement,
  HostTransfer,
} from "@quixi/core/contracts";
import { failure } from "./transfers.ts";
type Writable = {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};
type Handle = FileSystemFileHandle & {
  createWritable?: () => Promise<Writable>;
};
type Stage = {
  finishing: boolean;
  finishingTask?: Promise<unknown>;
  releaseLock: () => void;
  id: string;
  requestId: string;
  handle: Handle;
  writable: Writable | null;
  window: TransferWindow;
  offset: number;
  pending: number;
  final: boolean;
  verified: boolean;
  closed: boolean;
  hash: ReturnType<typeof sha256.create>;
  digest: string | null;
  expectedBytes: number | null;
  expectedSha256: string | null;
  queue: Promise<void>;
};
export interface RetainedDownload {
  id: string;
  name: string;
  byteLength: number;
  createdAt: number;
}
export class DiskStages {
  constructor(private readonly namespace = "default") {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(namespace))
      throw new Error("Invalid host file-staging namespace.");
  }
  private lock(name: string) {
    return `quixi-host-files:${this.namespace}:${name}`;
  }
  private starting = 0;
  private readonly items = new Map<string, Stage>();
  private readonly session = crypto.randomUUID();
  private directory: Promise<FileSystemDirectoryHandle> | undefined;
  private readonly retained = new Map<
    string,
    { metadata: RetainedDownload; handle: Handle; url: string }
  >();
  private root() {
    return (this.directory ??= (async () => {
      if (!navigator.storage?.getDirectory)
        throw failure(
          "UNSUPPORTED",
          "This browser lacks private disk staging. Use the desktop host to export large archives.",
          this.session,
        );
      const root = await navigator.storage.getDirectory();
      const parent = await root.getDirectoryHandle("quixi-host-downloads", {
        create: true,
      });
      return parent.getDirectoryHandle(this.namespace, { create: true });
    })());
  }
  owns(id: string) {
    return this.items.has(id);
  }
  get size() {
    return this.items.size + this.starting;
  }
  async capabilities() {
    try {
      const directory = await this.root();
      const name = crypto.randomUUID(),
        handle = (await directory.getFileHandle(name, {
          create: true,
        })) as Handle;
      const supported = !!handle.createWritable && !!navigator.locks;
      await directory.removeEntry(name);
      return {
        available: supported,
        mode:
          typeof (window as Window & { showSaveFilePicker?: unknown })
            .showSaveFilePicker === "function"
            ? ("picker" as const)
            : ("download" as const),
        maxRetainedDownloads: 4,
        requiresCompletionConfirmation:
          typeof (window as Window & { showSaveFilePicker?: unknown })
            .showSaveFilePicker !== "function",
        reason: supported
          ? null
          : "Private writable streams and Web Locks are required for bounded browser exports.",
      };
    } catch {
      return {
        available: false,
        mode: "download" as const,
        maxRetainedDownloads: 4,
        requiresCompletionConfirmation: true,
        reason:
          "Enable site storage in a regular browser profile, or use the desktop host.",
      };
    }
  }
  private async hold(id: string) {
    if (!navigator.locks)
      throw failure(
        "UNSUPPORTED",
        "Safe disk staging requires browser Web Locks.",
        id,
      );
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(this.lock(id), { mode: "exclusive" }, async () => {
          resolve();
          await done;
        })
        .catch(reject);
    });
    return release;
  }
  private async cleanupOrphans(directory: FileSystemDirectoryHandle) {
    let examined = 0;
    for await (const [name] of (
      directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries()) {
      if (++examined > 32) break;
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      await navigator.locks.request(
        this.lock(name),
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) return;
          try {
            await directory.getFileHandle(name + ".json");
            return;
          } catch (error) {
            if (
              !(error instanceof DOMException && error.name === "NotFoundError")
            )
              throw error;
          }
          await directory.removeEntry(name);
        },
      );
    }
  }
  async begin(
    requestId: string,
    expected: { expectedBytes: number | null; expectedSha256: string | null },
  ): Promise<HostTransfer> {
    if (this.items.size + this.starting >= 16)
      throw failure(
        "OVERLOADED",
        "Release an existing disk transfer first.",
        requestId,
      );
    this.starting++;
    const id = crypto.randomUUID();
    let releaseLock: (() => void) | undefined,
      directory: FileSystemDirectoryHandle | undefined;
    try {
      releaseLock = await this.hold(id);
      directory = await this.root();
      await this.cleanupOrphans(directory);
      const handle = (await directory.getFileHandle(id, {
        create: true,
      })) as Handle;
      if (!handle.createWritable)
        throw failure(
          "UNSUPPORTED",
          "This browser lacks OPFS writable streams; use Safari 26 or a supported Chromium browser, or the desktop host.",
          requestId,
        );
      const writable = await handle.createWritable();
      this.items.set(id, {
        finishing: false,
        releaseLock,
        id,
        requestId,
        handle,
        writable,
        window: new TransferWindow(id, 65536, 4),
        offset: 0,
        pending: 0,
        final: false,
        verified: false,
        closed: false,
        hash: sha256.create(),
        digest: null,
        ...expected,
        queue: Promise.resolve(),
      });
      return { transferId: id, maxChunkBytes: 65536, maxInFlight: 4 };
    } catch (error) {
      await directory?.removeEntry(id).catch(() => {});
      releaseLock?.();
      throw error;
    } finally {
      this.starting--;
    }
  }
  private get(id: string) {
    const item = this.items.get(id);
    if (!item || item.closed)
      throw failure("NOT_FOUND", "Disk transfer was released.", id);
    return item;
  }
  async write(chunk: ByteChunk): Promise<ChunkAcknowledgement> {
    const item = this.get(chunk.transferId);
    if (item.verified || item.final || !item.writable)
      throw failure(
        "CONFLICT",
        "Disk transfer does not accept writes.",
        item.requestId,
      );
    if (item.pending >= 4)
      throw failure(
        "OVERLOADED",
        "Await disk write acknowledgement before sending more chunks.",
        item.requestId,
      );
    if (
      item.expectedBytes !== null &&
      item.offset + chunk.bytes.length > item.expectedBytes
    )
      throw failure(
        "INVALID_REQUEST",
        "Disk transfer exceeds its declared length.",
        item.requestId,
      );
    try {
      item.window.reserve(chunk);
    } catch {
      throw failure(
        "INVALID_REQUEST",
        "Invalid disk chunk sequence, offset or size.",
        item.requestId,
      );
    }
    const bytes = chunk.bytes.slice();
    item.pending++;
    item.offset += bytes.length;
    item.final = chunk.final;
    const ack = {
      transferId: item.id,
      sequence: chunk.sequence,
      committedOffset: chunk.offset + bytes.length,
    };
    const task = item.queue.then(async () => {
      if (item.closed)
        throw failure("CANCELLED", "Disk transfer cancelled.", item.requestId);
      await item.writable!.write(bytes);
      item.hash.update(bytes);
      item.window.acknowledge(ack);
    });
    item.queue = task;
    try {
      await task;
      return ack;
    } finally {
      item.pending--;
      bytes.fill(0);
    }
  }
  async finish(
    requestId: string,
    id: string,
    expected: { byteLength: number; sha256: string },
  ) {
    const item = this.get(id);
    if (item.finishing)
      throw failure(
        "CONFLICT",
        "Disk verification is already running.",
        requestId,
      );
    item.finishing = true;
    const task = this.finishNow(requestId, id, expected);
    item.finishingTask = task;
    try {
      return await task;
    } finally {
      item.finishing = false;
      delete item.finishingTask;
    }
  }
  private async finishNow(
    requestId: string,
    id: string,
    expected: { byteLength: number; sha256: string },
  ) {
    const item = this.get(id);
    if (item.pending || !item.final || !item.window.complete)
      throw failure(
        "CONFLICT",
        "Finish requires acknowledged final disk bytes.",
        requestId,
      );
    if (
      expected.byteLength !== item.offset ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      (item.expectedBytes !== null && item.expectedBytes !== item.offset)
    )
      throw failure(
        "INVALID_REQUEST",
        "Disk transfer length differs.",
        requestId,
      );
    await item.queue;
    if (item.closed)
      throw failure("CANCELLED", "Disk verification cancelled.", requestId);
    item.digest ??= bytesToHex(item.hash.digest());
    if (
      item.digest !== expected.sha256 ||
      (item.expectedSha256 !== null && item.expectedSha256 !== item.digest)
    )
      throw failure(
        "INVALID_REQUEST",
        "Disk transfer hash differs.",
        requestId,
      );
    if (item.writable) {
      await item.writable.close();
      item.writable = null;
    }
    const file = await item.handle.getFile(),
      readback = sha256.create();
    try {
      if (file.size !== item.offset)
        throw failure(
          "IO_ERROR",
          "Stored disk file length differs.",
          requestId,
        );
      for (let offset = 0; offset < file.size; offset += 65536) {
        if (item.closed)
          throw failure("CANCELLED", "Disk verification cancelled.", requestId);
        readback.update(
          new Uint8Array(
            await file.slice(offset, offset + 65536).arrayBuffer(),
          ),
        );
      }
      if (bytesToHex(readback.digest()) !== item.digest)
        throw failure("IO_ERROR", "Stored disk file hash differs.", requestId);
    } finally {
      readback.destroy();
    }
    item.verified = true;
    return {
      transferId: id,
      byteLength: item.offset,
      sha256: item.digest,
      state: "verified_staged" as const,
    };
  }
  async file(id: string): Promise<File> {
    const item = this.get(id);
    if (!item.verified)
      throw failure(
        "CONFLICT",
        "A verified file-save transfer is required.",
        item.requestId,
      );
    const file = await item.handle.getFile();
    if (file.size !== item.offset)
      throw failure("IO_ERROR", "Staged file size changed.", item.requestId);
    return file;
  }
  async handoff(id: string, name: string): Promise<string> {
    if (!navigator.locks)
      throw failure(
        "UNSUPPORTED",
        "Safe disk download retention requires browser Web Locks.",
        id,
      );
    return navigator.locks.request(this.lock("registry"), () =>
      this.handoffLocked(id, name),
    );
  }
  private async handoffLocked(id: string, name: string): Promise<string> {
    const prior = this.retained.get(id);
    if (prior) return prior.url;
    if ((await this.listRetained()).length >= 4)
      throw failure(
        "OVERLOADED",
        "Confirm completed downloads and clear their temporary files before downloading another archive.",
        id,
      );
    const item = this.get(id),
      file = await this.file(id),
      url = URL.createObjectURL(file);
    this.retained.set(id, {
      metadata: { id, name, byteLength: file.size, createdAt: Date.now() },
      handle: item.handle,
      url,
    });
    // A metadata sidecar supports explicit cleanup after reload. It contains no
    // archive content or secrets; backing bytes cannot be removed on a timer.
    const directory = await this.root(),
      meta = (await directory.getFileHandle(id + ".json", {
        create: true,
      })) as Handle;
    const writable = await meta.createWritable!();
    try {
      await writable.write(
        new TextEncoder().encode(
          JSON.stringify(this.retained.get(id)!.metadata),
        ),
      );
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      this.retained.delete(id);
      URL.revokeObjectURL(url);
      throw error;
    }
    return url;
  }
  async listRetained(): Promise<RetainedDownload[]> {
    const directory = await this.root(),
      result: RetainedDownload[] = [];
    let examined = 0;
    for await (const [name, handle] of (
      directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries()) {
      if (++examined > 256)
        throw failure(
          "OVERLOADED",
          "Temporary download directory needs cleanup before another export.",
          this.session,
        );
      if (!/^[a-f0-9-]{36}\.json$/.test(name) || handle.kind !== "file")
        continue;
      if (result.length >= 4) break;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (file.size > 1024) continue;
      try {
        const value = JSON.parse(await file.text()) as RetainedDownload;
        if (
          value.id + ".json" === name &&
          typeof value.name === "string" &&
          value.name.length <= 255 &&
          Number.isSafeInteger(value.byteLength) &&
          value.byteLength >= 0 &&
          Number.isSafeInteger(value.createdAt)
        )
          result.push(value);
      } catch {
        /* Malformed metadata is not a deletion instruction. */
      }
    }
    return result;
  }
  async clearRetained(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw failure(
        "INVALID_REQUEST",
        "Invalid retained download identity.",
        id,
      );
    const metadata = (await this.listRetained()).find(
      (entry) => entry.id === id,
    );
    if (!metadata) return;
    await this.release(id);
    const retained = this.retained.get(id);
    if (retained) {
      URL.revokeObjectURL(retained.url);
      this.retained.delete(id);
    }
    const directory = await this.root();
    for (const name of [id, id + ".json"]) {
      try {
        await directory.removeEntry(name);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError"))
          throw error;
      }
    }
  }
  async release(id: string) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    item.closed = true;
    await item.queue.catch(() => {});
    await item.finishingTask?.catch(() => {});
    if (item.writable) await item.writable.abort().catch(() => {});
    item.hash.destroy();
    try {
      if (!this.retained.has(id))
        await (await this.root()).removeEntry(id).catch((error) => {
          if (
            !(error instanceof DOMException && error.name === "NotFoundError")
          )
            throw error;
        });
    } finally {
      item.releaseLock();
    }
  }
  async cancel(requestId: string) {
    await Promise.all(
      [...this.items.values()]
        .filter((item) => item.requestId === requestId)
        .map((item) => this.release(item.id)),
    );
  }
  async dispose() {
    await Promise.all([...this.items.keys()].map((id) => this.release(id)));
    for (const value of this.retained.values()) URL.revokeObjectURL(value.url);
    this.retained.clear();
  }
}

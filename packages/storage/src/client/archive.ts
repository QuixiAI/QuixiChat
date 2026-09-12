import {
  assertEntityPage,
  assertArchiveSelection,
  assertStorageRequest,
  jsonByteLength,
  MAX_TRANSFER_BYTES,
  TransferWindow,
} from "@quixi/core/contracts";
import type {
  ByteChunk,
  ArchiveSelection,
  CancellationResult,
  ChunkAcknowledgement,
  Progress,
  SearchIndexStatus,
  StorageClient,
  StorageOperations,
  StorageRequest,
} from "@quixi/core/contracts";
import { isQuixiId } from "@quixi/core/model";
import {
  ARCHIVE_MAX_CANCEL_PENDING,
  ARCHIVE_MAX_PENDING,
  ARCHIVE_PROTOCOL_VERSION,
  ArchiveStorageError,
  archiveError,
  callOperationId,
  hasArchiveProtocolVersion,
  validArchiveId,
  validateAck,
  validateArchiveCall,
  validateChunk,
} from "../archive-protocol.ts";
import type { ArchiveCall, ArchiveOutput } from "../archive-protocol.ts";

interface Pending {
  call: ArchiveCall;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Upload {
  window: TransferWindow;
  inFlight: number;
}
interface Download {
  window: TransferWindow;
  credits: number;
  ended: boolean;
  sha256: string;
  byteLength: number;
  rangeBytes: number;
}
export interface ArchiveClientOptions {
  selection: ArchiveSelection;
  timeoutMs?: number;
}
/** Production client. Only its elected owner worker opens the archive database.
 * Byte calls never automatically retry after an unknown reply; restart that
 * transfer while retaining canonical mutation/transaction identities.
 */
export class ArchiveStorageClient implements StorageClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, Pending>();
  private readonly uploads = new Map<string, Upload>();
  private readonly downloads = new Map<string, Download>();
  private readonly archiveTransfers = new Map<string, string>();
  private readonly changes = new Set<(ids: string[]) => void>();
  private readonly selectionChanges = new Set<(selection: ArchiveSelection) => void>();
  private readonly progress = new Set<(progress: Progress) => void>();
  private readonly searchChanges = new Set<
    (status: SearchIndexStatus) => void
  >();
  private failure: ArchiveStorageError | undefined;
  private closed = false;
  private closedAck: (() => void) | undefined;
  readonly archiveId: string;
  readonly selection: Readonly<ArchiveSelection>;
  readonly timeoutMs: number;

  constructor(options: ArchiveClientOptions, worker?: Worker) {
    assertArchiveSelection(options?.selection);
    this.selection = Object.freeze({ ...options.selection });
    this.archiveId = this.selection.archiveId;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (
      !validArchiveId(this.archiveId) ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 600_000
    )
      throw new Error("Invalid archive ID or request deadline");
    this.worker = worker ?? new Worker(new URL("../worker/archive.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data }: MessageEvent<ArchiveOutput>) => {
      if (!hasArchiveProtocolVersion(data)) {
        this.fail(new ArchiveStorageError(archiveError(new Error("Archive worker protocol changed; reopen the application and reconcile dispatched operations"), crypto.randomUUID(), null, "UNKNOWN_OUTCOME")));
        return;
      }
      if (data.type === "closed") {
        this.closedAck?.();
        return;
      }
      if (data.type === "fatal") {
        this.fail(new ArchiveStorageError(data.error));
        return;
      }
      if (data.type === "changed") {
        for (const listener of this.changes) {
          try {
            listener(data.operationIds);
          } catch {
            /* One subscriber cannot break reply handling. */
          }
        }
        return;
      }
      if (data.type === 'selection') {
        try { assertArchiveSelection(data.selection); }
        catch { return; }
        for (const listener of this.selectionChanges) {
          try { listener({ ...data.selection }); } catch { /* Isolate subscribers. */ }
        }
        return;
      }
      if (data.type === "progress") {
        for (const listener of this.progress) {
          try {
            listener(data.progress);
          } catch {
            /* Isolate subscriber failures. */
          }
        }
        return;
      }
      if (data.type === "search") {
        for (const listener of this.searchChanges) {
          try {
            listener(data.status);
          } catch {
            /* Isolate subscriber failures. */
          }
        }
        return;
      }
      if (data.type !== "reply") return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (!data.ok) {
        this.invalidateTransfer(pending.call);
        pending.reject(new ArchiveStorageError(data.error));
        return;
      }
      try {
        if (pending.call.kind === "read")
          validateChunk(data.result as ByteChunk);
        else jsonByteLength(data.result, MAX_TRANSFER_BYTES);
        pending.resolve(data.result);
      } catch (error) {
        this.invalidateTransfer(pending.call);
        pending.reject(
          new ArchiveStorageError(
            archiveError(
              error,
              data.id,
              callOperationId(pending.call),
              "UNKNOWN_OUTCOME",
            ),
          ),
        );
      }
    };
    this.worker.onerror = (event) =>
      this.fail(
        new ArchiveStorageError(
          archiveError(
            new Error(
              event.message || "Archive worker terminated unexpectedly",
            ),
            crypto.randomUUID(),
            null,
            "UNKNOWN_OUTCOME",
          ),
        ),
      );
    this.worker.onmessageerror = () =>
      this.fail(
        new ArchiveStorageError(
          archiveError(
            new Error("Archive worker reply could not be decoded"),
            crypto.randomUUID(),
            null,
            "UNKNOWN_OUTCOME",
          ),
        ),
      );
    this.worker.postMessage({ version: ARCHIVE_PROTOCOL_VERSION, type: "init", selection: this.selection });
  }
  private fail(error: ArchiveStorageError): void {
    this.failure = error;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      // A fatal/stale notification says nothing about a dispatched operation's
      // commit. In particular activation may commit before its reply is lost.
      // Keep the future-call failure, but reconcile each pending identity.
      item.reject(new ArchiveStorageError(archiveError(
        new Error(`${error.message} A dispatched request has an unknown outcome; inspect its original operation identity before retrying.`),
        item.call.id,
        callOperationId(item.call),
        'UNKNOWN_OUTCOME',
      )));
    }
    this.pending.clear();
    this.uploads.clear();
    this.downloads.clear();
    this.archiveTransfers.clear();
  }
  private invalidateTransfer(call: ArchiveCall): void {
    if (call.kind === "upload") this.uploads.delete(call.chunk.transferId);
    if (call.kind === "read") this.downloads.delete(call.transferId);
    if (call.kind === "ack")
      this.downloads.delete(call.acknowledgement.transferId);
  }
  private call(call: ArchiveCall): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed)
      return Promise.reject(
        new ArchiveStorageError(
          archiveError(
            new Error("Archive client is closed"),
            call.id,
            callOperationId(call),
            "CLOSED",
          ),
        ),
      );
    try {
      validateArchiveCall(call);
      if (this.pending.has(call.id))
        throw new ArchiveStorageError(
          archiveError(
            new Error("A request with this ID is already pending"),
            call.id,
            callOperationId(call),
            "CONFLICT",
          ),
        );
      this.assertAdmission(call);
    } catch (error) {
      return Promise.reject(
        error instanceof ArchiveStorageError
          ? error
          : new ArchiveStorageError(
              archiveError(
                error,
                call.id,
                callOperationId(call),
                "INVALID_REQUEST",
              ),
            ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(call.id);
        this.invalidateTransfer(call);
        reject(
          new ArchiveStorageError(
            archiveError(
              new Error(
                "Archive reply deadline elapsed after dispatch. Inspect canonical operation status before retrying a write; restart byte transfers after an unknown chunk outcome.",
              ),
              call.id,
              callOperationId(call),
              "UNKNOWN_OUTCOME",
            ),
          ),
        );
        if (call.kind !== "cancel")
          void this.cancel(call.id, callOperationId(call)).catch(
            () => undefined,
          );
      }, this.timeoutMs);
      this.pending.set(call.id, { call, resolve, reject, timer });
      try {
        this.worker.postMessage({ version: ARCHIVE_PROTOCOL_VERSION, type: "call", selection: this.selection, call });
      } catch (error) {
        this.pending.delete(call.id);
        clearTimeout(timer);
        this.invalidateTransfer(call);
        reject(
          new ArchiveStorageError(
            archiveError(
              error,
              call.id,
              callOperationId(call),
              "INVALID_REQUEST",
            ),
          ),
        );
      }
    });
  }
  private assertAdmission(call: ArchiveCall): void {
    const cancelCount = [...this.pending.values()].filter(
      (value) => value.call.kind === "cancel",
    ).length;
    if (
      call.kind === "cancel"
        ? cancelCount >= ARCHIVE_MAX_CANCEL_PENDING
        : this.pending.size - cancelCount >= ARCHIVE_MAX_PENDING
    )
      throw new ArchiveStorageError(
        archiveError(
          new Error("Archive request queue is full"),
          call.id,
          callOperationId(call),
          "OVERLOADED",
        ),
      );
  }
  async request<K extends keyof StorageOperations>(
    requestId: string,
    operation: K,
    args: StorageOperations[K]["args"],
  ): Promise<StorageOperations[K]["result"]> {
    const request = {
      version: 1,
      requestId,
      operation,
      args,
    } as StorageRequest;
    try {
      assertStorageRequest(request);
    } catch (error) {
      throw new ArchiveStorageError(
        archiveError(error, requestId, null, "INVALID_REQUEST"),
      );
    }
    const parent =
      request.operation === "sliceBlobTransfer"
        ? this.downloads.get(request.args.transferId)
        : undefined;
    if (
      request.operation === "sliceBlobTransfer" &&
      (!parent || this.archiveTransfers.has(request.args.transferId))
    )
      throw new ArchiveStorageError(
        archiveError(
          new Error("The verified blob reader is not open in this client"),
          requestId,
          null,
          "NOT_FOUND",
        ),
      );
    const value = await this.call({ id: requestId, kind: "request", request });
    if (
      request.operation === "readEntities" ||
      request.operation === "readMessageParts" ||
      request.operation === "readStagedImportRecords" ||
      request.operation === "importRunList" ||
      request.operation === "importRunReadGroups" ||
      request.operation === "importWorkRead" ||
      request.operation === "listLibrary" ||
      request.operation === "readConversationWindow" ||
      request.operation === "readMessageChildren"
    )
      assertEntityPage(value, request.args.page);
    if (request.operation === "beginBlobTransfer") {
      const result = value as StorageOperations["beginBlobTransfer"]["result"];
      if (
        !result ||
        !isQuixiId(result.transferId) ||
        !Number.isSafeInteger(result.maxChunkBytes) ||
        !Number.isSafeInteger(result.maxInFlight)
      )
        throw new Error("Invalid upload transfer response");
      if (!this.uploads.has(result.transferId))
        this.uploads.set(result.transferId, {
          window: new TransferWindow(
            result.transferId,
            result.maxChunkBytes,
            result.maxInFlight,
          ),
          inFlight: 0,
        });
    }
    if (request.operation === "readBlobTransfer") {
      const result = value as StorageOperations["readBlobTransfer"]["result"];
      if (
        !result ||
        !isQuixiId(result.transferId) ||
        result.sha256 !== request.args.sha256 ||
        !Number.isSafeInteger(result.byteLength) ||
        result.byteLength < 0
      )
        throw new Error("Invalid download transfer response");
      this.downloads.set(result.transferId, {
        window: new TransferWindow(result.transferId),
        credits: 0,
        ended: false,
        sha256: result.sha256,
        byteLength: result.byteLength,
        rangeBytes: result.byteLength,
      });
    }
    if (request.operation === "sliceBlobTransfer") {
      const result = value as StorageOperations["sliceBlobTransfer"]["result"];
      if (
        !result ||
        !isQuixiId(result.transferId) ||
        result.sha256 !== parent!.sha256 ||
        result.byteLength !== parent!.byteLength ||
        result.range?.offset !== request.args.offset ||
        result.range.byteLength !== request.args.byteLength ||
        result.range.offset + result.range.byteLength > result.byteLength
      )
        throw new ArchiveStorageError(
          archiveError(
            new Error("Invalid blob range response"),
            requestId,
            null,
            "UNKNOWN_OUTCOME",
          ),
        );
      this.downloads.set(result.transferId, {
        window: new TransferWindow(result.transferId),
        credits: 0,
        ended: false,
        sha256: result.sha256,
        byteLength: result.byteLength,
        rangeBytes: result.range.byteLength,
      });
    }
    if (request.operation === "listArchiveJobs") {
      const result = value as StorageOperations["listArchiveJobs"]["result"];
      if (
        !result ||
        !Array.isArray(result.items) ||
        result.items.length > request.args.maxItems ||
        !(result.nextJobId === null || isQuixiId(result.nextJobId))
      )
        throw new Error("Invalid archive job page");
    }
    if (request.operation === "beginArchiveRestore") {
      const result =
          value as StorageOperations["beginArchiveRestore"]["result"],
        transfer = result?.inputTransfer;
      if (
        !result?.job ||
        !isQuixiId(result.job.jobId) ||
        !transfer ||
        !isQuixiId(transfer.transferId) ||
        transfer.maxChunkBytes !== 65536 ||
        transfer.maxInFlight !== 4
      )
        throw new Error("Invalid archive upload descriptor");
      if (!this.uploads.has(transfer.transferId))
        this.uploads.set(transfer.transferId, {
          window: new TransferWindow(
            transfer.transferId,
            transfer.maxChunkBytes,
            transfer.maxInFlight,
          ),
          inFlight: 0,
        });
      this.archiveTransfers.set(transfer.transferId, result.job.jobId);
    }
    if (request.operation === "openArchiveExport") {
      const result = value as StorageOperations["openArchiveExport"]["result"];
      if (
        !result ||
        !isQuixiId(result.transferId) ||
        result.maxChunkBytes !== 65536 ||
        result.maxInFlight !== 4 ||
        !Number.isSafeInteger(result.byteLength) ||
        result.byteLength < 0 ||
        !/^[a-f0-9]{64}$/.test(result.sha256)
      )
        throw new Error("Invalid archive download descriptor");
      this.downloads.set(result.transferId, {
        window: new TransferWindow(
          result.transferId,
          result.maxChunkBytes,
          result.maxInFlight,
        ),
        credits: 0,
        ended: false,
        sha256: result.sha256,
        byteLength: result.byteLength,
        rangeBytes: result.byteLength,
      });
      this.archiveTransfers.set(result.transferId, request.args.jobId);
    }
    if (
      request.operation === "finishArchiveRestore" ||
      request.operation === "cancelArchiveJob" ||
      request.operation === "releaseArchiveJob"
    )
      for (const [transferId, jobId] of this.archiveTransfers)
        if (jobId === request.args.jobId) {
          this.uploads.delete(transferId);
          this.downloads.delete(transferId);
          this.archiveTransfers.delete(transferId);
        }
    if (request.operation === "discardBlobTransfer") {
      this.uploads.delete(request.args.transferId);
      this.downloads.delete(request.args.transferId);
    }
    return value as StorageOperations[K]["result"];
  }
  async sendChunk(chunk: ByteChunk): Promise<ChunkAcknowledgement> {
    const upload = this.uploads.get(chunk.transferId);
    const call: ArchiveCall = {
      id: crypto.randomUUID(),
      kind: "upload",
      chunk,
    };
    this.assertAdmission(call);
    if (upload && upload.inFlight >= upload.window.maxInFlight)
      throw new ArchiveStorageError(
        archiveError(
          new Error("Transfer backpressure: await acknowledgement"),
          call.id,
          null,
          "OVERLOADED",
        ),
      );
    try {
      validateChunk(chunk);
      if (!upload)
        throw new Error(
          "Upload is not open; begin a new transfer after an unknown outcome",
        );
      upload.window.reserve(chunk);
    } catch (error) {
      throw new ArchiveStorageError(
        archiveError(error, crypto.randomUUID(), null, "INVALID_REQUEST"),
      );
    }
    upload!.inFlight++;
    try {
      const ack = (await this.call(call)) as ChunkAcknowledgement;
      validateAck(ack);
      upload!.window.acknowledge(ack);
      if (upload!.window.complete) {
        this.uploads.delete(chunk.transferId);
        this.archiveTransfers.delete(chunk.transferId);
      }
      return ack;
    } catch (error) {
      this.uploads.delete(chunk.transferId);
      throw error;
    } finally {
      upload!.inFlight--;
    }
  }
  async readChunk(transferId: string): Promise<ByteChunk> {
    const download = this.downloads.get(transferId);
    if (!download)
      throw new ArchiveStorageError(
        archiveError(
          new Error(
            "Download is not open; reopen it after an unknown chunk outcome",
          ),
          crypto.randomUUID(),
          null,
          "NOT_FOUND",
        ),
      );
    const call: ArchiveCall = {
      id: crypto.randomUUID(),
      kind: "read",
      transferId,
    };
    this.assertAdmission(call);
    if (download.ended)
      throw new ArchiveStorageError(
        archiveError(
          new Error("Final chunk was already received"),
          call.id,
          null,
          "INVALID_REQUEST",
        ),
      );
    if (download.credits >= download.window.maxInFlight)
      throw new ArchiveStorageError(
        archiveError(
          new Error("Transfer backpressure: acknowledge a chunk"),
          call.id,
          null,
          "OVERLOADED",
        ),
      );
    // Reserve admission before posting: concurrent calls and replies awaiting ACK
    // share the same four credits. A rejected fifth call never reaches the owner.
    download.credits++;
    try {
      const chunk = (await this.call(call)) as ByteChunk;
      if (
        chunk.offset + chunk.bytes.length > download.rangeBytes ||
        chunk.final !==
          (chunk.offset + chunk.bytes.length === download.rangeBytes)
      )
        throw new Error(
          "Blob chunk exceeds its declared range or has an invalid final marker",
        );
      download.window.reserve(chunk);
      download.ended = chunk.final;
      return chunk;
    } catch (error) {
      this.downloads.delete(transferId);
      throw new ArchiveStorageError(
        archiveError(error, crypto.randomUUID(), null, "UNKNOWN_OUTCOME"),
      );
    }
  }
  async acknowledgeChunk(ack: ChunkAcknowledgement): Promise<void> {
    const download = this.downloads.get(ack.transferId);
    const call: ArchiveCall = {
      id: crypto.randomUUID(),
      kind: "ack",
      acknowledgement: ack,
    };
    this.assertAdmission(call);
    try {
      validateAck(ack);
      if (!download) throw new Error("Download is not open");
      download.window.acknowledge(ack);
    } catch (error) {
      throw new ArchiveStorageError(
        archiveError(error, crypto.randomUUID(), null, "INVALID_REQUEST"),
      );
    }
    await this.call(call);
    download!.credits--;
    if (download!.window.complete && download!.credits === 0) {
      this.downloads.delete(ack.transferId);
      this.archiveTransfers.delete(ack.transferId);
    }
  }
  async cancel(
    requestId: string,
    operationId: string | null,
  ): Promise<CancellationResult> {
    return (await this.call({
      id: crypto.randomUUID(),
      kind: "cancel",
      targetRequestId: requestId,
      operationId,
    })) as CancellationResult;
  }
  onProgress(listener: (value: Progress) => void): () => void {
    this.progress.add(listener);
    return () => this.progress.delete(listener);
  }
  onChange(listener: (ids: string[]) => void): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }
  /** Advisory UI hint only; every operation still checks its original fence. */
  onSelectionChange(listener: (selection: ArchiveSelection) => void): () => void {
    this.selectionChanges.add(listener);
    return () => this.selectionChanges.delete(listener);
  }
  onSearchChange(listener: (status: SearchIndexStatus) => void): () => void {
    this.searchChanges.add(listener);
    return () => this.searchChanges.delete(listener);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      this.closedAck = () => {
        clearTimeout(timer);
        resolve();
      };
      this.worker.postMessage({ version: ARCHIVE_PROTOCOL_VERSION, type: "close" });
    });
    this.worker.terminate();
    this.fail(
      new ArchiveStorageError(
        archiveError(
          new Error("Archive client closed; reconcile any dispatched writes"),
          crypto.randomUUID(),
          null,
          "UNKNOWN_OUTCOME",
        ),
      ),
    );
    this.changes.clear();
    this.selectionChanges.clear();
    this.progress.clear();
    this.searchChanges.clear();
  }
}
export function createStorageClient(
  options: ArchiveClientOptions,
): ArchiveStorageClient {
  return new ArchiveStorageClient(options);
}

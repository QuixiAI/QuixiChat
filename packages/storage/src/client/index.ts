import { MAX_PENDING, serializeError, validateRequest } from "../protocol.ts";
export { ArchiveStorageClient, createStorageClient } from "./archive.ts";
export type { ArchiveClientOptions } from "./archive.ts";
export { ArchiveStorageError } from "../archive-protocol.ts";
export { acquireGenerationLease } from "./producer.ts";
export type { GenerationLease } from "./producer.ts";
import type { Operation, ProofOperations, SerializedStorageError, StorageErrorCode, StorageRequest, WorkerOutput } from "../protocol.ts";
export type { ProofRecord, StorageDiagnostics, StorageErrorCode } from "../protocol.ts";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(error: SerializedStorageError) {
    super(error.message);
    this.name = "StorageError";
    this.code = error.code;
  }
}

/** Developer records use an isolated proof namespace, never the chat archive. */
export class StorageProofClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, {
    resolve: (result: unknown) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private failure: StorageError | undefined;
  private closedAck: (() => void) | undefined;

  constructor(readonly namespace = "development-proof") {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new StorageError({ code: "INVALID_REQUEST", message: "Invalid proof namespace" });
    this.worker = new Worker(new URL("../worker/index.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<WorkerOutput>) => {
      if (data.type === "changed") {
        for (const listener of this.listeners) listener();
      } else if (data.type === "closed") {
        this.closedAck?.();
      } else if (data.type === "fatal") {
        this.failure = new StorageError(data.error);
        this.rejectPending(this.failure);
      } else if (data.type === "response") {
        const request = this.pending.get(data.id);
        if (!request) return;
        this.pending.delete(data.id);
        clearTimeout(request.timer);
        if (data.ok) request.resolve(data.result);
        else request.reject(new StorageError(data.error));
      }
    };
    this.worker.onerror = (event) => {
      this.failure = new StorageError({ code: "INITIALIZATION_FAILED", message: event.message || "Storage worker failed" });
      this.rejectPending(this.failure);
    };
    this.worker.postMessage({ type: "init", namespace });
  }

  request<K extends Operation>(operation: K, args: ProofOperations[K]["args"], timeoutMs = 30_000): Promise<ProofOperations[K]["result"]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new StorageError({ code: "CLOSED", message: "Storage client is closed" }));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new StorageError({ code: "OVERLOADED", message: "Storage request queue is full" }));
    const id = crypto.randomUUID();
    const message = { type: "request", id, operation, args } as StorageRequest;
    try { validateRequest(message); }
    catch (error) { return Promise.reject(new StorageError(serializeError(error, "INVALID_REQUEST"))); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.worker.postMessage({ type: "cancel", id });
        reject(new StorageError({ code: "UNKNOWN_OUTCOME", message: "Storage request timed out; a dispatched write may have committed. Inspect state before retrying." }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      this.worker.postMessage(message);
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      this.closedAck = () => { clearTimeout(timer); resolve(); };
      this.worker.postMessage({ type: "close" });
    });
    this.worker.terminate();
    this.rejectPending(new StorageError({ code: "UNKNOWN_OUTCOME", message: "Storage client closed with pending work; inspect state before retrying writes" }));
    this.listeners.clear();
  }

  /** Developer failure probe: abrupt owner death without graceful close. */
  terminate(): void {
    this.closed = true;
    this.worker.terminate();
    this.rejectPending(new StorageError({ code: "UNKNOWN_OUTCOME", message: "Storage worker terminated; inspect write state after reconnecting" }));
    this.listeners.clear();
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
export { openActiveStorageClient, readArchiveSelection, archiveActivationStatus } from './selection.ts';
export { readRetainedArchive } from './retained-archive.ts';
export { exportRescueArchive, RESCUE_EXPORT_LIMITS } from './rescue-export.ts';
export type { RescueExportSummary, RescueManifest, RescueLedgerRow } from './rescue-export.ts';
export { reconcilePreviousArchiveOperations } from './reconcile-retained.ts';
export { reconcilePreviousArchiveExtraction } from './reconcile-extraction.ts';
export type { RetainedArchiveOperation } from './retained-archive.ts';

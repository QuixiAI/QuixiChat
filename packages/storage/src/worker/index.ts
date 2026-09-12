import { ProofDatabase } from "./database.ts";
import { MAX_PENDING, serializeError, validateRequest } from "../protocol.ts";
import type { SerializedStorageError, StorageRequest, StorageResponse, WorkerInput, WorkerOutput } from "../protocol.ts";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInput>) => void) | null;
  postMessage: (message: WorkerOutput) => void;
};
type BusMessage =
  | { type: "hello" }
  | { type: "owner" | "released"; ownerId: string }
  | { type: "work"; ownerId: string; senderId: string; request: StorageRequest }
  | { type: "result"; recipientId: string; response: StorageResponse }
  | { type: "changed" };

const workerId = crypto.randomUUID();
const waiting = new Map<string, { request: StorageRequest; dispatchedTo?: string }>();
const queue: { senderId: string; request: StorageRequest }[] = [];
const acquisition = new AbortController();
let channel: BroadcastChannel | undefined;
let database: ProofDatabase | undefined;
let ownerId: string | undefined;
let lockTask: Promise<void> | undefined;
let releaseOwner: (() => void) | undefined;
let processing: Promise<void> | undefined;
let closing = false;
let initialized = false;
let fatal: SerializedStorageError | undefined;

function broadcast(message: BusMessage): void { channel?.postMessage(message); }
function respond(recipientId: string, response: StorageResponse): void {
  if (recipientId === workerId) {
    if (!waiting.delete(response.id)) return;
    scope.postMessage(response);
  } else broadcast({ type: "result", recipientId, response });
}
function rejectWaiting(error: SerializedStorageError): void {
  for (const id of waiting.keys()) respond(workerId, { type: "response", id, ok: false, error });
}

function changeOwner(next: string | undefined): void {
  if (ownerId === next) return;
  ownerId = next;
  for (const [id, work] of waiting) {
    if (work.dispatchedTo && work.dispatchedTo !== next) {
      respond(workerId, { type: "response", id, ok: false, error: {
        code: "UNKNOWN_OUTCOME", message: "Database owner changed during the request. Inspect state before retrying a write.",
      } });
    }
  }
  dispatchWaiting();
}

function dispatchWaiting(): void {
  if (!ownerId || closing) return;
  for (const work of waiting.values()) {
    if (work.dispatchedTo) continue;
    work.dispatchedTo = ownerId;
    if (ownerId === workerId) enqueue(workerId, work.request);
    else broadcast({ type: "work", ownerId, senderId: workerId, request: work.request });
  }
}

function enqueue(senderId: string, request: StorageRequest): void {
  try {
    validateRequest(request);
    if (request.operation === "beginInterruptedWrite" && senderId !== workerId) throw new Error("Crash probe requires the owning tab; forwarding is disabled");
  } catch (error) {
    respond(senderId, { type: "response", id: request.id, ok: false, error: serializeError(error, "INVALID_REQUEST") });
    return;
  }
  if (closing || !database) {
    respond(senderId, { type: "response", id: request.id, ok: false, error: { code: "CLOSED", message: "Database owner is closing" } });
    return;
  }
  if (queue.length >= MAX_PENDING) {
    respond(senderId, { type: "response", id: request.id, ok: false, error: { code: "OVERLOADED", message: "Database owner queue is full" } });
    return;
  }
  queue.push({ senderId, request });
  if (!processing) {
    // Defer drain until processing holds the promise, including synchronous errors.
    processing = Promise.resolve().then(drain).finally(() => { processing = undefined; });
  }
}

async function drain(): Promise<void> {
  while (queue.length) {
    const work = queue.shift()!;
    try {
      if (!database) throw new Error("Database is closed");
      const result = await database.execute(work.request, workerId);
      respond(work.senderId, { type: "response", id: work.request.id, ok: true, result });
      if (work.request.operation === "put" || work.request.operation === "remove") {
        scope.postMessage({ type: "changed" });
        broadcast({ type: "changed" });
      }
    } catch (error) {
      respond(work.senderId, { type: "response", id: work.request.id, ok: false, error: serializeError(error) });
    }
  }
}

function start(namespace: string): void {
  if (initialized) return;
  initialized = true;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) {
    fail({ code: "INVALID_REQUEST", message: "Invalid storage namespace" });
    return;
  }
  if (!globalThis.isSecureContext || !navigator.locks || !navigator.storage?.getDirectory || typeof BroadcastChannel === "undefined") {
    fail({ code: "UNSUPPORTED", message: "Local storage requires a secure context, Web Locks, OPFS, and BroadcastChannel" });
    return;
  }
  channel = new BroadcastChannel(`quixi:proof:${namespace}:v1`);
  channel.onmessage = ({ data }: MessageEvent<BusMessage>) => {
    if (closing) return;
    switch (data.type) {
      case "hello": if (database && ownerId === workerId) broadcast({ type: "owner", ownerId: workerId }); break;
      case "owner": changeOwner(data.ownerId); break;
      case "released": if (ownerId === data.ownerId) changeOwner(undefined); break;
      case "work": if (data.ownerId === workerId && ownerId === workerId) enqueue(data.senderId, data.request); break;
      case "result": if (data.recipientId === workerId) respond(workerId, data.response); break;
      case "changed": scope.postMessage({ type: "changed" }); break;
    }
  };
  broadcast({ type: "hello" });
  lockTask = navigator.locks.request(`quixi:proof:${namespace}:owner`, { mode: "exclusive", signal: acquisition.signal }, async () => {
    const released = new Promise<void>((resolve) => { releaseOwner = resolve; });
    try {
      database = await ProofDatabase.open(namespace);
      if (!closing) {
        changeOwner(workerId);
        broadcast({ type: "owner", ownerId: workerId });
        await released;
      }
      await processing;
    } finally {
      database?.close();
      database = undefined;
      broadcast({ type: "released", ownerId: workerId });
      ownerId = undefined;
    }
  }).catch((error: unknown) => {
    if (!closing) fail(serializeError(error, "INITIALIZATION_FAILED"));
  });
}

function fail(error: SerializedStorageError): void {
  fatal = error;
  rejectWaiting(error);
  scope.postMessage({ type: "fatal", error });
}

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  acquisition.abort();
  releaseOwner?.();
  await lockTask;
  for (const [id, work] of waiting) respond(workerId, { type: "response", id, ok: false, error: {
    code: work.dispatchedTo ? "UNKNOWN_OUTCOME" : "CLOSED",
    message: work.dispatchedTo ? "Worker closed during a dispatched request; inspect state before retrying" : "Worker closed before dispatch",
  } });
  channel?.close();
  scope.postMessage({ type: "closed" });
}

scope.onmessage = ({ data }) => {
  if (data.type === "init") start(data.namespace);
  else if (data.type === "close") void close();
  else if (data.type === "cancel") waiting.delete(data.id);
  else if (data.type === "request") {
    try { validateRequest(data); }
    catch (error) {
      scope.postMessage({ type: "response", id: data.id, ok: false, error: serializeError(error, "INVALID_REQUEST") });
      return;
    }
    if (fatal || closing || waiting.size >= MAX_PENDING) {
      scope.postMessage({ type: "response", id: data.id, ok: false, error: fatal ?? {
        code: closing ? "CLOSED" : "OVERLOADED", message: closing ? "Storage worker closed" : "Storage request queue is full",
      } });
      return;
    }
    waiting.set(data.id, { request: data });
    dispatchWaiting();
  }
};

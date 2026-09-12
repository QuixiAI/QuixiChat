import { assertArchiveSelection, sameArchiveSelection, jsonByteLength, MAX_TRANSFER_BYTES } from "@quixi/core/contracts";
import type { ArchiveActivationReceipt, ArchiveSelection, CancellationResult, Progress, SearchIndexStatus } from "@quixi/core/contracts";
import { ARCHIVE_MAX_PENDING, ARCHIVE_PROTOCOL_VERSION, archiveChannelName, archiveError, callOperationId, hasArchiveProtocolVersion, validateArchiveCall, validateChunk } from "../archive-protocol.ts";
import type { ArchiveCall, ArchiveInput, ArchiveOutput, ArchiveOutputPayload, ArchiveReply } from "../archive-protocol.ts";
import { ArchiveDatabase } from "./archive-database.ts";

import { ManagedSelectionCatalog } from '../selection/managed-catalog.ts';
import { loadStorageSqlite } from './sqlite-module.ts';

/** Production and the separate isolated fixture entry install fixed policies.
 * No incoming protocol message can choose or change that policy. */
export function installArchiveWorker(mode: 'managed' | 'isolated-test'): void {
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<ArchiveInput>) => void; postMessage: (value: ArchiveOutput, transfer?: Transferable[]) => void };
type Bus = { type: "selection"; selection: ArchiveSelection } | { type: "hello" } | { type: "owner" | "released"; ownerId: string } | { type: "call"; ownerId: string; senderId: string; selection: ArchiveSelection; call: ArchiveCall } | { type: "reply"; recipientId: string; reply: ArchiveReply } | { type: "changed"; operationIds: string[] } | { type: "progress"; recipientId: string; progress: Progress } | { type: "search"; status: SearchIndexStatus };
function post(value: ArchiveOutputPayload, transfer?: Transferable[]): void {
  scope.postMessage({ ...value, version: ARCHIVE_PROTOCOL_VERSION }, transfer);
}
type Work = { senderId: string; selection: ArchiveSelection; call: ArchiveCall; controller: AbortController };
const workerId = crypto.randomUUID();
const waiting = new Map<string, { call: ArchiveCall; owner?: string }>();
const queue: Work[] = [];
const acquisition = new AbortController();
let database: ArchiveDatabase | undefined;
let pinned: ArchiveSelection;
let selectionCatalog: ManagedSelectionCatalog | undefined;
let maintenanceStopped = false;
function validateSelection(expected: ArchiveSelection): void {
  assertArchiveSelection(expected);
  if (!pinned || !sameArchiveSelection(expected, pinned)) throw Object.assign(new Error('This request belongs to a different archive selection; reopen its original context.'), { code: 'CONFLICT' });
}
async function fenced<T>(expected: ArchiveSelection, effect: () => Promise<T> | T): Promise<T> {
  validateSelection(expected);
  if (mode === 'isolated-test') return effect();
  if (!selectionCatalog) throw new Error('Archive selection is unavailable');
  return selectionCatalog.guard(expected, effect);
}
let channel: BroadcastChannel | undefined;
let ownerId: string | undefined;
let ownerTask: Promise<void> | undefined;
let startup: Promise<void> | undefined;
let release: (() => void) | undefined;
let draining: Promise<void> | undefined;
let active: Work | undefined;
let closing = false;
let initialized = false;
let fatal: ReturnType<typeof archiveError> | undefined;
let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
let searchMaintenance: AbortController | undefined;
const broadcast = (message: Bus): void => channel?.postMessage({ ...message, version: ARCHIVE_PROTOCOL_VERSION });
function deliver(reply: ArchiveReply): void {
  if (!waiting.delete(reply.id)) return;
  if (reply.ok && reply.result && typeof reply.result === "object" && "bytes" in reply.result) {
    const bytes = (reply.result as { bytes: unknown }).bytes;
    if (bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer) { post(reply, [bytes.buffer]); return; }
  }
  post(reply);
}
function reply(senderId: string, response: ArchiveReply): void {
  if (senderId === workerId) deliver(response); else broadcast({ type: "reply", recipientId: senderId, reply: response });
}
function reject(senderId: string, call: ArchiveCall, error: unknown, fallback?: Parameters<typeof archiveError>[3]): void {
  reply(senderId, { type: "reply", id: call.id, ok: false, error: archiveError(error, call.id, callOperationId(call), fallback) });
}
function progress(senderId: string, call: ArchiveCall, status: Progress["status"]): void {
  if (call.kind !== "request") return;
  const operationId = callOperationId(call);
  const ids = call.request.operation === "commit" ? call.request.args.mutations.map(mutation => mutation.operationId) : operationId ? [operationId] : [];
  for (const id of ids) {
    const value: Progress = { operationId: id, phase: call.request.operation, status, completedUnits: status === "complete" ? 1 : 0, totalUnits: 1, processedBytes: 0, totalBytes: null };
    if (senderId === workerId) post({ type: "progress", progress: value });
    else broadcast({ type: "progress", recipientId: senderId, progress: value });
  }
}
function dispatch(): void {
  if (!ownerId || closing) return;
  for (const item of waiting.values()) {
    if (item.owner) continue;
    item.owner = ownerId;
    if (ownerId === workerId) enqueue(workerId, item.call, pinned);
    else broadcast({ type: "call", ownerId, senderId: workerId, selection: pinned, call: item.call });
  }
}
function ownerChanged(next: string | undefined): void {
  if (ownerId === next) return;
  ownerId = next;
  for (const item of waiting.values()) if (item.owner && item.owner !== next) reject(workerId, item.call, new Error("Storage owner changed after dispatch. Inspect canonical operation status; restart a byte transfer after an unknown chunk outcome."), "UNKNOWN_OUTCOME");
  dispatch();
}
function cancelled(senderId: string, call: Extract<ArchiveCall, { kind: "cancel" }>): void {
  let outcome: CancellationResult["outcome"] = "unknown_outcome";
  const index = queue.findIndex(work => work.senderId === senderId && work.call.id === call.targetRequestId);
  if (index >= 0) {
    const [work] = queue.splice(index, 1);
    progress(senderId, work!.call, "cancelled");
    reject(senderId, work!.call, new Error("Storage request cancelled before execution"), "CANCELLED");
    outcome = "cancelled_before_commit";
  } else if (active?.senderId === senderId && active.call.id === call.targetRequestId) {
    if (active.call.kind === "request" && active.call.request.operation === "commit") {
      if (database!.repository.committedTransaction(active.call.request.args)) outcome = "committed";
      else { active.controller.abort(); outcome = "cancelled_before_commit"; }
    } else active.controller.abort();
  } else if (call.operationId && database!.operationStatus(call.operationId).status === "committed") outcome = "committed";
  reply(senderId, { type: "reply", id: call.id, ok: true, result: { requestId: call.targetRequestId, operationId: call.operationId, outcome } satisfies CancellationResult });
}
function enqueue(senderId: string, call: ArchiveCall, selection: ArchiveSelection): void {
  try { validateSelection(selection); validateArchiveCall(call); } catch (error) { reject(senderId, call, error, "INVALID_REQUEST"); return; }
  if (closing || !database) { reject(senderId, call, new Error("Archive owner is closing"), "CLOSED"); return; }
  if (call.kind === "cancel") {
    try { cancelled(senderId, call); } catch (error) { reject(senderId, call, error); }
    return;
  }
  if (queue.length + Number(!!active) >= ARCHIVE_MAX_PENDING) { reject(senderId, call, new Error("Archive owner queue is full"), "OVERLOADED"); return; }
  if (queue.some(work => work.senderId === senderId && work.call.id === call.id) || active?.senderId === senderId && active.call.id === call.id) { reject(senderId, call, new Error("Request ID is already executing"), "CONFLICT"); return; }
  queue.push({ senderId, selection: { ...selection }, call, controller: new AbortController() });
  searchMaintenance?.abort();
  progress(senderId, call, "queued");
  startDrain();
}
function startDrain(): void {
  if (draining || !database) return;
  clearTimeout(maintenanceTimer);
  draining = Promise.resolve().then(drain).finally(() => { draining = undefined; if (queue.length) startDrain(); });
}
async function drain(): Promise<void> {
  let processedForeground = false;
  while (queue.length) {
    const work = queue.shift()!; active = work;
    processedForeground = true;
    progress(work.senderId, work.call, "running");
    try {
      let result: unknown;
      if (work.call.kind === 'request' && work.call.request.operation === 'activateRestoredArchive') {
        if (mode !== 'managed' || !selectionCatalog) throw Object.assign(new Error('Archive activation requires a managed production session'), { code: 'UNSUPPORTED' });
        const args = work.call.request.args;
        validateSelection(args.expectedSelection);
        // The catalog owns the global gate; withActivationReview alone owns the
        // candidate lock. Never enter this through fenced()/guard() again.
        result = await selectionCatalog.activateReviewed(args, {
          signal: work.controller.signal,
          withReviewedCandidate: async commit => {
            database!.assertActivationIdle();
            await database!.quiesce();
            return database!.archives.withActivationReview(args.review, work.controller.signal, async () => commit());
          },
        });
      } else if (work.call.kind === 'request' && work.call.request.operation === 'readArchiveActivationContext') {
        result = await fenced(work.selection, () => ({ selection: { ...pinned }, expectedRevision: database!.sourceHighWater() }));
      } else result = await fenced(work.selection, () => database!.execute(work.call, workerId, work.controller.signal));
      if (work.call.kind === "read") validateChunk(result as Parameters<typeof validateChunk>[0]);
      else jsonByteLength(result, MAX_TRANSFER_BYTES - 256);
      progress(work.senderId, work.call, "complete");
      reply(work.senderId, { type: "reply", id: work.call.id, ok: true, result });
      if (work.call.kind === 'request' && work.call.request.operation === 'activateRestoredArchive') {
        const selection = (result as ArchiveActivationReceipt).selected;
        post({ type: 'selection', selection }); broadcast({ type: 'selection', selection });
      }
      if (work.call.kind === "request" && work.call.request.operation === "commit") {
        const operationIds = work.call.request.args.mutations.map(mutation => mutation.operationId);
        post({ type: "changed", operationIds }); broadcast({ type: "changed", operationIds });
      }
      if (work.call.kind === "request" && work.call.request.operation === "finalizeNormalizedImport") {
        const operationIds = [work.call.request.args.operationId];
        post({ type: "changed", operationIds }); broadcast({ type: "changed", operationIds });
      }
      if (work.call.kind === "request" && work.call.request.operation === "reconcileGenerationProducers") {
        const operationIds = (result as { operationIds: string[] }).operationIds;
        if (operationIds.length) { post({ type: "changed", operationIds }); broadcast({ type: "changed", operationIds }); }
      }
    } catch (error) { progress(work.senderId, work.call, archiveError(error, work.call.id).code === "CANCELLED" ? "cancelled" : "failed"); reject(work.senderId, work.call, error); }
    finally { active = undefined; }
  }
  if (database && !closing && !maintenanceStopped && processedForeground) {
    // Foreground calls arrive in short sequences (a view load issues many
    // bounded reads). Maintenance, including indexing slices, runs from the
    // idle timer instead of inline after each call, so it yields to them.
    clearTimeout(maintenanceTimer);
    maintenanceTimer = setTimeout(startDrain, 50);
    return;
  }
  if (database && !closing && !maintenanceStopped) {
    try { await fenced(pinned, async () => {
    const cleanup = await database!.cleanupImportBlobs();
    let producersRemain = false;
    try {
      const recovery = await database!.producers.reconcile(8);
      producersRemain = recovery.remaining;
      if (recovery.operationIds.length) { post({ type: "changed", operationIds: recovery.operationIds }); broadcast({ type: "changed", operationIds: recovery.operationIds }); }
    } catch { producersRemain = true; } // Retry durable recovery without failing foreground history access.
    const extraction = database!.cleanupExtraction();
    let search = { remaining: false, progressed: false };
    if (!queue.length && !closing) {
      searchMaintenance = new AbortController();
      try { search = await database!.advanceSearch(searchMaintenance.signal); }
      finally { searchMaintenance = undefined; }
    }
    if ((cleanup.remaining || extraction.remaining || producersRemain || search.remaining) && !closing) {
      const delay = cleanup.remaining && !cleanup.failed || extraction.remaining && extraction.progressed || search.remaining && search.progressed ? 50 : search.remaining ? 1_000 : 5_000;
      maintenanceTimer = setTimeout(startDrain, delay);
    }
    }); } catch (error) {
      maintenanceStopped = true;
      // No retrying stale background writes; foreground calls retain their own
      // identities and receive the same durable selection fence on dequeue.
      post({ type: 'fatal', error: archiveError(error, workerId) });
    }
  }
}
function fail(error: unknown): void {
  fatal = archiveError(error, workerId, null, "UNSUPPORTED");
  for (const work of waiting.values()) reject(workerId, work.call, fatal, fatal.code);
  post({ type: "fatal", error: fatal });
}
async function start(selection: ArchiveSelection): Promise<void> {
  if (initialized || fatal) return; initialized = true;
  assertArchiveSelection(selection);
  pinned = { ...selection };
  const archiveId = pinned.archiveId;
  if (mode === 'isolated-test' && (!/^test-[A-Za-z0-9_-]{1,59}$/.test(archiveId) || pinned.selectionRevision !== 0)) throw new Error('Isolated workers may only open explicit test-* archives at revision zero');
  if (!isSecureContext || !navigator.locks || !navigator.storage?.getDirectory || typeof BroadcastChannel === "undefined") { fail(new Error("Local archives require a secure context, Web Locks, OPFS and BroadcastChannel. Use a supported regular browser profile with site storage enabled.")); return; }
  if (mode === 'managed') {
    selectionCatalog = new ManagedSelectionCatalog(await loadStorageSqlite());
    await selectionCatalog.guard(pinned, () => {});
  }
  if (closing) return;
  channel = new BroadcastChannel(archiveChannelName(archiveId));
  channel.onmessage = ({ data }: MessageEvent<Bus>) => {
    if (closing || !hasArchiveProtocolVersion(data)) return;
    switch (data.type) {
      case "hello": if (database && ownerId === workerId) broadcast({ type: "owner", ownerId: workerId }); break;
      case "owner": ownerChanged(data.ownerId); break;
      case "released": if (ownerId === data.ownerId) ownerChanged(undefined); break;
      case "call": if (ownerId === workerId && data.ownerId === workerId) enqueue(data.senderId, data.call, data.selection); break;
      case "reply": if (data.recipientId === workerId) deliver(data.reply); break;
      case "changed": post({ type: "changed", operationIds: data.operationIds }); break;
      case "progress": if (data.recipientId === workerId) post({ type: "progress", progress: data.progress }); break;
      case "search": post(data); break;
      case "selection": post(data); break;
    }
  };
  broadcast({ type: "hello" });
  ownerTask = navigator.locks.request(`quixi:archive:${archiveId}:owner`, { mode: "exclusive", signal: acquisition.signal }, async () => {
    const released = new Promise<void>(resolve => { release = resolve; });
    try {
      database = await fenced(pinned, () => ArchiveDatabase.open(archiveId, status => { post({ type: "search", status }); broadcast({ type: "search", status }); }, { create: mode === "isolated-test" }));
      if (!closing) { ownerChanged(workerId); broadcast({ type: "owner", ownerId: workerId }); startDrain(); await released; }
      await draining;
    } finally {
      try {
        if (database) {
          try { await fenced(pinned, () => database!.quiesce()); } catch { /* Handle release remains necessary after a stale/unavailable fence. */ }
          await database.close('handles');
        }
      } finally { database = undefined; broadcast({ type: "released", ownerId: workerId }); ownerId = undefined; }
    }
  }).catch(error => { if (!closing) fail(error); });
}
async function close(): Promise<void> {
  if (closing) return; closing = true;
  clearTimeout(maintenanceTimer);
  searchMaintenance?.abort();
  acquisition.abort(); release?.(); await startup; await ownerTask;
  for (const work of waiting.values()) reject(workerId, work.call, new Error(work.owner ? "Archive closed after dispatch; reconcile the outcome before retrying" : "Archive closed before dispatch"), work.owner ? "UNKNOWN_OUTCOME" : "CLOSED");
  channel?.close(); post({ type: "closed" });
}
scope.onmessage = ({ data }) => {
  if (!hasArchiveProtocolVersion(data as unknown)) {
    // Legacy envelopes never initialize a namespace or enter the owner queue.
    // Keep a running modern session usable after a rejected stale frame.
    if (data && data.type === "call") {
      const call = data.call;
      post({ type: "reply", id: call?.id, ok: false, error: archiveError(new Error("Unsupported archive worker protocol; reopen the application"), call?.id, null, "UNSUPPORTED") });
    } else if (!initialized) fail(new Error("Unsupported archive worker protocol; reopen the application"));
    return;
  }
  if (data.type === "init") startup ??= start(data.selection).catch(fail);
  else if (data.type === "close") void close();
  else if (data.type === "call") {
    const call = data.call;
    try { validateSelection(data.selection); validateArchiveCall(call); } catch (error) { post({ type: "reply", id: call?.id, ok: false, error: archiveError(error, call?.id, null, "INVALID_REQUEST") }); return; }
    if (fatal || closing || waiting.has(call.id) || waiting.size >= ARCHIVE_MAX_PENDING + (call.kind === "cancel" ? 8 : 0)) {
      post({ type: "reply", id: call.id, ok: false, error: archiveError(fatal ?? new Error("Archive is closed, overloaded, or already processing this request ID"), call.id, callOperationId(call), closing ? "CLOSED" : waiting.has(call.id) ? "CONFLICT" : "OVERLOADED") }); return;
    }
    if (call.kind === "cancel") {
      const target = waiting.get(call.targetRequestId);
      if (target && !target.owner) {
        reject(workerId, target.call, new Error("Storage request cancelled before dispatch"), "CANCELLED");
        post({ type: "reply", id: call.id, ok: true, result: { requestId: call.targetRequestId, operationId: call.operationId, outcome: "not_dispatched" } }); return;
      }
    }
    waiting.set(call.id, { call }); dispatch();
  }
};

}

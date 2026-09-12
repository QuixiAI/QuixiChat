import {
  EXTENSION_IMPORT_CHANNEL,
  EXTENSION_IMPORT_LIMITS,
  EXTENSION_IMPORT_PROTOCOL_VERSION,
  generatePairingCode,
  parseExtensionToPageMessage,
  samePairingCode,
} from "@quixi/core/contracts";
import type {
  AdoptableFile,
  ExtensionBridge,
  ExtensionOffer,
  ExtensionToPageMessage,
  ExtensionTransferProgress,
  HostFile,
  PageToExtensionMessage,
} from "@quixi/core/contracts";
import type { WebTransfers } from "./transfers.ts";
import { failure } from "./transfers.ts";

type Item = {
  offer: ExtensionOffer;
  state: ExtensionTransferProgress["state"];
  transferId: string | null;
  receivedBytes: number;
  nextSequence: number;
  reason: string | null;
  requestId: string | null;
  resolve: ((file: HostFile) => void) | undefined;
  reject: ((error: Error) => void) | undefined;
  idle?: ReturnType<typeof setTimeout>;
  fileId: string | null;
  /** Chunks are applied strictly in arrival order; concurrent handling would misread sequence numbers. */
  queue: Promise<void>;
};
/** Product §24: the page side of the extension transfer. Offers need this
 * session's pairing code and an explicit accept; bytes are staged through the
 * host's disk transfers and verified against the bundle digest before the
 * application can read them as an ordinary selected file. */
export function createExtensionBridge(options: {
  transfers: WebTransfers;
  register: (file: AdoptableFile) => HostFile;
  releaseFile: (fileId: string) => void;
  target?: Pick<Window, "addEventListener" | "removeEventListener" | "postMessage">;
  origin?: () => string;
}): ExtensionBridge & { dispose(): Promise<void>; deliver(message: unknown): void } {
  const target = options.target ?? window;
  const origin = options.origin ?? (() => location.origin);
  const code = generatePairingCode();
  const offers = new Map<string, Item>();
  const offerListeners = new Set<(offer: ExtensionOffer) => void>();
  const progressListeners = new Set<(progress: ExtensionTransferProgress) => void>();
  let disposed = false;
  const send = (message: PageToExtensionMessage) => {
    try { target.postMessage({ ...message, channel: EXTENSION_IMPORT_CHANNEL, version: EXTENSION_IMPORT_PROTOCOL_VERSION }, origin()); } catch { /* the extension side may be gone */ }
  };
  const progress = (item: Item) => {
    const value: ExtensionTransferProgress = { offerId: item.offer.offerId, state: item.state, receivedBytes: item.receivedBytes, totalBytes: item.offer.bundle.file.byteLength, reason: item.reason };
    for (const listener of progressListeners) { try { listener(value); } catch { /* isolate */ } }
  };
  const arm = (item: Item) => {
    clearTimeout(item.idle);
    item.idle = setTimeout(() => { void fail(item, "The extension stopped sending; the transfer was abandoned.", "failed"); }, EXTENSION_IMPORT_LIMITS.idleTimeoutMs);
  };
  async function releaseStage(item: Item) {
    clearTimeout(item.idle);
    const transferId = item.transferId; item.transferId = null;
    if (transferId) { try { await options.transfers.release(transferId); } catch { /* already released */ } }
  }
  async function fail(item: Item, reason: string, state: "failed" | "cancelled" | "rejected") {
    if (item.state === "staged" || item.state === state) return;
    item.state = state; item.reason = reason;
    await releaseStage(item);
    send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: state === "rejected" ? "rejected" : "failed", offerId: item.offer.offerId, reason } as PageToExtensionMessage);
    progress(item);
    item.reject?.(failure(state === "cancelled" ? "CANCELLED" : "IO_ERROR", reason, item.requestId ?? item.offer.offerId));
    item.resolve = undefined; item.reject = undefined;
  }
  async function chunk(item: Item, message: Extract<ExtensionToPageMessage, { kind: "chunk" }>) {
    if (item.state !== "receiving" || !item.transferId) return;
    if (message.sequence !== item.nextSequence || message.offset !== item.receivedBytes) {
      // Out-of-order after a resume: tell the sender where we are.
      send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "ack", offerId: item.offer.offerId, sequence: item.nextSequence - 1, committedOffset: item.receivedBytes });
      return;
    }
    const total = item.offer.bundle.file.byteLength;
    if (item.receivedBytes + message.bytes.byteLength > total) { await fail(item, "The extension sent more bytes than the bundle declared.", "failed"); return; }
    arm(item);
    try {
      const bytes = new Uint8Array(message.bytes);
      const ack = await options.transfers.write({ transferId: item.transferId, sequence: message.sequence, offset: message.offset, bytes, final: message.final });
      item.nextSequence = message.sequence + 1;
      item.receivedBytes = ack.committedOffset;
      send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "ack", offerId: item.offer.offerId, sequence: message.sequence, committedOffset: item.receivedBytes });
      progress(item);
      if (message.final) {
        if (item.receivedBytes !== total) { await fail(item, "The extension ended the transfer before every declared byte arrived.", "failed"); return; }
        item.state = "verifying"; progress(item); clearTimeout(item.idle);
        const requestId = item.requestId ?? crypto.randomUUID();
        await options.transfers.finish(requestId, item.transferId, { byteLength: total, sha256: item.offer.bundle.file.sha256 });
        const file = await options.transfers.disk.file(item.transferId);
        const adoptable: AdoptableFile = {
          name: item.offer.bundle.file.name, mediaType: item.offer.bundle.file.mediaType, byteLength: total,
          read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
        };
        const registered = options.register(adoptable);
        item.fileId = registered.id;
        item.state = "staged"; progress(item);
        send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "staged", offerId: item.offer.offerId });
        item.resolve?.(registered); item.resolve = undefined; item.reject = undefined;
      }
    } catch (error) {
      await fail(item, error instanceof Error ? error.message : String(error), "failed");
    }
  }
  function deliver(raw: unknown) {
    if (disposed) return;
    const message = parseExtensionToPageMessage(raw);
    if (!message) return;
    const existing = offers.get(message.offerId);
    switch (message.kind) {
      case "offer": {
        if (existing) return;
        if (!samePairingCode(message.pairingCode, code)) { send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "rejected", offerId: message.offerId, reason: "The pairing code does not match this Quixi page. Read the code shown under Import history and try again." }); return; }
        if (offers.size >= 8) { send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "rejected", offerId: message.offerId, reason: "Too many pending offers; finish or reject one first." }); return; }
        const item: Item = { offer: { offerId: message.offerId, bundle: message.bundle, receivedAt: Date.now() }, state: "offered", transferId: null, receivedBytes: 0, nextSequence: 0, reason: null, requestId: null, fileId: null, resolve: undefined, reject: undefined, queue: Promise.resolve() };
        offers.set(message.offerId, item);
        for (const listener of offerListeners) { try { listener(item.offer); } catch { /* isolate */ } }
        progress(item);
        return;
      }
      case "resume": {
        if (!existing || !samePairingCode(message.pairingCode, code)) { send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "rejected", offerId: message.offerId, reason: "This transfer is no longer open on this page; offer it again." }); return; }
        if (existing.state === "receiving") { arm(existing); send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "accepted", offerId: existing.offer.offerId, maxChunkBytes: EXTENSION_IMPORT_LIMITS.maxChunkBytes, maxInFlight: EXTENSION_IMPORT_LIMITS.maxInFlight, committedOffset: existing.receivedBytes }); }
        else if (existing.state === "staged") send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "staged", offerId: existing.offer.offerId });
        else if (existing.state === "offered") progress(existing);
        else send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "failed", offerId: existing.offer.offerId, reason: existing.reason ?? "The transfer ended." });
        return;
      }
      case "chunk": if (existing) existing.queue = existing.queue.then(() => chunk(existing, message)).catch(() => {}); return;
      case "cancel": if (existing) void fail(existing, `The extension cancelled: ${message.reason}`, "cancelled"); return;
    }
  }
  const listener = (event: MessageEvent) => {
    // The content script posts from this same window on this origin.
    if (event.origin !== origin() || event.source !== (target as unknown as Window)) return;
    deliver(event.data);
  };
  target.addEventListener("message", listener as EventListener);
  const item = (offerId: string, requestId: string) => {
    const found = offers.get(offerId);
    if (!found) throw failure("NOT_FOUND", "That extension offer is no longer pending.", requestId);
    return found;
  };
  return {
    pairingCode: () => code,
    onOffer(fn) { offerListeners.add(fn); return () => { offerListeners.delete(fn); }; },
    onProgress(fn) { progressListeners.add(fn); return () => { progressListeners.delete(fn); }; },
    async accept(requestId, offerId) {
      if (disposed) throw failure("CLOSED", "Host is closed.", requestId);
      const found = item(offerId, requestId);
      if (found.state !== "offered") throw failure("CONFLICT", "This offer was already answered.", requestId);
      found.requestId = requestId;
      const transfer = await options.transfers.begin(requestId, { purpose: "file_save", expectedBytes: found.offer.bundle.file.byteLength, expectedSha256: found.offer.bundle.file.sha256 });
      found.transferId = transfer.transferId;
      found.state = "receiving";
      const staged = new Promise<HostFile>((resolve, reject) => { found.resolve = resolve; found.reject = reject; });
      arm(found);
      send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "accepted", offerId, maxChunkBytes: EXTENSION_IMPORT_LIMITS.maxChunkBytes, maxInFlight: EXTENSION_IMPORT_LIMITS.maxInFlight, committedOffset: 0 });
      progress(found);
      return staged;
    },
    async reject(requestId, offerId, reason) {
      const found = item(offerId, requestId);
      await fail(found, reason || "Declined on the Quixi page.", "rejected");
      offers.delete(offerId);
    },
    async cancel(requestId, offerId) {
      const found = item(offerId, requestId);
      await fail(found, "Cancelled on the Quixi page.", "cancelled");
      offers.delete(offerId);
    },
    async report(requestId, offerId, outcome) {
      const found = item(offerId, requestId);
      send({ channel: EXTENSION_IMPORT_CHANNEL, version: 1, kind: "imported", offerId, runId: outcome.runId, outcome: outcome.outcome, reason: outcome.reason });
      if (outcome.outcome !== "paused") {
        if (found.fileId) options.releaseFile(found.fileId);
        await releaseStage(found);
        offers.delete(offerId);
      }
    },
    deliver,
    async dispose() {
      disposed = true;
      target.removeEventListener("message", listener as EventListener);
      for (const found of offers.values()) { clearTimeout(found.idle); await releaseStage(found); found.reject?.(failure("CLOSED", "Host is closed.", found.requestId ?? found.offer.offerId)); }
      offers.clear(); offerListeners.clear(); progressListeners.clear();
    },
  };
}

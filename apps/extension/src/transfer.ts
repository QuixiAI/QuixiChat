/** Sender side of the versioned page transfer (core `extension-import`): one
 * offer, chunked bytes with a bounded in-flight window, acknowledgement-driven
 * progress, resume from the page's committed offset after a reconnect, and
 * explicit cancellation. The channel is abstract so Node tests drive it
 * without Chrome; the import page binds it to a tab port. */
import { EXTENSION_IMPORT_LIMITS } from "@quixi/core/contracts";
import type { PageToExtensionMessage, ProviderImportBundle } from "@quixi/core/contracts";

export interface SenderChannel {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: PageToExtensionMessage) => void): () => void;
  onDisconnect(listener: () => void): () => void;
}
export interface TransferSource { byteLength: number; read(start: number, end: number): Promise<Uint8Array> }
export interface TransferProgress { state: "offering" | "sending" | "staged" | "imported" | "rejected" | "failed" | "cancelled"; sentBytes: number; ackedBytes: number; totalBytes: number; reason: string | null; runId: string | null; outcome: "complete" | "failed" | "paused" | null }
export interface TransferOptions {
  channel: SenderChannel; bundle: ProviderImportBundle; source: TransferSource; pairingCode: string; offerId: string;
  onProgress?: (progress: TransferProgress) => void;
  /** Base64 for JSON ports; tests can pass bytes through. */
  encode?: (bytes: Uint8Array) => unknown;
  now?: () => number;
}
export const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
/** Resolves with the page's final import outcome (or the terminal transfer state). */
export function runTransfer(options: TransferOptions): { done: Promise<TransferProgress>; cancel(reason: string): void; reconnect(channel: SenderChannel): void } {
  const encode = options.encode ?? base64;
  const total = options.source.byteLength;
  let progress: TransferProgress = { state: "offering", sentBytes: 0, ackedBytes: 0, totalBytes: total, reason: null, runId: null, outcome: null };
  let channel = options.channel, maxChunk: number = EXTENSION_IMPORT_LIMITS.maxChunkBytes, maxInFlight: number = EXTENSION_IMPORT_LIMITS.maxInFlight;
  let nextOffset = 0, nextSequence = 0, inFlight = 0, sending = false, finished = false, detach: (() => void)[] = [];
  let resolve!: (value: TransferProgress) => void;
  const done = new Promise<TransferProgress>((r) => { resolve = r; });
  const update = (change: Partial<TransferProgress>) => { progress = { ...progress, ...change }; try { options.onProgress?.(progress); } catch { /* isolate */ } };
  const finish = (change: Partial<TransferProgress>) => { if (finished) return; finished = true; update(change); for (const off of detach) off(); resolve(progress); };
  const tagged = (message: Record<string, unknown>) => channel.send({ channel: "quixi-extension-import", version: 1, offerId: options.offerId, ...message });
  async function pump(): Promise<void> {
    if (sending) return; sending = true;
    try {
      while (!finished && progress.state === "sending" && inFlight < maxInFlight && nextOffset < total) {
        const end = Math.min(total, nextOffset + maxChunk);
        const bytes = await options.source.read(nextOffset, end);
        if (finished || progress.state !== "sending") return;
        if (bytes.byteLength !== end - nextOffset) { cancel(`The source changed while it was being sent (expected ${end - nextOffset} bytes at ${nextOffset} of ${total}, read ${bytes.byteLength}).`); return; }
        const final = end === total;
        tagged({ kind: "chunk", sequence: nextSequence, offset: nextOffset, bytesBase64: encode(bytes), final });
        nextSequence++; nextOffset = end; inFlight++;
        update({ sentBytes: nextOffset });
      }
    } finally { sending = false; }
  }
  function attach(next: SenderChannel) {
    for (const off of detach) off();
    channel = next;
    detach = [
      next.onMessage((message) => {
        if (message.offerId !== options.offerId) return;
        switch (message.kind) {
          case "accepted":
            maxChunk = Math.min(maxChunk, message.maxChunkBytes); maxInFlight = Math.min(EXTENSION_IMPORT_LIMITS.maxInFlight, Math.max(1, message.maxInFlight));
            // Resume from the page's committed offset; anything after it is resent.
            nextOffset = message.committedOffset; nextSequence = Math.ceil(message.committedOffset / maxChunk); inFlight = 0;
            update({ state: "sending", ackedBytes: message.committedOffset, sentBytes: message.committedOffset });
            void pump();
            return;
          case "ack":
            if (message.committedOffset > progress.ackedBytes) update({ ackedBytes: message.committedOffset });
            inFlight = Math.max(0, inFlight - 1);
            void pump();
            return;
          case "staged": update({ state: "staged", ackedBytes: total }); return;
          case "imported": finish({ state: "imported", runId: message.runId, outcome: message.outcome, reason: message.reason }); return;
          case "rejected": finish({ state: "rejected", reason: message.reason }); return;
          case "failed": finish({ state: "failed", reason: message.reason }); return;
        }
      }),
      next.onDisconnect(() => { if (!finished) update({ reason: "Connection to the Quixi page was lost; reconnect to resume." }); }),
    ];
  }
  function cancel(reason: string) {
    if (finished) return;
    try { tagged({ kind: "cancel", reason }); } catch { /* channel may be gone */ }
    finish({ state: "cancelled", reason });
  }
  attach(options.channel);
  update({});
  tagged({ kind: "offer", pairingCode: options.pairingCode, bundle: options.bundle });
  return {
    done, cancel,
    reconnect(next) { if (finished) return; attach(next); tagged({ kind: "resume", pairingCode: options.pairingCode }); },
  };
}

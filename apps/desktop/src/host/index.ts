import { invoke } from "@tauri-apps/api/core";
import { HOST_BOUNDARIES, type AdoptableFile, type ByteChunk, type HostCapabilities, type HostClient } from "@quixi/core/contracts";
import { isQuixiId } from "@quixi/core/model";

type Opened = { sessionId: string; capabilities: HostCapabilities; secretStore: { available: boolean; reason: string | null } };
/** Native configuration owns registered destinations; JavaScript cannot supply arbitrary origins. */
export async function createDesktopHost(): Promise<HostClient & { dispose(): Promise<void>; readonly secretStore: Opened["secretStore"] }> {
  const opened = await invoke<Opened>("native_host_open");
  let closed = false;
  const call = async <T>(operation: string, payload: unknown = {}): Promise<T> => {
    if (closed) throw Object.assign(new Error("Desktop host session is closed."), { code: "CLOSED" });
    return invoke<T>("native_host_call", { sessionId: opened.sessionId, operation, payload });
  };
  const unsupported = async (requestId: string, capability: string): Promise<never> => {
    throw { code: "UNSUPPORTED", message: `${capability} is not implemented in this desktop host slice.`, requestId, operationId: null, retry: "after_user_action", details: {} };
  };
  // Files dropped onto the webview arrive as platform file objects, not native
  // paths (the window disables Tauri's own drag-drop interception so HTML5
  // drops reach the interface). They are read here in 64 KiB positional
  // slices; native dialog selections keep their native transfers.
  const ADOPTED_CHUNK = 65_536;
  const adopted = new Map<string, AdoptableFile>();
  const adoptedTransfers = new Map<string, { fileId: string; file: AdoptableFile; offset: number; sequence: number; done: boolean }>();
  const invalid = (requestId: string, message: string) => Object.assign(new Error(message), { code: "INVALID_REQUEST", requestId });
  const clipboardWriter = (): ((text: string) => Promise<void>) | null =>
    typeof navigator !== "undefined" && typeof window !== "undefined" && window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === "function" ? text => navigator.clipboard.writeText(text) : null;
  return {
    secretStore: Object.freeze({ ...opened.secretStore }),
    // The WebView exposes the clipboard to the page in its secure custom
    // scheme; Rust capabilities are augmented here and nothing native runs.
    async requestPersistentStorage(requestId) {
      if (!isQuixiId(requestId)) throw invalid(requestId, "Invalid request id.");
      throw Object.assign(new Error("Desktop storage lives in the app's data directory and is not subject to browser eviction; there is nothing to request."), { code: "UNSUPPORTED", requestId });
    },
    capabilities: async () => ({ ...(await call<Omit<HostCapabilities, "clipboard" | "extensionTransfers" | "persistentStorage">>("capabilities")), persistentStorage: { available: false, permission: "not_required" as const, reason: "Desktop storage lives in the app's data directory and is not subject to browser eviction." }, extensionTransfers: { available: false, permission: "denied" as const, reason: "Browser extensions cannot reach the desktop app. Import the official export file or a Quixi archive instead." }, clipboard: clipboardWriter() ? { available: true, permission: "prompt" as const, reason: null } : { available: false, permission: "denied" as const, reason: "This WebView does not expose clipboard writing to the page." } }),
    async writeClipboardText(requestId, text) {
      if (closed) throw Object.assign(new Error("Desktop host session is closed."), { code: "CLOSED" });
      if (!isQuixiId(requestId) || typeof text !== "string" || text.length > HOST_BOUNDARIES.maxClipboardChars) throw invalid(requestId, "Clipboard text exceeds its bound.");
      const writer = clipboardWriter();
      if (!writer) throw Object.assign(new Error("This WebView does not expose clipboard writing to the page."), { code: "UNSUPPORTED", requestId });
      try { await writer(text); } catch { throw Object.assign(new Error("The WebView refused clipboard access; copy from the source view instead."), { code: "UNSUPPORTED", requestId }); }
    },
    async startProviderHttp(request, beforeDispatch) { await beforeDispatch?.(); return call("startProviderHttp", request); },
    openSecret: (requestId, binding) => call("openSecret", { requestId, binding }),
    async storeSecret(requestId, binding, value, replace) {
      if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > HOST_BOUNDARIES.maxSecretBytes) throw Object.assign(new Error("Credential exceeds the native host input bound."), { code: "INVALID_REQUEST", requestId });
      return call("storeSecret", { requestId, binding, value: Array.from(value), replace });
    },
    deleteSecret: (requestId, handle) => call("deleteSecret", { requestId, handle }),
    beginTransfer: (requestId, declaration) => call("beginTransfer", { requestId, declaration }),
    finishTransfer: (requestId, transferId, expected) => call("finishTransfer", { requestId, transferId, expected }),
    async releaseTransfer(requestId, transferId) {
      if (adoptedTransfers.delete(transferId)) return;
      return call("releaseTransfer", { requestId, transferId });
    },
    async acknowledgeChunk(acknowledgement) {
      if (adoptedTransfers.has(acknowledgement.transferId)) return;
      return call("acknowledgeChunk", acknowledgement);
    },
    cancel: requestId => call("cancel", { requestId }),
    async writeChunk(chunk) {
      if (closed) throw Object.assign(new Error("Desktop host session is closed."), { code: "CLOSED" });
      if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.length > 65_536 || !isQuixiId(chunk.transferId) || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !Number.isInteger(chunk.sequence) || chunk.sequence < 0 || chunk.sequence > 0xffffffff || typeof chunk.final !== "boolean") throw Object.assign(new Error("Desktop chunks require valid bounded metadata and at most 64 KiB."), { code: "INVALID_REQUEST" });
      const metadata = new TextEncoder().encode(JSON.stringify({ sessionId: opened.sessionId, transferId: chunk.transferId, sequence: chunk.sequence, offset: chunk.offset, final: chunk.final }));
      const frame = new Uint8Array(4 + metadata.length + chunk.bytes.length);
      new DataView(frame.buffer).setUint32(0, metadata.length, true); frame.set(metadata, 4); frame.set(chunk.bytes, 4 + metadata.length);
      return invoke("native_host_write_chunk", frame);
    },
    async readChunk(transferId): Promise<ByteChunk> {
      if (closed) throw Object.assign(new Error("Desktop host session is closed."), { code: "CLOSED" });
      const local = adoptedTransfers.get(transferId);
      if (local) {
        if (local.done) throw Object.assign(new Error("Adopted file transfer already ended."), { code: "CONFLICT" });
        const end = Math.min(local.file.byteLength, local.offset + ADOPTED_CHUNK);
        const bytes = end > local.offset ? await local.file.read(local.offset, end) : new Uint8Array();
        if (!(bytes instanceof Uint8Array) || bytes.length !== end - local.offset) {
          local.done = true;
          throw Object.assign(new Error("Dropped file changed while it was being read."), { code: "IO_ERROR" });
        }
        const chunk: ByteChunk = { transferId, sequence: local.sequence++, offset: local.offset, bytes, final: end === local.file.byteLength };
        local.offset = end;
        local.done = chunk.final;
        return chunk;
      }
      const raw = await invoke<ArrayBuffer>("native_host_read_chunk", { sessionId: opened.sessionId, transferId });
      const bytes = new Uint8Array(raw); const data = new DataView(bytes.buffer);
      if (bytes.length < 24 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "QH01") throw Object.assign(new Error("Invalid native chunk frame."), { code: "IO_ERROR" });
      const offset = Number(data.getBigUint64(8, true)); const flags = data.getUint32(16, true); const count = data.getUint32(20, true);
      if (!Number.isSafeInteger(offset) || flags > 1 || count > 65_536 || bytes.length !== 24 + count) throw Object.assign(new Error("Native chunk exceeds framing bounds."), { code: "IO_ERROR" });
      return { transferId, sequence: data.getUint32(4, true), offset, final: flags === 1, bytes: bytes.slice(24) };
    },
    startOAuth: request => call("startOAuth", request),
    chooseFiles: (requestId, options) => call("chooseFiles", { requestId, options }),
    async adoptFiles(requestId, files) {
      if (closed) throw Object.assign(new Error("Desktop host session is closed."), { code: "CLOSED" });
      if (!isQuixiId(requestId) || !Array.isArray(files)) throw invalid(requestId, "Adopted files must be a list under a UUID request.");
      if (files.length + adopted.size > HOST_BOUNDARIES.maxSelectedFiles) throw Object.assign(new Error("Release selected file handles before adopting more files."), { code: "OVERLOADED", requestId });
      return files.map(file => {
        if (typeof file.name !== "string" || !file.name || file.name.length > 255 || !(file.mediaType === null || (typeof file.mediaType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.mediaType))) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || typeof file.read !== "function")
          throw invalid(requestId, "Adopted files need a bounded name, media type and size.");
        const id = crypto.randomUUID();
        adopted.set(id, { name: file.name, mediaType: file.mediaType, byteLength: file.byteLength, read: (start, end) => file.read(start, end) });
        return { id, name: file.name, mediaType: file.mediaType, byteLength: file.byteLength };
      });
    },
    async openFileTransfer(requestId, fileId) {
      const file = adopted.get(fileId);
      if (!file) return call("openFileTransfer", { requestId, fileId });
      if (!isQuixiId(requestId) || adoptedTransfers.has(requestId)) throw invalid(requestId, "Adopted file transfers need a fresh UUID request.");
      adoptedTransfers.set(requestId, { fileId, file, offset: 0, sequence: 0, done: false });
      return { transferId: requestId, maxChunkBytes: ADOPTED_CHUNK, maxInFlight: 1 };
    },
    async releaseFile(requestId, fileId) {
      if (adopted.delete(fileId)) {
        for (const [transferId, transfer] of adoptedTransfers) if (transfer.fileId === fileId) adoptedTransfers.delete(transferId);
        return;
      }
      return call("releaseFile", { requestId, fileId });
    },
    saveFileTransfer: (requestId, file) => call("saveFileTransfer", { requestId, file }),
    notify: requestId => unsupported(requestId, "Native notifications"),
    async dispose() { if (closed) return; closed = true; await invoke("native_host_call", { sessionId: opened.sessionId, operation: "dispose", payload: {} }); },
  };
}

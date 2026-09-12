import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MAX_TRANSFER_BYTES, TransferWindow } from "@quixi/core/contracts";
import type { BlobPurpose, ByteChunk, ChunkAcknowledgement } from "@quixi/core/contracts";
import { isQuixiId } from "@quixi/core/model";

// The owner worker supplies quixi/ only after acquiring its archive Web Lock.
// No SQLite VFS directory or model file is touched by this byte layer.
interface SyncFile {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncFile> };
type Directory = FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
interface Upload {
  file: SyncFile;
  hash: ReturnType<typeof sha256.create>;
  sequence: number;
  offset: number;
  final: boolean;
  state: "writing" | "verified" | "failed";
  expectedBytes: number | null;
  expectedSha256: string | null;
  purpose: BlobPurpose;
  verified: VerifiedBlob | null;
}
interface Download {
  file: SyncFile;
  digest: string;
  byteLength: number;
  baseOffset: number;
  offset: number;
  sequence: number;
  final: boolean;
  pending: number;
  window: TransferWindow;
}
export interface VerifiedReadProgress { transferId: string; byteLength: number; verifiedBytes: number; complete: boolean }
interface SharedRead { file: SyncFile; byteLength: number; readers: number; verifiedBytes: number; hash: ReturnType<typeof sha256.create> | null }
export interface VerifiedBlob { transferId: string; sha256: string; byteLength: number; utf8Verified: boolean }
export interface BlobFile { kind: "staged" | "blob"; name: string; byteLength: number }
export class BlobStorageError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "CONFLICT" | "NOT_FOUND" | "OVERLOADED" | "IO_ERROR" | "QUOTA_EXCEEDED" | "CANCELLED", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobStorageError";
  }
}

const MAX_OPEN_TRANSFERS = 8;
const MAX_VERIFICATION_BYTES = 131072;
const validDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const validSize = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function requireId(id: string): void {
  if (!isQuixiId(id)) throw new BlobStorageError("INVALID_REQUEST", "Invalid blob transfer ID");
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BlobStorageError("CANCELLED", "Blob operation cancelled");
}
function ioError(error: unknown): Error {
  if (error instanceof BlobStorageError) return error;
  const name = error instanceof Error ? error.name : "";
  return new BlobStorageError(name === "QuotaExceededError" ? "QUOTA_EXCEEDED" : "IO_ERROR", error instanceof Error ? error.message : String(error), { cause: error });
}
async function exists(directory: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  try { return await directory.getFileHandle(name); }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
}
async function openFile(handle: FileSystemFileHandle): Promise<SyncFile> {
  return (handle as SyncFileHandle).createSyncAccessHandle();
}
function writeAll(file: SyncFile, bytes: Uint8Array, at: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = file.write(bytes.subarray(written), { at: at + written });
    if (!Number.isSafeInteger(count) || count < 1 || count > bytes.byteLength - written) throw new BlobStorageError("IO_ERROR", "Blob write made invalid progress");
    written += count;
  }
}
function readAll(file: SyncFile, bytes: Uint8Array, at: number): void {
  let read = 0;
  while (read < bytes.byteLength) {
    const count = file.read(bytes.subarray(read), { at: at + read });
    if (!Number.isSafeInteger(count) || count < 1 || count > bytes.byteLength - read) throw new BlobStorageError("IO_ERROR", "Blob ended before its recorded size");
    read += count;
  }
}
// Yield between bounded blocks so owner cancellation/control messages can run.
const yieldWorker = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function digestFile(file: SyncFile, signal?: AbortSignal, validateUtf8 = false): Promise<string> {
  const hash = sha256.create();
  const decoder = validateUtf8 ? new TextDecoder("utf-8", { fatal: true }) : undefined;
  const decode = (bytes?: Uint8Array): void => {
    try { if (bytes) decoder?.decode(bytes, { stream: true }); else decoder?.decode(); }
    catch (error) { throw new BlobStorageError("INVALID_REQUEST", "Canonical text must contain valid UTF-8 bytes", { cause: error }); }
  };
  const size = file.getSize();
  if (!validSize(size)) throw new BlobStorageError("IO_ERROR", "Invalid blob size");
  const buffer = new Uint8Array(Math.min(MAX_TRANSFER_BYTES, size));
  try {
    for (let at = 0; at < size; at += buffer.byteLength) {
      aborted(signal);
      const block = buffer.subarray(0, Math.min(buffer.byteLength, size - at));
      readAll(file, block, at);
      hash.update(block);
      decode(block);
      await yieldWorker();
    }
    aborted(signal);
    decode();
    if (file.getSize() !== size) throw new BlobStorageError("IO_ERROR", "Blob size changed during verification");
    return bytesToHex(hash.digest());
  } finally { hash.destroy(); }
}

/** Private byte layer. SQL owns durable transfer metadata and canonical publication.
 * Calls are serialized by the storage owner, including close/discard during async I/O.
 * Successful publish precedes the SQL transaction that exposes an attachment.
 * A crash can leave an orphan file, but never authorizes a missing/partial blob.
 */
export class OpfsBlobStore {
  private readonly uploads = new Map<string, Upload>();
  private readonly downloads = new Map<string, Download>();
  private readonly readFiles = new Map<string, SharedRead>();
  private closed = false;
  private inventoryRevision = 0;
  /** Owner-local write fence for metadata-only inventories, including chunk writes
   * which deliberately do not update the durable transfer row. */
  get inventoryEpoch(): number { return this.inventoryRevision; }
  private constructor(private readonly blobs: FileSystemDirectoryHandle, private readonly staging: FileSystemDirectoryHandle) {}

  static async open(quixi: FileSystemDirectoryHandle): Promise<OpfsBlobStore> {
    const blobs = await quixi.getDirectoryHandle("blobs", { create: true });
    const temp = await quixi.getDirectoryHandle("temp", { create: true });
    const staging = await temp.getDirectoryHandle("blob-transfers", { create: true });
    return new OpfsBlobStore(blobs, staging);
  }

  private checkOpen(): void {
    if (this.closed) throw new BlobStorageError("CONFLICT", "Blob store is closed");
  }
  private reserve(id: string): void {
    this.checkOpen(); requireId(id);
    if (this.uploads.has(id) || this.downloads.has(id)) throw new BlobStorageError("CONFLICT", "Transfer ID is already open");
    if (this.uploads.size + this.downloads.size >= MAX_OPEN_TRANSFERS) throw new BlobStorageError("OVERLOADED", "Too many open blob transfers; finish or cancel an existing transfer");
  }
  private upload(id: string): Upload {
    this.checkOpen(); requireId(id);
    const upload = this.uploads.get(id);
    if (!upload) throw new BlobStorageError("NOT_FOUND", "Blob upload is not open; reconcile durable transfer metadata after restart");
    return upload;
  }

  async begin(transferId: string, expectedBytes: number | null, expectedSha256: string | null, purpose: BlobPurpose = "attachment"): Promise<void> {
    this.reserve(transferId);
    if (!["attachment", "raw_source", "archive", "document", "canonical_text"].includes(purpose)) throw new BlobStorageError("INVALID_REQUEST", "Invalid blob purpose");
    if (!(expectedBytes === null || validSize(expectedBytes)) || !(expectedSha256 === null || validDigest(expectedSha256))) throw new BlobStorageError("INVALID_REQUEST", "Invalid expected blob size or digest");
    const name = `${transferId}.stage`;
    this.inventoryRevision++;
    if (await exists(this.staging, name)) throw new BlobStorageError("CONFLICT", "Staging file already exists; reconcile it before retrying");
    try {
      const file = await openFile(await this.staging.getFileHandle(name, { create: true }));
      this.uploads.set(transferId, { file, hash: sha256.create(), sequence: 0, offset: 0, final: false, state: "writing", expectedBytes, expectedSha256, purpose, verified: null });
    } catch (error) { throw ioError(error); }
    finally { this.inventoryRevision++; }
  }

  append(chunk: ByteChunk): ChunkAcknowledgement {
    const upload = this.upload(chunk.transferId);
    if (upload.state !== "writing" || upload.final || chunk.sequence !== upload.sequence || chunk.offset !== upload.offset || !(chunk.bytes instanceof Uint8Array) || typeof chunk.final !== "boolean" || chunk.bytes.byteLength > MAX_TRANSFER_BYTES || (!chunk.bytes.byteLength && !chunk.final)) throw new BlobStorageError("INVALID_REQUEST", "Invalid blob chunk state, sequence, offset, or size");
    const end = upload.offset + chunk.bytes.byteLength;
    if (!validSize(end) || (upload.expectedBytes !== null && end > upload.expectedBytes)) throw new BlobStorageError("INVALID_REQUEST", "Chunk exceeds declared blob length");
    try {
      this.inventoryRevision++;
      writeAll(upload.file, chunk.bytes, upload.offset);
      upload.file.flush();
      upload.hash.update(chunk.bytes);
      upload.offset = end; upload.sequence++; upload.final = chunk.final;
      return { transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: end };
    } catch (error) { upload.state = "failed"; throw ioError(error); }
  }

  async finish(transferId: string, expectedBytes: number, expectedSha256: string, signal?: AbortSignal): Promise<VerifiedBlob> {
    const upload = this.upload(transferId);
    if (!validSize(expectedBytes) || !validDigest(expectedSha256)) throw new BlobStorageError("INVALID_REQUEST", "Invalid final blob size or digest");
    if (upload.verified) {
      if (upload.verified.sha256 !== expectedSha256 || upload.verified.byteLength !== expectedBytes) throw new BlobStorageError("CONFLICT", "Finalization conflicts with verified content");
      return { ...upload.verified };
    }
    if (upload.state !== "writing" || !upload.final) throw new BlobStorageError("CONFLICT", "Upload has not received a complete byte stream");
    try {
      if (upload.offset !== expectedBytes || (upload.expectedBytes !== null && upload.expectedBytes !== expectedBytes) || (upload.expectedSha256 !== null && upload.expectedSha256 !== expectedSha256) || bytesToHex(upload.hash.digest()) !== expectedSha256) throw new BlobStorageError("CONFLICT", "Blob content does not match its declared size or SHA-256");
      upload.file.flush();
      if (upload.file.getSize() !== expectedBytes || await digestFile(upload.file, signal, upload.purpose === "canonical_text") !== expectedSha256) throw new BlobStorageError("IO_ERROR", "Staged blob failed read-back verification");
      upload.state = "verified";
      upload.verified = { transferId, sha256: expectedSha256, byteLength: expectedBytes, utf8Verified: upload.purpose === "canonical_text" };
      return { ...upload.verified };
    } catch (error) { upload.state = "failed"; throw ioError(error); }
  }

  /** Durable catalog owns verified descriptors; finished uploads need no live
   * access handle or resident hash state while waiting for a canonical commit.
   */
  releaseStaged(transferId: string): void {
    const upload = this.upload(transferId);
    if (upload.state !== "verified") throw new BlobStorageError("CONFLICT", "Only verified staging can release its live handle");
    upload.file.close(); upload.hash.destroy(); this.uploads.delete(transferId);
  }

  async restoreVerified(verified: VerifiedBlob, signal?: AbortSignal): Promise<void> {
    const loaded = this.uploads.get(verified.transferId);
    if (loaded) {
      if (loaded.state !== "verified" || loaded.verified?.sha256 !== verified.sha256 || loaded.verified.byteLength !== verified.byteLength || loaded.verified.utf8Verified !== verified.utf8Verified) throw new BlobStorageError("CONFLICT", "Loaded staging differs from its durable descriptor");
      return;
    }
    this.reserve(verified.transferId);
    if (!validDigest(verified.sha256) || !validSize(verified.byteLength) || typeof verified.utf8Verified !== "boolean") throw new BlobStorageError("INVALID_REQUEST", "Invalid verified staging descriptor");
    let file: SyncFile | undefined;
    try {
      file = await openFile(await this.staging.getFileHandle(`${verified.transferId}.stage`));
      if (file.getSize() !== verified.byteLength || await digestFile(file, signal, verified.utf8Verified) !== verified.sha256) throw new BlobStorageError("IO_ERROR", "Stored staging differs from its verified catalog entry");
      this.uploads.set(verified.transferId, { file, hash: sha256.create(), sequence: 0, offset: verified.byteLength, final: true, state: "verified", expectedBytes: verified.byteLength, expectedSha256: verified.sha256, purpose: verified.utf8Verified ? "canonical_text" : "attachment", verified: { ...verified } });
      file = undefined;
    } catch (error) { file?.close(); throw ioError(error); }
  }

  /** Keep the staging file until the caller's canonical SQL commit succeeds.
   * Existing content is verified before deduplication. Corrupt existing files are
   * reported for reference-aware recovery, never silently overwritten.
   */
  async publish(transferId: string, signal?: AbortSignal, options: { replaceUnpublished?: boolean } = {}): Promise<VerifiedBlob> {
    const upload = this.upload(transferId);
    if (upload.state !== "verified" || !upload.verified) throw new BlobStorageError("CONFLICT", "Only a verified staged blob can be published");
    const result = upload.verified;
    this.inventoryRevision++;
    const directory = await this.blobs.getDirectoryHandle(result.sha256.slice(0, 2), { create: true });
    const existing = await exists(directory, result.sha256);
    const shared = this.readFiles.get(result.sha256);
    let target: SyncFile | undefined;
    let repairing = false;
    try {
      aborted(signal);
      if (shared && !existing) throw new BlobStorageError("IO_ERROR", "Held blob no longer has its published directory entry");
      target = shared?.file ?? await openFile(existing ?? await directory.getFileHandle(result.sha256, { create: true }));
      if (existing && !shared && options.replaceUnpublished && (target.getSize() !== result.byteLength || await digestFile(target, signal) !== result.sha256)) repairing = true;
      if (!existing || repairing) {
        const buffer = new Uint8Array(Math.min(MAX_TRANSFER_BYTES, result.byteLength));
        for (let at = 0; at < result.byteLength; at += buffer.byteLength) {
          aborted(signal);
          const block = buffer.subarray(0, Math.min(buffer.byteLength, result.byteLength - at));
          readAll(upload.file, block, at); writeAll(target, block, at);
          await yieldWorker();
        }
        target.truncate(result.byteLength); target.flush();
      }
      if (target.getSize() !== result.byteLength || await digestFile(target, signal) !== result.sha256) throw new BlobStorageError("IO_ERROR", "Published blob failed integrity verification; preserve it for reference-aware recovery");
      return { ...result };
    } catch (error) {
      // Only remove a file created by this attempt. Existing content may have
      // canonical references even when corrupt and must survive diagnosis.
      if (shared && !(error instanceof BlobStorageError && error.code === "CANCELLED")) this.invalidateRead(result.sha256);
      if (target && !shared) target.close();
      target = undefined;
      if (!existing || repairing) await directory.removeEntry(result.sha256).catch(() => undefined);
      throw ioError(error);
    } finally { this.inventoryRevision++; if (!shared) target?.close(); }
  }

  /** Reserve an exclusive handle without reading bytes. Pending readers share one
   * hash cursor, but cannot expose content until the complete digest is checked. */
  async beginVerifiedRead(transferId: string, digest: string, signal?: AbortSignal): Promise<VerifiedReadProgress> {
    this.reserve(transferId);
    if (!validDigest(digest)) throw new BlobStorageError("INVALID_REQUEST", "Invalid blob digest");
    aborted(signal);
    let shared = this.readFiles.get(digest);
    let file: SyncFile | undefined;
    try {
      if (!shared) {
        const directory = await this.blobs.getDirectoryHandle(digest.slice(0, 2));
        file = await openFile(await directory.getFileHandle(digest));
        aborted(signal);
        const byteLength = file.getSize();
        if (!validSize(byteLength)) throw new BlobStorageError("IO_ERROR", "Invalid blob size");
        shared = { file, byteLength, readers: 0, verifiedBytes: 0, hash: sha256.create() };
        this.readFiles.set(digest, shared);
        file = undefined;
      }
      if (shared.file.getSize() !== shared.byteLength) {
        this.invalidateRead(digest);
        throw new BlobStorageError("IO_ERROR", "Blob size changed while its handle was held");
      }
      shared.readers++;
      this.downloads.set(transferId, { file: shared.file, digest, byteLength: shared.byteLength, baseOffset: 0, offset: 0, sequence: 0, final: false, pending: 0, window: new TransferWindow(transferId) });
      return this.readProgress(transferId, shared);
    } catch (error) {
      file?.close();
      if (error instanceof DOMException && error.name === "NotFoundError") throw new BlobStorageError("NOT_FOUND", "Referenced blob bytes are missing", { cause: error });
      throw ioError(error);
    }
  }

  private readProgress(transferId: string, shared: SharedRead): VerifiedReadProgress {
    return { transferId, byteLength: shared.byteLength, verifiedBytes: shared.verifiedBytes, complete: shared.hash === null };
  }

  async advanceVerifiedRead(transferId: string, maxBytes: number, signal?: AbortSignal): Promise<VerifiedReadProgress> {
    this.checkOpen(); requireId(transferId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_VERIFICATION_BYTES) throw new BlobStorageError("INVALID_REQUEST", "Invalid verification byte budget");
    const download = this.downloads.get(transferId);
    if (!download) throw new BlobStorageError("NOT_FOUND", "Blob verification is not open");
    const shared = this.readFiles.get(download.digest)!;
    try {
      aborted(signal);
      if (shared.file.getSize() !== shared.byteLength) throw new BlobStorageError("IO_ERROR", "Blob size changed during verification");
      if (shared.hash) {
        const block = new Uint8Array(Math.min(maxBytes, shared.byteLength - shared.verifiedBytes));
        readAll(shared.file, block, shared.verifiedBytes);
        shared.hash.update(block);
        shared.verifiedBytes += block.byteLength;
        if (shared.verifiedBytes === shared.byteLength) {
          if (shared.file.getSize() !== shared.byteLength || bytesToHex(shared.hash.digest()) !== download.digest) throw new BlobStorageError("IO_ERROR", "Blob content no longer matches its SHA-256");
          shared.hash.destroy(); shared.hash = null;
        }
      }
      return this.readProgress(transferId, shared);
    } catch (error) {
      if (error instanceof BlobStorageError && error.code === "CANCELLED") this.closeRead(transferId, download);
      else {
        // A failed shared digest invalidates every dependent reader, including
        // pending aliases. No remaining handle can serve these bytes as verified.
        this.invalidateRead(download.digest);
      }
      throw ioError(error);
    }
  }

  async openRead(transferId: string, digest: string, signal?: AbortSignal): Promise<{ transferId: string; sha256: string; byteLength: number }> {
    let opened = false;
    try {
      let progress = await this.beginVerifiedRead(transferId, digest, signal);
      opened = true;
      while (!progress.complete) {
        progress = await this.advanceVerifiedRead(transferId, MAX_VERIFICATION_BYTES, signal);
        if (!progress.complete) await yieldWorker();
      }
      return { transferId, sha256: digest, byteLength: progress.byteLength };
    } catch (error) {
      if (opened) await this.discard(transferId).catch(() => undefined);
      throw error;
    }
  }

  /** A held read transfer pins the verified exclusive file handle. Child ranges
   * share that handle and have independent credits; no second hash pass or
   * whole-file buffer is needed. Offsets select bytes in the complete blob.
   */
  sliceRead(parentTransferId: string, transferId: string, range: { offset: number; byteLength: number }): { transferId: string; sha256: string; byteLength: number; range: { offset: number; byteLength: number } } {
    this.reserve(transferId); requireId(parentTransferId);
    const parent = this.downloads.get(parentTransferId);
    if (!parent) throw new BlobStorageError("NOT_FOUND", "The verified blob reader is no longer open");
    const shared = this.readFiles.get(parent.digest)!;
    if (shared.hash) throw new BlobStorageError("CONFLICT", "Blob verification is not complete");
    if (!range || !validSize(range.offset) || !validSize(range.byteLength) || !validSize(range.offset + range.byteLength) || range.offset + range.byteLength > shared.byteLength) throw new BlobStorageError("INVALID_REQUEST", "Blob range exceeds the verified file");
    if (shared.file.getSize() !== shared.byteLength) throw new BlobStorageError("IO_ERROR", "Verified blob size changed while its handle was held");
    shared.readers++;
    this.downloads.set(transferId, { file: shared.file, digest: parent.digest, byteLength: range.byteLength, baseOffset: range.offset, offset: 0, sequence: 0, final: false, pending: 0, window: new TransferWindow(transferId) });
    return { transferId, sha256: parent.digest, byteLength: shared.byteLength, range: { ...range } };
  }

  readChunk(transferId: string, maxBytes = MAX_TRANSFER_BYTES): ByteChunk {
    this.checkOpen(); requireId(transferId);
    const download = this.downloads.get(transferId);
    if (!download) throw new BlobStorageError("NOT_FOUND", "Blob download is not open");
    if (this.readFiles.get(download.digest)!.hash) throw new BlobStorageError("CONFLICT", "Blob verification is not complete");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TRANSFER_BYTES || download.final) throw new BlobStorageError("INVALID_REQUEST", "Invalid read size or completed stream");
    // Check before allocation or disk I/O, even if callers ignore backpressure.
    if (download.pending >= 4) throw new BlobStorageError("OVERLOADED", "Acknowledge a blob chunk before reading more");
    const bytes = new Uint8Array(Math.min(maxBytes, download.byteLength - download.offset));
    try { readAll(download.file, bytes, download.baseOffset + download.offset); } catch (error) { throw ioError(error); }
    const chunk = { transferId, sequence: download.sequence, offset: download.offset, bytes, final: download.offset + bytes.byteLength === download.byteLength };
    download.window.reserve(chunk);
    download.sequence++; download.pending++; download.offset += bytes.byteLength; download.final = chunk.final;
    return chunk;
  }

  private invalidateRead(digest: string): void {
    for (const [id, reader] of this.downloads) if (reader.digest === digest) this.closeRead(id, reader);
    const unused = this.readFiles.get(digest);
    if (unused) { unused.hash?.destroy(); unused.file.close(); this.readFiles.delete(digest); }
  }

  private closeRead(transferId: string, download: Download): void {
    const shared = this.readFiles.get(download.digest)!;
    if (--shared.readers === 0) { shared.hash?.destroy(); shared.file.close(); this.readFiles.delete(download.digest); }
    this.downloads.delete(transferId);
  }
  acknowledge(ack: ChunkAcknowledgement): void {
    this.checkOpen();
    const download = this.downloads.get(ack.transferId);
    if (!download) throw new BlobStorageError("NOT_FOUND", "Blob download is not open");
    try { download.window.acknowledge(ack); } catch (error) { throw new BlobStorageError("INVALID_REQUEST", String(error)); }
    download.pending--;
    if (download.window.complete) this.closeRead(ack.transferId, download);
  }

  async discard(transferId: string): Promise<boolean> {
    this.checkOpen(); requireId(transferId);
    const upload = this.uploads.get(transferId);
    const download = this.downloads.get(transferId);
    if (upload) { upload.file.close(); upload.hash.destroy(); this.uploads.delete(transferId); }
    if (download) this.closeRead(transferId, download);
    // Releasing a read-only download has no inventory-visible effect. Fence
    // actual staging removal, including a failure after deletion was attempted.
    if (!await exists(this.staging, `${transferId}.stage`)) return !!download;
    this.inventoryRevision++;
    try { await this.staging.removeEntry(`${transferId}.stage`); return true; }
    catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return !!download; throw ioError(error); }
    finally { this.inventoryRevision++; }
  }

  /** Each yielded entry consumes inventory work, including valid prefix
   * directories and unknown entries. Unknown names never cross this boundary.
   * This reads lengths only and does not open, hash, quarantine, or delete blobs. */
  /** Diagnostics: the published content file's size for one digest, or null
   * when it is absent. One handle lookup; an in-progress reader keeps the
   * file readable, so an open handle never counts as missing. */
  async publishedByteLength(sha256: string): Promise<number | null> {
    this.checkOpen();
    if (!validDigest(sha256)) return null;
    let directory: FileSystemDirectoryHandle;
    try { directory = await this.blobs.getDirectoryHandle(sha256.slice(0, 2)); }
    catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw ioError(error); }
    const handle = await exists(directory, sha256);
    if (!handle) return null;
    try { return (await handle.getFile()).size; }
    catch (error) { throw ioError(error); }
  }
  /** Reviewed cleanup (plan 23): removes one published content file. Refused
   * while a verified read holds it; the caller has already established that
   * nothing references the digest. Returns the removed size, or null when
   * the file was already absent. */
  async deletePublished(sha256: string): Promise<number | null> {
    this.checkOpen();
    if (!validDigest(sha256)) throw new BlobStorageError("INVALID_REQUEST", "Invalid blob digest");
    if (this.readFiles.has(sha256)) throw new BlobStorageError("CONFLICT", "The file is open for a verified read");
    try {
      let directory: FileSystemDirectoryHandle;
      try { directory = await this.blobs.getDirectoryHandle(sha256.slice(0, 2)); }
      catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
      const handle = await exists(directory, sha256);
      if (!handle) return null;
      const size = (await handle.getFile()).size;
      await directory.removeEntry(sha256);
      return size;
    } catch (error) { throw ioError(error); }
    finally { this.inventoryRevision++; }
  }
  async *inspectInventory(): AsyncGenerator<{
    kind: 'prefix' | 'blob' | 'staged' | 'unknown';
    sha256: string | null; path: string | null; byteLength: number | null;
  }> {
    this.checkOpen();
    for await (const handle of (this.staging as Directory).values()) {
      this.checkOpen();
      if (handle.kind === 'file' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.stage$/.test(handle.name)) {
        const active = this.uploads.get(handle.name.slice(0, -6));
        yield { kind: 'staged', sha256: null, path: `temp/blob-transfers/${handle.name}`, byteLength: active ? active.file.getSize() : (await (handle as FileSystemFileHandle).getFile()).size };
      } else yield { kind: 'unknown', sha256: null, path: null, byteLength: null };
    }
    for await (const prefix of (this.blobs as Directory).values()) {
      this.checkOpen();
      if (prefix.kind !== 'directory' || !/^[0-9a-f]{2}$/.test(prefix.name)) {
        yield { kind: 'unknown', sha256: null, path: null, byteLength: null };
        continue;
      }
      yield { kind: 'prefix', sha256: null, path: null, byteLength: null };
      for await (const handle of (prefix as Directory).values()) {
        this.checkOpen();
        if (handle.kind === 'file' && validDigest(handle.name) && handle.name.startsWith(prefix.name)) {
          const active = this.readFiles.get(handle.name);
          yield { kind: 'blob', sha256: handle.name, path: `blobs/${prefix.name}/${handle.name}`, byteLength: active ? active.file.getSize() : (await (handle as FileSystemFileHandle).getFile()).size };
        } else yield { kind: 'unknown', sha256: null, path: null, byteLength: null };
      }
    }
  }

  /** Stream inventory for SQL reconciliation. Never infer orphanhood from age;
   * committed references and durable transfer rows decide cleanup eligibility.
   */
  async *inventory(): AsyncGenerator<BlobFile> {
    this.checkOpen();
    for await (const handle of (this.staging as Directory).values()) {
      if (handle.kind === "file" && /^[0-9a-f-]{36}\.stage$/.test(handle.name)) yield { kind: "staged", name: handle.name, byteLength: (await (handle as FileSystemFileHandle).getFile()).size };
    }
    for await (const prefix of (this.blobs as Directory).values()) {
      if (prefix.kind !== "directory" || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      for await (const handle of (prefix as Directory).values()) {
        if (handle.kind === "file" && validDigest(handle.name) && handle.name.startsWith(prefix.name)) yield { kind: "blob", name: handle.name, byteLength: (await (handle as FileSystemFileHandle).getFile()).size };
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const upload of this.uploads.values()) { try { upload.file.close(); } finally { upload.hash.destroy(); } }
    for (const shared of this.readFiles.values()) { shared.hash?.destroy(); shared.file.close(); }
    this.uploads.clear(); this.downloads.clear(); this.readFiles.clear();
  }
}

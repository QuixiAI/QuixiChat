import { canonicalJson } from "@quixi/core/contracts";
import type { BlobPurpose, ByteChunk, ChunkAcknowledgement, StorageOperations } from "@quixi/core/contracts";
import type { JsonValue } from "@quixi/core/model";
import { isQuixiId } from "@quixi/core/model";
import type { VerifiedReadProgress } from "./blobs.ts";
import { BlobStorageError, OpfsBlobStore } from "./blobs.ts";

type Value = string | number | null;
interface CatalogSqlite {
  exec(options: string | { sql: string; bind?: Value[]; rowMode?: "object"; returnValue?: "resultRows" }): unknown;
}
interface Transfer {
  id: string; purpose: BlobPurpose; state: "opening" | "writing" | "verified" | "published" | "consumed" | "discarded" | "interrupted" | "failed";
  sha256: string | null; byte_length: number | null; utf8_verified: number;
}
const id = (value: string): void => { if (!isQuixiId(value)) throw new BlobStorageError("INVALID_REQUEST", "Invalid blob operation or transfer ID"); };
const encode = (value: unknown): string => canonicalJson(value as JsonValue);

/** Durable metadata for the owner worker's byte store. This class owns no
 * canonical history and never runs OPFS I/O inside a SQL transaction.
 * Reconcile once after acquiring exclusive ownership, before admitting requests.
 */
export class BlobCatalog {
  private verificationEpoch = crypto.randomUUID();
  private readonly pendingReads = new Map<string, { sha256: string; byteLength: number }>();
  constructor(private readonly db: CatalogSqlite, private readonly bytes: OpfsBlobStore) {}

  initialize(): void {
    // CanonicalRepository.migrate owns the ordered schema and checksum ledger.
    this.rows("SELECT sha256,byte_length,utf8_verified,availability,verification_epoch FROM quixi_blob_catalog LIMIT 0");
    this.rows("SELECT id,purpose,state,sha256,byte_length,utf8_verified FROM quixi_blob_transfers LIMIT 0");
    this.rows("SELECT operation_id,identity,result FROM quixi_blob_operations LIMIT 0");
  }

  /** No claim of resumability without a restored hash/file cursor. Verified
   * staging reopens from its descriptor; unfinalized uploads require restart.
   */
  reconcileOwnerStart(): void {
    this.db.exec("UPDATE quixi_blob_transfers SET state='interrupted' WHERE state IN('opening','writing')");
  }
  private rows(sql: string, bind: Value[] = []): Record<string, Value>[] {
    return this.db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as Record<string, Value>[];
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* SQLite can abort a transaction itself. */ } throw error; }
  }
  private transfer(transferId: string): Transfer {
    id(transferId);
    const row = this.rows("SELECT * FROM quixi_blob_transfers WHERE id=?", [transferId])[0];
    if (!row) throw new BlobStorageError("NOT_FOUND", "Blob transfer metadata is missing");
    return row as unknown as Transfer;
  }
  private prior<T>(operationId: string, identity: string): T | null {
    id(operationId);
    const row = this.rows("SELECT identity,result FROM quixi_blob_operations WHERE operation_id=?", [operationId])[0];
    if (!row) return null;
    if (row.identity !== identity) throw new BlobStorageError("CONFLICT", "Blob operation ID was reused with different arguments");
    return JSON.parse(String(row.result)) as T;
  }
  private record(operationId: string, identity: string, result: unknown): void {
    this.db.exec({ sql: "INSERT INTO quixi_blob_operations VALUES(?,?,?)", bind: [operationId, identity, encode(result)] });
  }
  private quarantine(sha256: string): void {
    try { this.db.exec({ sql: "UPDATE quixi_blob_catalog SET availability='unverified',verification_epoch='' WHERE sha256=?", bind: [sha256] }); }
    catch {
      // If SQL cannot persist quarantine, invalidate all current-owner evidence
      // in constant memory. No old catalog row can authorize another reference.
      this.verificationEpoch = crypto.randomUUID();
    }
  }

  async begin(args: StorageOperations["beginBlobTransfer"]["args"], nextId: () => string): Promise<StorageOperations["beginBlobTransfer"]["result"]> {
    const identity = encode({ kind: "begin", args });
    const previous = this.prior<StorageOperations["beginBlobTransfer"]["result"]>(args.operationId, identity);
    if (previous) {
      const transfer = this.transfer(previous.transferId);
      if (["opening", "interrupted", "failed", "discarded", "consumed"].includes(transfer.state)) throw new BlobStorageError("CONFLICT", "This upload ended or lost its owner; use a new transfer operation and retain canonical mutation IDs for retries");
      return previous;
    }
    const transferId = nextId(); id(transferId);
    const result = { transferId, maxChunkBytes: 1_048_576, maxInFlight: 4 };
    this.transaction(() => {
      this.db.exec({ sql: "INSERT INTO quixi_blob_transfers(id,purpose,state) VALUES(?,?,'opening')", bind: [transferId, args.purpose] });
      this.record(args.operationId, identity, result);
    });
    let opened = false;
    try {
      await this.bytes.begin(transferId, args.expectedBytes, args.expectedSha256, args.purpose);
      opened = true;
      this.db.exec({ sql: "UPDATE quixi_blob_transfers SET state='writing' WHERE id=?", bind: [transferId] });
      return result;
    } catch (error) {
      if (opened) await this.bytes.discard(transferId).catch(() => undefined);
      // If quota also prevents this update, owner-start reconciliation fences it.
      try { this.db.exec({ sql: "UPDATE quixi_blob_transfers SET state='failed' WHERE id=?", bind: [transferId] }); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  append(chunk: ByteChunk): ChunkAcknowledgement {
    if (this.transfer(chunk.transferId).state !== "writing") throw new BlobStorageError("CONFLICT", "Blob transfer is not writable");
    return this.bytes.append(chunk);
  }

  async finish(args: StorageOperations["finishBlobTransfer"]["args"], signal?: AbortSignal): Promise<StorageOperations["finishBlobTransfer"]["result"]> {
    const identity = encode({ kind: "finish", args });
    const previous = this.prior<StorageOperations["finishBlobTransfer"]["result"]>(args.operationId, identity);
    const transfer = this.transfer(args.transferId);
    if (["interrupted", "failed", "discarded"].includes(transfer.state)) throw new BlobStorageError("CONFLICT", "Blob finalization cannot resume an interrupted or discarded upload");
    if (previous) return previous;
    if (transfer.state !== "writing" && transfer.state !== "verified") throw new BlobStorageError("CONFLICT", "Blob upload cannot be finalized in its current state");
    const verified = await this.bytes.finish(args.transferId, args.expectedBytes, args.expectedSha256, signal);
    const result = { transferId: verified.transferId, sha256: verified.sha256, byteLength: verified.byteLength, state: "verified_staged" as const };
    this.transaction(() => {
      this.db.exec({ sql: "UPDATE quixi_blob_transfers SET state='verified',sha256=?,byte_length=?,utf8_verified=? WHERE id=?", bind: [verified.sha256, verified.byteLength, Number(verified.utf8Verified), args.transferId] });
      this.record(args.operationId, identity, result);
    });
    this.bytes.releaseStaged(args.transferId);
    return result;
  }

  /** Caller checks canonical transaction replay before invoking this method.
   * Publication is durable and repeatable even if the later canonical transaction
   * fails. Orphan accounting must consult references before physical deletion.
   */
  async preparePublication(transferIds: readonly string[], signal?: AbortSignal): Promise<void> {
    if (transferIds.length > 128 || new Set(transferIds).size !== transferIds.length) throw new BlobStorageError("INVALID_REQUEST", "Invalid publication transfer list");
    for (const transferId of transferIds) {
      const transfer = this.transfer(transferId);
      if (transfer.state === "published" || transfer.state === "consumed") {
        await this.verifyExisting(transfer.sha256!, transfer.byte_length!, transfer.utf8_verified ? "utf-8" : undefined, signal);
        continue;
      }
      if (transfer.state !== "verified") throw new BlobStorageError("CONFLICT", "Canonical publication requires verified staging");
      const registered = this.rows("SELECT sha256 FROM quixi_blob_catalog WHERE sha256=?", [transfer.sha256!]).length > 0;
      await this.bytes.restoreVerified({ transferId, sha256: transfer.sha256!, byteLength: transfer.byte_length!, utf8Verified: !!transfer.utf8_verified }, signal);
      let published;
      try { published = await this.bytes.publish(transferId, signal, { replaceUnpublished: !registered }); }
      catch (error) {
        if (registered) await this.quarantineReadFailure(transfer.sha256!, error);
        throw error;
      }
      finally { this.bytes.releaseStaged(transferId); }
      this.transaction(() => {
        const existing = this.rows("SELECT byte_length FROM quixi_blob_catalog WHERE sha256=?", [published.sha256])[0];
        if (existing && existing.byte_length !== published.byteLength) throw new BlobStorageError("CONFLICT", "Published digest conflicts with the durable byte length");
        this.db.exec({ sql: "INSERT INTO quixi_blob_catalog(sha256,byte_length,utf8_verified,availability,verification_epoch) VALUES(?,?,?,'verified',?) ON CONFLICT(sha256) DO UPDATE SET utf8_verified=max(utf8_verified,excluded.utf8_verified),availability='verified',verification_epoch=excluded.verification_epoch", bind: [published.sha256, published.byteLength, Number(published.utf8Verified), this.verificationEpoch] });
        this.db.exec({ sql: "UPDATE quixi_blob_transfers SET state='published' WHERE id=?", bind: [transferId] });
      });
    }
  }

  /** Synchronous SQL check injected into CanonicalRepository. */
  assertAvailable(sha256: string, byteLength: number, _stagedIds: readonly string[], requiredEncoding?: "utf-8"): void {
    const row = this.rows("SELECT byte_length,utf8_verified,availability,verification_epoch FROM quixi_blob_catalog WHERE sha256=?", [sha256])[0];
    if (!row || row.byte_length !== byteLength || row.availability !== "verified" || row.verification_epoch !== this.verificationEpoch || (requiredEncoding === "utf-8" && row.utf8_verified !== 1)) throw new BlobStorageError("CONFLICT", "Canonical reference lacks current-owner verified bytes or required UTF-8 evidence");
  }

  async consumeAfterCommit(transferIds: readonly string[]): Promise<{ pendingCleanup: string[] }> {
    const pendingCleanup: string[] = [];
    for (const transferId of transferIds) {
      try {
        const transfer = this.transfer(transferId);
        if (transfer.state === "consumed" || transfer.state === "discarded") continue;
        if (transfer.state !== "published") throw new BlobStorageError("CONFLICT", "Only published staging can be consumed after commit");
        await this.bytes.discard(transferId);
        this.db.exec({ sql: "UPDATE quixi_blob_transfers SET state='consumed' WHERE id=?", bind: [transferId] });
      } catch { pendingCleanup.push(transferId); }
    }
    return { pendingCleanup };
  }

  /** Release a terminal import's staging without invalidating an already
   * published transfer identity used by canonical retries or another import.
   */
  async cleanupImportTransfer(transferId: string): Promise<boolean> {
    const row = this.rows("SELECT state FROM quixi_blob_transfers WHERE id=?", [transferId])[0];
    if (row?.state === "published" || row?.state === "consumed") return (await this.consumeAfterCommit([transferId])).pendingCleanup.length === 0;
    await this.discard(transferId); return true;
  }
  async discard(transferId: string): Promise<{ discarded: boolean }> {
    id(transferId);
    this.pendingReads.delete(transferId);
    const row = this.rows("SELECT state FROM quixi_blob_transfers WHERE id=?", [transferId])[0];
    if (!row) return { discarded: await this.bytes.discard(transferId) };
    if (row.state === "consumed" || row.state === "discarded") return { discarded: false };
    await this.bytes.discard(transferId);
    this.db.exec({ sql: "UPDATE quixi_blob_transfers SET state='discarded' WHERE id=?", bind: [transferId] });
    return { discarded: true };
  }

  /** Owner-local verification cursors are never durable evidence. Every step
   * rechecks the catalog length; only a complete digest grants this owner trust. */
  async beginVerifiedRead(sha256: string, nextId: () => string, signal?: AbortSignal): Promise<VerifiedReadProgress> {
    const row = this.rows("SELECT byte_length FROM quixi_blob_catalog WHERE sha256=?", [sha256])[0];
    if (!row) throw new BlobStorageError("NOT_FOUND", "Blob is not published in the catalog");
    let result: VerifiedReadProgress | undefined;
    try {
      result = await this.bytes.beginVerifiedRead(nextId(), sha256, signal);
      this.validateReadMetadata(sha256, Number(row.byte_length), result);
      if (!result.complete) this.pendingReads.set(result.transferId, { sha256, byteLength: result.byteLength });
      return result;
    } catch (error) {
      if (result) await this.bytes.discard(result.transferId).catch(() => undefined);
      await this.quarantineReadFailure(sha256, error);
      throw error;
    }
  }

  async advanceVerifiedRead(transferId: string, maxBytes: number, signal?: AbortSignal): Promise<VerifiedReadProgress> {
    id(transferId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 131072) throw new BlobStorageError("INVALID_REQUEST", "Invalid verification byte budget");
    const pending = this.pendingReads.get(transferId);
    if (!pending) throw new BlobStorageError("NOT_FOUND", "Blob verification is not open in this catalog");
    try {
      this.validateReadMetadata(pending.sha256, pending.byteLength);
      const result = await this.bytes.advanceVerifiedRead(transferId, maxBytes, signal);
      this.validateReadMetadata(pending.sha256, pending.byteLength, result);
      if (result.complete) this.pendingReads.delete(transferId);
      return result;
    } catch (error) {
      this.pendingReads.delete(transferId);
      await this.bytes.discard(transferId).catch(() => undefined);
      await this.quarantineReadFailure(pending.sha256, error);
      throw error;
    }
  }

  private validateReadMetadata(sha256: string, byteLength: number, result?: VerifiedReadProgress): void {
    const current = this.rows("SELECT byte_length FROM quixi_blob_catalog WHERE sha256=?", [sha256])[0];
    if (!current) throw new BlobStorageError("NOT_FOUND", "Blob is no longer published in the catalog");
    if (current.byte_length !== byteLength || (result && result.byteLength !== byteLength)) throw new BlobStorageError("IO_ERROR", "Published blob length differs from its catalog");
    if (result?.complete) this.db.exec({ sql: "UPDATE quixi_blob_catalog SET availability='verified',verification_epoch=? WHERE sha256=?", bind: [this.verificationEpoch, sha256] });
  }

  private async quarantineReadFailure(sha256: string, error: unknown): Promise<void> {
    if (error instanceof BlobStorageError && error.code !== "IO_ERROR" && error.code !== "NOT_FOUND") return;
    this.quarantine(sha256);
    // A shared digest failure can close sibling byte transfers. Forget all
    // owner-local cursors for that digest too; abandoned failures cannot grow
    // this map beyond the live transfer bound. Metadata failures also release
    // sibling byte handles which have not yet observed that invalidation.
    for (const [transferId, pending] of this.pendingReads) {
      if (pending.sha256 !== sha256) continue;
      this.pendingReads.delete(transferId);
      await this.bytes.discard(transferId).catch(() => undefined);
    }
  }

  async openRead(sha256: string, nextId: () => string, signal?: AbortSignal): Promise<StorageOperations["readBlobTransfer"]["result"]> {
    const row = this.rows("SELECT byte_length FROM quixi_blob_catalog WHERE sha256=?", [sha256])[0];
    if (!row) throw new BlobStorageError("NOT_FOUND", "Blob is not published in the catalog");
    let result: StorageOperations["readBlobTransfer"]["result"] | undefined;
    try {
      result = await this.bytes.openRead(nextId(), sha256, signal);
      this.validateReadMetadata(sha256, Number(row.byte_length), { ...result, verifiedBytes: result.byteLength, complete: true });
      return result;
    } catch (error) {
      if (result) await this.bytes.discard(result.transferId).catch(() => undefined);
      // Retain corrupt/missing rows: absence authorizes unpublished-orphan repair.
      await this.quarantineReadFailure(sha256, error);
      throw error;
    }
  }

  /** Call before new canonical references to already-published content. Reopens
   * and hashes actual bytes; metadata from a previous owner is insufficient.
   */
  async verifyExisting(sha256: string, byteLength: number, requiredEncoding?: "utf-8", signal?: AbortSignal): Promise<void> {
    const read = await this.openRead(sha256, () => crypto.randomUUID(), signal);
    try {
      if (read.byteLength !== byteLength) throw new BlobStorageError("CONFLICT", "Canonical blob reference has the wrong byte length");
      const metadata = this.rows("SELECT utf8_verified FROM quixi_blob_catalog WHERE sha256=?", [sha256])[0]!;
      if (requiredEncoding === "utf-8" && metadata.utf8_verified !== 1) {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          if (signal?.aborted) throw new BlobStorageError("CANCELLED", "Text verification cancelled");
          const chunk = this.bytes.readChunk(read.transferId);
          try { decoder.decode(chunk.bytes, { stream: !chunk.final }); }
          catch (error) { throw new BlobStorageError("INVALID_REQUEST", "Canonical text must contain valid UTF-8 bytes", { cause: error }); }
          this.bytes.acknowledge({ transferId: read.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
          if (chunk.final) break;
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        this.db.exec({ sql: "UPDATE quixi_blob_catalog SET utf8_verified=1 WHERE sha256=?", bind: [sha256] });
      }
      this.assertAvailable(sha256, byteLength, [], requiredEncoding);
    } finally { await this.bytes.discard(read.transferId); }
  }
  readChunk(transferId: string): ByteChunk { return this.bytes.readChunk(transferId); }
  sliceRead(transferId: string, nextId: () => string, range: { offset: number; byteLength: number }): ReturnType<OpfsBlobStore["sliceRead"]> { return this.bytes.sliceRead(transferId, nextId(), range); }
  acknowledge(ack: ChunkAcknowledgement): void {
    this.bytes.acknowledge(ack);
    // A foreground reader can complete this shared hash before its incremental
    // owner calls advance again. Successful consumption also retires that cursor.
    this.pendingReads.delete(ack.transferId);
  }
}

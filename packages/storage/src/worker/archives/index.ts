import { openSqliteFileReader } from "./sqlite-file.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  ARCHIVE_LIMITS,
  assertArchivesArgs,
  canonicalJson,
  TransferWindow,
} from "@quixi/core/contracts";
import type {
  ArchivesOperations,
  ArchiveJobStatus,
  ArchiveActivationReview,
  ByteChunk,
  ChunkAcknowledgement,
} from "@quixi/core/contracts";
import type { JsonValue } from "@quixi/core/model";
import { CANONICAL_MIGRATIONS } from "../../../migrations/index.ts";
import { BlobStorageError } from "../blobs.ts";
import type { SearchBlobAccess } from "../search/index.ts";
import {
  copySnapshot,
  approvedSchema,
  sqlRows,
  snapshotSummary,
} from "./snapshot.ts";
import type {
  ArchiveDatabaseFile,
  ArchivePool,
  ArchiveSqlite,
} from "./snapshot.ts";
import { CleanSnapshotCopy } from "./clean-copy.ts";
import {
  ArchiveFileWriter,
  openArchiveFile,
  readArchiveBytes,
} from "./files.ts";
import type { ArchiveFileHandle } from "./files.ts";
import { exportArchive } from "./export.ts";
import type { ExportTick } from "./export.ts";
import { ArchiveReceiver, ArchiveInventoryValidator } from "./receive.ts";
import {
  ArchiveSchemaValidator,
  restrictRestoreConnection,
} from "./schema-validation.ts";
import { CanonicalArchiveValidator } from "./validation.ts";
import type { ArchiveManifest } from "./format.ts";
export interface ArchiveRepositoryOptions {
  db: ArchiveDatabaseFile;
  sqlite: ArchiveSqlite;
  pool: ArchivePool;
  archiveId: string;
  quixiDirectory: FileSystemDirectoryHandle;
  opfsRoot: FileSystemDirectoryHandle;
  blobs: SearchBlobAccess;
}
type Metadata = {
  status: ArchiveJobStatus;
  candidateId: string | null;
  inputId: string | null;
  manifest: ArchiveManifest | null;
  input: { byteLength: number | null; sha256: string | null } | null;
  /** Rescue and upgraded restores clean the raw database into the candidate
   * once; the cleaned candidate is then revalidated like a portable one. */
  rescueCleaned?: boolean;
  /** Set when the received ledger was a strict prefix: the candidate was
   * upgraded from this schema through the fresh-schema copy. */
  sourceSchemaVersion?: number;
};
type Runtime = {
  signal?: AbortSignal | undefined;
  directory: FileSystemDirectoryHandle;
  candidate?: FileSystemDirectoryHandle;
  raw?: ArchiveDatabaseFile;
  clean?: ArchiveDatabaseFile;
  copier?: CleanSnapshotCopy;
  output?: ArchiveFileHandle;
  writer?: ArchiveFileWriter;
  iterator?: AsyncGenerator<ExportTick>;
  pending?: ExportTick;
  receiver?: ArchiveReceiver;
  inventory?: ArchiveInventoryValidator;
  candidatePool?: ArchivePool;
  candidateDb?: ArchiveDatabaseFile;
  schema?: ArchiveSchemaValidator;
  validator?: CanonicalArchiveValidator;
  blobAfter?: string;
  blob?: {
    file: ArchiveFileHandle;
    offset: number;
    byteLength: number;
    sha256: string;
    hash: ReturnType<typeof sha256.create>;
    decoder: TextDecoder | null;
  };
  freshReady?: boolean;
  revalidate?: boolean;
  databaseRead?: {
    reader: ReturnType<typeof openSqliteFileReader>;
    offset: number;
    hash: ReturnType<typeof sha256.create>;
  };
};
type Transfer = {
  jobId: string;
  kind: "input" | "output";
  window: TransferWindow;
  offset: number;
  sequence: number;
  final: boolean;
};
const json = (value: unknown) => canonicalJson(value as JsonValue),
  hash = (value: unknown) =>
    bytesToHex(sha256(new TextEncoder().encode(json(value))));
/** Earliest schema whose archives restore here through the candidate upgrade.
 * Schema 8 is the first cohort with a frozen production writer proof, and
 * every later migration only adds objects or replaces triggers, so its
 * canonical, journal, catalog and local-state rows copy unchanged into a
 * fresh current-schema candidate. Older ledgers name their version instead. */
export const RESTORE_UPGRADE_FLOOR = 8;
type LedgerRow = { version: number; name: string; checksum: string };
let expectedLedgerRows: LedgerRow[] | undefined;
function expectedLedger(): LedgerRow[] {
  return (expectedLedgerRows ??= CANONICAL_MIGRATIONS.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: hash(migration.sql),
  })));
}
/** How a declared or found ledger relates to this build's migrations. */
export function ledgerRelation(
  rows: readonly LedgerRow[],
): "equal" | "prefix" | "other" {
  const expected = expectedLedger();
  if (rows.length > expected.length) return "other";
  if (!rows.every((row, index) => json(row) === json(expected[index])))
    return "other";
  return rows.length === expected.length ? "equal" : "prefix";
}
function stopped(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new BlobStorageError(
      "CANCELLED",
      "Archive work cancelled before its next checkpoint.",
    );
}
/** Private archive jobs. All methods, including byte transfer calls and close,
 * are serialized by the existing storage owner. No method activates a candidate. */
export class ArchiveRepository {
  private readonly runtime = new Map<string, Runtime>();
  private readonly transfers = new Map<string, Transfer>();
  private closed = false;
  constructor(private readonly options: ArchiveRepositoryOptions) {
    options.db
      .exec(`CREATE TABLE IF NOT EXISTS quixi_archive_jobs(id TEXT PRIMARY KEY,metadata TEXT NOT NULL CHECK(json_valid(metadata) AND length(CAST(metadata AS BLOB))<=65536)) STRICT;
CREATE TABLE IF NOT EXISTS quixi_archive_received_entries(job_id TEXT NOT NULL,path TEXT NOT NULL,byte_length INTEGER NOT NULL,sha256 TEXT,checked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,path)) STRICT;
CREATE TABLE IF NOT EXISTS quixi_archive_operations(id TEXT PRIMARY KEY,identity TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result) AND length(CAST(result AS BLOB))<=65536)) STRICT;
CREATE INDEX IF NOT EXISTS quixi_archive_review_token ON quixi_archive_operations(json_extract(result,'$.token')) WHERE json_type(result,'$.token')='text';`);
    // Unfinished hash/parser cursors are not resumable after owner loss. Ready
    // candidates are retained, but require revalidation before a new review token.
    options.db.exec(
      "UPDATE quixi_archive_jobs SET metadata=json_set(metadata,'$.status.state','failed','$.status.failure',json_object('code','UNKNOWN_OUTCOME','reason','Archive owner ended before completion; release this job and start a new one.')) WHERE json_extract(metadata,'$.status.state')='working'",
    );
  }
  private get db() {
    return this.options.db;
  }
  private check() {
    if (this.closed)
      throw new BlobStorageError("CONFLICT", "Archive repository is closed.");
  }
  private job(id: string): Metadata {
    const row = sqlRows(
      this.db,
      "SELECT metadata FROM quixi_archive_jobs WHERE id=?",
      [id],
    )[0];
    if (!row) throw new BlobStorageError("NOT_FOUND", "Archive job is absent.");
    return JSON.parse(String(row.metadata));
  }
  private save(job: Metadata) {
    this.db.exec({
      sql: "INSERT INTO quixi_archive_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
      bind: [job.status.jobId, json(job)],
    });
  }
  operationStatus(operationId: string): JsonValue | null {
    const row = sqlRows(
      this.db,
      "SELECT result FROM quixi_archive_operations WHERE id=?",
      [operationId],
    )[0];
    return row ? JSON.parse(String(row.result)) : null;
  }
  private prior(operationId: string, identity: string): unknown | undefined {
    const row = sqlRows(
      this.db,
      "SELECT identity,result FROM quixi_archive_operations WHERE id=?",
      [operationId],
    )[0];
    if (!row) return undefined;
    if (row.identity !== identity)
      throw new BlobStorageError(
        "CONFLICT",
        "Archive operation ID was reused with different arguments.",
      );
    return JSON.parse(String(row.result));
  }
  private record(operationId: string, identity: string, result: unknown) {
    this.db.exec({
      sql: "INSERT INTO quixi_archive_operations VALUES(?,?,?)",
      bind: [operationId, identity, json(result)],
    });
  }
  private async directory(jobId: string) {
    const temporary = await this.options.quixiDirectory.getDirectoryHandle(
      "temp",
      { create: true },
    );
    const archives = await temporary.getDirectoryHandle("archives", {
      create: true,
    });
    return archives.getDirectoryHandle(jobId, { create: true });
  }
  private async loaded(job: Metadata): Promise<Runtime> {
    let runtime = this.runtime.get(job.status.jobId);
    if (!runtime) {
      runtime = { directory: await this.directory(job.status.jobId) };
      this.runtime.set(job.status.jobId, runtime);
    }
    return runtime;
  }
  private admission() {
    const count = Number(
      this.db.selectValue(
        "SELECT count(*) FROM quixi_archive_jobs WHERE json_extract(metadata,'$.status.state') IN('working','ready')",
      ),
    );
    if (count >= ARCHIVE_LIMITS.maxActiveJobs)
      throw new BlobStorageError(
        "OVERLOADED",
        "Release an existing archive job first.",
      );
  }
  private status(jobId: string): ArchiveJobStatus {
    return this.job(jobId).status;
  }
  ownsTransfer(id: string): boolean {
    return this.transfers.has(id);
  }
  async request<K extends keyof ArchivesOperations>(
    operation: K,
    args: ArchivesOperations[K]["args"],
    signal?: AbortSignal,
  ): Promise<ArchivesOperations[K]["result"]> {
    this.check();
    assertArchivesArgs(operation, args);
    stopped(signal);
    const value = args as ArchivesOperations[keyof ArchivesOperations]["args"];
    const operationId = "operationId" in value ? value.operationId : null,
      identity = hash([operation, args]);
    if (operationId) {
      const previous = this.prior(operationId, identity);
      if (previous !== undefined) {
        if (
          operation === "prepareArchiveActivation" &&
          !this.runtime.get(
            (args as ArchivesOperations["prepareArchiveActivation"]["args"])
              .jobId,
          )?.freshReady
        )
          throw new BlobStorageError(
            "CONFLICT",
            "Advance this restore job to revalidate it under the current storage owner.",
          );
        return previous as ArchivesOperations[K]["result"];
      }
    }
    let result: unknown;
    switch (operation) {
      case "listArchiveJobs": {
        const page = args as ArchivesOperations["listArchiveJobs"]["args"],
          rows = sqlRows(
            this.db,
            "SELECT metadata FROM quixi_archive_jobs WHERE id>? AND json_extract(metadata,'$.status.state')!='released' ORDER BY id LIMIT ?",
            [page.afterJobId ?? "", page.maxItems + 1],
          );
        const items = rows
          .slice(0, page.maxItems)
          .map((row) => (JSON.parse(String(row.metadata)) as Metadata).status);
        result = {
          items,
          nextJobId: rows.length > page.maxItems ? items.at(-1)!.jobId : null,
        };
        break;
      }
      case "beginArchiveExport":
        result = await this.beginExport(
          args as ArchivesOperations["beginArchiveExport"]["args"],
        );
        break;
      case "beginArchiveRestore":
        result = await this.beginRestore(
          args as ArchivesOperations["beginArchiveRestore"]["args"],
        );
        break;
      case "archiveJobStatus":
        result = this.status(
          (args as ArchivesOperations["archiveJobStatus"]["args"]).jobId,
        );
        break;
      case "advanceArchiveJob":
        result = await this.advance(
          args as ArchivesOperations["advanceArchiveJob"]["args"],
          signal,
        );
        break;
      case "openArchiveExport":
        result = await this.openExport(
          (args as ArchivesOperations["openArchiveExport"]["args"]).jobId,
          signal,
        );
        break;
      case "finishArchiveRestore":
        result = await this.finishRestore(
          args as ArchivesOperations["finishArchiveRestore"]["args"],
        );
        break;
      case "cancelArchiveJob":
      case "releaseArchiveJob":
        result = await this.release(
          (args as ArchivesOperations["releaseArchiveJob"]["args"]).jobId,
          operation === "cancelArchiveJob",
        );
        break;
      case "prepareArchiveActivation":
        result = this.review(
          args as ArchivesOperations["prepareArchiveActivation"]["args"],
        );
        break;
    }
    if (operationId) this.record(operationId, identity, result);
    return result as ArchivesOperations[K]["result"];
  }
  private initial(
    jobId: string,
    kind: "export" | "restore",
    format: "portable" | "open",
  ): ArchiveJobStatus {
    return {
      jobId,
      kind,
      format,
      state: "working",
      phase: kind === "export" ? "snapshot" : "receiving",
      completedBytes: 0,
      totalBytes: null,
      completedRecords: 0,
      totalRecords: null,
      entryCount: 0,
      sourceSchemaVersion: null,
      failure: null,
      output: null,
      candidate: null,
    };
  }
  private async cleanupFailed() {
    const row = sqlRows(
      this.db,
      "SELECT id FROM quixi_archive_jobs WHERE json_extract(metadata,'$.status.state') IN('failed','cancelled') ORDER BY id LIMIT 1",
    )[0];
    if (row) await this.release(String(row.id), false);
  }
  private async beginExport(
    args: ArchivesOperations["beginArchiveExport"]["args"],
  ) {
    await this.cleanupFailed();
    this.admission();
    const job: Metadata = {
      status: this.initial(args.operationId, "export", args.format),
      candidateId: null,
      inputId: null,
      manifest: null,
      input: null,
    };
    this.save(job);
    await this.loaded(job);
    return job.status;
  }
  private async beginRestore(
    args: ArchivesOperations["beginArchiveRestore"]["args"],
  ) {
    await this.cleanupFailed();
    this.admission();
    const job: Metadata = {
      status: this.initial(args.operationId, "restore", "portable"),
      candidateId: crypto.randomUUID(),
      inputId: crypto.randomUUID(),
      manifest: null,
      input: { byteLength: args.expectedBytes, sha256: args.expectedSha256 },
    };
    job.status.totalBytes = args.expectedBytes;
    this.save(job);
    const runtime = await this.loaded(job);
    runtime.candidate = await this.options.opfsRoot.getDirectoryHandle(
      `quixi-${job.candidateId}`,
      { create: true },
    );
    runtime.receiver = new ArchiveReceiver(
      this.db,
      job.status.jobId,
      runtime.candidate,
      job.input!,
    );
    this.transfers.set(job.inputId!, {
      jobId: job.status.jobId,
      kind: "input",
      window: new TransferWindow(job.inputId!, 65536, 4),
      offset: 0,
      sequence: 0,
      final: false,
    });
    return {
      job: job.status,
      inputTransfer: {
        transferId: job.inputId!,
        maxChunkBytes: 65536,
        maxInFlight: 4,
      },
    };
  }
  async append(
    chunk: ByteChunk,
    signal?: AbortSignal,
  ): Promise<ChunkAcknowledgement> {
    this.check();
    stopped(signal);
    const transfer = this.transfers.get(chunk.transferId);
    if (!transfer || transfer.kind !== "input")
      throw new BlobStorageError(
        "NOT_FOUND",
        "Archive input transfer is absent.",
      );
    const job = this.job(transfer.jobId),
      runtime = this.runtime.get(transfer.jobId);
    if (
      job.status.state !== "working" ||
      job.status.phase !== "receiving" ||
      !runtime?.receiver
    )
      throw new BlobStorageError("CONFLICT", "Archive input is not writable.");
    transfer.window.reserve(chunk);
    try {
      await runtime.receiver.push(chunk.bytes);
      transfer.offset += chunk.bytes.length;
      transfer.final = chunk.final;
      const ack = {
        transferId: chunk.transferId,
        sequence: chunk.sequence,
        committedOffset: transfer.offset,
      };
      transfer.window.acknowledge(ack);
      job.status.completedBytes = transfer.offset;
      this.save(job);
      return ack;
    } catch (error) {
      await this.fail(job, error);
      throw error;
    }
  }
  private async finishRestore(
    args: ArchivesOperations["finishArchiveRestore"]["args"],
  ) {
    const job = this.job(args.jobId),
      runtime = this.runtime.get(args.jobId),
      transfer = job.inputId ? this.transfers.get(job.inputId) : null;
    if (
      job.status.state !== "working" ||
      job.status.phase !== "receiving" ||
      !runtime?.receiver ||
      !transfer?.window.complete
    )
      throw new BlobStorageError(
        "CONFLICT",
        "Restore input must be complete before validation.",
      );
    try {
      job.manifest = runtime.receiver.finish(args);
      await runtime.receiver.close();
      delete runtime.receiver;
      this.transfers.delete(job.inputId!);
      job.status.phase = "container_validation";
      job.status.entryCount = job.manifest.inventory.entries;
      job.status.totalRecords = job.manifest.source.canonicalRecords;
      this.save(job);
      return job.status;
    } catch (error) {
      await this.fail(job, error);
      throw error;
    }
  }
  private async advance(
    args: ArchivesOperations["advanceArchiveJob"]["args"],
    signal?: AbortSignal,
  ) {
    const job = this.job(args.jobId);
    if (job.status.state === "ready") {
      if (
        job.status.kind === "export" ||
        this.runtime.get(args.jobId)?.freshReady
      )
        return job.status;
      const runtime = await this.loaded(job);
      runtime.revalidate = true;
      job.status.state = "working";
      job.status.phase = "container_validation";
      job.status.completedRecords = 0;
      this.db.exec({
        sql: "UPDATE quixi_archive_received_entries SET checked=0 WHERE job_id=?",
        bind: [args.jobId],
      });
      this.clearValidation(args.jobId);
      this.save(job);
    }
    if (job.status.state !== "working")
      throw new BlobStorageError("CONFLICT", "Archive job is not active.");
    const runtime = await this.loaded(job);
    try {
      if (job.status.kind === "export")
        await this.advanceExport(job, runtime, args, signal);
      else await this.advanceRestore(job, runtime, args, signal);
      this.save(job);
      return job.status;
    } catch (error) {
      await this.fail(job, error);
      throw error;
    }
  }
  private async advanceExport(
    job: Metadata,
    runtime: Runtime,
    args: ArchivesOperations["advanceArchiveJob"]["args"],
    signal?: AbortSignal,
  ) {
    stopped(signal);
    runtime.signal = signal;
    const id = job.status.jobId;
    if (!runtime.copier && !runtime.iterator) {
      runtime.raw = await copySnapshot(
        this.options.sqlite,
        this.options.pool,
        this.db,
        `/export-${id}.sqlite3`,
        signal,
      );
      runtime.clean = new this.options.pool.OpfsSAHPoolDb(
        `/clean-${id}.sqlite3`,
      );
      runtime.copier = new CleanSnapshotCopy(runtime.raw, runtime.clean);
      return;
    }
    if (runtime.copier) {
      const done = runtime.copier.step(args.maxRecords);
      job.status.completedRecords = runtime.copier.copiedRows;
      if (!done) return;
      delete runtime.copier;
      runtime.raw!.close();
      delete runtime.raw;
      this.options.pool.unlink(`/export-${id}.sqlite3`);
      runtime.output = await openArchiveFile(
        runtime.directory,
        "output.tar",
        true,
      );
      runtime.writer = new ArchiveFileWriter(runtime.output);
      runtime.iterator = exportArchive({
        sqlite: this.options.sqlite,
        snapshot: runtime.clean!,
        files: runtime.directory,
        blobs: this.options.blobs,
        format: job.status.format,
        currentSignal: () => runtime.signal,
      });
      job.status.phase = "encoding";
      job.status.completedRecords = 0;
    }
    let bytes = 0,
      records = 0,
      steps = 0;
    while (
      bytes < args.maxBytes &&
      records < args.maxRecords &&
      steps++ < 256
    ) {
      stopped(signal);
      if (!runtime.pending) {
        const next = await runtime.iterator!.next();
        if (next.done) {
          const output = runtime.writer!.finish();
          job.status.state = "ready";
          job.status.phase = "ready";
          job.status.output = {
            name: `quixi-${job.status.format}-${id}.tar`,
            mediaType: "application/x-tar",
            ...output,
          };
          job.status.totalBytes = output.byteLength;
          runtime.clean!.close();
          delete runtime.clean;
          this.options.pool.unlink(`/clean-${id}.sqlite3`);
          return;
        }
        runtime.pending = next.value;
      }
      const tick = runtime.pending;
      if (tick.waitingForResources) {
        delete runtime.pending;
        return;
      }
      if (tick.bytes) {
        const count = Math.min(tick.bytes.length, args.maxBytes - bytes);
        runtime.writer!.write(tick.bytes.subarray(0, count));
        bytes += count;
        job.status.completedBytes = runtime.writer!.byteLength;
        if (count < tick.bytes.length) {
          runtime.pending = { ...tick, bytes: tick.bytes.subarray(count) };
          continue;
        }
      } else bytes += tick.stagedBytes;
      records += tick.records;
      job.status.completedRecords += tick.records;
      delete runtime.pending;
    }
  }
  private async advanceRestore(
    job: Metadata,
    runtime: Runtime,
    args: ArchivesOperations["advanceArchiveJob"]["args"],
    signal?: AbortSignal,
  ) {
    stopped(signal);
    if (job.status.phase === "receiving")
      throw new BlobStorageError(
        "CONFLICT",
        "Finish receiving the archive before validation.",
      );
    const id = job.status.jobId,
      candidate = (runtime.candidate ??=
        await this.options.opfsRoot.getDirectoryHandle(
          `quixi-${job.candidateId}`,
        ));
    if (job.status.phase === "container_validation") {
      runtime.inventory ??= new ArchiveInventoryValidator(
        this.db,
        id,
        await openArchiveFile(candidate, "checksums.jsonl"),
        job.manifest!,
      );
      if (!runtime.inventory.step(args.maxRecords)) return;
      runtime.inventory.close();
      delete runtime.inventory;
      job.status.phase = "schema_validation";
      return;
    }
    if (job.status.phase === "schema_validation") {
      const rescue = job.manifest!.kind === "rescue";
      // A declared ledger that is a strict prefix of this build's migrations
      // (from the upgrade floor) restores through the same raw import and
      // fresh-schema clean copy as a rescue, so the isolated candidate is
      // upgraded before validation and review; the received bytes never
      // change. Once cleaned, revalidation follows the cleaned candidate.
      const viaRaw =
        rescue ||
        job.sourceSchemaVersion !== undefined ||
        ledgerRelation(job.manifest!.source.migrations) === "prefix";
      if (!runtime.candidatePool) {
        runtime.candidatePool = await this.options.sqlite.installOpfsSAHPoolVfs(
          {
            name: `quixi-restore-${id}`,
            directory: `/quixi-${job.candidateId}/database`,
            initialCapacity: 6,
          },
        );
        await runtime.candidatePool.unpauseVfs();
        const cleaned = viaRaw && (runtime.revalidate || job.rescueCleaned);
        if (!runtime.revalidate && !cleaned) {
          const input = await openArchiveFile(candidate, "incoming.sqlite3");
          let offset = 0;
          try {
            await runtime.candidatePool.importDb(
              viaRaw ? "/rescue-raw.sqlite3" : "/archive.sqlite3",
              async () => {
                stopped(signal);
                if (offset === input.getSize()) return undefined;
                const bytes = readArchiveBytes(
                  input,
                  offset,
                  Math.min(65536, input.getSize() - offset),
                );
                offset += bytes.length;
                await new Promise((resolve) => setTimeout(resolve, 0));
                return bytes;
              },
            );
          } finally {
            input.close();
          }
        }
        if (viaRaw && !cleaned) {
          // The received bytes are verified on the raw copy, then cleaned
          // into a fresh candidate exactly as a portable export is cleaned.
          runtime.raw = new runtime.candidatePool.OpfsSAHPoolDb(
            "/rescue-raw.sqlite3",
            "r",
          );
          restrictRestoreConnection(this.options.sqlite, runtime.raw);
          runtime.databaseRead = {
            reader: openSqliteFileReader(this.options.sqlite, runtime.raw),
            offset: 0,
            hash: sha256.create(),
          };
        } else {
          runtime.candidateDb = new runtime.candidatePool.OpfsSAHPoolDb(
            "/archive.sqlite3",
            "r",
          );
          restrictRestoreConnection(this.options.sqlite, runtime.candidateDb);
          if (cleaned)
            runtime.schema = new ArchiveSchemaValidator(
              runtime.candidateDb,
              await approvedSchema(this.options.pool, `/schema-${id}.sqlite3`),
            );
          else
            runtime.databaseRead = {
              reader: openSqliteFileReader(
                this.options.sqlite,
                runtime.candidateDb,
              ),
              offset: 0,
              hash: sha256.create(),
            };
        }
      }
      if (runtime.databaseRead) {
        const scan = runtime.databaseRead;
        let bytes = 0;
        while (scan.offset < scan.reader.byteLength && bytes < args.maxBytes) {
          stopped(signal);
          const chunk = scan.reader.read(
            scan.offset,
            Math.min(65536, args.maxBytes - bytes),
          );
          scan.hash.update(chunk);
          scan.offset += chunk.length;
          bytes += chunk.length;
        }
        if (scan.offset < scan.reader.byteLength) return;
        const expected = sqlRows(
          this.db,
          "SELECT byte_length,sha256 FROM quixi_archive_received_entries WHERE job_id=? AND path='quixi.sqlite'",
          [id],
        )[0];
        if (
          !expected ||
          scan.reader.byteLength !== expected.byte_length ||
          bytesToHex(scan.hash.digest()) !== expected.sha256
        )
          throw new Error(
            "Isolated candidate database differs from its received checksum.",
          );
        scan.reader.close();
        delete runtime.databaseRead;
        if (runtime.raw) {
          this.checkRawLedger(job, runtime.raw);
          runtime.clean = new runtime.candidatePool!.OpfsSAHPoolDb(
            "/archive.sqlite3",
            "c",
          );
          runtime.copier = new CleanSnapshotCopy(runtime.raw, runtime.clean);
          return;
        }
        runtime.schema = new ArchiveSchemaValidator(
          runtime.candidateDb!,
          await approvedSchema(this.options.pool, `/schema-${id}.sqlite3`),
        );
      }
      if (runtime.copier) {
        if (!runtime.copier.step(Math.min(args.maxRecords, 128))) return;
        runtime.raw!.close();
        runtime.clean!.close();
        delete runtime.raw;
        delete runtime.clean;
        delete runtime.copier;
        runtime.candidatePool!.unlink("/rescue-raw.sqlite3");
        job.rescueCleaned = true;
        runtime.candidateDb = new runtime.candidatePool!.OpfsSAHPoolDb(
          "/archive.sqlite3",
          "r",
        );
        restrictRestoreConnection(this.options.sqlite, runtime.candidateDb);
        runtime.schema = new ArchiveSchemaValidator(
          runtime.candidateDb,
          await approvedSchema(this.options.pool, `/schema-${id}.sqlite3`),
        );
        return;
      }
      if (!runtime.schema!.step(args.maxRecords)) return;
      const expected = expectedLedger(),
        actual = sqlRows(
          runtime.candidateDb!,
          "SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version",
        );
      if (rescue) {
        // The summary a portable exporter would have declared, derived from
        // the cleaned candidate itself; the raw ledger was checked earlier.
        job.manifest!.source = {
          ...snapshotSummary(runtime.candidateDb!),
          migrations: expected,
        };
        job.status.totalRecords = job.manifest!.source.canonicalRecords;
      } else if (job.sourceSchemaVersion !== undefined) {
        // An upgraded portable keeps its declared canonical summary, which the
        // record validation still checks against the cleaned candidate; only
        // its schema facts now describe the candidate.
        job.manifest!.source = {
          ...job.manifest!.source,
          schemaVersion: expected.length,
          migrations: expected,
        };
      }
      if (
        json(actual) !== json(expected) ||
        json(job.manifest!.source.migrations) !== json(expected)
      )
        throw new Error("Archive migration history is unsupported.");
      if (runtime.candidateDb!.selectValue("PRAGMA integrity_check") !== "ok")
        throw new Error("Restored SQLite integrity check failed.");
      runtime.validator = new CanonicalArchiveValidator(
        runtime.candidateDb!,
        this.db,
        id,
        job.manifest!,
      );
      job.status.phase = "record_validation";
      return;
    }
    if (job.status.phase === "record_validation") {
      const status = runtime.validator!.step(args.maxRecords);
      job.status.completedRecords = status.checkedRecords;
      if (status.phase === "ready") {
        job.status.phase = "blob_validation";
        runtime.blobAfter = "";
      }
      return;
    }
    if (job.status.phase === "blob_validation") {
      let bytes = 0;
      while (bytes < args.maxBytes) {
        stopped(signal);
        if (!runtime.blob) {
          const next = runtime.validator!.blobChecks(
            runtime.blobAfter ?? "",
            1,
          )[0];
          if (!next) {
            await this.readyCandidate(job, runtime);
            return;
          }
          const dir = await (
            await candidate.getDirectoryHandle("blobs")
          ).getDirectoryHandle(next.sha256.slice(0, 2));
          const file = await openArchiveFile(dir, next.sha256);
          if (file.getSize() !== next.byteLength) {
            file.close();
            throw new Error("Restored blob length changed during validation.");
          }
          runtime.blob = {
            file,
            offset: 0,
            byteLength: next.byteLength,
            sha256: next.sha256,
            hash: sha256.create(),
            decoder: next.utf8
              ? new TextDecoder("utf-8", { fatal: true })
              : null,
          };
        }
        const blob = runtime.blob,
          count = Math.min(
            65536,
            blob.byteLength - blob.offset,
            args.maxBytes - bytes,
          ),
          chunk = readArchiveBytes(blob.file, blob.offset, count);
        blob.hash.update(chunk);
        blob.decoder?.decode(chunk, { stream: true });
        blob.offset += count;
        bytes += count;
        if (blob.offset === blob.byteLength) {
          blob.decoder?.decode();
          if (bytesToHex(blob.hash.digest()) !== blob.sha256)
            throw new Error("Restored blob hash changed during validation.");
          blob.file.close();
          runtime.blobAfter = blob.sha256;
          delete runtime.blob;
        }
      }
    }
  }
  /** The raw database's own ledger decides how it restores: equal to this
   * build's migrations, or a strict prefix from the upgrade floor that the
   * fresh-schema copy upgrades in the isolated candidate. A ledger beyond,
   * below the floor or differing from the build's history names its version
   * so the user can pick the right build. The manifest must agree with it. */
  private checkRawLedger(job: Metadata, raw: ArchiveDatabaseFile) {
    const expected = expectedLedger();
    const archive = job.manifest!.kind === "rescue" ? "Rescue archive" : "Archive";
    let actual: LedgerRow[];
    try {
      actual = sqlRows(
        raw,
        "SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version LIMIT 129",
      ).map((row) => ({
        version: Number(row.version),
        name: String(row.name),
        checksum: String(row.checksum),
      }));
    } catch {
      throw new Error(
        `${archive} has no readable migration ledger; it cannot be restored by this Quixi version.`,
      );
    }
    const declared =
      job.manifest!.kind === "rescue"
        ? (job.manifest!.recovery?.ledger ?? null)
        : job.manifest!.source.migrations;
    if (json(declared) !== json(actual))
      throw new Error(
        `${archive} manifest ledger differs from the database's own ledger.`,
      );
    const found = actual.length ? actual[actual.length - 1]!.version : 0;
    const relation = ledgerRelation(actual);
    if (relation === "other") {
      const at = actual.findIndex(
        (row, index) =>
          index >= expected.length || json(row) !== json(expected[index]),
      );
      const row = actual[at]!;
      if (at >= expected.length)
        throw new Error(
          `${archive} schema version ${found} is not supported by this Quixi version (schema ${expected.length}). Restore it with the Quixi version that last opened the archive.`,
        );
      throw new Error(
        `${archive} migration ${row.version} (${row.name}) differs from this Quixi version's migration history; it cannot be restored here.`,
      );
    }
    if (relation === "prefix" && found < RESTORE_UPGRADE_FLOOR)
      throw new Error(
        `${archive} schema version ${found} predates the earliest schema this Quixi version can upgrade (schema ${RESTORE_UPGRADE_FLOOR}). Restore it with the Quixi version that last opened the archive.`,
      );
    job.status.sourceSchemaVersion = found;
    if (relation === "prefix") job.sourceSchemaVersion = found;
  }
  private async readyCandidate(job: Metadata, runtime: Runtime) {
    if (job.manifest!.kind === "rescue") {
      // Drop received blob files no canonical record references; the
      // candidate then holds exactly what a portable export would carry.
      const extra = sqlRows(
        this.db,
        "SELECT path FROM quixi_archive_received_entries e WHERE job_id=? AND path GLOB 'blobs/*' AND NOT EXISTS (SELECT 1 FROM archive_validation_blobs b WHERE b.job_id=e.job_id AND 'blobs/'||b.sha256=e.path)",
        [job.status.jobId],
      );
      for (const row of extra) {
        const sha256 = String(row.path).slice(6);
        const bucket = await (
          await runtime.candidate!.getDirectoryHandle("blobs")
        ).getDirectoryHandle(sha256.slice(0, 2));
        await bucket.removeEntry(sha256);
      }
    }
    const summary = snapshotSummary(runtime.candidateDb!);
    if (
      summary.streamingGenerations !== job.manifest!.source.streamingGenerations
    )
      throw new Error("Manifest streaming-generation count differs.");
    const metadata = await openArchiveFile(runtime.candidate!, "manifest.json");
    let manifestSha256: string;
    try {
      manifestSha256 = bytesToHex(
        sha256(readArchiveBytes(metadata, 0, metadata.getSize())),
      );
    } finally {
      metadata.close();
    }
    const blobSummary = sqlRows(
      this.db,
      "SELECT count(*) AS count,coalesce(sum(byte_length),0) AS bytes FROM archive_validation_blobs WHERE job_id=?",
      [job.status.jobId],
    )[0]!;
    if (
      job.status.candidate &&
      job.status.candidate.manifestSha256 !== manifestSha256
    )
      throw new Error(
        "Candidate manifest changed since its original validation.",
      );
    job.status.candidate = {
      archiveId: job.candidateId!,
      schemaVersion: summary.schemaVersion,
      canonicalRecords: summary.canonicalRecords,
      syncOperations: summary.syncOperations,
      blobCount: Number(blobSummary.count),
      blobBytes: Number(blobSummary.bytes),
      streamingGenerations: summary.streamingGenerations,
      defaultWorkspaceId: summary.defaultWorkspaceId,
      manifestSha256,
    };
    const marker = await openArchiveFile(
        runtime.candidate!,
        "archive-ready.json",
        true,
      ),
      writer = new ArchiveFileWriter(marker);
    writer.write(
      new TextEncoder().encode(
        json({ jobId: job.status.jobId, candidate: job.status.candidate }),
      ),
    );
    writer.finish();
    writer.close();
    runtime.candidateDb!.close();
    delete runtime.candidateDb;
    runtime.candidatePool!.pauseVfs();
    delete runtime.candidatePool;
    runtime.freshReady = true;
    job.status.state = "ready";
    job.status.phase = "ready";
  }
  private async openExport(id: string, signal?: AbortSignal) {
    const job = this.job(id);
    if (
      job.status.kind !== "export" ||
      job.status.state !== "ready" ||
      !job.status.output
    )
      throw new BlobStorageError("CONFLICT", "Archive export is not ready.");
    const runtime = await this.loaded(job);
    if (!runtime.output) {
      runtime.output = await openArchiveFile(runtime.directory, "output.tar");
      const digest = sha256.create();
      try {
        for (
          let offset = 0;
          offset < runtime.output.getSize();
          offset += 65536
        ) {
          stopped(signal);
          digest.update(
            readArchiveBytes(
              runtime.output,
              offset,
              Math.min(65536, runtime.output.getSize() - offset),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (
          runtime.output.getSize() !== job.status.output.byteLength ||
          bytesToHex(digest.digest()) !== job.status.output.sha256
        )
          throw new Error("Stored export bytes changed; export again.");
      } catch (error) {
        runtime.output.close();
        delete runtime.output;
        throw error;
      } finally {
        digest.destroy();
      }
    }
    if (
      [...this.transfers.values()].some(
        (transfer) => transfer.jobId === id && transfer.kind === "output",
      )
    )
      throw new BlobStorageError(
        "OVERLOADED",
        "Finish or release the existing archive download first.",
      );
    const transferId = crypto.randomUUID();
    this.transfers.set(transferId, {
      jobId: id,
      kind: "output",
      window: new TransferWindow(transferId, 65536, 4),
      offset: 0,
      sequence: 0,
      final: false,
    });
    return {
      transferId,
      maxChunkBytes: 65536,
      maxInFlight: 4,
      byteLength: job.status.output.byteLength,
      sha256: job.status.output.sha256,
    };
  }
  readChunk(transferId: string): ByteChunk {
    this.check();
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.kind !== "output" || transfer.final)
      throw new BlobStorageError(
        "NOT_FOUND",
        "Archive output transfer is absent or ended.",
      );
    const file = this.runtime.get(transfer.jobId)!.output!,
      bytes = readArchiveBytes(
        file,
        transfer.offset,
        Math.min(65536, file.getSize() - transfer.offset),
      );
    const chunk = {
      transferId,
      sequence: transfer.sequence,
      offset: transfer.offset,
      bytes,
      final: transfer.offset + bytes.length === file.getSize(),
    };
    transfer.window.reserve(chunk);
    transfer.sequence++;
    transfer.offset += bytes.length;
    transfer.final = chunk.final;
    return chunk;
  }
  acknowledge(ack: ChunkAcknowledgement): void {
    const transfer = this.transfers.get(ack.transferId);
    if (!transfer || transfer.kind !== "output")
      throw new BlobStorageError(
        "NOT_FOUND",
        "Archive output transfer is absent.",
      );
    transfer.window.acknowledge(ack);
    if (transfer.window.complete) this.transfers.delete(ack.transferId);
  }
  private review(
    args: ArchivesOperations["prepareArchiveActivation"]["args"],
  ): ArchiveActivationReview {
    const job = this.job(args.jobId);
    if (
      job.status.kind !== "restore" ||
      job.status.state !== "ready" ||
      !job.status.candidate
    )
      throw new BlobStorageError(
        "CONFLICT",
        "Restore candidate is not ready for review.",
      );
    if (!this.runtime.get(args.jobId)?.freshReady)
      throw new BlobStorageError(
        "CONFLICT",
        "Advance this restore job to revalidate it under the current storage owner.",
      );
    if (
      args.expectedActiveArchiveId !== this.options.archiveId ||
      args.expectedRevision !==
        Number(
          this.db.selectValue(
            "SELECT coalesce(max(sequence),0) FROM quixi_sync_ops",
          ),
        )
    )
      throw new BlobStorageError(
        "CONFLICT",
        "Active archive changed; refresh the replacement review.",
      );
    return {
      token: crypto.randomUUID(),
      jobId: args.jobId,
      candidate: job.status.candidate,
      expectedActiveArchiveId: args.expectedActiveArchiveId,
      expectedRevision: args.expectedRevision,
    };
  }
  /** Final activation barrier. The caller serializes this with foreground
   * source operations and commits only its profile-selection pointer in callback.
   * The target owner lock is held throughout fresh validation and pointer commit. */
  async withActivationReview<T>(
    review: ArchiveActivationReview,
    signal: AbortSignal,
    callback: () => Promise<T>,
  ): Promise<T> {
    this.check();
    stopped(signal);
    const persisted = sqlRows(
      this.db,
      "SELECT result FROM quixi_archive_operations WHERE json_type(result,'$.token')='text' AND json_extract(result,'$.token')=? LIMIT 1",
      [review.token],
    )[0];
    if (
      !persisted ||
      json(JSON.parse(String(persisted.result))) !== json(review)
    )
      throw new BlobStorageError(
        "CONFLICT",
        "Activation review token does not match its durable review.",
      );
    const job = this.job(review.jobId);
    if (
      job.status.kind !== "restore" ||
      job.status.state !== "ready" ||
      !job.status.candidate ||
      json(job.status.candidate) !== json(review.candidate) ||
      review.candidate.archiveId === this.options.archiveId
    )
      throw new BlobStorageError(
        "CONFLICT",
        "Activation candidate is no longer the reviewed ready archive.",
      );
    const fence = () => {
      stopped(signal);
      if (
        review.expectedActiveArchiveId !== this.options.archiveId ||
        review.expectedRevision !==
          Number(
            this.db.selectValue(
              "SELECT coalesce(max(sequence),0) FROM quixi_sync_ops",
            ),
          )
      )
        throw new BlobStorageError(
          "CONFLICT",
          "Active history changed after replacement review.",
        );
    };
    fence();
    return navigator.locks.request(
      `quixi:archive:${review.candidate.archiveId}:owner`,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new BlobStorageError(
            "CONFLICT",
            "Close contexts already using this candidate before replacing the active archive.",
          );
        await this.closeRuntime(review.jobId);
        let status = await this.advance(
          {
            operationId: crypto.randomUUID(),
            jobId: review.jobId,
            maxRecords: 128,
            maxBytes: 1048576,
          },
          signal,
        );
        while (status.state === "working") {
          await new Promise((resolve) => setTimeout(resolve, 0));
          status = await this.advance(
            {
              operationId: crypto.randomUUID(),
              jobId: review.jobId,
              maxRecords: 128,
              maxBytes: 1048576,
            },
            signal,
          );
        }
        if (
          status.state !== "ready" ||
          json(status.candidate) !== json(review.candidate)
        )
          throw new BlobStorageError(
            "CONFLICT",
            "Fresh activation validation differs from the reviewed candidate.",
          );
        fence();
        return callback();
      },
    );
  }
  private async closeRuntime(id: string) {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    this.runtime.delete(id);
    const cleanup = [
      () => runtime.iterator?.return(undefined),
      () => runtime.receiver?.close(),
      () => runtime.inventory?.close(),
      () => runtime.blob?.file.close(),
      () => runtime.blob?.hash.destroy(),
      () => runtime.writer?.close(),
      () => !runtime.writer && runtime.output?.close(),
      () => runtime.databaseRead?.reader.close(),
      () => runtime.databaseRead?.hash.destroy(),
      () => runtime.raw?.close(),
      () => runtime.clean?.close(),
      () => runtime.candidateDb?.close(),
      () => runtime.candidatePool?.pauseVfs(),
    ];
    let failure: unknown;
    for (const action of cleanup) {
      try {
        await action();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  private clearValidation(id: string) {
    for (const table of [
      "nodes",
      "stack",
      "coverage",
      "blobs",
      "parts",
      "tombstones",
      "imports",
    ]) {
      const name = "archive_validation_" + table;
      if (
        this.db.selectValue(
          "SELECT 1 FROM sqlite_temp_schema WHERE type='table' AND name=?",
          [name],
        )
      )
        this.db.exec({ sql: `DELETE FROM ${name} WHERE job_id=?`, bind: [id] });
    }
  }
  private async fail(job: Metadata, error: unknown) {
    try {
      await this.closeRuntime(job.status.jobId);
    } catch {
      /* Keep original failure; every handle cleanup was attempted. */
    }
    for (const [id, transfer] of this.transfers)
      if (transfer.jobId === job.status.jobId) this.transfers.delete(id);
    job.status.state =
      (error as { code?: string })?.code === "CANCELLED"
        ? "cancelled"
        : "failed";
    job.status.failure = {
      code: String((error as { code?: string })?.code ?? "IO_ERROR"),
      reason: String(error).slice(0, 1024),
    };
    this.save(job);
  }
  private async release(id: string, cancel: boolean) {
    const job = this.job(id);
    await this.closeRuntime(id);
    for (const [transferId, transfer] of this.transfers)
      if (transfer.jobId === id) this.transfers.delete(transferId);
    this.options.pool.unlink(`/export-${id}.sqlite3`);
    this.options.pool.unlink(`/clean-${id}.sqlite3`);
    this.options.pool.unlink(`/schema-${id}.sqlite3`);
    const temp = await this.options.quixiDirectory.getDirectoryHandle("temp", {
        create: true,
      }),
      archives = await temp.getDirectoryHandle("archives", { create: true });
    try {
      await archives.removeEntry(id, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError"))
        throw error;
    }
    // A ready namespace may already be selected by another context. Only the
    // root activation/catalog workflow may delete a validated candidate.
    if (job.candidateId && !job.status.candidate) {
      try {
        await this.options.opfsRoot.removeEntry(`quixi-${job.candidateId}`, {
          recursive: true,
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError"))
          throw error;
      }
    }
    this.db.exec({
      sql: "DELETE FROM quixi_archive_received_entries WHERE job_id=?",
      bind: [id],
    });
    this.clearValidation(id);
    job.status.state = cancel ? "cancelled" : "released";
    job.status.phase = "cleanup";
    this.save(job);
    return job.status;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    for (const id of [...this.runtime.keys()]) await this.closeRuntime(id);
    this.transfers.clear();
    this.closed = true;
  }
}

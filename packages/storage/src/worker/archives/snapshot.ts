import { CanonicalRepository } from "../canonical/repository.ts";
import type { CanonicalSqlite, SqlValue } from "../canonical/repository.ts";
import type { FileDatabase, FileSqlite } from "./sqlite-file.ts";
import { openSqliteFileReader, openSqliteFileWriter, withSqliteFileReader } from "./sqlite-file.ts";
import type { BoundedSqliteWriter } from "./sqlite-file.ts";
export interface ArchiveDatabaseFile extends FileDatabase {
  close(): void;
}
export interface ArchivePool {
  OpfsSAHPoolDb: new (name: string, flags?: string) => ArchiveDatabaseFile;
  importDb(
    name: string,
    read: () => Promise<Uint8Array | undefined>,
  ): Promise<number>;
  unlink(name: string): boolean;
  reserveMinimumCapacity(minimum: number): Promise<number>;
  pauseVfs(): void;
  unpauseVfs(): Promise<unknown>;
}
export interface ArchiveSqlite extends FileSqlite {
  installOpfsSAHPoolVfs(options: {
    name: string;
    directory: string;
    initialCapacity: number;
  }): Promise<ArchivePool>;
}
export const sqlRows = (
  db: CanonicalSqlite,
  sql: string,
  bind: SqlValue[] = [],
) =>
  db.exec({
    sql,
    ...(bind.length ? { bind } : {}),
    rowMode: "object",
    returnValue: "resultRows",
  }) as Record<string, SqlValue>[];
export interface SnapshotSummary {
  schemaVersion: number;
  canonicalRecords: number;
  syncOperations: number;
  highWaterSequence: number;
  streamingGenerations: number;
  defaultWorkspaceId: string | null;
}
export function snapshotSummary(db: CanonicalSqlite): SnapshotSummary {
  const workspace = sqlRows(
    db,
    "SELECT value FROM quixi_local_state WHERE key='defaultWorkspaceId'",
  )[0];
  return {
    schemaVersion: Number(
      db.selectValue("SELECT max(version) FROM quixi_schema_migrations"),
    ),
    canonicalRecords: Number(
      db.selectValue("SELECT count(*) FROM quixi_records"),
    ),
    syncOperations: Number(
      db.selectValue("SELECT count(*) FROM quixi_sync_ops"),
    ),
    highWaterSequence: Number(
      db.selectValue("SELECT coalesce(max(sequence),0) FROM quixi_sync_ops"),
    ),
    streamingGenerations: Number(
      db.selectValue(
        "SELECT count(*) FROM quixi_records WHERE collection='generations' AND json_extract(payload,'$.status')='streaming'",
      ),
    ),
    defaultWorkspaceId: workspace ? JSON.parse(String(workspace.value)) : null,
  };
}
export async function copySnapshot(
  sqlite: ArchiveSqlite,
  pool: ArchivePool,
  source: ArchiveDatabaseFile,
  name: string,
  signal?: AbortSignal,
): Promise<ArchiveDatabaseFile> {
  const copier = new SnapshotCopier(sqlite, pool, source, name, signal);
  try {
    for (;;) {
      const db = await copier.advance(Number.MAX_SAFE_INTEGER);
      if (db) return db;
    }
  } catch (error) {
    copier.close();
    throw error;
  }
}
/** Any bounded byte source a pool file can be copied from. */
export interface BoundedByteSource {
  readonly byteLength: number;
  read(offset: number, maxBytes: number): Uint8Array;
  close(): void;
}
/** A pool database file filled from a byte source in bounded steps (ADR 0010
 * amendment, 2026-09-13). The first step opens the target as a pool database
 * (already associated with its name, so no other file open can take its
 * handle between steps) and the source; each `advance(maxBytes)` copies up to
 * that many bytes in 64 KiB blocks through the VFS and, once the whole file
 * is copied, closes both and returns `finish()`. `close` releases the source
 * and unlinks the incomplete private output. */
export class BoundedFileCopier<T> {
  copiedBytes = 0;
  totalBytes: number | null = null;
  private source: BoundedByteSource | null = null;
  private writer: BoundedSqliteWriter | null = null;
  private target: ArchiveDatabaseFile | null = null;
  private result: { value: T } | null = null;
  private opened = false;
  private closed = false;
  constructor(
    private readonly sqlite: ArchiveSqlite,
    private readonly pool: ArchivePool,
    private readonly name: string,
    private readonly openSource: () => Promise<BoundedByteSource> | BoundedByteSource,
    private readonly finish: () => T,
  ) {}
  private async start(): Promise<void> {
    await this.pool.reserveMinimumCapacity(10);
    if (this.closed) throw new Error("Bounded copy is closed.");
    try {
      this.opened = true; // an open attempt may leave the pool file behind; close unlinks it
      this.target = new this.pool.OpfsSAHPoolDb(this.name);
      this.writer = openSqliteFileWriter(this.sqlite, this.target);
      this.writer.truncate(0);
      this.source = await this.openSource();
      this.totalBytes = this.source.byteLength;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  /** Copies up to `maxBytes` more; `finish()`'s value once complete, else null. */
  async advance(maxBytes: number): Promise<T | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid copy step budget.");
    if (this.result) return this.result.value;
    if (this.closed) throw new Error("Bounded copy is closed.");
    if (!this.source) await this.start();
    try {
      const source = this.source!, writer = this.writer!;
      let budget = maxBytes;
      while (budget > 0 && this.copiedBytes < source.byteLength) {
        const bytes = source.read(this.copiedBytes, Math.min(65536, budget));
        if (!bytes.length) throw new Error("Bounded copy source returned no bytes.");
        writer.write(this.copiedBytes, bytes);
        this.copiedBytes += bytes.length;
        budget -= bytes.length;
      }
      if (this.copiedBytes < source.byteLength) return null;
      source.close();
      writer.close();
      this.target!.close();
      this.source = null; this.writer = null; this.target = null;
      this.result = { value: this.finish() };
      return this.result.value;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  /** Releases the source and the target; an incomplete copy's private output is unlinked. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const release of [() => this.source?.close(), () => this.writer?.close(), () => this.target?.close()]) {
      try { release(); } catch { /* every handle is attempted */ }
    }
    this.source = null; this.writer = null; this.target = null;
    if (this.opened && !this.result) this.pool.unlink(this.name);
  }
}
/** The export's source snapshot: the live database read under one read
 * transaction held across steps, landing as a pool database that is opened
 * once the copy completes. */
export class SnapshotCopier extends BoundedFileCopier<ArchiveDatabaseFile> {
  constructor(sqlite: ArchiveSqlite, pool: ArchivePool, source: ArchiveDatabaseFile, name: string, signal?: AbortSignal) {
    if (!/^\/export-[a-f0-9-]{36}\.sqlite3$/.test(name)) throw new Error("Invalid snapshot identity.");
    super(sqlite, pool, name, () => openSqliteFileReader(sqlite, source, signal), () => {
      const db = new pool.OpfsSAHPoolDb(name);
      db.exec("PRAGMA temp_store=FILE; PRAGMA foreign_keys=ON;");
      return db;
    });
  }
}
export async function* databaseChunks(
  sqlite: FileSqlite,
  db: ArchiveDatabaseFile,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = openSqliteFileReader(sqlite, db, signal);
  try {
    for (let offset = 0; offset < reader.byteLength; offset += 65536)
      yield reader.read(offset, 65536);
  } finally {
    reader.close();
  }
}
export interface ApprovedSchemaObject {
  type: string;
  name: string;
  table: string;
  sql: string | null;
}
export async function approvedSchema(
  pool: ArchivePool,
  name: string,
): Promise<ApprovedSchemaObject[]> {
  const db = new pool.OpfsSAHPoolDb(name);
  try {
    new CanonicalRepository(db, {
      assertBlobAvailable() {
        throw new Error("Empty schema validation cannot reference blobs.");
      },
    }).migrate();
    return sqlRows(
      db,
      "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
    ).map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: row.sql === null ? null : String(row.sql),
    }));
  } finally {
    db.close();
    pool.unlink(name);
  }
}

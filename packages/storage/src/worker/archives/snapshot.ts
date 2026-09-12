import { CanonicalRepository } from "../canonical/repository.ts";
import type { CanonicalSqlite, SqlValue } from "../canonical/repository.ts";
import type { FileDatabase, FileSqlite } from "./sqlite-file.ts";
import { openSqliteFileReader, withSqliteFileReader } from "./sqlite-file.ts";
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
  if (!/^\/export-[a-f0-9-]{36}\.sqlite3$/.test(name))
    throw new Error("Invalid snapshot identity.");
  await pool.reserveMinimumCapacity(10);
  try {
    await withSqliteFileReader(
      sqlite,
      source,
      async (reader) => {
        let offset = 0;
        await pool.importDb(name, async () => {
          if (offset === reader.byteLength) return undefined;
          const bytes = reader.read(offset, 65536);
          offset += bytes.length;
          await new Promise((resolve) => setTimeout(resolve, 0));
          return bytes;
        });
      },
      signal,
    );
    const db = new pool.OpfsSAHPoolDb(name);
    db.exec("PRAGMA temp_store=FILE; PRAGMA foreign_keys=ON;");
    return db;
  } catch (error) {
    pool.unlink(name);
    throw error;
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

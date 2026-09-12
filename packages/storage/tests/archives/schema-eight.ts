import { canonicalJson } from "@quixi/core/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CANONICAL_MIGRATIONS } from "../../migrations/index.ts";
import { RESTORE_UPGRADE_FLOOR } from "../../src/worker/archives/index.ts";
import type { ArchiveRepository } from "../../src/worker/archives/index.ts";
import type {
  ArchiveDatabaseFile,
  ArchivePool,
  ArchiveSqlite,
} from "../../src/worker/archives/snapshot.ts";
import { sqlRows } from "../../src/worker/archives/snapshot.ts";
import { exportArchive } from "../../src/worker/archives/export.ts";
import {
  openArchiveFile,
  ArchiveFileWriter,
  archiveFileChunks,
} from "../../src/worker/archives/files.ts";
import type { SearchBlobAccess } from "../../src/worker/search/index.ts";

/** Copy a table's stored columns row by row; generated columns are hidden in
 * table_xinfo and recomputed by the target. Table shapes have not changed
 * since schema 8, so the same statement fits both databases. */
function copyRows(
  source: ArchiveDatabaseFile,
  target: ArchiveDatabaseFile,
  table: string,
  filter = "",
  override: (row: Record<string, unknown>) => void = () => {},
): number {
  const columns = sqlRows(source, `PRAGMA table_xinfo(${table})`)
    .filter((column) => column.hidden === 0)
    .map((column) => String(column.name));
  const rows = sqlRows(
    source,
    `SELECT ${columns.join(",")} FROM ${table}${filter} ORDER BY rowid`,
  );
  for (const row of rows) {
    override(row);
    target.exec({
      sql: `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      bind: columns.map((column) => row[column]!),
    });
  }
  return rows.length;
}

/** Construct a genuine schema-8 portable: a database whose objects and ledger
 * are exactly what immutable migrations 1–8 produce, holding the live
 * archive's canonical records, journal and referenced catalog rows, exported
 * with the production portable writer. The current restore must upgrade it in
 * the isolated candidate and reach a ready state; the caller then verifies the
 * candidate's rows against the source. */
export async function acceptSchemaEight(context: {
  sqlite: ArchiveSqlite;
  pool: ArchivePool;
  source: ArchiveDatabaseFile;
  files: FileSystemDirectoryHandle;
  blobs: SearchBlobAccess;
  jobs: ArchiveRepository;
}) {
  const id = () => crypto.randomUUID(),
    name = "/schema-eight-" + id() + ".sqlite3",
    database = new context.pool.OpfsSAHPoolDb(name),
    files = await context.files.getDirectoryHandle("schema-eight", {
      create: true,
    });
  let output: ArchiveFileWriter | undefined;
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS quixi_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL) STRICT",
    );
    for (const migration of CANONICAL_MIGRATIONS.filter(
      (item) => item.version <= RESTORE_UPGRADE_FLOOR,
    )) {
      database.exec(migration.sql);
      database.exec({
        sql: "INSERT INTO quixi_schema_migrations VALUES(?,?,?)",
        bind: [
          migration.version,
          migration.name,
          bytesToHex(
            sha256(new TextEncoder().encode(canonicalJson(migration.sql))),
          ),
        ],
      });
    }
    if (
      database.selectValue(
        "SELECT max(version) FROM quixi_schema_migrations",
      ) !== RESTORE_UPGRADE_FLOOR
    )
      throw new Error("Historical fixture is not schema 8.");
    const records = copyRows(context.source, database, "quixi_records");
    copyRows(context.source, database, "quixi_edges");
    const operations = copyRows(context.source, database, "quixi_sync_ops");
    copyRows(context.source, database, "quixi_transactions");
    copyRows(
      context.source,
      database,
      "quixi_local_state",
      " WHERE key='defaultWorkspaceId'",
    );
    copyRows(context.source, database, "quixi_import_jobs", " WHERE state='published'");
    for (const table of ["quixi_import_record_identities", "quixi_import_operations"])
      copyRows(
        context.source,
        database,
        table,
        " WHERE import_id IN(SELECT id FROM quixi_import_jobs WHERE state='published')",
      );
    // Referenced blobs, as a portable export carries them: catalog rows for
    // every canonical reference, unverified until the restoring owner checks
    // the bytes, plus the exporter's temporary reference table.
    database.exec(
      "CREATE TEMP TABLE archive_blob_refs(sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,utf8 INTEGER NOT NULL) STRICT",
    );
    for (const row of sqlRows(
      context.source,
      "SELECT collection,payload FROM quixi_records WHERE collection IN('attachments','rawObjects','parts')",
    )) {
      const value = JSON.parse(String(row.payload)) as Record<string, unknown>;
      let reference: [string, number, number] | null = null;
      if (row.collection === "attachments" && value.availability === "available")
        reference = [String(value.blobSha256), Number(value.sizeBytes), 0];
      else if (row.collection === "rawObjects" && value.availability === "available")
        reference = [String(value.sha256), Number(value.byteLength), 0];
      else if (row.collection === "parts") {
        const data = value.data as { textBlob?: { sha256: string; byteLength: number } } | undefined;
        if ((value.kind === "Text" || value.kind === "Note") && data?.textBlob)
          reference = [data.textBlob.sha256, data.textBlob.byteLength, 1];
      }
      if (reference)
        database.exec({
          sql: "INSERT INTO archive_blob_refs VALUES(?,?,?) ON CONFLICT(sha256) DO UPDATE SET utf8=max(utf8,excluded.utf8)",
          bind: reference,
        });
    }
    for (const reference of sqlRows(database, "SELECT sha256 FROM archive_blob_refs"))
      copyRows(
        context.source,
        database,
        "quixi_blob_catalog",
        ` WHERE sha256='${String(reference.sha256).replace(/[^0-9a-f]/g, "")}'`,
        (row) => {
          row.availability = "unverified";
          row.verification_epoch = "";
        },
      );
    const file = await openArchiveFile(files, "schema-eight.tar", true);
    output = new ArchiveFileWriter(file);
    for await (const tick of exportArchive({
      sqlite: context.sqlite,
      snapshot: database,
      files,
      blobs: context.blobs,
      format: "portable",
    }))
      if (tick.bytes) output.write(tick.bytes);
    const digest = output.finish();
    const restore = await context.jobs.request("beginArchiveRestore", {
      operationId: id(),
      expectedBytes: digest.byteLength,
      expectedSha256: digest.sha256,
    });
    const jobId = restore.job.jobId;
    let sequence = 0,
      offset = 0;
    for await (const bytes of archiveFileChunks(file)) {
      await context.jobs.append({
        transferId: restore.inputTransfer.transferId,
        sequence: sequence++,
        offset,
        bytes,
        final: offset + bytes.length === digest.byteLength,
      });
      offset += bytes.length;
    }
    let status = await context.jobs.request("finishArchiveRestore", {
      operationId: id(),
      jobId,
      byteLength: digest.byteLength,
      sha256: digest.sha256,
    });
    for (let step = 0; step < 4096 && status.state === "working"; step++)
      status = await context.jobs.request("advanceArchiveJob", {
        operationId: id(),
        jobId,
        maxRecords: 8,
        maxBytes: 65536,
      });
    if (status.state !== "ready" || !status.candidate)
      throw new Error(
        `Schema-8 portable did not restore through the candidate upgrade: ${JSON.stringify(status)}`,
      );
    if (status.sourceSchemaVersion !== RESTORE_UPGRADE_FLOOR)
      throw new Error("Upgraded restore did not report its received schema.");
    if (status.candidate.schemaVersion !== CANONICAL_MIGRATIONS.at(-1)!.version)
      throw new Error("Upgraded candidate is not at this build's schema.");
    if (
      status.candidate.canonicalRecords !== records ||
      status.candidate.syncOperations !== operations
    )
      throw new Error("Upgraded candidate summary differs from the copied rows.");
    return {
      jobId,
      candidateId: status.candidate.archiveId,
      sourceSchemaVersion: RESTORE_UPGRADE_FLOOR,
      targetSchemaVersion: status.candidate.schemaVersion,
      canonicalRecords: records,
      syncOperations: operations,
      archiveBytes: digest.byteLength,
      candidateReady: true,
    };
  } finally {
    output?.close();
    database.close();
    context.pool.unlink(name);
  }
}

import { canonicalJson } from "@quixi/core/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CANONICAL_MIGRATIONS } from "../../migrations/index.ts";
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

/** Construct a genuine schema-7 portable using the immutable historical SQL,
 * then send its complete verified TAR bytes through the current restore job. */
export async function rejectSchemaSeven(context: {
  sqlite: ArchiveSqlite;
  pool: ArchivePool;
  source: ArchiveDatabaseFile;
  files: FileSystemDirectoryHandle;
  blobs: SearchBlobAccess;
  jobs: ArchiveRepository;
  currentSchemaObjectCount: number;
}) {
  const id = () => crypto.randomUUID(),
    name = "/schema-seven-" + id() + ".sqlite3",
    database = new context.pool.OpfsSAHPoolDb(name),
    files = await context.files.getDirectoryHandle("schema-seven", {
      create: true,
    });
  const signature = () =>
      JSON.stringify([
        sqlRows(
          context.source,
          "SELECT collection,id,payload FROM quixi_records ORDER BY collection,id",
        ),
        sqlRows(
          context.source,
          "SELECT * FROM quixi_sync_ops ORDER BY sequence",
        ),
      ]),
    before = signature();
  let output: ArchiveFileWriter | undefined, jobId: string | undefined;
  try {
    database.exec(
      "CREATE TABLE quixi_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL) STRICT",
    );
    for (const migration of CANONICAL_MIGRATIONS.filter(
      (item) => item.version <= 7,
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
      ) !== 7
    )
      throw new Error("Historical fixture is not schema 7.");
    const historicalSchemaObjectCount = Number(
      database.selectValue("SELECT count(*) FROM sqlite_schema"),
    );
    database.exec(
      "CREATE TEMP TABLE archive_blob_refs(sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL) STRICT",
    );
    const file = await openArchiveFile(files, "schema-seven.tar", true);
    output = new ArchiveFileWriter(file);
    for await (const tick of exportArchive({
      sqlite: context.sqlite,
      snapshot: database,
      files,
      blobs: context.blobs,
      format: "portable",
    }))
      if (tick.bytes) output.write(tick.bytes);
    const digest = output.finish(),
      restore = await context.jobs.request("beginArchiveRestore", {
        operationId: id(),
        expectedBytes: digest.byteLength,
        expectedSha256: digest.sha256,
      });
    jobId = restore.job.jobId;
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
    await context.jobs.request("finishArchiveRestore", {
      operationId: id(),
      jobId,
      byteLength: digest.byteLength,
      sha256: digest.sha256,
    });
    let reason: string | null = null;
    try {
      for (let step = 0; step < 256; step++) {
        const status = await context.jobs.request("advanceArchiveJob", {
          operationId: id(),
          jobId,
          maxRecords: 8,
          maxBytes: 65536,
        });
        if (status.state === "ready")
          throw new Error(
            "Schema-7 portable was silently accepted by the current build.",
          );
      }
      throw new Error("Schema-7 restore did not reach compatibility decision.");
    } catch (error) {
      reason = String(error);
      // Since the candidate upgrade floor (schema 8), a schema-7 ledger is
      // refused by name from the raw database before any schema object
      // comparison; no candidate is cleaned or validated.
      if (
        !/Archive schema version 7 predates the earliest schema this Quixi version can upgrade \(schema 8\)/.test(
          reason,
        )
      )
        throw new Error(
          `Schema-7 negative-fixture rejection matcher failed: ${reason}; status=${JSON.stringify(await context.jobs.request("archiveJobStatus", { jobId }))}`,
        );
    }
    const status = await context.jobs.request("archiveJobStatus", { jobId });
    if (
      status.state !== "failed" ||
      status.phase !== "schema_validation" ||
      status.candidate !== null
    )
      throw new Error("Unsupported archive produced an activation candidate.");
    if (signature() !== before)
      throw new Error("Unsupported portable altered active canonical history.");
    return {
      sourceSchemaVersion: 7,
      targetSchemaVersion: CANONICAL_MIGRATIONS.at(-1)!.version,
      historicalSchemaObjectCount,
      currentSchemaObjectCount: context.currentSchemaObjectCount,
      rejectionKind: "schema_floor",
      archiveBytes: digest.byteLength,
      rejectedAt: status.phase,
      reason,
      activeHistoryUnchanged: true,
      candidateReady: false,
    };
  } finally {
    output?.close();
    database.close();
    context.pool.unlink(name);
    if (jobId)
      await context.jobs.request("releaseArchiveJob", {
        operationId: id(),
        jobId,
      });
  }
}

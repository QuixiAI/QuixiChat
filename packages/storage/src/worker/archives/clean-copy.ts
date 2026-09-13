import { CanonicalRepository } from "../canonical/repository.ts";
import { jsonByteLength } from "@quixi/core/contracts";
import type { CanonicalHistory } from "@quixi/core/model";
import type { CanonicalSqlite, SqlValue } from "../canonical/repository.ts";
import { sqlRows } from "./snapshot.ts";
/** Fresh output has no freelist containing excluded staging or derived bytes.
 * This is logical copying of the captured SQLite snapshot, not an active-data
 * migration. All original canonical IDs, payloads and journal identities survive.
 */
const copyTables = [
  "quixi_records",
  "quixi_edges",
  "quixi_sync_ops",
  "quixi_transactions",
  "quixi_import_jobs",
  "quixi_import_record_identities",
  "quixi_import_operations",
  "quixi_blob_catalog",
  "quixi_local_state",
] as const;
export class CleanSnapshotCopy {
  private tableIndex = 0;
  private after = 0;
  private columns: string[] = [];
  private complete = false;
  copiedRows = 0;
  constructor(
    private readonly source: CanonicalSqlite,
    private readonly output: CanonicalSqlite,
  ) {
    new CanonicalRepository(output, {
      assertBlobAvailable() {
        throw new Error("Schema creation cannot reference bytes.");
      },
    }).migrate();
    output.exec(
      "CREATE TEMP TABLE archive_blob_refs(sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,utf8 INTEGER NOT NULL) STRICT;",
    );
  }
  private reference(sha256: string, byteLength: number, utf8: boolean) {
    const previous = sqlRows(
      this.output,
      "SELECT byte_length,utf8 FROM archive_blob_refs WHERE sha256=?",
      [sha256],
    )[0];
    if (previous && previous.byte_length !== byteLength)
      throw new Error("Canonical references disagree about a blob length.");
    this.output.exec({
      sql: "INSERT INTO archive_blob_refs VALUES(?,?,?) ON CONFLICT(sha256) DO UPDATE SET utf8=max(utf8,excluded.utf8)",
      bind: [sha256, byteLength, utf8 ? 1 : 0],
    });
  }
  private references(collection: string, payload: string) {
    if (collection === "attachments") {
      const value = JSON.parse(
        payload,
      ) as CanonicalHistory["attachments"][number];
      if (value.availability === "available")
        this.reference(value.blobSha256!, value.sizeBytes!, false);
    } else if (collection === "rawObjects") {
      const value = JSON.parse(
        payload,
      ) as CanonicalHistory["rawObjects"][number];
      if (value.availability === "available")
        this.reference(value.sha256!, value.byteLength!, false);
    } else if (collection === "parts") {
      const value = JSON.parse(payload) as CanonicalHistory["parts"][number];
      if (
        (value.kind === "Text" || value.kind === "Note") &&
        value.data.textBlob
      )
        this.reference(
          value.data.textBlob.sha256,
          value.data.textBlob.byteLength,
          true,
        );
    }
  }
  /** One row is an atomic metadata unit, bounded by the existing canonical/
   * control contracts. maxRows bounds SQL work units, not individual query time. */
  step(maxRows: number): boolean {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 128)
      throw new Error("Invalid snapshot row budget.");
    if (this.complete) return true;
    // One transaction per step: autocommitting each copied row cost a journal
    // write and sync per row, which dominated the export at a million messages.
    this.output.exec("BEGIN");
    try {
      const done = this.copy(maxRows);
      this.output.exec("COMMIT");
      return done;
    } catch (error) {
      try { this.output.exec("ROLLBACK"); } catch { /* the failed step's rows are discarded either way */ }
      throw error;
    }
  }
  private copy(maxRows: number): boolean {
    for (let work = 0; work < maxRows; work++) {
      const table = copyTables[this.tableIndex];
      if (!table) {
        const missing = sqlRows(
          this.output,
          "SELECT r.sha256 FROM archive_blob_refs r LEFT JOIN quixi_blob_catalog b ON b.sha256=r.sha256 WHERE b.sha256 IS NULL LIMIT 1",
        );
        if (missing.length)
          throw new Error(
            "Canonical snapshot references a missing blob catalog entry.",
          );
        const sequence = sqlRows(
          this.source,
          "SELECT seq FROM sqlite_sequence WHERE name='quixi_sync_ops'",
        )[0];
        if (sequence)
          this.output.exec({
            sql: "UPDATE sqlite_sequence SET seq=? WHERE name='quixi_sync_ops'",
            bind: [sequence.seq!],
          });
        this.complete = true;
        return true;
      }
      if (!this.columns.length)
        this.columns = sqlRows(this.source, `PRAGMA table_xinfo(${table})`)
          .filter((column) => column.hidden === 0)
          .map((column) => String(column.name));
      if (this.columns.some((column) => !/^[_a-z0-9]+$/.test(column)))
        throw new Error("Unsupported snapshot column.");
      const filter =
        table === "quixi_local_state"
          ? " AND key='defaultWorkspaceId'"
          : table === "quixi_import_jobs"
            ? " AND state='published'"
            : table === "quixi_import_record_identities" ||
                table === "quixi_import_operations"
              ? " AND import_id IN(SELECT id FROM quixi_import_jobs WHERE state='published')"
              : "";
      // One ordered statement for the step's remaining row budget, not one per row: at a
      // million messages the per-row form cost more than the copying itself.
      const rows = sqlRows(
        this.source,
        `SELECT rowid AS archive_rowid,${this.columns.join(",")} FROM ${table} WHERE rowid>?${filter} ORDER BY rowid LIMIT ?`,
        [this.after, maxRows - work],
      );
      if (!rows.length) {
        this.tableIndex++;
        this.after = 0;
        this.columns = [];
        continue;
      }
      const insert = `INSERT INTO ${table}(${this.columns.join(",")}) VALUES(${this.columns.map(() => "?").join(",")})`;
      for (const row of rows) {
        jsonByteLength(row, 4_194_304);
        this.after = Number(row.archive_rowid);
        if (table === "quixi_blob_catalog") {
          const reference = sqlRows(
            this.output,
            "SELECT byte_length,utf8 FROM archive_blob_refs WHERE sha256=?",
            [row.sha256!],
          )[0];
          if (!reference) continue;
          if (reference.byte_length !== row.byte_length)
            throw new Error("Canonical blob length differs from catalog.");
          row.availability = "unverified";
          row.verification_epoch = "";
        }
        this.output.exec({ sql: insert, bind: this.columns.map((column) => row[column]!) });
        if (table === "quixi_records")
          this.references(String(row.collection), String(row.payload));
        this.copiedRows++;
      }
      work += rows.length - 1;
    }
    return false;
  }
  get done(): boolean {
    return this.complete;
  }
}

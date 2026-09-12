import type { ArchiveDatabaseFile, ApprovedSchemaObject } from "./snapshot.ts";
import { sqlRows } from "./snapshot.ts";
import type { FileSqlite } from "./sqlite-file.ts";
/** Configure before querying any application table. The pinned SQLite parser is
 * still a dependency; never execute SQL text taken from the archive itself. */
export function restrictRestoreConnection(
  sqlite: FileSqlite,
  db: ArchiveDatabaseFile,
): void {
  const capi = sqlite.capi as FileSqlite["capi"] & {
    sqlite3_limit(db: number, category: number, value: number): number;
    SQLITE_LIMIT_LENGTH: number;
    SQLITE_LIMIT_SQL_LENGTH: number;
    SQLITE_LIMIT_COLUMN: number;
    SQLITE_LIMIT_EXPR_DEPTH: number;
    sqlite3_db_config(
      db: number,
      option: number,
      value: number,
      output: number,
    ): number;
    SQLITE_DBCONFIG_DEFENSIVE: number;
    SQLITE_DBCONFIG_TRUSTED_SCHEMA: number;
    SQLITE_DBCONFIG_ENABLE_TRIGGER: number;
  };
  for (const [category, value] of [
    [capi.SQLITE_LIMIT_LENGTH, 4_194_304],
    [capi.SQLITE_LIMIT_SQL_LENGTH, 1_048_576],
    [capi.SQLITE_LIMIT_COLUMN, 256],
    [capi.SQLITE_LIMIT_EXPR_DEPTH, 100],
  ]) {
    if (!Number.isInteger(category) || typeof capi.sqlite3_limit !== "function")
      throw new Error("SQLite restore limits are unavailable.");
    capi.sqlite3_limit(db.pointer, category!, value!);
  }
  for (const [option, value] of [
    [capi.SQLITE_DBCONFIG_DEFENSIVE, 1],
    [capi.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0],
    [capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, 0],
  ]) {
    if (
      !Number.isInteger(option) ||
      typeof capi.sqlite3_db_config !== "function" ||
      capi.sqlite3_db_config(db.pointer, option!, value!, 0) !== capi.SQLITE_OK
    )
      throw new Error("SQLite defensive restore configuration failed.");
  }
  db.exec("PRAGMA query_only=ON; PRAGMA temp_store=FILE;");
}
/** Exact executable schema approval precedes migration ledger/application reads.
 * Each call compares at most maxObjects definitions against a trusted schema. */
export class ArchiveSchemaValidator {
  private offset = 0;
  private countChecked = false;
  constructor(
    private readonly db: ArchiveDatabaseFile,
    private readonly expected: readonly ApprovedSchemaObject[],
  ) {
    if (expected.length < 1 || expected.length > 512)
      throw new Error("Trusted schema inventory exceeds its limit.");
  }
  step(maxObjects: number): boolean {
    if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 128)
      throw new Error("Invalid schema validation budget.");
    if (!this.countChecked) {
      if (
        Number(this.db.selectValue("SELECT count(*) FROM sqlite_schema")) !==
        this.expected.length
      )
        throw new Error(
          "Archive contains unexpected or missing SQLite schema objects.",
        );
      this.countChecked = true;
    }
    const encoder = new TextEncoder();
    for (
      let count = 0;
      count < maxObjects && this.offset < this.expected.length;
      count++, this.offset++
    ) {
      const expected = this.expected[this.offset]!,
        meta = sqlRows(
          this.db,
          "SELECT type,tbl_name,length(CAST(sql AS BLOB)) AS sql_bytes FROM sqlite_schema WHERE name=?",
          [expected.name],
        )[0];
      if (
        !meta ||
        meta.type !== expected.type ||
        meta.tbl_name !== expected.table ||
        meta.sql_bytes !==
          (expected.sql === null ? null : encoder.encode(expected.sql).length)
      )
        throw new Error(
          `Archive schema object ${expected.name} is unsupported.`,
        );
      const definition = this.db.selectValue(
        "SELECT sql FROM sqlite_schema WHERE name=?",
        [expected.name],
      );
      if (definition !== expected.sql)
        throw new Error(
          `Archive schema definition ${expected.name} differs from this build.`,
        );
    }
    return this.offset === this.expected.length;
  }
}

import type { CanonicalSqlite } from "./canonical/index.ts";
/** Runtime-only guards extend global operation identity to archive jobs. Clean
 * portable snapshots omit these jobs and guards, preserving canonical journals. */
export function installArchiveOperationFences(db: CanonicalSqlite): void {
  const journals = [
    "quixi_sync_ops",
    "quixi_import_operations",
    "quixi_blob_operations",
    "quixi_import_work_operations",
  ];
  for (const table of journals)
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${table}_archive_identity BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM quixi_archive_operations WHERE id=NEW.operation_id) BEGIN SELECT RAISE(ABORT,'operation identity already used by archive job'); END`,
    );
  const exists = journals
    .map((table) => `EXISTS(SELECT 1 FROM ${table} WHERE operation_id=NEW.id)`)
    .join(" OR ");
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS quixi_archive_external_identity BEFORE INSERT ON quixi_archive_operations WHEN ${exists} BEGIN SELECT RAISE(ABORT,'archive operation identity already used by another journal'); END`,
  );
}

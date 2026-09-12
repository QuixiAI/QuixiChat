/** The committed ledger version is the known-old-writer barrier. Schema-8
 * workers reject this version before canonical recovery or requests. No user
 * records, operations, or derived data need rewriting for transport fencing. */
export const ARCHIVE_ACCESS_MIGRATION = {
  version: 9,
  name: 'mandatory_archive_selection_protocol',
  sql: "SELECT 'archive-protocol-2-with-selection-fences';",
} as const;

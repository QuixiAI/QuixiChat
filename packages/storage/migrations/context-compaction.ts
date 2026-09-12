/** Format gate: older writers must not ignore a reviewed request exclusion.
 * Context payloads use the existing immutable JSON records and reference edges. */
export const CONTEXT_COMPACTION_MIGRATION = {
  version: 11,
  name: 'reviewed_context_attachment_exclusions',
  sql: 'SELECT 1; -- ContextSnapshot compaction version 1 requires a compatible writer.\n',
} as const;

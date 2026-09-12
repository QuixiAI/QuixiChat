/** Actionable wording for storage boundary failures surfaced by the library
 * and conversation workflows. The exact storage message is kept in
 * parentheses so a report still carries the original detail. Nothing here
 * claims a recovery the worker did not perform. */
export function describeStorageError(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  const detail =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  const withDetail = (text: string) =>
    detail && detail !== text ? `${text} (${detail})` : text;
  switch (code) {
    case "QUOTA_EXCEEDED":
      return withDetail(
        "Local storage is full, so this change was not saved. Your saved history is unchanged. Free space or browser site data, or export a backup, then try again.",
      );
    case "OVERLOADED":
      return withDetail(
        "Storage is busy with other work. Nothing was changed; try again in a moment.",
      );
    case "UNKNOWN_OUTCOME":
      return withDetail(
        "The last change may or may not have been saved. Check the conversation before repeating it.",
      );
    case "CLOSED":
      return withDetail(
        "The archive connection closed before this change was saved. Reload to reconnect; saved history is unchanged.",
      );
    case "CONFLICT":
      return withDetail(
        "The conversation changed elsewhere first. Review the current state before repeating this change.",
      );
    case "IO_ERROR":
      return withDetail(
        "A local storage read or write failed, so this change was not saved. Check free space and browser site data, then try again.",
      );
    case "MIGRATION_FAILED":
      return withDetail(
        "This archive's schema does not match this version of Quixi; nothing was changed.",
      );
    default:
      return detail;
  }
}

/** Typed startup outcomes for a host that could not open the selected archive.
 * Guidance is derived from the storage boundary code; the exact worker message
 * is retained verbatim for diagnosis. Nothing here reads or changes archive
 * bytes, and no guidance promises a recovery path that is not implemented. */
export interface StartupFailureDescription {
  code: string;
  message: string;
  title: string;
  guidance: string;
  /** True when trying again without any user change can plausibly succeed. */
  retryable: boolean;
}
const KNOWN_CODES = [
  "MIGRATION_FAILED",
  "CONFLICT",
  "UNSUPPORTED",
  "IO_ERROR",
  "QUOTA_EXCEEDED",
  "NOT_FOUND",
  "OVERLOADED",
  "CLOSED",
  "INTERNAL",
] as const;
export function describeStartupFailure(
  error: unknown,
): StartupFailureDescription {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code =
    typeof candidate?.code === "string" &&
    (KNOWN_CODES as readonly string[]).includes(candidate.code)
      ? candidate.code
      : "UNKNOWN";
  const message = (
    typeof candidate?.message === "string" && candidate.message
      ? candidate.message
      : String(error)
  ).slice(0, 4096);
  switch (code) {
    case "MIGRATION_FAILED":
      return {
        code,
        message,
        title: "This archive needs a different version of Quixi",
        guidance:
          "Its schema history does not match this build, so Quixi did not open or change it. Open it with the Quixi version that last used it, or update Quixi and try again. A recovery export from this state is not available yet.",
        retryable: false,
      };
    case "CONFLICT":
      return {
        code,
        message,
        title: "Another Quixi window is holding this archive",
        guidance:
          "Close other Quixi tabs or windows, including ones running an older version, then try again. The archive was not changed.",
        retryable: true,
      };
    case "UNSUPPORTED":
      return {
        code,
        message,
        title: "Local archive storage is unavailable in this session",
        guidance:
          "Quixi keeps your history in browser-managed local storage, which this session does not provide. Use a regular browser profile with site storage enabled; private or restricted sessions may prevent access. No archive was opened.",
        retryable: false,
      };
    case "QUOTA_EXCEEDED":
      return {
        code,
        message,
        title: "Local storage is full",
        guidance:
          "The browser refused the space Quixi needs to open the archive. Free site storage or disk space, then try again. Existing archive files were not changed.",
        retryable: true,
      };
    case "IO_ERROR":
      return {
        code,
        message,
        title: "The archive could not be read",
        guidance:
          "A local file read or write failed while opening the archive. Check free disk space and the browser's site data for this origin, then try again. Existing archive files were not changed.",
        retryable: true,
      };
    case "NOT_FOUND":
      return {
        code,
        message,
        title: "The selected archive is missing",
        guidance:
          "The archive that was last selected is not present in local storage. Quixi does not create an empty archive in its place. Restore it from a backup, or check whether browser site data was cleared.",
        retryable: false,
      };
    case "OVERLOADED":
    case "CLOSED":
      return {
        code,
        message,
        title: "Quixi could not finish opening the archive",
        guidance:
          "The storage worker stopped or was busy before startup completed. Try again; if this repeats, reload the application.",
        retryable: true,
      };
    default:
      return {
        code,
        message,
        title: "Quixi could not open your archive",
        guidance:
          "Startup failed before the archive was opened. Try again; if this repeats, keep the details below for diagnosis. Existing archive files were not changed by this screen.",
        retryable: true,
      };
  }
}

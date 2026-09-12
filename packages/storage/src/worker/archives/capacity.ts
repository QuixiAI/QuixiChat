/** Storage-capacity check before an archive job begins (plan 09, product
 * §111): the worker compares what the job will write on OPFS with what the
 * browser reports as free, and refuses up front with the numbers instead of
 * failing part-way through with a quota error. An unknown estimate never
 * refuses: the browser's later quota error still stops the job safely. */
export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
}
/** Room kept for journal, TAR headers and the job's own metadata. */
export const ARCHIVE_CAPACITY_SLACK_BYTES = 8 * 1024 * 1024;
export interface ArchiveCapacityRequirement {
  kind: "export" | "restore";
  requiredBytes: number;
  basis: string;
}
/** An export writes a snapshot of the database plus every blob into the
 * container; a restore holds the received container and its validated
 * candidate copy at once. */
export function archiveCapacityRequirement(
  input:
    | { kind: "export"; databaseBytes: number; blobBytes: number }
    | { kind: "restore"; expectedBytes: number },
): ArchiveCapacityRequirement {
  if (input.kind === "export") {
    const requiredBytes = Math.max(0, input.databaseBytes) + Math.max(0, input.blobBytes) + ARCHIVE_CAPACITY_SLACK_BYTES;
    return { kind: "export", requiredBytes, basis: `database ${formatBytes(input.databaseBytes)} + blobs ${formatBytes(input.blobBytes)} + ${formatBytes(ARCHIVE_CAPACITY_SLACK_BYTES)} slack` };
  }
  const requiredBytes = 2 * Math.max(0, input.expectedBytes) + ARCHIVE_CAPACITY_SLACK_BYTES;
  return { kind: "restore", requiredBytes, basis: `received container ${formatBytes(input.expectedBytes)} + its validated copy + ${formatBytes(ARCHIVE_CAPACITY_SLACK_BYTES)} slack` };
}
export interface ArchiveCapacityDecision {
  allowed: boolean;
  requiredBytes: number;
  availableBytes: number | null;
  reason: string | null;
}
export function archiveCapacityDecision(requirement: ArchiveCapacityRequirement, estimate: StorageEstimate | null): ArchiveCapacityDecision {
  const usage = estimate?.usage, quota = estimate?.quota;
  if (typeof usage !== "number" || typeof quota !== "number" || !Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0)
    return { allowed: true, requiredBytes: requirement.requiredBytes, availableBytes: null, reason: null };
  const availableBytes = Math.max(0, quota - usage);
  if (availableBytes >= requirement.requiredBytes) return { allowed: true, requiredBytes: requirement.requiredBytes, availableBytes, reason: null };
  return {
    allowed: false,
    requiredBytes: requirement.requiredBytes,
    availableBytes,
    reason: `The archive ${requirement.kind} needs about ${formatBytes(requirement.requiredBytes)} of free local storage (${requirement.basis}); this browser reports about ${formatBytes(availableBytes)} free. Free space or export from a device with more room.`,
  };
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

import { ARCHIVE_EXCLUDED, ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, archiveJson } from "./format.ts";
/** Rescue archives carry the exact database bytes and blob files of an archive
 * this build could not open, plus only metadata that needs no interpretation of
 * canonical rows. The receiving build owns all schema interpretation. */
export const RESCUE_KIND = "rescue";
export interface RescueLedgerRow {
  version: number;
  name: string;
  checksum: string;
}
export interface RescueManifest {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_FORMAT_VERSION;
  kind: typeof RESCUE_KIND;
  recovery: {
    /** Exact byte length of the database as the pool presented it. */
    databaseBytes: number;
    databaseSha256: string;
    /** SQLite header fields as found; null when the header is not a SQLite header. */
    header: { pageSize: number; pageCount: number } | null;
    /** Migration ledger rows as found, or null when they could not be read. */
    ledger: RescueLedgerRow[] | null;
    ledgerError: string | null;
    /** Whether the ledger is a prefix of, or equal to, the exporting build's migrations. */
    ledgerCompatible: boolean;
    buildMigrations: number;
    blobFiles: number;
    /** Blob files whose content hash differs from their name; copied as found. */
    blobHashMismatches: number;
    /** Files under blobs/ with unrecognized names; not copied. */
    unrecognizedFiles: number;
  };
  inventory: {
    path: "checksums.jsonl";
    byteLength: number;
    sha256: string;
    entries: number;
  };
  excluded: typeof ARCHIVE_EXCLUDED;
}
export const RESCUE_LIMITS = Object.freeze({
  maxBlobFiles: 1_000_000,
  maxLedgerRows: 128,
  chunkBytes: 1_048_576,
});

const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Parse a rescue manifest strictly. Nothing here interprets canonical rows;
 * the ledger is validated only for shape, never for compatibility. */
export function parseRescueManifest(text: string): RescueManifest {
  if (new TextEncoder().encode(text).length > 65536)
    throw new Error("Rescue manifest exceeds its metadata bound.");
  const value = JSON.parse(text) as RescueManifest;
  const recovery = value?.recovery, inventory = value?.inventory;
  if (
    !value || value.format !== ARCHIVE_FORMAT || value.version !== ARCHIVE_FORMAT_VERSION || value.kind !== RESCUE_KIND ||
    Object.keys(value).sort().join(",") !== "excluded,format,inventory,kind,recovery,version" ||
    !recovery || !inventory || inventory.path !== "checksums.jsonl" || !count(inventory.byteLength) ||
    !count(inventory.entries) || inventory.entries > 1_000_002 || !digest(inventory.sha256) ||
    !count(recovery.databaseBytes) || !digest(recovery.databaseSha256) ||
    !(recovery.header === null || (recovery.header && count(recovery.header.pageSize) && count(recovery.header.pageCount))) ||
    !(recovery.ledger === null || (Array.isArray(recovery.ledger) && recovery.ledger.length <= RESCUE_LIMITS.maxLedgerRows &&
      recovery.ledger.every((row) => count(row.version) && typeof row.name === "string" && row.name.length <= 256 && typeof row.checksum === "string" && row.checksum.length <= 128))) ||
    !(recovery.ledgerError === null || (typeof recovery.ledgerError === "string" && recovery.ledgerError.length <= 512)) ||
    typeof recovery.ledgerCompatible !== "boolean" || !count(recovery.buildMigrations) || !count(recovery.blobFiles) ||
    !count(recovery.blobHashMismatches) || !count(recovery.unrecognizedFiles) ||
    archiveJson(value.excluded) !== archiveJson(ARCHIVE_EXCLUDED)
  )
    throw new Error("Rescue manifest contains invalid or unsupported metadata.");
  return value;
}

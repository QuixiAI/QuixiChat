import { canonicalJson, jsonByteLength } from "@quixi/core/contracts";
import type { JsonValue } from "@quixi/core/model";
import { isQuixiId } from "@quixi/core/model";
import type { SnapshotSummary } from "./snapshot.ts";
export const ARCHIVE_FORMAT = "quixi-archive";
export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_EXCLUDED = [
  "host_secrets",
  "runtime_producer_leases",
  "unfinished_imports",
  "host_transfer_staging",
  "derived_search",
  "inference_models",
] as const;
export interface ArchiveDeclaration {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_FORMAT_VERSION;
  kind: "portable" | "open" | "rescue";
}
export interface ArchiveChecksum {
  path: string;
  byteLength: number;
  sha256: string;
}
export interface ArchiveManifest extends ArchiveDeclaration {
  source: SnapshotSummary & {
    migrations: { version: number; name: string; checksum: string }[];
  };
  inventory: {
    path: "checksums.jsonl";
    byteLength: number;
    sha256: string;
    entries: number;
  };
  excluded: typeof ARCHIVE_EXCLUDED;
  /** Present only for rescue archives; `source` is then derived from the
   * cleaned candidate during restore rather than declared by the exporter. */
  recovery?: import("./rescue-format.ts").RescueManifest["recovery"];
}
export const archiveJson = (value: unknown) =>
  canonicalJson(value as JsonValue);
export function archiveMetadata(value: unknown): Uint8Array {
  jsonByteLength(value, 65536);
  return new TextEncoder().encode(archiveJson(value) + "\n");
}
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseDeclaration(text: string): ArchiveDeclaration {
  if (new TextEncoder().encode(text).length > 65536)
    throw new Error("Archive declaration exceeds its metadata bound.");
  const value = JSON.parse(text) as ArchiveDeclaration;
  if (
    value.format !== ARCHIVE_FORMAT ||
    value.version !== ARCHIVE_FORMAT_VERSION ||
    !["portable", "open", "rescue"].includes(value.kind) ||
    Object.keys(value).sort().join(",") !== "format,kind,version"
  )
    throw new Error("Unsupported archive format declaration.");
  return value;
}
export function parseManifest(text: string): ArchiveManifest {
  if (new TextEncoder().encode(text).length > 65536)
    throw new Error("Archive manifest exceeds its metadata bound.");
  const value = JSON.parse(text) as ArchiveManifest;
  parseDeclaration(
    archiveJson({
      format: value.format,
      version: value.version,
      kind: value.kind,
    }),
  );
  const source = value.source,
    inventory = value.inventory;
  if (
    !source ||
    !inventory ||
    inventory.path !== "checksums.jsonl" ||
    !count(inventory.byteLength) ||
    !count(inventory.entries) ||
    inventory.entries > 1_000_000 ||
    !digest(inventory.sha256) ||
    !count(source.schemaVersion) ||
    source.schemaVersion < 1 ||
    !count(source.canonicalRecords) ||
    !count(source.syncOperations) ||
    !count(source.highWaterSequence) ||
    !count(source.streamingGenerations) ||
    !(
      source.defaultWorkspaceId === null || isQuixiId(source.defaultWorkspaceId)
    ) ||
    !Array.isArray(source.migrations) ||
    source.migrations.length < 1 ||
    source.migrations.length > 128 ||
    source.migrations.some(
      (migration, index) =>
        migration.version !== index + 1 ||
        typeof migration.name !== "string" ||
        migration.name.length > 256 ||
        !digest(migration.checksum),
    ) ||
    source.migrations.length !== source.schemaVersion ||
    archiveJson(value.excluded) !== archiveJson(ARCHIVE_EXCLUDED)
  )
    throw new Error(
      "Archive manifest contains invalid or unsupported metadata.",
    );
  return value;
}

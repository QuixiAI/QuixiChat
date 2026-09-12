import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CanonicalSqlite } from "../canonical/repository.ts";
import { sqlRows } from "./snapshot.ts";
import {
  ArchiveFileWriter,
  openArchiveFile,
  readArchiveBytes,
} from "./files.ts";
import { TarDecoder } from "./tar.ts";
import type { TarEntry } from "./tar.ts";
import { parseDeclaration, parseManifest } from "./format.ts";
import type { ArchiveManifest, ArchiveChecksum } from "./format.ts";
import { parseRescueManifest } from "./rescue-format.ts";
const decoder = new TextDecoder("utf-8", { fatal: true });
/** Receives into an already isolated candidate directory. The caller must never
 * pass the active directory. Observed inventory is SQL-backed, not a JS set. */
export class ArchiveReceiver {
  private parser: TarDecoder;
  private writer: ArchiveFileWriter | null = null;
  private entry: TarEntry | null = null;
  private hash = sha256.create();
  private offset = 0;
  private state: "format" | "database" | "blobs" | "manifest" | "end" =
    "format";
  private closed = false;
  private kind: "portable" | "rescue" | null = null;
  private manifest: ArchiveManifest | null = null;
  constructor(
    private readonly db: CanonicalSqlite,
    private readonly jobId: string,
    private readonly candidate: FileSystemDirectoryHandle,
    private readonly expected: {
      byteLength: number | null;
      sha256: string | null;
    },
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS quixi_archive_received_entries(job_id TEXT NOT NULL,path TEXT NOT NULL,byte_length INTEGER NOT NULL,sha256 TEXT,checked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,path)) STRICT",
    );
    this.parser = new TarDecoder({
      start: (entry) => this.start(entry),
      write: async (bytes) => {
        this.writer!.write(bytes);
      },
      end: () => this.end(),
    });
  }
  get byteLength(): number {
    return this.offset;
  }
  async push(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Restore input is closed.");
    if (
      bytes.length > 65536 ||
      !Number.isSafeInteger(this.offset + bytes.length) ||
      (this.expected.byteLength !== null &&
        this.offset + bytes.length > this.expected.byteLength)
    )
      throw new Error("Restore input exceeds its declared byte bound.");
    this.hash.update(bytes);
    this.offset += bytes.length;
    await this.parser.push(bytes);
  }
  private async start(entry: TarEntry): Promise<void> {
    const { path, byteLength } = entry;
    if (
      (this.state === "format" && path !== "format.json") ||
      (this.state === "database" && path !== "quixi.sqlite") ||
      (this.state === "blobs" &&
        path !== "checksums.jsonl" &&
        !path.startsWith("blobs/")) ||
      (this.state === "manifest" && path !== "manifest.json") ||
      this.state === "end"
    )
      throw new Error(
        "Archive entries are not in the required portable order.",
      );
    if (["format.json", "manifest.json"].includes(path) && byteLength > 65536)
      throw new Error("Archive metadata exceeds its bound.");
    this.db.exec({
      sql: "INSERT INTO quixi_archive_received_entries(job_id,path,byte_length) VALUES(?,?,?)",
      bind: [this.jobId, path, byteLength],
    });
    let directory = this.candidate,
      name = path;
    if (path.startsWith("blobs/")) {
      name = path.slice(6);
      const blobs = await this.candidate.getDirectoryHandle("blobs", {
        create: true,
      });
      directory = await blobs.getDirectoryHandle(name.slice(0, 2), {
        create: true,
      });
    } else if (path === "quixi.sqlite") name = "incoming.sqlite3";
    this.entry = entry;
    this.writer = new ArchiveFileWriter(
      await openArchiveFile(directory, name, true),
    );
  }
  private async metadata(name: string): Promise<string> {
    const file = await openArchiveFile(this.candidate, name);
    try {
      if (file.getSize() > 65536)
        throw new Error("Archive metadata exceeds its bound.");
      return decoder.decode(readArchiveBytes(file, 0, file.getSize()));
    } finally {
      file.close();
    }
  }
  private async end(): Promise<void> {
    const entry = this.entry!,
      writer = this.writer!,
      digest = writer.finish();
    writer.close();
    this.writer = null;
    this.entry = null;
    if (
      digest.byteLength !== entry.byteLength ||
      (entry.path.startsWith("blobs/") && digest.sha256 !== entry.path.slice(6))
    )
      throw new Error("Archive entry hash or length mismatch.");
    this.db.exec({
      sql: "UPDATE quixi_archive_received_entries SET sha256=? WHERE job_id=? AND path=?",
      bind: [digest.sha256, this.jobId, entry.path],
    });
    if (entry.path === "format.json") {
      const kind = parseDeclaration(await this.metadata("format.json")).kind;
      if (kind === "open")
        throw new Error(
          "Open text exports cannot replace a canonical archive.",
        );
      this.kind = kind;
      this.state = "database";
    } else if (entry.path === "quixi.sqlite") this.state = "blobs";
    else if (entry.path === "checksums.jsonl") this.state = "manifest";
    else if (entry.path === "manifest.json") {
      const text = await this.metadata("manifest.json");
      if (this.kind === "rescue") {
        // A rescue manifest declares no canonical summary. The restore path
        // cleans the raw database into a fresh candidate and derives the
        // summary from it; placeholders here are replaced at that step.
        const rescue = parseRescueManifest(text);
        this.manifest = {
          format: rescue.format,
          version: rescue.version,
          kind: rescue.kind,
          source: {
            schemaVersion: rescue.recovery.ledger?.length ?? 0,
            canonicalRecords: 0,
            syncOperations: 0,
            highWaterSequence: 0,
            streamingGenerations: 0,
            defaultWorkspaceId: null,
            migrations: rescue.recovery.ledger ?? [],
          },
          inventory: rescue.inventory,
          excluded: rescue.excluded,
          recovery: rescue.recovery,
        };
      } else {
        this.manifest = parseManifest(text);
        if (this.manifest.kind !== "portable")
          throw new Error("Restore manifest is not portable.");
      }
      this.state = "end";
    }
  }
  /** Container/hash completion alone is insufficient for activation. The caller
   * must next validate checksums, exact schema, canonical topology and blobs. */
  finish(expected: { byteLength: number; sha256: string }): ArchiveManifest {
    if (this.closed) throw new Error("Restore input is closed.");
    this.parser.finish();
    if (
      this.state !== "end" ||
      !this.manifest ||
      this.offset !== expected.byteLength ||
      (this.expected.byteLength !== null &&
        this.offset !== this.expected.byteLength)
    )
      throw new Error("Archive input length or final manifest is incomplete.");
    const digest = bytesToHex(this.hash.clone().digest());
    if (
      digest !== expected.sha256 ||
      (this.expected.sha256 !== null && digest !== this.expected.sha256)
    )
      throw new Error("Archive input hash mismatch.");
    const inventory = sqlRows(
      this.db,
      "SELECT byte_length,sha256 FROM quixi_archive_received_entries WHERE job_id=? AND path=?",
      [this.jobId, "checksums.jsonl"],
    )[0];
    if (
      !inventory ||
      inventory.byte_length !== this.manifest.inventory.byteLength ||
      inventory.sha256 !== this.manifest.inventory.sha256
    )
      throw new Error(
        "Archive checksum inventory differs from the final manifest.",
      );
    this.closed = true;
    this.hash.destroy();
    return this.manifest;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.hash.destroy();
    this.writer?.close();
    this.writer = null;
  }
}
/** Read at most maxLines checksum records per step, with a 64 KiB file buffer
 * and 1024-byte line bound. Extra/missing/duplicate inventory claims fail. */
export class ArchiveInventoryValidator {
  private offset = 0;
  private pending = new Uint8Array();
  private count = 0;
  private done = false;
  constructor(
    private readonly db: CanonicalSqlite,
    private readonly jobId: string,
    private readonly file: import("./files.ts").ArchiveFileHandle,
    private readonly manifest: ArchiveManifest,
  ) {}
  step(maxLines: number): boolean {
    if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 128)
      throw new Error("Invalid checksum validation budget.");
    if (this.done) return true;
    let processed = 0;
    while (processed < maxLines) {
      let newline = this.pending.indexOf(10);
      if (newline < 0 && this.offset < this.file.getSize()) {
        if (this.pending.length > 1024)
          throw new Error("Checksum inventory line exceeds its bound.");
        const next = readArchiveBytes(
          this.file,
          this.offset,
          Math.min(65536, this.file.getSize() - this.offset),
        );
        this.offset += next.length;
        const combined = new Uint8Array(this.pending.length + next.length);
        combined.set(this.pending);
        combined.set(next, this.pending.length);
        this.pending = combined;
        newline = this.pending.indexOf(10);
      }
      if (newline < 0) {
        if (this.pending.length)
          throw new Error("Checksum inventory ends with a partial line.");
        const actual = Number(
          this.db.selectValue(
            "SELECT count(*) FROM quixi_archive_received_entries WHERE job_id=? AND path NOT IN('checksums.jsonl','manifest.json')",
            [this.jobId],
          ),
        );
        if (
          this.count !== actual ||
          this.count !== this.manifest.inventory.entries ||
          Number(
            this.db.selectValue(
              "SELECT EXISTS(SELECT 1 FROM quixi_archive_received_entries WHERE job_id=? AND path NOT IN('checksums.jsonl','manifest.json') AND checked=0)",
              [this.jobId],
            ),
          )
        )
          throw new Error("Checksum inventory omits archive entries.");
        this.done = true;
        return true;
      }
      if (newline > 1024)
        throw new Error("Checksum inventory line exceeds its bound.");
      const value = JSON.parse(
        decoder.decode(this.pending.subarray(0, newline)),
      ) as ArchiveChecksum;
      this.pending = this.pending.slice(newline + 1);
      if (
        !value ||
        typeof value.path !== "string" ||
        ["checksums.jsonl", "manifest.json"].includes(value.path) ||
        !Number.isSafeInteger(value.byteLength) ||
        value.byteLength < 0 ||
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sha256)
      )
        throw new Error("Invalid archive checksum claim.");
      const row = sqlRows(
        this.db,
        "SELECT byte_length,sha256,checked FROM quixi_archive_received_entries WHERE job_id=? AND path=?",
        [this.jobId, value.path],
      )[0];
      if (
        !row ||
        row.checked !== 0 ||
        row.byte_length !== value.byteLength ||
        row.sha256 !== value.sha256
      )
        throw new Error(
          "Archive checksum claim is duplicate, missing or mismatched.",
        );
      this.db.exec({
        sql: "UPDATE quixi_archive_received_entries SET checked=1 WHERE job_id=? AND path=?",
        bind: [this.jobId, value.path],
      });
      this.count++;
      processed++;
    }
    return false;
  }
  close(): void {
    this.file.close();
  }
}

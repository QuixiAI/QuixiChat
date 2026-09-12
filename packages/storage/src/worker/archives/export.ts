import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CanonicalHistory } from "@quixi/core/model";
import type { SearchBlobAccess } from "../search/index.ts";
import {
  ArchiveFileWriter,
  archiveFileChunks,
  openArchiveFile,
} from "./files.ts";
import type { ArchiveFileHandle } from "./files.ts";
import { openSqliteFileReader } from "./sqlite-file.ts";
import type { ArchiveDatabaseFile, ArchiveSqlite } from "./snapshot.ts";
import { sqlRows, snapshotSummary } from "./snapshot.ts";
import { encodeTarEntry, tarEnd } from "./tar.ts";
import {
  ARCHIVE_EXCLUDED,
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  archiveJson,
  archiveMetadata,
} from "./format.ts";
import type { ArchiveManifest, ArchiveChecksum } from "./format.ts";
export interface ExportTick {
  bytes: Uint8Array | null;
  records: number;
  stagedBytes: number;
  waitingForResources?: boolean;
}
export interface ArchiveExportContext {
  sqlite: ArchiveSqlite;
  snapshot: ArchiveDatabaseFile;
  files: FileSystemDirectoryHandle;
  blobs: SearchBlobAccess;
  format: "portable" | "open";
  signal?: AbortSignal;
  currentSignal?: () => AbortSignal | undefined;
}
const encoder = new TextEncoder();
function check(signal?: AbortSignal) {
  if (signal?.aborted)
    throw Object.assign(new Error("Archive export cancelled."), {
      code: "CANCELLED",
    });
}
async function* one(bytes: Uint8Array) {
  yield bytes;
}
function textWrite(writer: ArchiveFileWriter, text: string): number {
  const bytes = encoder.encode(text);
  for (let offset = 0; offset < bytes.length; offset += 65536)
    writer.write(bytes.subarray(offset, offset + 65536));
  return bytes.length;
}
/** A private disk copy releases the canonical reader before yielding encoding
 * ticks. Initial verification/copy is cancellable but may exceed one step's
 * wall time. It retains only one 64 KiB chunk and no foreground byte lease. */
async function* stageBlob(
  context: ArchiveExportContext,
  digest: string,
  byteLength: number,
): AsyncGenerator<ExportTick, ArchiveFileHandle> {
  const signal = () => context.currentSignal?.() ?? context.signal;
  while (true) {
    check(signal());
    let parent: Awaited<ReturnType<SearchBlobAccess["openRead"]>> | undefined,
      file: ArchiveFileHandle | undefined,
      writer: ArchiveFileWriter | undefined;
    try {
      parent = await context.blobs.openRead(
        digest,
        () => crypto.randomUUID(),
        signal(),
      );
      if (parent.byteLength !== byteLength)
        throw new Error("Archive blob length differs from canonical snapshot.");
      file = await openArchiveFile(context.files, "current-blob.bin", true);
      writer = new ArchiveFileWriter(file);
      for (let offset = 0; offset < byteLength; offset += 65536) {
        check(signal());
        const child = context.blobs.sliceRead(
          parent.transferId,
          () => crypto.randomUUID(),
          { offset, byteLength: Math.min(65536, byteLength - offset) },
        );
        try {
          const chunk = context.blobs.readChunk(child.transferId);
          writer.write(chunk.bytes);
          context.blobs.acknowledge({
            transferId: chunk.transferId,
            sequence: chunk.sequence,
            committedOffset: chunk.offset + chunk.bytes.length,
          });
        } finally {
          await context.blobs.discard(child.transferId);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const observed = writer.finish();
      if (observed.byteLength !== byteLength || observed.sha256 !== digest)
        throw new Error(
          "Private archive blob copy failed its integrity check.",
        );
      await context.blobs.discard(parent.transferId);
      parent = undefined;
      return file;
    } catch (error) {
      writer?.close();
      if (!writer) file?.close();
      if ((error as { code?: string })?.code !== "OVERLOADED") throw error;
    } finally {
      if (parent) await context.blobs.discard(parent.transferId);
    }
    yield {
      bytes: null,
      records: 0,
      stagedBytes: 0,
      waitingForResources: true,
    };
  }
}
/** All temporary text and checksum files are disk-backed. The consumer writes
 * yielded TAR bytes before requesting the next tick and applies its own quotas. */
export async function* exportArchive(
  context: ArchiveExportContext,
): AsyncGenerator<ExportTick> {
  const { sqlite, snapshot, files, format } = context;
  const signal = () => context.currentSignal?.() ?? context.signal;
  const indexFile = await openArchiveFile(files, "checksums.jsonl", true),
    indexWriter = new ArchiveFileWriter(indexFile);
  let entries = 0;
  const entry = async function* (
    path: string,
    byteLength: number,
    source: AsyncIterable<Uint8Array>,
    inventory = true,
  ): AsyncGenerator<ExportTick> {
    check(signal());
    const hash = sha256.create();
    let observed = 0;
    const counted = async function* () {
      for await (const bytes of source) {
        check(signal());
        hash.update(bytes);
        observed += bytes.length;
        yield bytes;
      }
    };
    try {
      for await (const bytes of encodeTarEntry({ path, byteLength }, counted()))
        yield { bytes, records: 0, stagedBytes: 0 };
      const digest = bytesToHex(hash.digest());
      if (inventory) {
        const checksum: ArchiveChecksum = {
          path,
          byteLength: observed,
          sha256: digest,
        };
        indexWriter.write(archiveMetadata(checksum));
        entries++;
      }
    } finally {
      hash.destroy();
    }
  };
  let recordsFile: ArchiveFileHandle | undefined,
    markdownFile: ArchiveFileHandle | undefined;
  try {
    const declaration = archiveMetadata({
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_FORMAT_VERSION,
      kind: format,
    });
    yield* entry("format.json", declaration.length, one(declaration));
    if (format === "portable") {
      const reader = openSqliteFileReader(sqlite, snapshot);
      const source = async function* () {
        for (let offset = 0; offset < reader.byteLength; offset += 65536)
          yield reader.read(offset, 65536);
      };
      try {
        yield* entry("quixi.sqlite", reader.byteLength, source());
      } finally {
        reader.close();
      }
    } else {
      recordsFile = await openArchiveFile(files, "records.jsonl", true);
      markdownFile = await openArchiveFile(files, "history.md", true);
      const recordsWriter = new ArchiveFileWriter(recordsFile),
        markdownWriter = new ArchiveFileWriter(markdownFile);
      textWrite(
        markdownWriter,
        "# Quixi history\n\nThis export retains every message branch, including tombstones. IDs and parent IDs identify relationships. Raw and attachment bytes are in `blobs/`.\n\n",
      );
      let after = 0;
      while (true) {
        check(signal());
        const row = sqlRows(
          snapshot,
          "SELECT rowid,collection,payload FROM quixi_records WHERE rowid>? ORDER BY rowid LIMIT 1",
          [after],
        )[0];
        if (!row) break;
        after = Number(row.rowid);
        const value = JSON.parse(String(row.payload));
        let work = textWrite(
          recordsWriter,
          archiveJson({
            type: "entity",
            collection: row.collection,
            record: value,
          }) + "\n",
        );
        // Include complete machine-readable metadata as ordinary Markdown code.
        work += textWrite(
          markdownWriter,
          `## ${String(row.collection)} ${String(value.id ?? value.threadId)}\n\n    ${archiveJson(value)}\n\n`,
        );
        if (row.collection === "parts") {
          const part = value as CanonicalHistory["parts"][number];
          if (
            (part.kind === "Text" || part.kind === "Note") &&
            part.data.textBlob
          ) {
            const reference = part.data.textBlob,
              decoder = new TextDecoder("utf-8", { fatal: true });
            work += textWrite(markdownWriter, "Text body:\n\n    ");
            yield { bytes: null, records: 0, stagedBytes: work };
            work = 0;
            const staged = yield* stageBlob(
              context,
              reference.sha256,
              reference.byteLength,
            );
            try {
              for await (const bytes of archiveFileChunks(staged)) {
                check(signal());
                const text = decoder.decode(bytes, { stream: true });
                const written = textWrite(
                  markdownWriter,
                  text.replaceAll("\n", "\n    "),
                );
                yield { bytes: null, records: 0, stagedBytes: written };
              }
            } finally {
              staged.close();
            }
            work += textWrite(markdownWriter, decoder.decode() + "\n\n");
          } else if (
            (part.kind === "Text" || part.kind === "Note") &&
            typeof part.data.text === "string"
          )
            work += textWrite(
              markdownWriter,
              part.data.text
                .split("\n")
                .map((line) => "    " + line)
                .join("\n") + "\n\n",
            );
        }
        yield { bytes: null, records: 1, stagedBytes: work };
      }
      let sequence = 0;
      while (true) {
        check(signal());
        const row = sqlRows(
          snapshot,
          "SELECT sequence,operation_id,kind,recorded_at,identity,payload,affects,result FROM quixi_sync_ops WHERE sequence>? ORDER BY sequence LIMIT 1",
          [sequence],
        )[0];
        if (!row) break;
        sequence = Number(row.sequence);
        const record = {
          ...row,
          payload: JSON.parse(String(row.payload)),
          affects: JSON.parse(String(row.affects)),
          result: JSON.parse(String(row.result)),
        };
        const work = textWrite(
          recordsWriter,
          archiveJson({ type: "operation", operation: record }) + "\n",
        );
        yield { bytes: null, records: 1, stagedBytes: work };
      }
      const records = recordsWriter.finish(),
        markdown = markdownWriter.finish();
      yield* entry(
        "records.jsonl",
        records.byteLength,
        archiveFileChunks(recordsFile),
      );
      yield* entry(
        "history.md",
        markdown.byteLength,
        archiveFileChunks(markdownFile),
      );
    }
    let after = "";
    while (true) {
      const ref = sqlRows(
        snapshot,
        "SELECT sha256,byte_length FROM archive_blob_refs WHERE sha256>? ORDER BY sha256 LIMIT 1",
        [after],
      )[0];
      if (!ref) break;
      after = String(ref.sha256);
      const staged = yield* stageBlob(context, after, Number(ref.byte_length));
      try {
        yield* entry(
          "blobs/" + after,
          Number(ref.byte_length),
          archiveFileChunks(staged),
        );
      } finally {
        staged.close();
      }
    }
    const index = indexWriter.finish();
    yield* entry(
      "checksums.jsonl",
      index.byteLength,
      archiveFileChunks(indexFile),
      false,
    );
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_FORMAT_VERSION,
      kind: format,
      source: {
        ...snapshotSummary(snapshot),
        migrations: sqlRows(
          snapshot,
          "SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version",
        ).map((row) => ({
          version: Number(row.version),
          name: String(row.name),
          checksum: String(row.checksum),
        })),
      },
      inventory: {
        path: "checksums.jsonl",
        byteLength: index.byteLength,
        sha256: index.sha256,
        entries,
      },
      excluded: ARCHIVE_EXCLUDED,
    };
    const encoded = archiveMetadata(manifest);
    yield* entry("manifest.json", encoded.length, one(encoded), false);
    yield { bytes: tarEnd(), records: 0, stagedBytes: 0 };
  } finally {
    recordsFile?.close();
    markdownFile?.close();
    indexWriter.close();
  }
}

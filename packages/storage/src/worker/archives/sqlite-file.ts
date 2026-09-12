import type { CanonicalSqlite } from "../canonical/repository.ts";

/** The pinned SQLite public C/VFS surface used for bounded file reads. */
export interface FileSqlite {
  capi: {
    SQLITE_OK: number;
    SQLITE_FCNTL_FILE_POINTER: number;
    sqlite3_file_control(
      db: number,
      schema: string,
      operation: number,
      output: number,
    ): number;
    sqlite3_file: new (pointer: number) => {
      $pMethods: number;
      dispose(): void;
    };
    sqlite3_io_methods: new (pointer: number) => {
      $xRead: number;
      $xFileSize: number;
      dispose(): void;
    };
  };
  wasm: {
    alloc(bytes: number): number;
    dealloc(pointer: number): void;
    peekPtr(pointer: number): number;
    peek64(pointer: number): bigint;
    heap8u(): Uint8Array;
    functionEntry(pointer: number): (...args: (number | bigint)[]) => number;
  };
}
export interface FileDatabase extends CanonicalSqlite {
  pointer: number;
}
export interface BoundedSqliteReader {
  readonly byteLength: number;
  /** Fresh caller-owned copy, no more than 64 KiB. */
  read(offset: number, maxBytes: number): Uint8Array;
}
export const SQLITE_FILE_CHUNK_BYTES = 65_536;

/** Caller serializes all use of this connection for the callback's lifetime.
 * The read transaction protects a DELETE-journal snapshot while file bytes are
 * copied. This is cancellable block I/O, not the incremental online backup API.
 */
export function openSqliteFileReader(
  sqlite: FileSqlite,
  db: FileDatabase,
  signal?: AbortSignal,
): BoundedSqliteReader & { close(): void } {
  const { capi, wasm } = sqlite;
  if (String(db.selectValue("PRAGMA journal_mode")).toLowerCase() !== "delete")
    throw new Error("Bounded archive copy requires DELETE journal mode.");
  if (!Number.isInteger(capi.SQLITE_FCNTL_FILE_POINTER))
    throw new Error(
      "The pinned SQLite build does not expose file-pointer access.",
    );
  let scratch = 0,
    output = 0,
    file: InstanceType<FileSqlite["capi"]["sqlite3_file"]> | undefined,
    methods: InstanceType<FileSqlite["capi"]["sqlite3_io_methods"]> | undefined;
  let transaction = false,
    live = true;
  const close = () => {
    if (!live) return;
    live = false;
    methods?.dispose();
    file?.dispose();
    if (scratch) wasm.dealloc(scratch);
    if (output) wasm.dealloc(output);
    if (transaction) db.exec("ROLLBACK");
  };
  const check = () => {
    if (!live) throw new Error("Snapshot reader is closed.");
    if (signal?.aborted)
      throw Object.assign(new Error("Archive snapshot cancelled."), {
        code: "CANCELLED",
      });
  };
  try {
    check();
    db.exec("BEGIN");
    transaction = true;
    // Establish a SQLite read lock before reaching its underlying file.
    db.selectValue("SELECT count(*) FROM sqlite_schema");
    scratch = wasm.alloc(SQLITE_FILE_CHUNK_BYTES);
    output = wasm.alloc(8);
    if (!scratch || !output)
      throw new Error("Cannot allocate bounded snapshot scratch space.");
    if (
      capi.sqlite3_file_control(
        db.pointer,
        "main",
        capi.SQLITE_FCNTL_FILE_POINTER,
        output,
      ) !== capi.SQLITE_OK
    )
      throw new Error("SQLite could not expose its snapshot file.");
    const pointer = wasm.peekPtr(output);
    if (!pointer) throw new Error("SQLite snapshot file is unavailable.");
    file = new capi.sqlite3_file(pointer);
    methods = new capi.sqlite3_io_methods(file.$pMethods);
    if (
      wasm.functionEntry(methods.$xFileSize)(pointer, output) !== capi.SQLITE_OK
    )
      throw new Error("SQLite snapshot size read failed.");
    const byteLength = Number(wasm.peek64(output));
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 512 ||
      byteLength % 512
    )
      throw new Error("SQLite snapshot size is invalid.");
    const read = wasm.functionEntry(methods.$xRead);
    return {
      byteLength,
      close,
      read(offset, maxBytes) {
        check();
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > byteLength ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > SQLITE_FILE_CHUNK_BYTES
        )
          throw new Error("Invalid bounded snapshot range.");
        const count = Math.min(maxBytes, byteLength - offset);
        if (!count) return new Uint8Array();
        if (read(pointer, scratch, count, BigInt(offset)) !== capi.SQLITE_OK)
          throw new Error("SQLite snapshot range read failed.");
        return wasm.heap8u().slice(scratch, scratch + count);
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
export async function withSqliteFileReader<T>(
  sqlite: FileSqlite,
  db: FileDatabase,
  consume: (reader: BoundedSqliteReader) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const reader = openSqliteFileReader(sqlite, db, signal);
  try {
    return await consume(reader);
  } finally {
    reader.close();
  }
}

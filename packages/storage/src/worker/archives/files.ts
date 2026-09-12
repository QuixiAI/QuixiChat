import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
export interface ArchiveFileHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
type SyncHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<ArchiveFileHandle>;
};
export interface ArchiveFileDigest {
  byteLength: number;
  sha256: string;
}
const safeName = (name: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) &&
  name !== "." &&
  name !== "..";
export async function openArchiveFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  create = false,
): Promise<ArchiveFileHandle> {
  if (!safeName(name)) throw new Error("Invalid internal archive file name.");
  const handle = await directory.getFileHandle(name, { create });
  return (handle as SyncHandle).createSyncAccessHandle();
}
export function writeArchiveBytes(
  file: ArchiveFileHandle,
  bytes: Uint8Array,
  offset: number,
): void {
  if (
    bytes.length > 65536 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(offset + bytes.length)
  )
    throw new Error("Archive file write exceeds its byte bound.");
  let written = 0;
  while (written < bytes.length) {
    const count = file.write(bytes.subarray(written), { at: offset + written });
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > bytes.length - written
    )
      throw new Error("Archive write made invalid progress.");
    written += count;
  }
}
export function readArchiveBytes(
  file: ArchiveFileHandle,
  offset: number,
  count: number,
): Uint8Array {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 65536 ||
    offset + count > file.getSize()
  )
    throw new Error("Invalid bounded archive file read.");
  const bytes = new Uint8Array(count);
  let read = 0;
  while (read < count) {
    const length = file.read(bytes.subarray(read), { at: offset + read });
    if (!Number.isSafeInteger(length) || length < 1 || length > count - read)
      throw new Error("Archive input ended early.");
    read += length;
  }
  return bytes;
}
export async function* archiveFileChunks(
  file: ArchiveFileHandle,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const size = file.getSize();
  for (let offset = 0; offset < size; offset += 65536) {
    if (signal?.aborted)
      throw Object.assign(new Error("Archive byte stream cancelled."), {
        code: "CANCELLED",
      });
    yield readArchiveBytes(file, offset, Math.min(65536, size - offset));
  }
}
/** Disk-backed output with one hash state and no retained body buffers. */
export class ArchiveFileWriter {
  private hash = sha256.create();
  private offset = 0;
  private done = false;
  constructor(private readonly file: ArchiveFileHandle) {
    file.truncate(0);
  }
  get byteLength(): number {
    return this.offset;
  }
  write(bytes: Uint8Array): void {
    if (this.done) throw new Error("Archive output is already finished.");
    writeArchiveBytes(this.file, bytes, this.offset);
    this.hash.update(bytes);
    this.offset += bytes.length;
  }
  finish(): ArchiveFileDigest {
    if (this.done) throw new Error("Archive output is already finished.");
    this.file.flush();
    const result = {
      byteLength: this.offset,
      sha256: bytesToHex(this.hash.digest()),
    };
    this.done = true;
    return result;
  }
  close(): void {
    if (!this.done) this.hash.destroy();
    this.done = true;
    this.file.close();
  }
}

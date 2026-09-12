/** Streaming regular-file TAR/PAX subset. The container is readable by ordinary
 * tar tools; the restore reader deliberately accepts only Quixi's fixed paths. */
export interface TarEntry {
  path: string;
  byteLength: number;
}
export interface TarSink {
  start(entry: TarEntry): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
}
const BLOCK = 512,
  CHUNK = 65536,
  MAX_OCTAL_SIZE = 8 ** 11 - 1;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const safePath = (path: string) =>
  [
    "format.json",
    "quixi.sqlite",
    "checksums.jsonl",
    "manifest.json",
    "records.jsonl",
    "history.md",
  ].includes(path) || /^blobs\/[a-f0-9]{64}$/.test(path);
const sizeOk = (size: number) => Number.isSafeInteger(size) && size >= 0;
function fail(reason: string): never {
  throw Object.assign(new Error(reason), { code: "INVALID_REQUEST" });
}
function field(
  header: Uint8Array,
  at: number,
  width: number,
  text: string,
): void {
  const bytes = encoder.encode(text);
  if (bytes.length > width) fail("TAR header field is too long.");
  header.set(bytes, at);
}
function octal(
  header: Uint8Array,
  at: number,
  width: number,
  value: number,
): void {
  field(header, at, width, value.toString(8).padStart(width - 1, "0") + "\0");
}
function header(path: string, byteLength: number, kind = "0"): Uint8Array {
  const bytes = new Uint8Array(BLOCK);
  field(bytes, 0, 100, path);
  octal(bytes, 100, 8, 0o600);
  octal(bytes, 108, 8, 0);
  octal(bytes, 116, 8, 0);
  octal(bytes, 124, 12, byteLength);
  octal(bytes, 136, 12, 0);
  bytes.fill(32, 148, 156);
  field(bytes, 156, 1, kind);
  field(bytes, 257, 6, "ustar\0");
  field(bytes, 263, 2, "00");
  const sum = bytes.reduce((a, b) => a + b, 0);
  field(bytes, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return bytes;
}
function paxSize(size: number): Uint8Array {
  const value = ` size=${size}\n`;
  let length = value.length + 1;
  while (String(length).length + value.length !== length)
    length = String(length).length + value.length;
  return encoder.encode(`${length}${value}`);
}
export async function* encodeTarEntry(
  entry: TarEntry,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (!safePath(entry.path) || !sizeOk(entry.byteLength))
    fail("Invalid archive entry path or size.");
  if (entry.byteLength > MAX_OCTAL_SIZE) {
    const pax = paxSize(entry.byteLength);
    yield header("pax-size", pax.length, "x");
    yield pax;
    if (pax.length % BLOCK) yield new Uint8Array(BLOCK - (pax.length % BLOCK));
  }
  yield header(
    entry.path,
    entry.byteLength > MAX_OCTAL_SIZE ? 0 : entry.byteLength,
  );
  let written = 0;
  for await (const bytes of source) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length > CHUNK ||
      written + bytes.length > entry.byteLength
    )
      fail("Archive entry violated its declared byte bound.");
    if (bytes.length) {
      written += bytes.length;
      yield bytes;
    }
  }
  if (written !== entry.byteLength)
    fail("Archive entry ended before its declared size.");
  if (written % BLOCK) yield new Uint8Array(BLOCK - (written % BLOCK));
}
export const tarEnd = () => new Uint8Array(2 * BLOCK);
function stringField(bytes: Uint8Array, at: number, length: number): string {
  const value = bytes.subarray(at, at + length),
    zero = value.indexOf(0);
  return decoder.decode(zero < 0 ? value : value.subarray(0, zero));
}
function numberField(bytes: Uint8Array, at: number, length: number): number {
  const text = stringField(bytes, at, length).trim();
  if (!/^[0-7]+$/.test(text)) fail("Malformed TAR numeric field.");
  const value = Number.parseInt(text, 8);
  if (!sizeOk(value)) fail("TAR size exceeds safe integers.");
  return value;
}
export class TarDecoder {
  private buffer = new Uint8Array(BLOCK);
  private filled = 0;
  private state: "header" | "body" | "padding" | "end" = "header";
  private remaining = 0;
  private padding = 0;
  private zeroBlocks = 0;
  private pax: Uint8Array | null = null;
  private paxAt = 0;
  private nextSize: number | null = null;
  private entries = 0;
  private finished = false;
  /** Duplicate detection belongs to the disk-backed inventory sink, never an
   * archive-sized in-memory set. start() must reject a repeated path. */
  constructor(
    private readonly sink: TarSink,
    private readonly limits: { maxEntries: number; maxEntryBytes: number } = {
      maxEntries: 1_000_000,
      maxEntryBytes: Number.MAX_SAFE_INTEGER,
    },
  ) {}
  async push(bytes: Uint8Array): Promise<void> {
    if (this.finished) fail("TAR decoder is finished.");
    if (!(bytes instanceof Uint8Array) || bytes.length > CHUNK)
      fail("TAR input chunks must be at most 64 KiB.");
    let at = 0;
    while (at < bytes.length) {
      if (this.state === "end") {
        if (bytes.subarray(at).some((value) => value !== 0))
          fail("Unexpected trailing archive data.");
        return;
      }
      if (this.state === "header") {
        const count = Math.min(BLOCK - this.filled, bytes.length - at);
        this.buffer.set(bytes.subarray(at, at + count), this.filled);
        this.filled += count;
        at += count;
        if (this.filled < BLOCK) continue;
        this.filled = 0;
        await this.beginHeader();
        continue;
      }
      if (this.state === "padding") {
        const count = Math.min(this.padding, bytes.length - at);
        if (bytes.subarray(at, at + count).some((value) => value !== 0))
          fail("TAR entry padding is not zero.");
        this.padding -= count;
        at += count;
        if (this.padding === 0) this.state = "header";
        continue;
      }
      const count = Math.min(this.remaining, bytes.length - at),
        part = bytes.subarray(at, at + count);
      if (this.pax) {
        this.pax.set(part, this.paxAt);
        this.paxAt += count;
      } else await this.sink.write(part);
      this.remaining -= count;
      at += count;
      if (this.remaining === 0) await this.endEntry();
    }
  }
  private async beginHeader(): Promise<void> {
    const bytes = this.buffer;
    if (bytes.every((value) => value === 0)) {
      if (this.nextSize !== null) fail("Orphaned PAX extension.");
      if (++this.zeroBlocks === 2) this.state = "end";
      return;
    }
    if (this.zeroBlocks) fail("Archive ended with only one zero block.");
    const expected = numberField(bytes, 148, 8),
      sum = bytes.reduce(
        (value, byte, index) =>
          value + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
    if (sum !== expected) fail("TAR header checksum mismatch.");
    if (
      stringField(bytes, 257, 6) !== "ustar" ||
      stringField(bytes, 263, 2) !== "00" ||
      stringField(bytes, 345, 155) ||
      stringField(bytes, 157, 100)
    )
      fail("Unsupported TAR header or link target.");
    const kind = stringField(bytes, 156, 1),
      path = stringField(bytes, 0, 100),
      storedSize = numberField(bytes, 124, 12);
    if (kind === "x") {
      if (
        path !== "pax-size" ||
        this.nextSize !== null ||
        storedSize < 1 ||
        storedSize > 65536
      )
        fail("Unsupported or oversized PAX extension.");
      this.pax = new Uint8Array(storedSize);
      this.paxAt = 0;
      this.remaining = storedSize;
    } else {
      if (kind !== "0" || !safePath(path))
        fail("Archive contains an unsupported path or entry type.");
      const byteLength = this.nextSize ?? storedSize;
      this.nextSize = null;
      if (
        !sizeOk(byteLength) ||
        byteLength > this.limits.maxEntryBytes ||
        ++this.entries > this.limits.maxEntries
      )
        fail("Archive entry resource limit exceeded.");
      this.remaining = byteLength;
      await this.sink.start({ path, byteLength });
    }
    this.padding = (BLOCK - (this.remaining % BLOCK)) % BLOCK;
    this.state = "body";
    if (!this.remaining) await this.endEntry();
  }
  private async endEntry(): Promise<void> {
    if (this.pax) {
      const text = decoder.decode(this.pax),
        match = /^(\d+) size=(0|[1-9]\d*)\n$/.exec(text);
      if (
        !match ||
        Number(match[1]) !== this.pax.length ||
        !sizeOk(Number(match[2]))
      )
        fail("PAX extension is not a bounded size declaration.");
      this.nextSize = Number(match[2]);
      this.pax = null;
    } else await this.sink.end();
    this.state = this.padding ? "padding" : "header";
  }
  finish(): void {
    if (this.finished) fail("TAR decoder is finished.");
    if (this.state !== "end" || this.nextSize !== null)
      fail("Archive is truncated or missing its end marker.");
    this.finished = true;
  }
}

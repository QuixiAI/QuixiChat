import { DiskStages } from "./disk-stages.ts";
import {
  TransferWindow,
  type BoundaryErrorCode,
  type ByteChunk,
  type ChunkAcknowledgement,
  type HostTransfer,
} from "@quixi/core/contracts";

export const WEB_HOST_LIMITS = Object.freeze({
  chunkBytes: 65_536,
  inFlight: 4,
  transfers: 16,
  stageBytes: 8_388_608,
  bufferedBytes: 16_777_216,
  sourceChunkBytes: 1_048_576,
  requests: 4,
});
export function failure(
  code: BoundaryErrorCode,
  message: string,
  requestId: string,
): Error {
  return Object.assign(new Error(message), {
    code,
    requestId,
    operationId: null,
    retry: code === "UNSUPPORTED" ? "after_user_action" : "never",
    details: {},
  });
}
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
type Base = {
  id: string;
  requestId: string;
  window: TransferWindow;
  offset: number;
  sequence: number;
  final: boolean;
  busy: boolean;
};
type Stage = Base & {
  kind: "stage";
  purpose: "provider_request" | "file_save";
  chunks: Uint8Array[];
  expectedBytes: number | null;
  expectedSha256: string | null;
  verified: boolean;
};
type Source = Base & {
  kind: "source";
  reader: ReadableStreamDefaultReader<Uint8Array>;
  remainder: Uint8Array;
  pending: Map<number, number>;
  close: () => void;
  idleMs: number;
};
type Transfer = Stage | Source;

/** Session-owned, bounded staging and pull/acknowledgement streaming. No persistence. */
export class WebTransfers {
  private readonly entries = new Map<string, Transfer>();
  private buffered = 0;
  readonly disk: DiskStages;
  constructor(fileStagingNamespace?: string) {
    this.disk = new DiskStages(fileStagingNamespace);
  }
  private descriptor(item: Transfer): HostTransfer {
    return {
      transferId: item.id,
      maxChunkBytes: WEB_HOST_LIMITS.chunkBytes,
      maxInFlight: WEB_HOST_LIMITS.inFlight,
    };
  }
  private base(requestId: string): Base {
    if (this.entries.size + this.disk.size >= WEB_HOST_LIMITS.transfers)
      throw failure(
        "OVERLOADED",
        "Release an existing host transfer first.",
        requestId,
      );
    const id = crypto.randomUUID();
    return {
      id,
      requestId,
      window: new TransferWindow(
        id,
        WEB_HOST_LIMITS.chunkBytes,
        WEB_HOST_LIMITS.inFlight,
      ),
      offset: 0,
      sequence: 0,
      final: false,
      busy: false,
    };
  }
  private charge(count: number, requestId: string): void {
    if (this.buffered + count > WEB_HOST_LIMITS.bufferedBytes)
      throw failure(
        "OVERLOADED",
        "Host transfer memory budget reached.",
        requestId,
      );
    this.buffered += count;
  }
  private get(id: string): Transfer {
    const item = this.entries.get(id);
    if (!item)
      throw failure("NOT_FOUND", "Host transfer is absent or released.", id);
    return item;
  }
  async begin(
    requestId: string,
    declaration: {
      purpose: "provider_request" | "file_save";
      expectedBytes: number | null;
      expectedSha256: string | null;
    },
  ): Promise<HostTransfer> {
    if (
      !["provider_request", "file_save"].includes(declaration.purpose) ||
      !(
        declaration.expectedBytes === null ||
        (Number.isSafeInteger(declaration.expectedBytes) &&
          declaration.expectedBytes >= 0)
      ) ||
      !(
        declaration.expectedSha256 === null ||
        /^[a-f0-9]{64}$/.test(declaration.expectedSha256)
      )
    )
      throw failure(
        "INVALID_REQUEST",
        "Invalid transfer declaration.",
        requestId,
      );
    if (declaration.purpose === "file_save") {
      this.base(requestId);
      return this.disk.begin(requestId, declaration);
    }
    if (
      declaration.expectedBytes !== null &&
      declaration.expectedBytes > WEB_HOST_LIMITS.stageBytes
    )
      throw failure(
        "UNSUPPORTED",
        "Provider request staging is limited to 8 MiB.",
        requestId,
      );
    const item: Stage = {
      ...this.base(requestId),
      ...declaration,
      kind: "stage",
      chunks: [],
      verified: false,
    };
    this.entries.set(item.id, item);
    return this.descriptor(item);
  }
  source(
    requestId: string,
    stream: ReadableStream<Uint8Array>,
    close: () => void = () => {},
    idleMs = 120_000,
  ): HostTransfer {
    const item: Source = {
      ...this.base(requestId),
      kind: "source",
      reader: stream.getReader(),
      remainder: new Uint8Array(),
      pending: new Map(),
      close,
      idleMs,
    };
    this.entries.set(item.id, item);
    return this.descriptor(item);
  }
  async write(chunk: ByteChunk): Promise<ChunkAcknowledgement> {
    if (this.disk.owns(chunk.transferId)) return this.disk.write(chunk);
    const item = this.get(chunk.transferId);
    if (item.kind !== "stage" || item.verified || item.busy)
      throw failure(
        "CONFLICT",
        "Transfer does not accept writes.",
        item.requestId,
      );
    if (item.offset + chunk.bytes.byteLength > WEB_HOST_LIMITS.stageBytes)
      throw failure(
        "UNSUPPORTED",
        "The browser staging limit is 8 MiB.",
        item.requestId,
      );
    if (
      item.expectedBytes !== null &&
      item.offset + chunk.bytes.byteLength > item.expectedBytes
    )
      throw failure(
        "INVALID_REQUEST",
        "Transfer exceeds its declared length.",
        item.requestId,
      );
    this.charge(chunk.bytes.byteLength, item.requestId);
    try {
      item.window.reserve(chunk);
    } catch {
      this.buffered -= chunk.bytes.byteLength;
      throw failure(
        "INVALID_REQUEST",
        "Invalid chunk sequence, offset, or size.",
        item.requestId,
      );
    }
    item.chunks.push(chunk.bytes.slice());
    item.offset += chunk.bytes.byteLength;
    item.final = chunk.final;
    const ack = {
      transferId: item.id,
      sequence: chunk.sequence,
      committedOffset: item.offset,
    };
    item.window.acknowledge(ack);
    return ack;
  }
  async finish(
    requestId: string,
    id: string,
    expected: { byteLength: number; sha256: string },
  ): Promise<{
    transferId: string;
    byteLength: number;
    sha256: string;
    state: "verified_staged";
  }> {
    if (this.disk.owns(id)) return this.disk.finish(requestId, id, expected);
    const item = this.get(id);
    if (
      item.kind !== "stage" ||
      item.busy ||
      !item.final ||
      !item.window.complete
    )
      throw failure(
        "CONFLICT",
        "Finish requires a completed staged transfer.",
        requestId,
      );
    if (
      expected.byteLength !== item.offset ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      (item.expectedBytes !== null && item.expectedBytes !== item.offset)
    )
      throw failure(
        "INVALID_REQUEST",
        "Staged transfer length does not match.",
        requestId,
      );
    this.charge(item.offset, requestId);
    item.busy = true;
    try {
      const bytes = this.concatenate(item);
      const digest = await sha256(bytes);
      bytes.fill(0);
      if (!this.entries.has(id))
        throw failure(
          "CANCELLED",
          "Transfer was released during verification.",
          requestId,
        );
      if (
        digest !== expected.sha256 ||
        (item.expectedSha256 !== null && digest !== item.expectedSha256)
      )
        throw failure(
          "INVALID_REQUEST",
          "Staged transfer hash does not match.",
          requestId,
        );
      item.verified = true;
      return {
        transferId: id,
        byteLength: item.offset,
        sha256: digest,
        state: "verified_staged",
      };
    } finally {
      this.buffered -= item.offset;
      item.busy = false;
    }
  }
  private concatenate(item: Stage): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(item.offset);
    let offset = 0;
    for (const chunk of item.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  async withStaged<T>(
    id: string,
    purpose: Stage["purpose"],
    run: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T> {
    const item = this.get(id);
    if (
      item.kind !== "stage" ||
      !item.verified ||
      item.busy ||
      item.purpose !== purpose
    )
      throw failure(
        "CONFLICT",
        "A verified transfer of the matching purpose is required.",
        item.requestId,
      );
    this.charge(item.offset, item.requestId);
    item.busy = true;
    const bytes = this.concatenate(item);
    try {
      return await run(bytes);
    } finally {
      bytes.fill(0);
      this.buffered -= bytes.byteLength;
      item.busy = false;
    }
  }
  async read(id: string): Promise<ByteChunk> {
    const item = this.get(id);
    if (item.kind !== "source" || item.busy || item.final)
      throw failure(
        "CONFLICT",
        "Transfer is not readable or a read is already pending.",
        item.requestId,
      );
    if (item.pending.size >= WEB_HOST_LIMITS.inFlight)
      throw failure(
        "OVERLOADED",
        "Acknowledge a chunk before reading more.",
        item.requestId,
      );
    item.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (item.remainder.byteLength === 0) {
        const next = await Promise.race([
          item.reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                failure(
                  "IO_ERROR",
                  "Host body read timed out.",
                  item.requestId,
                ),
              );
              void this.release(id);
            }, item.idleMs);
          }),
        ]);
        if (!this.entries.has(id))
          throw failure("CANCELLED", "Transfer was released.", item.requestId);
        if (next.done) item.final = true;
        else {
          if (
            next.value.byteLength === 0 ||
            next.value.byteLength > WEB_HOST_LIMITS.sourceChunkBytes
          )
            throw failure(
              "IO_ERROR",
              "Source returned an unsupported chunk size.",
              item.requestId,
            );
          this.charge(next.value.byteLength, item.requestId);
          item.remainder = next.value;
        }
      }
      const bytes = item.remainder.slice(0, WEB_HOST_LIMITS.chunkBytes);
      item.remainder = item.remainder.slice(bytes.byteLength);
      const chunk = {
        transferId: id,
        sequence: item.sequence++,
        offset: item.offset,
        bytes,
        final: item.final,
      };
      item.window.reserve(chunk);
      item.offset += bytes.byteLength;
      item.pending.set(chunk.sequence, bytes.byteLength);
      return chunk;
    } catch (error) {
      const released = !this.entries.has(id);
      await this.release(id);
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
      )
        throw error;
      throw failure(
        released ? "CANCELLED" : "IO_ERROR",
        "Host source read failed or was cancelled.",
        item.requestId,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      item.busy = false;
    }
  }
  async acknowledge(ack: ChunkAcknowledgement): Promise<void> {
    const item = this.get(ack.transferId);
    if (item.kind !== "source")
      throw failure(
        "CONFLICT",
        "Staged writes already acknowledge consumption.",
        item.requestId,
      );
    try {
      item.window.acknowledge(ack);
    } catch {
      throw failure(
        "INVALID_REQUEST",
        "Acknowledgement does not match a pending chunk.",
        item.requestId,
      );
    }
    this.buffered -= item.pending.get(ack.sequence) ?? 0;
    item.pending.delete(ack.sequence);
    if (item.window.complete) await this.release(item.id);
  }
  async release(id: string): Promise<void> {
    if (this.disk.owns(id)) return this.disk.release(id);
    const item = this.entries.get(id);
    if (!item) return;
    this.entries.delete(id);
    if (item.kind === "stage") {
      this.buffered -= item.offset;
      for (const chunk of item.chunks) chunk.fill(0);
    } else {
      this.buffered -=
        item.remainder.byteLength +
        [...item.pending.values()].reduce((a, b) => a + b, 0);
      item.remainder = new Uint8Array();
      item.pending.clear();
      item.close();
      try {
        await item.reader.cancel();
      } catch {
        /* The owning fetch may already be aborted. */
      }
    }
  }
  async cancel(requestId: string): Promise<void> {
    await this.disk.cancel(requestId);
    await Promise.all(
      [...this.entries.values()]
        .filter((item) => item.requestId === requestId)
        .map((item) => this.release(item.id)),
    );
  }
  async dispose(): Promise<void> {
    await this.disk.dispose();
    await Promise.all([...this.entries.keys()].map((id) => this.release(id)));
  }
}

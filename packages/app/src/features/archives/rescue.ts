import type { HostClient } from "@quixi/core/contracts";
import { exportRescueArchive } from "@quixi/storage/client";
import type { RescueExportSummary } from "@quixi/storage/client";
/** Stage a byte-level rescue archive into host file staging without opening
 * the archive's schema. Used from the startup outcome view when the selected
 * archive could not be opened; see ADR 0016. At most one rescue chunk is held
 * while the host acknowledges the previous write. */
export interface PreparedRescueDownload {
  summary: RescueExportSummary;
  name: string;
  /** Invoke from a new user gesture; browser save pickers need activation. */
  save(requestId: string): Promise<void>;
  release(): Promise<void>;
}
export interface RescueWorkflowOptions {
  signal?: AbortSignal;
  onProgress?: (stagedBytes: number) => void;
}
const id = () => crypto.randomUUID();
function stopped(signal?: AbortSignal) {
  if (signal?.aborted)
    throw Object.assign(new Error("Rescue export cancelled."), {
      code: "CANCELLED",
    });
}
export async function prepareRescueDownload(
  host: HostClient,
  archiveId: string,
  options: RescueWorkflowOptions = {},
): Promise<PreparedRescueDownload> {
  const destination = await host.beginTransfer(id(), {
    purpose: "file_save",
    expectedBytes: null,
    expectedSha256: null,
  });
  const transferId = destination.transferId,
    chunkBytes = destination.maxChunkBytes;
  let sequence = 0,
    offset = 0,
    held: Uint8Array | null = null;
  const write = async (bytes: Uint8Array, final: boolean) => {
    stopped(options.signal);
    await host.writeChunk({ transferId, sequence, offset, bytes, final });
    sequence++;
    offset += bytes.length;
    try {
      options.onProgress?.(offset);
    } catch {
      /* UI callbacks cannot affect the transfer. */
    }
  };
  try {
    const summary = await exportRescueArchive(
      archiveId,
      id(),
      async (chunk) => {
        // Split to the host bound and delay each piece by one so the last
        // piece can carry the final flag once the export completes.
        for (let at = 0; at < chunk.length; at += chunkBytes) {
          const piece = chunk.subarray(at, Math.min(chunk.length, at + chunkBytes));
          if (held) await write(held, false);
          held = piece;
        }
      },
      { timeoutMs: 300_000 },
    );
    if (!held) throw new Error("Rescue export produced no bytes.");
    await write(held, true);
    held = null;
    if (offset !== summary.byteLength)
      throw new Error("Rescue export length differs from the staged bytes.");
    await host.finishTransfer(id(), transferId, {
      byteLength: summary.byteLength,
      sha256: summary.sha256,
    });
    const name = `quixi-rescue-${new Date().toISOString().slice(0, 10)}.tar`;
    let released = false;
    return {
      summary,
      name,
      async save(requestId) {
        if (released) throw new Error("Prepared rescue archive was released.");
        await host.saveFileTransfer(requestId, {
          name,
          mediaType: "application/x-tar",
          transferId,
        });
      },
      async release() {
        if (released) return;
        await host.releaseTransfer(id(), transferId);
        released = true;
      },
    };
  } catch (error) {
    await host.releaseTransfer(id(), transferId).catch(() => {});
    throw error;
  }
}

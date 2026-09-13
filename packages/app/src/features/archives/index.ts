import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { INTEGRITY_CHECK_DEADLINE_MS } from "@quixi/core/contracts";
import type {
  ArchiveExportFormat,
  ArchiveJobStatus,
  HostClient,
  HostFile,
  StorageClient,
  StorageOperations,
  StorageRequestOptions,
} from "@quixi/core/contracts";
export interface ArchiveWorkflowOptions {
  signal?: AbortSignal;
  onProgress?: (job: ArchiveJobStatus) => void;
}
export interface PreparedArchiveDownload {
  job: ArchiveJobStatus;
  /** Invoke from a new user gesture after preparation finishes. Browser save
   * pickers require transient activation. A browser download is a handoff;
   * its completion must be confirmed before clearing retained temporary files. */
  save(requestId: string): Promise<void>;
  release(): Promise<void>;
}
const id = () => crypto.randomUUID();
function stopped(signal?: AbortSignal) {
  if (signal?.aborted)
    throw Object.assign(new Error("Archive workflow cancelled."), {
      code: "CANCELLED",
    });
}
function notify(options: ArchiveWorkflowOptions, job: ArchiveJobStatus) {
  try {
    options.onProgress?.(job);
  } catch {
    /* UI callbacks cannot corrupt archive lifecycle. */
  }
}
async function request<K extends keyof StorageOperations>(
  storage: StorageClient,
  operation: K,
  args: StorageOperations[K]["args"],
  signal?: AbortSignal,
  options?: StorageRequestOptions,
): Promise<StorageOperations[K]["result"]> {
  stopped(signal);
  const requestId = id(),
    operationId =
      args && typeof args === "object" && "operationId" in args
        ? String(args.operationId)
        : null;
  const abort = () => {
    void storage.cancel(requestId, operationId).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await storage.request(requestId, operation, args, options);
    stopped(signal);
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
async function finishJob(
  storage: StorageClient,
  job: ArchiveJobStatus,
  options: ArchiveWorkflowOptions,
) {
  while (job.state === "working") {
    stopped(options.signal);
    job = await request(
      storage,
      "advanceArchiveJob",
      { operationId: id(), jobId: job.jobId, maxRecords: 64, maxBytes: 262144 },
      options.signal,
      // Every step is bounded by records/bytes except restore validation's per-table integrity check, whose cost is that table's size.
      { timeoutMs: INTEGRITY_CHECK_DEADLINE_MS },
    );
    notify(options, job);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (job.state !== "ready")
    throw Object.assign(
      new Error(job.failure?.reason ?? "Archive job did not become ready."),
      { code: job.failure?.code ?? "IO_ERROR" },
    );
  return job;
}
async function cleanupJob(
  storage: StorageClient,
  jobId: string,
  operationId = id(),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await storage.request(id(), "releaseArchiveJob", { operationId, jobId });
      return;
    } catch (error) {
      if (
        attempt >= 1 ||
        (error as { code?: string })?.code !== "UNKNOWN_OUTCOME"
      )
        throw error;
    }
  }
}
/** Prepare disk-backed output without opening a save dialog. At most one
 * storage chunk is retained while waiting for the host's write acknowledgement. */
export function prepareArchiveDownload(
  storage: StorageClient,
  host: HostClient,
  format: ArchiveExportFormat,
  options: ArchiveWorkflowOptions = {},
): Promise<PreparedArchiveDownload> {
  return prepareDownload(storage, host, format, options);
}
/** Stage an outstanding ready export after page/owner loss without exporting again. */
export function prepareExistingArchiveDownload(
  storage: StorageClient,
  host: HostClient,
  jobId: string,
  options: ArchiveWorkflowOptions = {},
): Promise<PreparedArchiveDownload> {
  return prepareDownload(storage, host, "portable", options, jobId);
}
async function prepareDownload(
  storage: StorageClient,
  host: HostClient,
  format: ArchiveExportFormat,
  options: ArchiveWorkflowOptions,
  existingJobId?: string,
): Promise<PreparedArchiveDownload> {
  let jobId: string | undefined, transferId: string | undefined;
  try {
    jobId = existingJobId ?? id();
    let job = existingJobId
      ? await request(storage, "archiveJobStatus", { jobId }, options.signal)
      : await request(
          storage,
          "beginArchiveExport",
          { operationId: jobId, format },
          options.signal,
        );
    if (existingJobId && (job.kind !== "export" || job.state !== "ready"))
      throw new Error("Existing archive output is not ready.");
    notify(options, job);
    job = await finishJob(storage, job, options);
    const source = await request(
        storage,
        "openArchiveExport",
        { jobId },
        options.signal,
      ),
      destination = await host.beginTransfer(id(), {
        purpose: "file_save",
        expectedBytes: source.byteLength,
        expectedSha256: source.sha256,
      });
    transferId = destination.transferId;
    if (source.maxChunkBytes > destination.maxChunkBytes)
      throw new Error("Host does not support archive chunk size.");
    while (true) {
      stopped(options.signal);
      const chunk = await storage.readChunk(source.transferId),
        end = chunk.offset + chunk.bytes.length;
      await host.writeChunk({ ...chunk, transferId });
      await storage.acknowledgeChunk({
        transferId: source.transferId,
        sequence: chunk.sequence,
        committedOffset: end,
      });
      if (chunk.final) break;
    }
    stopped(options.signal);
    await host.finishTransfer(id(), transferId, {
      byteLength: source.byteLength,
      sha256: source.sha256,
    });
    stopped(options.signal);
    let released = false;
    const releaseOperation = id(),
      output = job.output!,
      preparedTransfer = transferId,
      preparedJob = jobId;
    return {
      job,
      async save(requestId) {
        if (released) throw new Error("Prepared archive was released.");
        await host.saveFileTransfer(requestId, {
          name: output.name,
          mediaType: output.mediaType,
          transferId: preparedTransfer,
        });
      },
      async release() {
        if (released) return;
        let failure: unknown;
        try {
          await host.releaseTransfer(id(), preparedTransfer);
        } catch (error) {
          failure = error;
        }
        try {
          await cleanupJob(storage, preparedJob, releaseOperation);
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
        released = true;
      },
    };
  } catch (error) {
    if (transferId)
      await host.releaseTransfer(id(), transferId).catch(() => {});
    if (jobId) await cleanupJob(storage, jobId).catch(() => {});
    throw error;
  }
}
/** Validate a selected portable file into an isolated candidate. This does not
 * activate or replace an archive. The workflow consumes/releases its file handle. */
export async function stageArchiveRestore(
  storage: StorageClient,
  host: HostClient,
  file: HostFile,
  options: ArchiveWorkflowOptions = {},
): Promise<ArchiveJobStatus> {
  let jobId: string | undefined, sourceId: string | undefined;
  const digest = sha256.create();
  try {
    jobId = id();
    const begun = await request(
      storage,
      "beginArchiveRestore",
      {
        operationId: jobId,
        expectedBytes: file.byteLength,
        expectedSha256: null,
      },
      options.signal,
    );
    notify(options, begun.job);
    const source = await host.openFileTransfer(id(), file.id);
    sourceId = source.transferId;
    let offset = 0,
      sequence = 0;
    while (true) {
      stopped(options.signal);
      const chunk = await host.readChunk(sourceId),
        end = chunk.offset + chunk.bytes.length;
      digest.update(chunk.bytes);
      if (chunk.bytes.length === 0 && chunk.final) {
        await storage.sendChunk({
          transferId: begun.inputTransfer.transferId,
          sequence: sequence++,
          offset,
          bytes: new Uint8Array(),
          final: true,
        });
      } else
        for (
          let index = 0;
          index < chunk.bytes.length;
          index += begun.inputTransfer.maxChunkBytes
        ) {
          const bytes = chunk.bytes.slice(
              index,
              index + begun.inputTransfer.maxChunkBytes,
            ),
            count = bytes.length;
          await storage.sendChunk({
            transferId: begun.inputTransfer.transferId,
            sequence: sequence++,
            offset,
            bytes,
            final: chunk.final && index + count === chunk.bytes.length,
          });
          offset += count;
        }
      await host.acknowledgeChunk({
        transferId: sourceId,
        sequence: chunk.sequence,
        committedOffset: end,
      });
      if (chunk.final) break;
    }
    const job = await request(
      storage,
      "finishArchiveRestore",
      {
        operationId: id(),
        jobId,
        byteLength: offset,
        sha256: bytesToHex(digest.digest()),
      },
      options.signal,
    );
    return await finishJob(storage, job, options);
  } catch (error) {
    if (jobId) await cleanupJob(storage, jobId).catch(() => {});
    throw error;
  } finally {
    digest.destroy();
    if (sourceId) await host.releaseTransfer(id(), sourceId).catch(() => {});
    await host.releaseFile(id(), file.id).catch(() => {});
  }
}

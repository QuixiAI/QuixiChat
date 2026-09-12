import { createIsolatedStorageClient as createStorageClient } from "../isolated-client.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  ArchiveJobStatus,
  CanonicalMutation,
} from "@quixi/core/contracts";
const id = () => crypto.randomUUID();
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
export async function publicArchiveProof() {
  const archiveId = `test-${id()}`;
  let client = createStorageClient({ archiveId });
  let steps = 0;
  const advance = async (job: ArchiveJobStatus) => {
    do {
      if (++steps > 10000)
        throw new Error("Archive public step limit exceeded.");
      job = await client.request(id(), "advanceArchiveJob", {
        operationId: id(),
        jobId: job.jobId,
        maxRecords: 8,
        maxBytes: 262144,
      });
    } while (job.state === "working");
    check(
      job.state === "ready",
      "Archive job failed: " + JSON.stringify(job.failure),
    );
    return job;
  };
  try {
    const length = 9 * 1048576 + 17,
      hash = sha256.create(),
      upload = await client.request(id(), "beginBlobTransfer", {
        operationId: id(),
        purpose: "raw_source",
        expectedBytes: length,
        expectedSha256: null,
      });
    for (
      let offset = 0, sequence = 0;
      offset < length;
      offset += 65536, sequence++
    ) {
      const bytes = new Uint8Array(Math.min(65536, length - offset));
      for (let i = 0; i < bytes.length; i++) bytes[i] = (offset + i) % 251;
      hash.update(bytes);
      await client.sendChunk({
        transferId: upload.transferId,
        sequence,
        offset,
        bytes,
        final: offset + bytes.length === length,
      });
    }
    const digest = bytesToHex(hash.digest());
    await client.request(id(), "finishBlobTransfer", {
      operationId: id(),
      transferId: upload.transferId,
      expectedBytes: length,
      expectedSha256: digest,
    });
    const rawId = id(),
      operationId = id(),
      mutation: CanonicalMutation = {
        version: 1,
        operationId,
        kind: "RegisterRawObject",
        recordedAt: 1700000000000,
        payload: {
          rawObject: {
            id: rawId,
            availability: "available",
            sha256: digest,
            byteLength: length,
            mediaType: "application/octet-stream",
            storageRef: "sha256:" + digest,
          },
        },
      };
    await client.request(id(), "commit", {
      transactionId: id(),
      mutations: [mutation],
      stagedBlobIds: [upload.transferId],
      expectedThreadRevisions: [],
    });
    const before = await client.request(id(), "diagnostics", null),
      begin = id();
    let job = await client.request(id(), "beginArchiveExport", {
      operationId: begin,
      format: "portable",
    });
    check(
      (
        await client.request(id(), "beginArchiveExport", {
          operationId: begin,
          format: "portable",
        })
      ).jobId === job.jobId,
      "Archive begin replay duplicated job.",
    );
    check(
      (await client.request(id(), "operationStatus", { operationId: begin }))
        .status === "committed",
      "Archive operation status missing.",
    );
    let conflict = false;
    try {
      await client.request(id(), "beginBlobTransfer", {
        operationId: begin,
        purpose: "attachment",
        expectedBytes: 0,
        expectedSha256: null,
      });
    } catch (error) {
      conflict = (error as { code?: string }).code === "CONFLICT";
    }
    check(conflict, "Archive-to-blob operation identity fence failed.");
    conflict = false;
    try {
      await client.request(id(), "beginArchiveExport", {
        operationId,
        format: "portable",
      });
    } catch (error) {
      conflict = (error as { code?: string }).code === "CONFLICT";
    }
    check(conflict, "Canonical-to-archive operation identity fence failed.");
    // Hold all foreground byte slots while archive reaches its first blob. It
    // must yield a working job, then continue once these credits are released.
    const holds = [];
    for (let i = 0; i < 8; i++)
      holds.push(
        await client.request(id(), "readBlobTransfer", { sha256: digest }),
      );
    for (let i = 0; i < 60; i++)
      job = await client.request(id(), "advanceArchiveJob", {
        operationId: id(),
        jobId: job.jobId,
        maxRecords: 8,
        maxBytes: 262144,
      });
    check(
      job.state === "working" && job.phase === "encoding",
      "Foreground byte admission did not pause archive encoding.",
    );
    for (const transfer of holds)
      await client.request(id(), "discardBlobTransfer", {
        transferId: transfer.transferId,
      });
    job = await advance(job);
    const output = await client.request(id(), "openArchiveExport", {
      jobId: job.jobId,
    });
    const restore = await client.request(id(), "beginArchiveRestore", {
      operationId: id(),
      expectedBytes: output.byteLength,
      expectedSha256: output.sha256,
    });
    let peak = 0;
    while (true) {
      const chunk = await client.readChunk(output.transferId);
      peak = Math.max(peak, chunk.bytes.length);
      const copy = chunk.bytes.slice();
      await client.sendChunk({
        ...chunk,
        transferId: restore.inputTransfer.transferId,
        bytes: copy,
      });
      await client.acknowledgeChunk({
        transferId: chunk.transferId,
        sequence: chunk.sequence,
        committedOffset: chunk.offset + chunk.bytes.length,
      });
      if (chunk.final) break;
    }
    check(peak === 65536, "Archive transfer exceeded 64 KiB credit contract.");
    let candidate = await client.request(id(), "finishArchiveRestore", {
      operationId: id(),
      jobId: restore.job.jobId,
      byteLength: output.byteLength,
      sha256: output.sha256,
    });
    candidate = await advance(candidate);
    const reviewArgs = {
        operationId: id(),
        jobId: candidate.jobId,
        expectedActiveArchiveId: archiveId,
        expectedRevision: before.syncOperations,
      },
      review = await client.request(
        id(),
        "prepareArchiveActivation",
        reviewArgs,
      );
    await client.close();
    client = createStorageClient({ archiveId });
    let needsValidation = false;
    try {
      await client.request(id(), "prepareArchiveActivation", reviewArgs);
    } catch (error) {
      needsValidation = (error as { code?: string }).code === "CONFLICT";
    }
    check(
      needsValidation,
      "Previous-owner review receipt bypassed fresh candidate validation.",
    );
    candidate = await advance(candidate);
    const renewed = await client.request(id(), "prepareArchiveActivation", {
      ...reviewArgs,
      operationId: id(),
    });
    check(
      renewed.candidate.manifestSha256 === review.candidate.manifestSha256,
      "Revalidated candidate identity changed.",
    );
    const after = await client.request(id(), "diagnostics", null);
    check(
      after.canonicalRecords === before.canonicalRecords &&
        after.syncOperations === before.syncOperations,
      "Export/restore altered active canonical history.",
    );
    await client.request(id(), "releaseArchiveJob", {
      operationId: id(),
      jobId: job.jobId,
    });
    await client.request(id(), "releaseArchiveJob", {
      operationId: id(),
      jobId: candidate.jobId,
    });
    const reader = new Worker(new URL("./browser-worker.ts", import.meta.url), { type: "module" });
    try {
      const state = await new Promise<{canonicalRecords: number; syncOperations: number; integrity: string; blobBytes: number; blobSha256: string}>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Retained candidate inspection deadline exceeded")), 30_000);
        reader.onmessage = ({ data }) => { clearTimeout(timer); data.ok ? resolve(data.result) : reject(new Error(data.error)); };
        reader.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        reader.postMessage({ command: "inspect-retained-candidate", archiveId: review.candidate.archiveId, digest });
      });
      check(
        state.canonicalRecords === before.canonicalRecords &&
          state.syncOperations === before.syncOperations && state.integrity === "ok",
        "Independent retained candidate inspection differs.",
      );
      check(
        state.blobSha256 === digest && state.blobBytes === length,
        "Independent retained candidate blob differs.",
      );
    } finally {
      reader.terminate();
    }
    return {
      archiveBytes: output.byteLength,
      blobBytes: length,
      peakTransferBytes: peak,
      steps,
      checks: [
        "actual ArchiveStorageClient owner-worker job and transfer routes",
        "9 MiB blob streamed without whole-archive array",
        "stable operation replay and bidirectional identity fences",
        "all eight foreground blob leases pause then resume export",
        "ready restore survives owner restart and requires revalidation",
        "canonical active archive unchanged",
        "private query-only candidate reader verifies canonical counts and raw bytes without writable client activation",
      ],
    };
  } finally {
    await client.close();
  }
}

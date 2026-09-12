import { compactionRoundtrip } from "./compaction-roundtrip.ts";
import { rejectSchemaSeven } from "./schema-seven.ts";
import { acceptSchemaEight } from "./schema-eight.ts";
import { ArchiveRepository } from "../../src/worker/archives/index.ts";
import { CanonicalArchiveValidator } from "../../src/worker/archives/validation.ts";
import {
  ArchiveSchemaValidator,
  restrictRestoreConnection,
} from "../../src/worker/archives/schema-validation.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CanonicalRepository } from "../../src/worker/canonical/repository.ts";
import type { CanonicalMutation } from "@quixi/core/contracts";
import { BlobCatalog } from "../../src/worker/blob-catalog.ts";
import { OpfsBlobStore } from "../../src/worker/blobs.ts";
import {
  copySnapshot,
  sqlRows,
  approvedSchema,
} from "../../src/worker/archives/snapshot.ts";
import type {
  ArchiveSqlite,
  ArchivePool,
  ArchiveDatabaseFile,
} from "../../src/worker/archives/snapshot.ts";
import { CleanSnapshotCopy } from "../../src/worker/archives/clean-copy.ts";
import { exportArchive } from "../../src/worker/archives/export.ts";
import {
  openArchiveFile,
  ArchiveFileWriter,
  archiveFileChunks,
  readArchiveBytes,
} from "../../src/worker/archives/files.ts";
import {
  ArchiveReceiver,
  ArchiveInventoryValidator,
} from "../../src/worker/archives/receive.ts";
const check = (value: unknown, reason: string) => {
  if (!value) throw new Error(reason);
};
export async function archiveRoundtrip(
  sqlite: ArchiveSqlite,
  pool: ArchivePool,
  source: ArchiveDatabaseFile,
  namespace: string,
) {
  const root = await navigator.storage.getDirectory(),
    quixi = await root.getDirectoryHandle(`quixi-export-fixture-${namespace}`, {
      create: true,
    }),
    files = await quixi.getDirectoryHandle("archive-work", { create: true });
  const blobs = await OpfsBlobStore.open(quixi),
    catalog = new BlobCatalog(source, blobs),
    canonical = new CanonicalRepository(source, {
      assertBlobAvailable: (...args) => catalog.assertAvailable(...args),
    });
  canonical.migrate();
  catalog.initialize();
  const id = () => crypto.randomUUID(),
    now = 1700000000000,
    blob = new TextEncoder().encode(
      "raw provenance 🧪\n".repeat(30000) + "readable_tail",
    ),
    digest = bytesToHex(sha256(blob));
  let raw: ArchiveDatabaseFile | undefined,
    clean: ArchiveDatabaseFile | undefined,
    restored: ArchiveDatabaseFile | undefined;
  const rawName = `/export-${id()}.sqlite3`,
    cleanName = `/clean-${id()}.sqlite3`,
    restoredName = `/restored-${id()}.sqlite3`;
  try {
    const upload = await catalog.begin(
      {
        operationId: id(),
        purpose: "canonical_text",
        expectedBytes: blob.length,
        expectedSha256: digest,
      },
      id,
    );
    for (
      let offset = 0, sequence = 0;
      offset < blob.length;
      offset += 65536, sequence++
    )
      catalog.append({
        transferId: upload.transferId,
        sequence,
        offset,
        bytes: blob.slice(offset, offset + 65536),
        final: offset + 65536 >= blob.length,
      });
    await catalog.finish({
      operationId: id(),
      transferId: upload.transferId,
      expectedBytes: blob.length,
      expectedSha256: digest,
    });
    await catalog.preparePublication([upload.transferId]);
    const rawId = id(),
      threadId = id(),
      contextId = id(),
      workspaceId = id(),
      rootMessage = id(),
      branchA = id(),
      branchB = id(),
      importId = id();
    const mutation = (kind: CanonicalMutation["kind"], payload: unknown) =>
      ({
        version: 1,
        operationId: id(),
        kind,
        recordedAt: now,
        payload,
      }) as CanonicalMutation;
    const message = (
      messageId: string,
      parentId: string | null,
      text: string | undefined,
    ) =>
      mutation("CreateMessage", {
        message: {
          id: messageId,
          threadId,
          parentId,
          role: "user",
          createdAt: now,
          recordedAt: now,
          generationId: null,
          editedFromMessageId: null,
          partCount: 1,
          sealed: true,
        },
        parts: [
          {
            id: id(),
            messageId,
            order: 0,
            kind: "Text",
            data:
              text === undefined
                ? {
                    textBlob: {
                      sha256: digest,
                      byteLength: blob.length,
                      encoding: "utf-8",
                    },
                  }
                : { text },
          },
        ],
      });
    const mutations = [
      mutation("RegisterRawObject", {
        rawObject: {
          id: rawId,
          availability: "available",
          sha256: digest,
          byteLength: blob.length,
          mediaType: "text/plain",
          storageRef: `sha256:${digest}`,
        },
      }),
      mutation("RegisterImportSource", {
        source: {
          id: importId,
          provider: "fixture",
          method: "synthetic",
          sourceThreadId: "source-thread",
          sourceUrl: null,
          importerName: "archive-proof",
          importerVersion: "1",
          sourceFormatVersion: null,
          sourceFingerprint: null,
          importedAt: now,
        },
        rawObjects: [],
      }),
      mutation("CreateThread", {
        thread: {
          id: threadId,
          workspaceId,
          createdAt: now,
          recordedAt: now,
          systemPrompt: null,
          preferredRoute: null,
          importSourceId: importId,
        },
        context: {
          id: contextId,
          threadId,
          previousId: null,
          version: 1,
          systemPrompt: null,
          preferredRoute: null,
          recordedAt: now,
        },
        state: {
          threadId,
          title: "Portable branches",
          tags: ["archive"],
          pinned: false,
          archived: false,
          activeLeafMessageId: null,
          contextSnapshotId: contextId,
          routingProfile: null,
          revision: 0,
        },
      }),
      message(rootMessage, null, "root text"),
      message(branchA, rootMessage, "first branch"),
      message(branchB, rootMessage, undefined),
      mutation("AttachProvenance", {
        identities: [],
        provenance: [
          {
            id: id(),
            entityKind: "message",
            entityId: branchB,
            importSourceId: importId,
            rawObjectId: rawId,
            locator: "fixture:branch",
            sourceCreatedAtText: null,
            compatibility: [],
          },
        ],
      }),
    ];
    canonical.commit({
      transactionId: id(),
      mutations,
      expectedThreadRevisions: [],
      stagedBlobIds: [upload.transferId],
    });
    await catalog.consumeAfterCommit([upload.transferId]);
    const commit = (items: CanonicalMutation[]) =>
      canonical.commit({
        transactionId: id(),
        mutations: items,
        expectedThreadRevisions: [],
        stagedBlobIds: [],
      });
    const generationId = id(),
      outputId = id(),
      textPartId = id();
    commit([
      mutation("CreateGeneration", {
        generation: {
          id: generationId,
          threadId,
          parentMessageId: rootMessage,
          outputMessageId: outputId,
          contextSnapshotId: contextId,
          provider: "fixture",
          providerAccountId: "synthetic",
          model: "fixture-model",
          parameters: {},
          status: "streaming",
          createdAt: now,
          recordedAt: now,
          completedAt: null,
          tokensIn: 4,
          tokensOut: 6,
          cachedTokens: 0,
          estimatedCost: null,
          reportedCost: null,
          lastSequence: 0,
          rawResponseId: rawId,
          compatibility: [],
        },
        output: {
          id: outputId,
          threadId,
          parentId: rootMessage,
          role: "assistant",
          createdAt: now,
          recordedAt: now,
          generationId,
          editedFromMessageId: null,
          partCount: 1,
          sealed: false,
        },
        parts: [
          {
            id: textPartId,
            messageId: outputId,
            order: 0,
            kind: "Text",
            data: { text: "stream prefix\u0000🙂" },
          },
        ],
      }),
      mutation("SetActiveBranch", { threadId, value: branchB }),
    ]);
    commit([
      mutation("AppendGenerationOutput", {
        generationId,
        sequence: 1,
        newParts: [
          "quixi.provider.raw-stream-chunk",
          "quixi.provider.response-manifest",
        ].map((providerKind, index) => ({
          id: id(),
          messageId: outputId,
          order: index + 1,
          kind: "ProviderArtifact",
          data: { providerKind, rawObjectId: rawId, locator: "" },
        })),
        textAppend: null,
      }),
    ]);
    commit([
      mutation("AppendGenerationOutput", {
        generationId,
        sequence: 2,
        newParts: [],
        textAppend: {
          partId: textPartId,
          text: " continued across raw evidence",
        },
      }),
    ]);
    commit([
      mutation("CompleteGeneration", {
        generationId,
        status: "complete",
        completedAt: now,
        tokensIn: 4,
        tokensOut: 6,
        cachedTokens: 0,
        estimatedCost: null,
        reportedCost: null,
        rawResponseId: rawId,
      }),
    ]);
    const prior = canonical.get("threadStates", threadId)!;
    commit([
      mutation("TombstoneBranch", {
        tombstone: {
          id: id(),
          threadId,
          rootMessageId: branchA,
          createdAt: now,
          reason: "synthetic deletion",
        },
        state: { ...prior, revision: prior.revision + 1 },
      }),
    ]);
    const importedThread = id(),
      importedContext = id(),
      importedMessage = id(),
      importedPart = id(),
      importJob = id();
    canonical.beginNormalizedImport({
      operationId: id(),
      importId: importJob,
      threadId: importedThread,
      mode: "create",
      expectedThreadRevision: null,
      recordedAt: now,
    });
    const importedRecords = [
      {
        collection: "threads",
        record: {
          id: importedThread,
          workspaceId,
          createdAt: now,
          recordedAt: now,
          systemPrompt: null,
          preferredRoute: null,
          importSourceId: importId,
        },
      },
      {
        collection: "contexts",
        record: {
          id: importedContext,
          threadId: importedThread,
          previousId: null,
          version: 1,
          systemPrompt: null,
          preferredRoute: null,
          recordedAt: now,
        },
      },
      {
        collection: "threadStates",
        record: {
          threadId: importedThread,
          title: "Published import",
          tags: [],
          pinned: false,
          archived: false,
          activeLeafMessageId: importedMessage,
          contextSnapshotId: importedContext,
          routingProfile: null,
          revision: 0,
        },
      },
      {
        collection: "messages",
        record: {
          id: importedMessage,
          threadId: importedThread,
          parentId: null,
          role: "user",
          createdAt: now,
          recordedAt: now,
          generationId: null,
          editedFromMessageId: null,
          partCount: 1,
          sealed: true,
        },
      },
      {
        collection: "parts",
        record: {
          id: importedPart,
          messageId: importedMessage,
          order: 0,
          kind: "Text",
          data: { text: "Imported record retained" },
        },
      },
    ].map((entry) => ({ ...entry, operationId: id(), recordedAt: now }));
    canonical.stageImportRecords({
      operationId: id(),
      importId: importJob,
      sequence: 0,
      records:
        importedRecords as import("@quixi/core/contracts").StagedImportRecord[],
    });
    let importedStatus = canonical.normalizedImportStatus({
      importId: importJob,
    });
    for (let checks = 0; importedStatus.state !== "ready"; checks++) {
      if (checks > 100)
        throw new Error("Fixture import validation did not finish.");
      importedStatus = canonical.validateImportStep({
        operationId: id(),
        importId: importJob,
        maxRecords: 2,
        stagedBlobIds: [],
      });
    }
    canonical.finalizeNormalizedImport({
      operationId: id(),
      importId: importJob,
      recordedAt: now,
      expectedRecordCount: importedStatus.recordCount,
      expectedManifestDigest: importedStatus.manifestDigest,
    });
    source.exec({
      sql: "INSERT INTO quixi_local_state VALUES('defaultWorkspaceId',?)",
      bind: [JSON.stringify(workspaceId)],
    });
    source.exec({
      sql: "INSERT INTO quixi_import_runs VALUES(?,?)",
      bind: [
        id(),
        JSON.stringify({ private: "do_not_export_private_staging_marker" }),
      ],
    });
    raw = await copySnapshot(sqlite, pool, source, rawName);
    clean = new pool.OpfsSAHPoolDb(cleanName);
    const copier = new CleanSnapshotCopy(raw, clean);
    let copySteps = 0;
    while (!copier.step(2)) copySteps++;
    const outputFile = await openArchiveFile(files, "portable.tar", true),
      output = new ArchiveFileWriter(outputFile);
    let peakChunk = 0;
    for await (const tick of exportArchive({
      sqlite,
      snapshot: clean,
      files,
      blobs: catalog,
      format: "portable",
    })) {
      if (tick.bytes) {
        peakChunk = Math.max(peakChunk, tick.bytes.length);
        output.write(tick.bytes);
      }
    }
    const archiveDigest = output.finish();
    const candidate = await root.getDirectoryHandle(
        `quixi-restore-fixture-${namespace}`,
        { create: true },
      ),
      jobId = id(),
      receiver = new ArchiveReceiver(source, jobId, candidate, {
        byteLength: archiveDigest.byteLength,
        sha256: archiveDigest.sha256,
      });
    for await (const bytes of archiveFileChunks(outputFile))
      await receiver.push(bytes);
    const manifest = receiver.finish(archiveDigest);
    await receiver.close();
    const inventory = new ArchiveInventoryValidator(
      source,
      jobId,
      await openArchiveFile(candidate, "checksums.jsonl"),
      manifest,
    );
    while (!inventory.step(2)) {}
    inventory.close();
    const incoming = await openArchiveFile(candidate, "incoming.sqlite3");
    let offset = 0;
    await pool.importDb(restoredName, async () => {
      if (offset === incoming.getSize()) return undefined;
      const bytes = readArchiveBytes(
        incoming,
        offset,
        Math.min(65536, incoming.getSize() - offset),
      );
      offset += bytes.length;
      return bytes;
    });
    incoming.close();
    restored = new pool.OpfsSAHPoolDb(restoredName);
    restrictRestoreConnection(sqlite, restored);
    const currentSchema = await approvedSchema(pool, `/schema-${id()}.sqlite3`);
    const schema = new ArchiveSchemaValidator(restored, currentSchema);
    while (!schema.step(4)) {}
    const validator = new CanonicalArchiveValidator(
      restored,
      source,
      jobId,
      manifest,
    );
    let validationSteps = 0;
    while (validator.step(2).phase !== "ready") {
      if (++validationSteps > 10000)
        throw new Error("Canonical validation did not finish.");
    }
    const canonicalRows = (db: ArchiveDatabaseFile) =>
      sqlRows(
        db,
        "SELECT collection,id,payload FROM quixi_records ORDER BY collection,id",
      );
    const operations = (db: ArchiveDatabaseFile) =>
      sqlRows(db, "SELECT * FROM quixi_sync_ops ORDER BY sequence");
    check(
      JSON.stringify(canonicalRows(source)) ===
        JSON.stringify(canonicalRows(restored)),
      "Restored canonical records differ.",
    );
    check(
      JSON.stringify(operations(source)) ===
        JSON.stringify(operations(restored)),
      "Restored operation journal differs.",
    );
    check(
      restored.selectValue("PRAGMA integrity_check") === "ok",
      "Restored SQLite integrity failed.",
    );
    check(
      restored.selectValue("SELECT count(*) FROM quixi_import_runs") === 0,
      "Private staging survived export.",
    );
    const restoredBlobDir = await (
        await candidate.getDirectoryHandle("blobs")
      ).getDirectoryHandle(digest.slice(0, 2)),
      restoredBlob = await openArchiveFile(restoredBlobDir, digest),
      hash = sha256.create();
    for await (const bytes of archiveFileChunks(restoredBlob))
      hash.update(bytes);
    restoredBlob.close();
    check(
      bytesToHex(hash.digest()) === digest,
      "Restored raw/text bytes differ.",
    );
    const textDir = await quixi.getDirectoryHandle("open-work", {
        create: true,
      }),
      openFile = await openArchiveFile(textDir, "open.tar", true),
      openOutput = new ArchiveFileWriter(openFile);
    for await (const tick of exportArchive({
      sqlite,
      snapshot: clean,
      files: textDir,
      blobs: catalog,
      format: "open",
    }))
      if (tick.bytes) openOutput.write(tick.bytes);
    const openDigest = openOutput.finish();
    openOutput.close();
    const markdown = await openArchiveFile(textDir, "history.md"),
      tail = readArchiveBytes(
        markdown,
        Math.max(0, markdown.getSize() - 65536),
        Math.min(65536, markdown.getSize()),
      );
    markdown.close();
    check(
      new TextDecoder().decode(tail).includes("readable_tail"),
      "Open Markdown omitted blob-backed tail.",
    );
    check(
      new TextDecoder()
        .decode(tail)
        .includes("stream prefix\u0000🙂 continued across raw evidence"),
      "Open Markdown split or omitted text appended across transport provenance.",
    );
    output.close();
    const jobs = new ArchiveRepository({
      db: source,
      sqlite,
      pool,
      archiveId: namespace,
      quixiDirectory: quixi,
      opfsRoot: root,
      blobs: catalog,
    });
    let exported = await jobs.request("beginArchiveExport", {
      operationId: id(),
      format: "portable",
    });
    let jobSteps = 0;
    while (exported.state === "working") {
      if (++jobSteps > 10000)
        throw new Error("Archive dispatcher export did not finish.");
      exported = await jobs.request("advanceArchiveJob", {
        operationId: id(),
        jobId: exported.jobId,
        maxRecords: 3,
        maxBytes: 65536,
      });
    }
    check(
      exported.state === "ready" && exported.output,
      "Archive dispatcher export failed.",
    );
    const download = await jobs.request("openArchiveExport", {
        jobId: exported.jobId,
      }),
      restore = await jobs.request("beginArchiveRestore", {
        operationId: id(),
        expectedBytes: download.byteLength,
        expectedSha256: download.sha256,
      });
    while (true) {
      const chunk = jobs.readChunk(download.transferId);
      await jobs.append({
        ...chunk,
        transferId: restore.inputTransfer.transferId,
      });
      jobs.acknowledge({
        transferId: chunk.transferId,
        sequence: chunk.sequence,
        committedOffset: chunk.offset + chunk.bytes.length,
      });
      if (chunk.final) break;
    }
    let restoreStatus = await jobs.request("finishArchiveRestore", {
      operationId: id(),
      jobId: restore.job.jobId,
      byteLength: download.byteLength,
      sha256: download.sha256,
    });
    while (restoreStatus.state === "working") {
      if (++jobSteps > 20000)
        throw new Error("Archive dispatcher restore did not finish.");
      restoreStatus = await jobs.request("advanceArchiveJob", {
        operationId: id(),
        jobId: restoreStatus.jobId,
        maxRecords: 3,
        maxBytes: 65536,
      });
    }
    check(
      restoreStatus.state === "ready" && restoreStatus.candidate,
      "Archive dispatcher restore failed.",
    );
    const revision = Number(
        source.selectValue("SELECT max(sequence) FROM quixi_sync_ops"),
      ),
      review = await jobs.request("prepareArchiveActivation", {
        operationId: id(),
        jobId: restoreStatus.jobId,
        expectedActiveArchiveId: namespace,
        expectedRevision: revision,
      });
    check(
      review.candidate.archiveId !== namespace &&
        review.expectedRevision === revision,
      "Archive review must retain active/candidate identities.",
    );
    let staleRejected = false;
    try {
      await jobs.request("prepareArchiveActivation", {
        operationId: id(),
        jobId: restoreStatus.jobId,
        expectedActiveArchiveId: namespace,
        expectedRevision: revision - 1,
      });
    } catch {
      staleRejected = true;
    }
    check(staleRejected, "Stale activation revision was accepted.");
    const controller = new AbortController();
    let activated = 0,
      lockedRejected = false;
    await navigator.locks.request(
      `quixi:archive:${review.candidate.archiveId}:owner`,
      async () => {
        try {
          await jobs.withActivationReview(
            review,
            controller.signal,
            async () => {
              activated++;
            },
          );
        } catch (error) {
          lockedRejected = (error as { code?: string }).code === "CONFLICT";
        }
      },
    );
    check(
      lockedRejected && activated === 0,
      "Busy candidate lock did not prevent activation callback.",
    );
    await jobs.withActivationReview(review, controller.signal, async () => {
      activated++;
    });
    check(activated === 1, "Fresh activation barrier did not invoke callback.");
    const candidateDirectory = await root.getDirectoryHandle(
        "quixi-" + review.candidate.archiveId,
      ),
      candidateBlob = await openArchiveFile(
        await (
          await candidateDirectory.getDirectoryHandle("blobs")
        ).getDirectoryHandle(digest.slice(0, 2)),
        digest,
      );
    candidateBlob.write(new Uint8Array([0]), { at: 0 });
    candidateBlob.flush();
    candidateBlob.close();
    let corruptRejected = false;
    try {
      await jobs.withActivationReview(review, controller.signal, async () => {
        activated++;
      });
    } catch {
      corruptRejected = true;
    }
    check(
      corruptRejected && activated === 1,
      "Corrupt candidate bytes reached activation callback.",
    );
    await jobs.request("releaseArchiveJob", {
      operationId: id(),
      jobId: exported.jobId,
    });
    await jobs.request("releaseArchiveJob", {
      operationId: id(),
      jobId: restoreStatus.jobId,
    });
    check(
      await root.getDirectoryHandle("quixi-" + review.candidate.archiveId),
      "Releasing ready restore deleted its retained candidate.",
    );
    const schemaSevenRejection = await rejectSchemaSeven({
      sqlite,
      pool,
      source,
      files,
      blobs: catalog,
      jobs,
      currentSchemaObjectCount: currentSchema.length,
    });
    const schemaEightUpgrade = await acceptSchemaEight({
      sqlite,
      pool,
      source,
      files,
      blobs: catalog,
      jobs,
    });
    const abandoned = await jobs.request("beginArchiveExport", {
      operationId: id(),
      format: "portable",
    });
    await jobs.close();
    // The upgraded schema-8 candidate holds exactly the source's records and
    // journal at this build's schema; it is read directly while no owner runs.
    const upgradedPool = await sqlite.installOpfsSAHPoolVfs({
      name: `schema-eight-check-${id()}`,
      directory: `/quixi-${schemaEightUpgrade.candidateId}/database`,
      initialCapacity: 6,
    });
    try {
      const upgraded = new upgradedPool.OpfsSAHPoolDb("/archive.sqlite3", "r");
      try {
        check(
          JSON.stringify(canonicalRows(source)) ===
            JSON.stringify(canonicalRows(upgraded)),
          "Upgraded schema-8 candidate records differ from the source.",
        );
        check(
          JSON.stringify(operations(source)) ===
            JSON.stringify(operations(upgraded)),
          "Upgraded schema-8 candidate journal differs from the source.",
        );
        check(
          Number(
            upgraded.selectValue(
              "SELECT max(version) FROM quixi_schema_migrations",
            ),
          ) === schemaEightUpgrade.targetSchemaVersion,
          "Upgraded candidate ledger is not this build's.",
        );
        check(
          upgraded.selectValue("PRAGMA integrity_check") === "ok",
          "Upgraded candidate integrity failed.",
        );
      } finally {
        upgraded.close();
      }
    } finally {
      upgradedPool.pauseVfs();
    }
    const reopened = new ArchiveRepository({
      db: source,
      sqlite,
      pool,
      archiveId: namespace,
      quixiDirectory: quixi,
      opfsRoot: root,
      blobs: catalog,
    });
    check(
      (await reopened.request("archiveJobStatus", { jobId: abandoned.jobId }))
        .state === "failed",
      "Interrupted archive job was not fenced on owner reopen.",
    );
    await reopened.request("releaseArchiveJob", {
      operationId: id(),
      jobId: abandoned.jobId,
    });
    let eightStatus = await reopened.request("archiveJobStatus", {
      jobId: schemaEightUpgrade.jobId,
    });
    for (let step = 0; step < 4096 && eightStatus.state === "working"; step++)
      eightStatus = await reopened.request("advanceArchiveJob", {
        operationId: id(),
        jobId: schemaEightUpgrade.jobId,
        maxRecords: 16,
        maxBytes: 262144,
      });
    check(
      eightStatus.state === "ready" &&
        eightStatus.sourceSchemaVersion === 8 &&
        eightStatus.candidate?.archiveId === schemaEightUpgrade.candidateId,
      `Upgraded schema-8 restore did not stay ready across owner reopen: ${JSON.stringify(eightStatus)}`,
    );
    await reopened.request("releaseArchiveJob", {
      operationId: id(),
      jobId: schemaEightUpgrade.jobId,
    });
    const compaction = await compactionRoundtrip(reopened, sqlite, source, canonical, threadId, digest, blob.length, catalog);
    await reopened.close();
    return {
      compaction,
      jobSteps,
      schemaSevenRejection,
      schemaEightUpgrade,
      schemaVersion: manifest.source.schemaVersion,
      migrations: manifest.source.migrations,
      archiveBytes: archiveDigest.byteLength,
      openBytes: openDigest.byteLength,
      canonicalRecords: manifest.source.canonicalRecords,
      syncOperations: manifest.source.syncOperations,
      blobBytes: blob.length,
      peakTarChunk: peakChunk,
      copySteps,
      validationSteps,
      manifestEntries: manifest.inventory.entries,
      checks: [
        "schema-12 reviewed summary proposal/frozen input/edited text, attachment exclusions and fresh branch empty selection/audit/source history survive an exact portable records/edges/journal/blobs roundtrip",
        "schema-7 portable rejected before activation with active history unchanged",
        "activation barrier target lock and fresh corruption rejection",
        "serialized repository export/restore job lifecycle",
        "candidate review current-revision fence and retention",
        "owner-loss unfinished job fence",
        "actual OPFS streamed portable export/receive",
        "manifest inventory validation",
        "canonical branches/provenance exact",
        "operation journal exact",
        "generation/tombstone and published import receipts exact",
        "text append across reserved transport provenance preserves NUL/Unicode and full Markdown",
        "raw/text blob SHA-256 exact",
        "private staging excluded",
        "Markdown includes full blob-backed tail",
      ],
    };
  } finally {
    restored?.close();
    clean?.close();
    raw?.close();
    pool.unlink(restoredName);
    pool.unlink(cleanName);
    pool.unlink(rawName);
    blobs.close();
  }
}

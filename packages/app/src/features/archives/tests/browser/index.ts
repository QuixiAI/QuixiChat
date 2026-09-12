import {
  openActiveStorageClient,
  readArchiveSelection,
  readRetainedArchive,
} from "@quixi/storage/client";
import type { ArchiveStorageClient } from "@quixi/storage/client";
import { MAX_TRANSFER_BYTES } from "@quixi/core/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
// Exercise the production browser download path, which has a Playwright
// completion event. Native OS save-picker automation is outside this proof.
Object.defineProperty(window, "showSaveFilePicker", {
  value: undefined,
  configurable: true,
});
const id = () => crypto.randomUUID();
const page = { maxItems: 64, maxBytes: 900000, cursor: null };
async function use<T>(
  action: (client: ArchiveStorageClient) => Promise<T>,
): Promise<T> {
  const client = await openActiveStorageClient();
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}
const api = {
  selection: () => readArchiveSelection(),
  jobs: () =>
    use((client) =>
      client.request(id(), "listArchiveJobs", {
        afterJobId: null,
        maxItems: 16,
      }),
    ),
  async snapshot() {
    return use(async (client) => ({
      selection: client.selection,
      diagnostics: await client.request(id(), "diagnostics", null),
      messages: await client.request(id(), "readEntities", {
        collection: "messages",
        threadId: null,
        page,
      }),
      parts: await client.request(id(), "readEntities", {
        collection: "parts",
        threadId: null,
        page,
      }),
      context: await client.request(id(), "readArchiveActivationContext", null),
      workspace: await client.request(id(), "archiveWorkspace", null),
      threads: await client.request(id(), "readEntities", {
        collection: "threads",
        threadId: null,
        page,
      }),
      states: await client.request(id(), "readEntities", {
        collection: "threadStates",
        threadId: null,
        page,
      }),
      raw: await client.request(id(), "readEntities", {
        collection: "rawObjects",
        threadId: null,
        page,
      }),
      sync: await client.request(id(), "readSyncOperations", {
        afterSequence: 0,
        page,
      }),
    }));
  },
  async seedRaw() {
    return use(async (client) => {
      const byteLength = 2 * 1048576 + 17,
        hash = sha256.create(),
        rawId = id();
      const upload = await client.request(id(), "beginBlobTransfer", {
        operationId: id(),
        purpose: "raw_source",
        expectedBytes: byteLength,
        expectedSha256: null,
      });
      for (
        let offset = 0, sequence = 0;
        offset < byteLength;
        offset += 65536, sequence++
      ) {
        const bytes = Uint8Array.from(
          { length: Math.min(65536, byteLength - offset) },
          (_, i) => (offset + i) % 251,
        );
        hash.update(bytes);
        await client.sendChunk({
          transferId: upload.transferId,
          sequence,
          offset,
          bytes,
          final: offset + bytes.length === byteLength,
        });
      }
      const digest = bytesToHex(hash.digest());
      await client.request(id(), "finishBlobTransfer", {
        operationId: id(),
        transferId: upload.transferId,
        expectedBytes: byteLength,
        expectedSha256: digest,
      });
      const states = await client.request(id(), "readEntities", {
        collection: "threadStates",
        threadId: null,
        page,
      });
      const state = states.items[0];
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        typeof state.threadId !== "string"
      )
        throw new Error("Fixture conversation is absent");
      const threadId = state.threadId,
        messageId = id(),
        recordedAt = Date.now();
      const text = "Saved archive message 🧪\nSecond preserved line.";
      await client.request(id(), "commit", {
        transactionId: id(),
        expectedThreadRevisions: [],
        stagedBlobIds: [upload.transferId],
        mutations: [
          {
            version: 1,
            operationId: id(),
            recordedAt,
            kind: "CreateMessage",
            payload: {
              message: {
                id: messageId,
                threadId,
                parentId: null,
                role: "user",
                createdAt: recordedAt,
                recordedAt,
                generationId: null,
                editedFromMessageId: null,
                partCount: 1,
                sealed: true,
              },
              parts: [
                { id: id(), messageId, order: 0, kind: "Text", data: { text } },
              ],
            },
          },
          {
            version: 1,
            operationId: id(),
            recordedAt,
            kind: "SetActiveBranch",
            payload: { threadId, value: messageId },
          },
          {
            version: 1,
            operationId: id(),
            recordedAt: Date.now(),
            kind: "RegisterRawObject",
            payload: {
              rawObject: {
                id: rawId,
                availability: "available",
                sha256: digest,
                byteLength,
                mediaType: "application/octet-stream",
                storageRef: `sha256:${digest}`,
              },
            },
          },
        ],
      });
      return { rawId, digest, byteLength, messageId, text };
    });
  },
  async verifyRaw(digest: string) {
    return use(async (client) => {
      const transfer = await client.request(id(), "readBlobTransfer", {
          sha256: digest,
        }),
        hash = sha256.create();
      let byteLength = 0,
        peakChunkBytes = 0;
      for (;;) {
        const chunk = await client.readChunk(transfer.transferId);
        hash.update(chunk.bytes);
        byteLength += chunk.bytes.length;
        peakChunkBytes = Math.max(peakChunkBytes, chunk.bytes.length);
        await client.acknowledgeChunk({
          transferId: transfer.transferId,
          sequence: chunk.sequence,
          committedOffset: chunk.offset + chunk.bytes.length,
        });
        if (chunk.final) break;
      }
      return {
        sha256: bytesToHex(hash.digest()),
        byteLength,
        peakChunkBytes,
        contractMaxChunkBytes: MAX_TRANSFER_BYTES,
      };
    });
  },
  retained: async (archiveId: string) => ({
    threads: await readRetainedArchive(archiveId, id(), "readEntities", {
      collection: "threads",
      threadId: null,
      page,
    }),
    states: await readRetainedArchive(archiveId, id(), "readEntities", {
      collection: "threadStates",
      threadId: null,
      page,
    }),
    sync: await readRetainedArchive(archiveId, id(), "readSyncOperations", {
      afterSequence: 0,
      page,
    }),
  }),
};
Object.assign(window, { restoreAcceptance: api });
await import("../../../../../../../apps/web/src/main.ts");

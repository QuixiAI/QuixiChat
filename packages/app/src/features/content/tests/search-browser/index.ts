import { openActiveStorageClient } from "@quixi/storage/client";
import type { ContentPart, ThreadState } from "@quixi/core/model";
import type {
  CanonicalMutation,
  StorageOperations,
} from "@quixi/core/contracts";
const id = () => crypto.randomUUID();
const calls: { operation: string; args: unknown }[] = [];
let holdNextPart = false;
let heldId: string | null = null;
let heldReply: { worker: Worker; data: unknown } | null = null;
const NativeWorker = Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener("message", (event) => {
      if (event.data?.type === "reply" && event.data.id === heldId) {
        if (heldReply)
          throw Error("Only one synthetic metadata reply may be held");
        heldReply = { worker: this, data: event.data };
        event.stopImmediatePropagation();
      }
    });
  }
  override postMessage(
    message: unknown,
    transfer: Transferable[] | StructuredSerializeOptions = [],
  ) {
    const request = (
      message as { call?: { request?: { operation: string; args: unknown } } }
    )?.call?.request;
    if (
      request &&
      [
        "readEntity",
        "readMessageParts",
        "resolveConversationSearchHit",
        "commit",
      ].includes(request.operation)
    ) {
      if (calls.length >= 2048) throw Error("Proof trace bound exceeded");
      calls.push({
        operation: request.operation,
        args: structuredClone(request.args),
      });
    }
    if (
      holdNextPart &&
      request?.operation === "readEntity" &&
      (request.args as { collection?: string })?.collection === "parts"
    ) {
      holdNextPart = false;
      heldId = (message as { call: { id: string } }).call.id;
    }
    if (Array.isArray(transfer)) super.postMessage(message, transfer);
    else super.postMessage(message, transfer);
  }
};
let client: Awaited<ReturnType<typeof openActiveStorageClient>>;
let seeded: {
  threadId: string;
  messageId: string;
  latePartId: string;
  imagePartId: string;
  attachmentId: string;
  draftThreadId: string;
};
const request = <K extends keyof StorageOperations>(
  operation: K,
  args: StorageOperations[K]["args"],
) => client.request(id(), operation, args);
const mutation = <K extends CanonicalMutation["kind"]>(
  kind: K,
  payload: Extract<CanonicalMutation, { kind: K }>["payload"],
) =>
  ({ version: 1, operationId: id(), recordedAt: 1, kind, payload }) as Extract<
    CanonicalMutation,
    { kind: K }
  >;
const thread = (
  threadId: string,
  contextId: string,
  workspaceId: string,
  title: string,
) =>
  mutation("CreateThread", {
    thread: {
      id: threadId,
      workspaceId,
      createdAt: 1,
      recordedAt: 1,
      systemPrompt: "Keep canonical context intact",
      preferredRoute: null,
      importSourceId: null,
    },
    context: {
      id: contextId,
      threadId,
      previousId: null,
      version: 1,
      systemPrompt: "Keep canonical context intact",
      preferredRoute: null,
      recordedAt: 1,
    },
    state: {
      threadId,
      title,
      tags: [],
      pinned: false,
      archived: false,
      activeLeafMessageId: null,
      contextSnapshotId: contextId,
      routingProfile: null,
      revision: 0,
    },
  });
async function seed() {
  client = await openActiveStorageClient();
  const { workspaceId } = await request("archiveWorkspace", null);
  const threadId = id(),
    messageId = id(),
    attachmentId = id(),
    imagePartId = id(),
    latePartId = id(),
    draftThreadId = id();
  const parts: ContentPart[] = Array.from({ length: 94 }, (_, order) => ({
    id: id(),
    messageId,
    order,
    kind: "Text",
    data: { text: `Ordinary section ${order + 1}.` },
  }));
  parts.push({
    id: latePartId,
    messageId,
    order: 94,
    kind: "Text",
    data: { text: "cassowarylate appears only in the ninety-fifth part." },
  });
  parts.push({
    id: imagePartId,
    messageId,
    order: 95,
    kind: "Image",
    data: {
      attachmentId,
      description: "descriptionfoxtrot is a caption, not the filename.",
    },
  });
  await request("commit", {
    transactionId: id(),
    expectedThreadRevisions: [],
    stagedBlobIds: [],
    mutations: [
      thread(threadId, id(), workspaceId, "Search navigation fixture"),
      thread(draftThreadId, id(), workspaceId, "Draft conversation"),
      mutation("RegisterAttachment", {
        attachment: {
          id: attachmentId,
          availability: "missing",
          filename: "harborneedle-chart.png",
          mimeType: "image/png",
          sizeBytes: null,
          blobSha256: null,
          rawObjectId: null,
        },
      }),
      mutation("CreateMessage", {
        message: {
          id: messageId,
          threadId,
          parentId: null,
          role: "assistant",
          createdAt: 1,
          recordedAt: 1,
          generationId: null,
          editedFromMessageId: null,
          partCount: parts.length,
          sealed: true,
        },
        parts,
      }),
      mutation("SetActiveBranch", { threadId, value: messageId }),
    ],
  });
  const start = performance.now();
  for (;;) {
    const status = await request("advanceSearchIndex", { maxChunks: 16 });
    if (status.state === "failed") throw Error("Search failed");
    if (!status.pendingSources) break;
    if (performance.now() - start > 30000) throw Error("Index proof deadline");
  }
  seeded = {
    threadId,
    messageId,
    latePartId,
    imagePartId,
    attachmentId,
    draftThreadId,
  };
  return seeded;
}
async function snapshot() {
  return {
    diagnostics: await request("diagnostics", null),
    view: await request("readThreadView", { threadId: seeded.threadId }),
  };
}
async function tombstone() {
  const before = (await request("readEntity", {
    collection: "threadStates",
    id: seeded.threadId,
  })) as unknown as ThreadState;
  await request("commit", {
    transactionId: id(),
    expectedThreadRevisions: [
      { threadId: seeded.threadId, revision: before.revision },
    ],
    stagedBlobIds: [],
    mutations: [
      mutation("TombstoneBranch", {
        tombstone: {
          id: id(),
          threadId: seeded.threadId,
          rootMessageId: seeded.messageId,
          createdAt: 2,
          reason: "Synthetic stale search navigation",
        },
        state: {
          ...before,
          activeLeafMessageId: null,
          revision: before.revision + 1,
        },
      }),
    ],
  });
}
Object.assign(window, {
  conversationSearchTest: {
    seed,
    snapshot,
    tombstone,
    holdNextPartRead() {
      if (holdNextPart || heldId || heldReply)
        throw Error("A metadata reply is already held");
      holdNextPart = true;
    },
    held: () => heldReply !== null,
    release() {
      const saved = heldReply;
      heldReply = null;
      heldId = null;
      if (saved)
        saved.worker.dispatchEvent(
          new MessageEvent("message", { data: saved.data }),
        );
    },
    trace: () => structuredClone(calls),
    clearTrace: () => {
      calls.length = 0;
    },
    close: () => client.close(),
  },
});
void import("../../../../../../../apps/web/src/main.ts");

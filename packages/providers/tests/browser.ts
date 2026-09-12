import { createWebHost } from "../../../apps/web/src/host/index.ts";
import { createIsolatedStorageClient as createStorageClient } from "../../storage/tests/isolated-client.ts";
import type { StorageClient, MutationBatch } from "@quixi/core/contracts";
import type { Generation, Message, ContentPart, RawObject } from "@quixi/core/model";
import {
  bindReasoningEvidence,
  createAnthropicAdapter,
  createOpenAICompatibleAdapter,
  parseThinkingReceipt,
  reconstructThinkingReceipts,
  THINKING_RECEIPT_KIND,
  type ProviderEvent,
  type ProviderInput,
  type Protocol,
  type ThinkingReceipt,
} from "../src/index.ts";
import { isReasoningEvidencePart, isInternalProvenancePart } from "@quixi/core/model";
import { startCoordinatedGeneration } from '@quixi/app/workflows/generation';
import { input, model } from "./fixtures.ts";
import { exerciseProviderHost } from "./host-proof.ts";
import { roundTripReasoning } from "./reasoning-archive.ts";
const id = () => crypto.randomUUID(),
  now = () => Date.now(),
  page = { maxItems: 1000, maxBytes: 1_000_000, cursor: null };
const bindings = Object.fromEntries(
  ["openai-compatible", "anthropic"].map((protocol) => [
    protocol,
    {
      providerId: protocol,
      accountId: "synthetic-account",
      destinationId: protocol,
      transportId: "synthetic-direct",
    },
  ]),
) as Parameters<typeof exerciseProviderHost>[1];
const host = () =>
  createWebHost({
    destinations: Object.entries(bindings).map(([protocol, binding]) => ({
      binding,
      baseUrl: location.origin,
      allowInsecureLoopback: true,
      routes: ["/v1/models", "/v1/messages", "/v1/chat/completions", "/v1/messages/count_tokens"].map(
        (path) => ({
          path,
          methods: ["GET", "POST"],
          headers: ["content-type", "anthropic-version"],
          ...(path === "/v1/models"
            ? { query: ["after_id", "before_id", "limit"] }
            : {}),
        }),
      ),
      credential: {
        header: protocol === "anthropic" ? "x-api-key" : "Authorization",
        prefix: protocol === "anthropic" ? "" : "Bearer ",
      },
      transport: {
        kind: "browser_direct",
        privacy: "local",
        relayIdentity: null,
      },
    })),
  });
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
let owner: StorageClient | null = null;
async function readBlob(client: StorageClient, sha256: string) {
  const transfer = await client.request(id(), "readBlobTransfer", { sha256 });
  const bytes = new Uint8Array(transfer.byteLength);
  for (;;) {
    const chunk = await client.readChunk(transfer.transferId);
    bytes.set(chunk.bytes, chunk.offset);
    await client.acknowledgeChunk({
      transferId: chunk.transferId,
      sequence: chunk.sequence,
      committedOffset: chunk.offset + chunk.bytes.length,
    });
    if (chunk.final) return bytes;
  }
}
async function verify(
  archiveId: string,
  generationId: string,
  outputId: string,
) {
  const client = createStorageClient({ archiveId });
  try {
    await client.request(id(), 'reconcileGenerationProducers', { maxProducers: 32 });
    const generation = await client.request(id(), "readEntity", {
      collection: "generations",
      id: generationId,
    });
    assert(generation, "Generation missing after reopen");
    const parts = await client.request(id(), "readMessageParts", {
      messageId: outputId,
      page,
    });
    assert(!parts.nextCursor, "Fixture exceeded one bounded page");
    const raws = parts.items.filter(
      (part: any) =>
        part.kind === "ProviderArtifact" &&
        part.data.providerKind === "quixi.provider.raw-stream-chunk",
    ) as any[];
    let rawText = "";
    const decoder = new TextDecoder();
    for (const part of raws) {
      const raw: any = await client.request(id(), "readEntity", {
        collection: "rawObjects",
        id: part.data.rawObjectId,
      });
      rawText += decoder.decode(await readBlob(client, raw.sha256), {
        stream: true,
      });
    }
    rawText += decoder.decode();
    const raw: any = (generation as any).rawResponseId
      ? await client.request(id(), "readEntity", {
          collection: "rawObjects",
          id: (generation as any).rawResponseId,
        })
      : null;
    const manifest = raw
      ? JSON.parse(new TextDecoder().decode(await readBlob(client, raw.sha256)))
      : null;
    const diagnostics = await client.request(id(), "diagnostics", null);
    const reasoning = [];
    const reasoningBlobs = [];
    for (const part of parts.items as unknown as ContentPart[]) {
      if (part.kind !== "ProviderArtifact" || part.data.providerKind !== "quixi.provider.anthropic-thinking-block") continue;
      const raw = await client.request(id(), "readEntity", { collection: "rawObjects", id: part.data.rawObjectId }) as unknown as RawObject | null;
      assert(raw?.sha256, "Missing thinking receipt bytes");
      reasoningBlobs.push({ sha256: raw.sha256, byteLength: raw.byteLength });
      reasoning.push(JSON.parse(new TextDecoder().decode(await readBlob(client, raw.sha256))));
    }
    return { generation, parts: parts.items, rawText, manifest, diagnostics, reasoning, reasoningBlobs };
  } finally {
    await client.close();
  }
}
async function persist(
  protocol: Protocol,
  mode: string,
  archiveId: string,
  lostReply = false,
  storageFailure = false,
  creationBarrier: "reject" | "cancel" | null = null,
) {
  let client: StorageClient = createStorageClient({ archiveId });
  const web = host();
  const binding = bindings[protocol];
  const credential = await web.storeSecret(
    id(),
    binding,
    new TextEncoder().encode("synthetic-secret"),
    null,
  );
  const threadId = id(),
    contextId = id(),
    parentId = id(),
    outputId = id(),
    generationId = id();
  let dropped = false,
    textCommitted = false;
  const reconnect = async () => {
    await client.close();
    client = createStorageClient({ archiveId });
    return client;
  };
  try {
    const batch: MutationBatch = {
      transactionId: id(),
      expectedThreadRevisions: [],
      stagedBlobIds: [],
      mutations: [
        {
          version: 1,
          operationId: id(),
          kind: "CreateThread",
          recordedAt: now(),
          payload: {
            thread: {
              id: threadId,
              workspaceId: id(),
              createdAt: now(),
              recordedAt: now(),
              systemPrompt: "Synthetic system",
              preferredRoute: null,
              importSourceId: null,
            },
            context: {
              id: contextId,
              threadId,
              previousId: null,
              version: 1,
              systemPrompt: "Synthetic system",
              preferredRoute: null,
              recordedAt: now(),
            },
            state: {
              threadId,
              title: "Synthetic provider proof",
              tags: [],
              pinned: false,
              archived: false,
              activeLeafMessageId: null,
              contextSnapshotId: contextId,
              routingProfile: null,
              revision: 0,
            },
          },
        },
        {
          version: 1,
          operationId: id(),
          kind: "CreateMessage",
          recordedAt: now(),
          payload: {
            message: {
              id: parentId,
              threadId,
              parentId: null,
              role: "user",
              createdAt: now(),
              recordedAt: now(),
              generationId: null,
              editedFromMessageId: null,
              partCount: 1,
              sealed: true,
            },
            parts: [
              {
                id: id(),
                messageId: parentId,
                order: 0,
                kind: "Text",
                data: { text: "Synthetic prompt" },
              },
            ],
          },
        },
      ],
    };
    await client.request(id(), "commit", batch);
    const realRequest = client.request.bind(client);
    if (lostReply || storageFailure)
      client.request = (async (
        requestId: string,
        operation: any,
        args: any,
      ) => {
        if (storageFailure && textCommitted && operation === "commit")
          throw { code: "QUOTA_EXCEEDED" };
        const result = await realRequest(requestId, operation, args);
        if (
          operation === "commit" &&
          args.mutations.some(
            (item: any) =>
              item.kind === "AppendGenerationOutput" &&
              item.payload.newParts.some((part: any) => part.kind === "Text"),
          )
        )
          textCommitted = true;
        if (
          lostReply &&
          operation === "commit" &&
          !dropped &&
          args.mutations.some(
            (item: any) => item.kind === "AppendGenerationOutput" && (protocol !== "anthropic" || item.payload.newParts.some((part: any) => part.kind === "ProviderArtifact" && part.data.providerKind === "quixi.provider.anthropic-thinking-block")),
          )
        ) {
          dropped = true;
          throw { code: "UNKNOWN_OUTCOME" };
        }
        return result;
      }) as StorageClient["request"];
    const adapter = (
      protocol === "anthropic"
        ? createAnthropicAdapter
        : createOpenAICompatibleAdapter
    )({
      host: web,
      binding,
      credential,
      catalog: [model(protocol, mode)],
      nextId: id,
      now,
    });
    const generation: Generation = {
      id: generationId,
      threadId,
      parentMessageId: parentId,
      outputMessageId: outputId,
      contextSnapshotId: contextId,
      provider: binding.providerId,
      providerAccountId: binding.accountId,
      model: mode,
      parameters: {},
      status: "streaming",
      createdAt: now(),
      recordedAt: now(),
      completedAt: null,
      tokensIn: null,
      tokensOut: null,
      cachedTokens: null,
      estimatedCost: null,
      reportedCost: null,
      lastSequence: 0,
      rawResponseId: null,
      compatibility: [],
    };
    const output: Message = {
      id: outputId,
      threadId,
      parentId,
      role: "assistant",
      createdAt: now(),
      recordedAt: now(),
      generationId,
      editedFromMessageId: null,
      partCount: 0,
      sealed: false,
    };
    const run = await startCoordinatedGeneration({
      archiveId,
      adapter,
      input: input(mode),
      storage: client,
      attempt: { generation, output },
      nextId: id,
      now,
      reconnectStorage: reconnect,
      async onCreated(created) {
        assert(
          created.generationId === generationId &&
            created.outputMessageId === outputId,
          "Producer barrier identity changed",
        );
        assert(
          (
            await client.request(id(), "operationStatus", {
              operationId: created.createOperationId,
            })
          ).status === "committed",
          "Producer barrier ran before durable creation",
        );
        if (creationBarrier === "reject")
          throw new Error("Synthetic producer registration rejection");
        if (creationBarrier === "cancel") {
          setTimeout(() => {
            void run.cancel();
          }, 10);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      },
      onCheckpoint(value) {
        Object.assign(window, { providerCheckpoint: value });
        if (mode === "slow")
          void client
            .request(id(), "readMessageParts", { messageId: outputId, page })
            .then((parts) => {
              if (parts.items.some((part: any) => part.kind === "Text"))
                void run.cancel();
            })
            .catch(() => {});
      },
    });
    const result = await run.result;
    await client.close();
    return { result, dropped, archiveId, generationId, outputId };
  } finally {
    await client.close();
    await web.dispose();
  }
}
/** Continue a persisted thinking response: receipts and raw segments are
 * read through the public storage client, bound to the message's generation,
 * mapped into a follow-up request with thinking enabled, counted and sent
 * through the web host's actual HTTP transport to the loopback fixture. */
async function continueReasoning(archiveId: string, generationId: string, outputId: string) {
  const client = createStorageClient({ archiveId });
  const web = host();
  try {
    const generation = (await client.request(id(), "readEntity", { collection: "generations", id: generationId })) as unknown as Generation | null;
    const message = (await client.request(id(), "readEntity", { collection: "messages", id: outputId })) as unknown as Message | null;
    assert(generation?.model && message?.sealed && message.generationId === generationId, "Continuation source is not a sealed generated message");
    const parts = (await client.request(id(), "readMessageParts", { messageId: outputId, page })).items as unknown as ContentPart[];
    const rawObject = async (rawObjectId: string) => {
      const raw = (await client.request(id(), "readEntity", { collection: "rawObjects", id: rawObjectId })) as unknown as RawObject | null;
      assert(raw?.sha256, "Missing raw object for continuation evidence");
      return readBlob(client, raw.sha256);
    };
    const receipts: ThinkingReceipt[] = [];
    const segments: Uint8Array[] = [];
    for (const part of parts) {
      if (part.kind !== "ProviderArtifact") continue;
      if (part.data.providerKind === THINKING_RECEIPT_KIND) receipts.push(parseThinkingReceipt(await rawObject(part.data.rawObjectId)));
      else if (part.data.providerKind === "quixi.provider.raw-stream-chunk") segments.push(await rawObject(part.data.rawObjectId));
    }
    const rebuilt = reconstructThinkingReceipts(segments, { generationId, outputMessageId: outputId, model: generation.model });
    const bound = bindReasoningEvidence({ id: outputId, generationId, model: generation.model }, parts, receipts);
    const rebound = bindReasoningEvidence({ id: outputId, generationId, model: generation.model }, parts, rebuilt);
    const content = parts.filter((part) => !isInternalProvenancePart(part) && !isReasoningEvidencePart(part));
    const binding = bindings.anthropic;
    const credential = await web.storeSecret(id(), binding, new TextEncoder().encode("synthetic-secret"), null);
    const adapter = createAnthropicAdapter({ host: web, binding, credential, catalog: [model("anthropic", generation.model, { thinking: true })], nextId: id, now });
    const followUp = (reasoning: ProviderInput["reasoning"]): ProviderInput => ({
      requestId: id(),
      modelId: generation.model!,
      systemPrompt: "Synthetic system",
      messages: [
        { role: "user", parts: [{ id: id(), messageId: id(), order: 0, kind: "Text", data: { text: "Synthetic prompt" } }] },
        { role: "assistant", parts: content },
        { role: "user", parts: [{ id: id(), messageId: id(), order: 0, kind: "Text", data: { text: "Continue that reasoning" } }] },
      ],
      ...(reasoning ? { reasoning } : {}),
      parameters: { maxOutputTokens: 2048, thinkingBudgetTokens: 1024, topP: 0.95 },
    });
    const input = followUp(bound.reasoning);
    const report = adapter.analyze(input);
    const unverified = adapter.analyze(followUp(undefined));
    const prepared = adapter.prepare(input).body;
    const count = await adapter.countTokens(input);
    const events: ProviderEvent[] = [];
    for await (const event of adapter.stream(input).events) events.push(event);
    const terminal = events.at(-1);
    return {
      receipts, rebuilt, bound, rebound,
      report, unverified,
      prepared: { thinking: prepared.thinking, assistant: (prepared.messages as { content: unknown }[])[1]!.content, maxTokens: prepared.max_tokens, topP: prepared.top_p },
      count,
      terminal: terminal?.type === "terminal" ? { status: terminal.status, responseId: terminal.responseId } : null,
      responseReceipts: events.filter((event) => event.type === "reasoning_block").map((event) => event.type === "reasoning_block" && [event.index, event.block]),
    };
  } finally {
    await client.close();
    await web.dispose();
  }
}
Object.assign(window, {
  async providerProof(operation: string, value: any) {
    if (operation === "continue")
      return continueReasoning(value.archiveId, value.generationId, value.outputId);
    if (operation === "host") {
      const web = host();
      try {
        return await exerciseProviderHost(web, bindings);
      } finally {
        await web.dispose();
      }
    }
    if (operation === "owner") {
      owner = createStorageClient({ archiveId: value });
      return owner.request(id(), "diagnostics", null);
    }
    if (operation === "persist")
      return persist(
        value.protocol,
        value.mode,
        value.archiveId,
        value.lostReply,
        value.storageFailure,
        value.creationBarrier,
      );
    if (operation === "verify")
      return verify(value.archiveId, value.generationId, value.outputId);
    if (operation === "reasoning-archive") {
      const client = createStorageClient({ archiveId: value.archiveId });
      try { return await roundTripReasoning(client, value.blobs); }
      finally { await client.close(); }
    }
    throw new Error("Unknown synthetic operation");
  },
});

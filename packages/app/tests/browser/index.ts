import type { EntityPage, HostCapabilities } from "@quixi/core/contracts";
import { attachmentFingerprint } from './composer-files-storage.ts';
import { mountApp } from "@quixi/app";
import { createIsolatedStorageClient as createStorageClient } from "../../../storage/tests/isolated-client.ts";
import { initialProviderCatalogs, openAIRegionalEvidence } from "@quixi/providers";
import type { ProviderConnection } from "../../src/features/providers/types.ts";
import { createWebHost } from "../../../../apps/web/src/host/index.ts";
import { configuredWebProviders } from "../../../../apps/web/src/configuration.ts";
const archiveId =
  new URL(location.href).searchParams.get("archive") ?? "test-app-acceptance";
const unavailable = new URL(location.href).searchParams.has("invalid-relay")
  ? configuredWebProviders("{invalid")
  : null;
const connections: ProviderConnection[] =
  unavailable?.connections ??
  initialProviderCatalogs().map((catalog) => ({
    id: catalog.providerId,
    label: catalog.providerId === "openai" ? "OpenAI" : "Anthropic",
    catalog,
    relayAuthorizationRequired: false,
    binding: {
      providerId: catalog.providerId,
      accountId: "primary",
      destinationId: catalog.providerId,
      transportId: catalog.providerId,
    },
  }));
if (!unavailable) for (const region of ['us', 'eu'] as const) connections.push({
  id: `openai-${region}`, label: region === 'us' ? 'OpenAI · US' : 'OpenAI · Europe (EEA + Switzerland)',
  catalog: initialProviderCatalogs().find(catalog => catalog.providerId === 'openai')!,
  relayAuthorizationRequired: false, processingRegion: region, binding: openAIRegionalEvidence(region).binding,
});
Object.defineProperty(window, "showSaveFilePicker", {
  value: undefined,
  configurable: true,
});
const wireHost = createWebHost({
  fileStagingNamespace: archiveId,
  destinations: unavailable
    ? []
    : connections.map((connection) => ({
        binding: connection.binding,
        baseUrl: location.origin,
        allowInsecureLoopback: true,
        transport: {
          kind: "browser_direct",
          privacy: "local",
          relayIdentity: null,
        },
        credential: {
          header: connection.catalog.providerId === "openai" ? "Authorization" : "x-api-key",
          prefix: connection.catalog.providerId === "openai" ? "Bearer " : "",
        },
        routes: [
          {
            path: "/v1/models",
            methods: ["GET"],
            headers: ["anthropic-version"],
            ...(connection.id === "anthropic"
              ? { query: ["after_id", "before_id", "limit"] }
              : {}),
          },
          {
            path:
              connection.catalog.providerId === "openai"
                ? "/v1/chat/completions"
                : "/v1/messages",
            methods: ["POST"],
            headers: ["content-type", "anthropic-version"],
          },
          ...(connection.id === "anthropic"
            ? [
                {
                  path: "/v1/messages/count_tokens",
                  methods: ["POST" as const],
                  headers: ["content-type", "anthropic-version"],
                },
              ]
            : []),
        ],
      })),
});
const providerDispatches: { binding: import('@quixi/core/contracts').ProviderBinding; path: string; method: string }[] = [];
// Explicit UI/controller fixture declarations. The actual HTTP transport below
// is the unchanged production WebHost on loopback; this is not native host or
// physical-region evidence and does not loosen any production validator.
const host = {
  ...wireHost,
  async capabilities(): Promise<HostCapabilities> {
    const caps = await wireHost.capabilities();
    return { ...caps, providerTransports: caps.providerTransports.map(transport => {
      const connection = connections.find(item => item.binding.transportId === transport.id)!;
      if (!connection.processingRegion) return transport;
      const evidence = openAIRegionalEvidence(connection.processingRegion);
      return { ...transport, kind: 'native_direct', privacy: 'direct_provider', endpointOrigin: evidence.upstreamOrigin, regionalProcessing: evidence };
    }) };
  },
  startProviderHttp(request: import('@quixi/core/contracts').ProviderHttpRequest, beforeDispatch?: () => Promise<void>) {
    providerDispatches.push({ binding: structuredClone(request.binding), path: request.path, method: request.method });
    return wireHost.startProviderHttp(request, beforeDispatch);
  },
};
const storage = createStorageClient({ archiveId });
// Count every production storage request the shared app makes and the byte
// size each bounded page reports, so scale scenarios can show that no view
// reads the archive whole.
const requestStats: Record<string, { calls: number; maxBytes: number }> = {};
const originalRequest = storage.request.bind(storage);
let loseNextPreferenceReply = false;
let heldPreferenceReply: Promise<void> | null = null;
let releasePreferenceReply: (() => void) | null = null;
let loseNextAliasReply = false;
let loseSummaryReply = false;
let loseBranchReply = false;
let rejectNextCommit = false;
let heldCommitReply: Promise<void> | null = null;
let releaseCommitReply: (() => void) | null = null;
let commitReplyWaiting = false;
storage.request = (async (requestId: string, operation: string, args: unknown) => {
  const entry = (requestStats[operation] ??= { calls: 0, maxBytes: 0 });
  entry.calls++;
  if (operation === "commit" && rejectNextCommit) {
    rejectNextCommit = false;
    throw Object.assign(new Error("Synthetic storage quota refusal before commit"), { code: "QUOTA_EXCEEDED" });
  }
  const result = await originalRequest(requestId, operation as never, args as never);
  if (operation === "commit" && heldCommitReply) {
    const held = heldCommitReply; heldCommitReply = null; commitReplyWaiting = true;
    try { await held; } finally { commitReplyWaiting = false; }
  }
  if ((operation === "setSendKey" || operation === "setInteractionPreferences") && heldPreferenceReply) {
    const held = heldPreferenceReply;
    heldPreferenceReply = null;
    await held;
  }
  if (operation === "commit" && loseBranchReply && (args as import("@quixi/core/contracts").MutationBatch).mutations.some(mutation => mutation.kind === "CreateThreadEvent" && mutation.payload.event.details.action === "start_branch")) {
    loseBranchReply = false;
    throw Object.assign(new Error("Synthetic lost fresh branch reply"), { code: "UNKNOWN_OUTCOME" });
  }
  if (operation === "putRoutingAlias" && loseNextAliasReply) {
    loseNextAliasReply = false;
    throw new Error("Synthetic lost alias reply after durable write");
  }
  if ((operation === "setSendKey" || operation === "setInteractionPreferences") && loseNextPreferenceReply) {
    loseNextPreferenceReply = false;
    throw new Error("Synthetic lost preference reply after durable write");
  }
  if (operation === "commit" && loseSummaryReply && (args as import("@quixi/core/contracts").MutationBatch).mutations.some(mutation => mutation.kind === "CreateThreadEvent" && mutation.payload.event.details.action === "apply_summary")) {
    loseSummaryReply = false;
    throw Object.assign(new Error("Synthetic lost summary apply reply"), { code: "UNKNOWN_OUTCOME" });
  }
  const bytes = (result as { bytes?: unknown } | null)?.bytes;
  if (typeof bytes === "number" && bytes > entry.maxBytes) entry.maxBytes = bytes;
  return result;
}) as typeof storage.request;
let healthClockOffset = 0;
const unmount = mountApp(document.getElementById("app")!, {
  archiveId,
  storage,
  host,
  // `?embedding=missing` points at an unprovisioned model so the app's explicit
  // unavailability path can be exercised without breaking lexical search.
  embedding: new URL(location.href).searchParams.get("embedding") === "missing"
    ? { modelUrl: "/models/missing.qxmodel", cacheDirectory: null } // no verified OPFS copy may substitute
    : { modelUrl: "/models/arctic-xs.qxmodel" },
  startupNotice: unavailable?.notice ?? null,
  temporaryDownloads: {
    list: host.listTemporaryDownloads,
    clear: (id) => host.clearTemporaryDownload(crypto.randomUUID(), id),
  },
  providerSettings: {
    now: () => Date.now() + healthClockOffset,
    connections,
    credentialCapability: {
      available: true,
      permission: "not_required",
      reason: null,
    },
  },
});
Object.assign(window, {
  appAcceptance: {
    advanceHealthClock: (milliseconds: number) => { if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 3_600_000) throw new Error('Invalid fixture clock advance'); healthClockOffset += milliseconds; window.dispatchEvent(new Event('focus')); },
    resetHealthClock: () => { healthClockOffset = 0; window.dispatchEvent(new Event('focus')); },
    rejectNextCommit: () => { rejectNextCommit = true; },
    holdCommitReply: () => { if (releaseCommitReply) throw new Error("Only one synthetic commit reply may be held"); heldCommitReply = new Promise(resolve => { releaseCommitReply = resolve; }); },
    commitReplyWaiting: () => commitReplyWaiting,
    releaseCommitReply: () => { releaseCommitReply?.(); releaseCommitReply = null; },
    attachmentFingerprint: (sha256: string) => attachmentFingerprint(storage, sha256),
    providerDispatches: () => structuredClone(providerDispatches),
    loseSummaryReply: () => { loseSummaryReply = true; },
    loseBranchReply: () => { loseBranchReply = true; },
    aliases: () => storage.request(crypto.randomUUID(), "readRoutingAliases", null),
    putAlias: (expectedRevision: number, alias: import("@quixi/core/contracts").RoutingAlias) => storage.request(crypto.randomUUID(), "putRoutingAlias", { expectedRevision, alias }),
    loseAliasReply: () => { loseNextAliasReply = true; },
    sync: (afterSequence = 0) => storage.request(crypto.randomUUID(), "readSyncOperations", { afterSequence, page: { maxItems: 64, maxBytes: 900000, cursor: null } }),
    losePreferenceReply: () => { loseNextPreferenceReply = true; },
    holdPreferenceReply: () => { if (releasePreferenceReply) throw new Error('Only one synthetic preference reply may be held'); heldPreferenceReply = new Promise(resolve => { releasePreferenceReply = resolve; }); },
    releasePreferenceReply: () => { releasePreferenceReply?.(); releasePreferenceReply = null; },
    preferences: () => storage.request(crypto.randomUUID(), "readLocalPreferences", null),
    setSendKey: (expectedRevision: number, sendKey: "enter" | "mod-enter") => storage.request(crypto.randomUUID(), "setSendKey", { expectedRevision, sendKey }),
    setInteractionPreferences: (expectedRevision: number, preferences: { showTimestamps: boolean; showModelBadges: boolean; composerLayout: 'comfortable' | 'compact'; modelSwitcherStyle: 'select' | 'list' }) => storage.request(crypto.randomUUID(), "setInteractionPreferences", { expectedRevision, preferences }),
    async records(
      collection:
        | "messages"
        | "generations"
        | "threadStates"
        | "parts"
        | "contexts"
        | "attachments"
        | "events"
        | "threads"
        | "summaryProposals"
        | "rawObjects",
    ) {
      // Every record of the collection, read in bounded pages (up to eight).
      const items: unknown[] = [];
      let cursor: string | null = null, bytes = 0, nextCursor: string | null = null;
      for (let pages = 0; pages < 8; pages++) {
        const page: EntityPage = await storage.request(crypto.randomUUID(), "readEntities", {
          collection,
          threadId: null,
          page: { maxItems: 64, maxBytes: 900000, cursor },
        });
        items.push(...page.items);
        bytes += page.bytes;
        nextCursor = page.nextCursor;
        if (!nextCursor) break;
        cursor = nextCursor;
      }
      return { items, nextCursor, bytes };
    },
    async parts(messageId: string) {
      return storage.request(crypto.randomUUID(), "readMessageParts", {
        messageId,
        page: { maxItems: 64, maxBytes: 900000, cursor: null },
      });
    },
    async status() {
      return storage.request(crypto.randomUUID(), "searchStatus", null);
    },
    requestStats() {
      return structuredClone(requestStats);
    },
    /** Stage a verified PNG attachment through the production worker and
     * commit a thread whose sealed user message carries it as an Image part. */
    async seedImageThread(pngBase64: string, title = "Image thread") {
      const id = () => crypto.randomUUID();
      const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const { workspaceId } = await storage.request(id(), "archiveWorkspace", null);
      const stage = await storage.request(id(), "beginBlobTransfer", { operationId: id(), purpose: "attachment", expectedBytes: bytes.length, expectedSha256: sha256 });
      await storage.sendChunk({ transferId: stage.transferId, sequence: 0, offset: 0, bytes, final: false });
      await storage.sendChunk({ transferId: stage.transferId, sequence: 1, offset: bytes.length, bytes: new Uint8Array(), final: true });
      await storage.request(id(), "finishBlobTransfer", { operationId: id(), transferId: stage.transferId, expectedBytes: bytes.length, expectedSha256: sha256 });
      const now = Date.now(), threadId = id(), contextId = id(), attachmentId = id(), messageId = id();
      const mutation = (kind: string, payload: unknown) => ({ version: 1, operationId: id(), kind, recordedAt: now, payload });
      await storage.request(id(), "commit", {
        transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [stage.transferId],
        mutations: [
          mutation("RegisterAttachment", { attachment: { id: attachmentId, availability: "available", filename: "seed.png", mimeType: "image/png", sizeBytes: bytes.length, blobSha256: sha256, rawObjectId: null } }),
          mutation("CreateThread", {
            thread: { id: threadId, workspaceId, createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
            context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
            state: { threadId, title, tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
          }),
          mutation("CreateMessage", {
            message: { id: messageId, threadId, parentId: null, role: "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 2, sealed: true },
            parts: [
              { id: id(), messageId, order: 0, kind: "Text", data: { text: "What is in this picture?" } },
              { id: id(), messageId, order: 1, kind: "Image", data: { attachmentId, description: "seeded PNG" } },
            ],
          }),
          mutation("SetActiveBranch", { threadId, value: messageId }),
        ],
      } as never);
      return { threadId, messageId, attachmentId, sha256, byteLength: bytes.length };
    },
    /** Commit a thread whose sealed assistant turn carries reasoning metadata
     * that no configured adapter maps, so its portability is blocked. */
    async seedPortabilityThread() {
      const id = () => crypto.randomUUID();
      const { workspaceId } = await storage.request(id(), "archiveWorkspace", null);
      const now = Date.now(), threadId = id(), contextId = id(), userId = id(), assistantId = id();
      const mutation = (kind: string, payload: unknown) => ({ version: 1, operationId: id(), kind, recordedAt: now, payload });
      await storage.request(id(), "commit", {
        transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [],
        mutations: [
          mutation("CreateThread", {
            thread: { id: threadId, workspaceId, createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
            context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
            state: { threadId, title: "Portability thread", tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
          }),
          mutation("CreateMessage", {
            message: { id: userId, threadId, parentId: null, role: "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
            parts: [{ id: id(), messageId: userId, order: 0, kind: "Text", data: { text: "Which comet returns in 2061?" } }],
          }),
          mutation("CreateMessage", {
            message: { id: assistantId, threadId, parentId: userId, role: "assistant", createdAt: now + 1, recordedAt: now + 1, generationId: null, editedFromMessageId: null, partCount: 2, sealed: true },
            parts: [
              { id: id(), messageId: assistantId, order: 0, kind: "Text", data: { text: "Halley's comet." } },
              { id: id(), messageId: assistantId, order: 1, kind: "ReasoningMetadata", data: { redacted: true, summary: null } },
            ],
          }),
          mutation("SetActiveBranch", { threadId, value: assistantId }),
        ],
      } as never);
      return { threadId, userId, assistantId };
    },
    /** Commit one sealed user message per entry through the production worker. */
    async seedTexts(entries: { title: string; text: string }[]) {
      const id = () => crypto.randomUUID();
      const { workspaceId } = await storage.request(id(), "archiveWorkspace", null);
      const now = Date.now();
      const mutation = (kind: string, payload: unknown, recordedAt: number) => ({ version: 1, operationId: id(), kind, recordedAt, payload });
      const seeded: { threadId: string; messageId: string }[] = [];
      const mutations: unknown[] = [];
      entries.forEach((entry, index) => {
        const at = now + index, threadId = id(), contextId = id(), messageId = id();
        mutations.push(mutation("CreateThread", {
          thread: { id: threadId, workspaceId, createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null },
          context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: at },
          state: { threadId, title: entry.title, tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
        }, at), mutation("CreateMessage", {
          message: { id: messageId, threadId, parentId: null, role: "user", createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
          parts: [{ id: id(), messageId, order: 0, kind: "Text", data: { text: entry.text } }],
        }, at), mutation("SetActiveBranch", { threadId, value: messageId }, at));
        seeded.push({ threadId, messageId });
      });
      await storage.request(id(), "commit", { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations } as never);
      return seeded;
    },
    semanticStatus: () => storage.request(crypto.randomUUID(), "semanticStatus", null),
    /** Plan 22 scale proof: the production Storage Worker's semantic path at
     * 100k+ chunks on this browser's OPFS. Vectors are deterministic synthetic
     * unit vectors published through the real claim→publish protocol (the
     * embedding worker is not involved); planted topic vectors make the
     * expected top hit of each query known. */
    semanticScale: {
      async seed(options: { threads: number; perThread: number; planted: number }) {
        const id = () => crypto.randomUUID();
        const { workspaceId } = await storage.request(id(), "archiveWorkspace", null);
        const started = performance.now();
        let batches = 0;
        const commit = async (mutations: unknown[]) => {
          for (let at = 0; at < mutations.length; at += 125) {
            batches++;
            await storage.request(id(), "commit", { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: mutations.slice(at, at + 125) } as never);
          }
        };
        const mutation = (kind: string, payload: unknown, recordedAt: number) => ({ version: 1, operationId: id(), kind, recordedAt, payload });
        const base = Date.now() - options.threads * options.perThread * 1000, threadIds: string[] = [], planted: { topic: number; messageId: string; threadId: string }[] = [];
        let pending: unknown[] = [];
        for (let t = 0; t < options.threads; t++) {
          const threadId = id(), contextId = id(), at = base + t * options.perThread * 1000;
          threadIds.push(threadId);
          pending.push(mutation("CreateThread", {
            thread: { id: threadId, workspaceId, createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null },
            context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: at },
            state: { threadId, title: `Scale thread ${String(t + 1).padStart(5, "0")}`, tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
          }, at));
          let parent: string | null = null;
          for (let n = 0; n < options.perThread; n++) {
            const messageId = id(), when = at + n * 1000;
            const plant = t < options.planted && n === Math.floor(options.perThread / 2) ? t : -1;
            const text = plant >= 0 ? `Planted topic ${plant} signal passage in thread ${t + 1}.` : `Passage ${n + 1} of thread ${t + 1} discussing item ${(t * 31 + n * 7) % 997}.`;
            pending.push(mutation("CreateMessage", { message: { id: messageId, threadId, parentId: parent, role: n % 2 ? "assistant" : "user", createdAt: when, recordedAt: when, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true }, parts: [{ id: id(), messageId, order: 0, kind: "Text", data: { text } }] }, when));
            if (plant >= 0) planted.push({ topic: plant, messageId, threadId });
            parent = messageId;
            if (n === options.perThread - 1) pending.push(mutation("SetActiveBranch", { threadId, value: messageId }, when));
            if (pending.length >= 120) { await commit(pending); pending = []; }
          }
        }
        if (pending.length) await commit(pending);
        return { seedMs: performance.now() - started, batches, threadIds, planted };
      },
      async index() {
        const started = performance.now();
        let status = await storage.request(crypto.randomUUID(), "searchStatus", null), slices = 0, lastLog = started;
        while (status.pendingSources > 0 || status.state === "indexing") {
          status = await storage.request(crypto.randomUUID(), "advanceSearchIndex", { maxChunks: 128 });
          slices++;
          if (slices > 200_000) throw new Error("Lexical indexing did not finish");
          if (slices % 100 === 0) { const now = performance.now(); console.log(`[scale] slices ${slices} indexed ${status.indexedChunks} pending ${status.pendingSources} ms/slice ${((now - lastLog) / 100).toFixed(1)}`); lastLog = now; }
        }
        return { indexMs: performance.now() - started, slices, indexedChunks: status.indexedChunks, version: status.version };
      },
      async enroll() {
        const index = await storage.request(crypto.randomUUID(), "searchStatus", null);
        return storage.request(crypto.randomUUID(), "enrollSemantic", { operationId: crypto.randomUUID(), model: { modelName: "synthetic-scale-vectors", modelVersion: "seeded-unit-vectors-v1", sourceHash: "0".repeat(64), dimensions: 384, tokenizerVersion: "none", preprocessingVersion: "none", chunkingVersion: index.version, storageRepresentation: "float32" } });
      },
      /** Publishes up to `limit` vectors through claim→publish; planted texts get their topic direction. */
      async publish(options: { limit: number }) {
        const started = performance.now();
        let published = 0, rounds = 0;
        const vectorFor = (text: string, digest: string) => {
          const v = new Float64Array(384);
          const plant = /Planted topic (\d+) signal/.exec(text);
          let seed = parseInt(digest.slice(0, 8), 16) >>> 0;
          const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
          for (let d = 0; d < 384; d++) v[d] = rand() - 0.5;
          if (plant) { for (let d = 0; d < 384; d++) v[d] = v[d]! * 0.05; v[Number(plant[1])] = 1; }
          let n = 0; for (let d = 0; d < 384; d++) n += v[d]! * v[d]!;
          n = Math.sqrt(n);
          return Array.from(v, (x) => x / n);
        };
        while (published < options.limit) {
          const claim = await storage.request(crypto.randomUUID(), "claimSemanticChunks", { maxChunks: Math.min(64, options.limit - published), maxBytes: 1_048_576 });
          if (!claim.items.length) break;
          const publication = await storage.request(crypto.randomUUID(), "publishSemanticVectors", { generation: claim.generation, items: claim.items.map((item) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: vectorFor(item.text, item.textDigest) })) });
          if (publication.rejected.length) throw new Error(`Rejected: ${JSON.stringify(publication.rejected[0])}`);
          published += publication.accepted; rounds++;
        }
        return { publishMs: performance.now() - started, published, rounds, status: await storage.request(crypto.randomUUID(), "semanticStatus", null) };
      },
      topicVector(topic: number) { const v = new Array<number>(384).fill(0); v[topic] = 1; return v; },
      async query(args: { mode: "exact" | "best" | "semantic"; query: string; queryVector?: number[]; filters: Record<string, unknown>; maxItems: number }) {
        const started = performance.now();
        const result = await storage.request(crypto.randomUUID(), "searchArchive", { mode: args.mode, query: args.query, ...(args.queryVector ? { queryVector: args.queryVector } : {}), filters: args.filters, page: { maxItems: args.maxItems, maxBytes: 900_000, cursor: null } } as never);
        return { ms: performance.now() - started, count: result.items.length, top: result.items.slice(0, 3).map((hit) => ({ messageId: hit.messageId, threadId: hit.threadId, explanation: hit.explanation })), bytes: result.bytes };
      },
    },
    resetRequestStats() {
      for (const key of Object.keys(requestStats)) delete requestStats[key];
    },
    /** Seed a large library and one long conversation through the production
     * worker in bounded batches; titles and texts are synthetic and unique. */
    async seed(options: { threads: number; longMessages: number }) {
      const id = () => crypto.randomUUID();
      const { workspaceId } = await storage.request(id(), "archiveWorkspace", null);
      const started = performance.now();
      let batches = 0;
      const commit = async (mutations: unknown[]) => {
        for (let at = 0; at < mutations.length; at += 125) {
          batches++;
          await storage.request(id(), "commit", {
            transactionId: id(),
            expectedThreadRevisions: [],
            stagedBlobIds: [],
            mutations: mutations.slice(at, at + 125),
          } as never);
        }
      };
      const mutation = (kind: string, payload: unknown, recordedAt: number) => ({
        version: 1, operationId: id(), kind, recordedAt, payload,
      });
      const thread = (title: string, at: number) => {
        const threadId = id(), contextId = id();
        return { threadId, create: mutation("CreateThread", {
          thread: { id: threadId, workspaceId, createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null },
          context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: at },
          state: { threadId, title, tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
        }, at) };
      };
      const message = (threadId: string, parentId: string | null, role: "user" | "assistant", text: string, at: number) => {
        const messageId = id();
        return { messageId, create: mutation("CreateMessage", {
          message: { id: messageId, threadId, parentId, role, createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
          parts: [{ id: id(), messageId, order: 0, kind: "Text", data: { text } }],
        }, at) };
      };
      const base = Date.now() - options.threads * 1000 - options.longMessages * 1000;
      let pending: unknown[] = [];
      for (let n = 1; n <= options.threads; n++) {
        const at = base + n * 1000;
        const t = thread(`Thread ${String(n).padStart(4, "0")}`, at);
        const m = message(t.threadId, null, "user", `Opening question for thread ${n}`, at);
        pending.push(t.create, m.create, mutation("SetActiveBranch", { threadId: t.threadId, value: m.messageId }, at));
        if (pending.length >= 120) { await commit(pending); pending = []; }
      }
      const longAt = base + options.threads * 1000;
      const long = thread("Long conversation", longAt);
      pending.push(long.create);
      let parent: string | null = null;
      for (let n = 1; n <= options.longMessages; n++) {
        const at = longAt + n * 1000;
        const m = message(long.threadId, parent, n % 2 ? "user" : "assistant", `Message ${n} of the long conversation.`, at);
        parent = m.messageId;
        pending.push(m.create);
        if (n === options.longMessages) pending.push(mutation("SetActiveBranch", { threadId: long.threadId, value: m.messageId }, at));
        if (pending.length >= 120) { await commit(pending); pending = []; }
      }
      if (pending.length) await commit(pending);
      return { seedMs: performance.now() - started, batches, longThreadId: long.threadId };
    },
    async prepareUnclaimedExport() {
      let job = await storage.request(
        crypto.randomUUID(),
        "beginArchiveExport",
        { operationId: crypto.randomUUID(), format: "portable" },
      );
      while (job.state === "working")
        job = await storage.request(crypto.randomUUID(), "advanceArchiveJob", {
          operationId: crypto.randomUUID(),
          jobId: job.jobId,
          maxRecords: 64,
          maxBytes: 262144,
        });
      if (job.state !== "ready" || !job.output)
        throw new Error("Export fixture did not complete");
      return job;
    },
    async close() {
      await unmount();
      await storage.close();
      await host.dispose();
    },
  },
});

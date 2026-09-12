import { describeStorageError } from "./storage-error.ts";
import type {
  CanonicalMutation,
  ArchiveActivationArgs,
  ArchiveActivationStatus,
  ArchiveSelection,
  HostClient,
  LibraryThread,
  MutationBatch,
  SearchPage,
  StorageClient,
  ThreadView,
  ViewPage,
} from "@quixi/core/contracts";
import type { RegionalProcessingEvidence, EntityPage } from "@quixi/core/contracts";
import type { ContentPart, Generation, ImportSource, JsonObject, Message, ThreadEvent } from "@quixi/core/model";
import type { ProviderSettingsOptions } from "../features/providers/types.ts";
import type { ModelDescription, ProviderAdapter } from "@quixi/providers";
export interface ConfiguredProvider {
  id: string;
  label: string;
  adapter: ProviderAdapter;
  models: readonly ModelDescription[];
  /** The host-reported privacy class of this connection's transport. */
  privacy?: string | null;
  regionalProcessing?: RegionalProcessingEvidence;
}
export interface AppServices {
  archiveId: string;
  storage: StorageClient;
  host: HostClient;
  startupNotice?: string | null;
  archiveSession?: {
    selection: ArchiveSelection;
    activationStatus(operationId: string, args?: ArchiveActivationArgs): Promise<ArchiveActivationStatus>;
    onSelectionChange(listener: (selection: ArchiveSelection) => void): () => void;
    reconcilePreviousOperations(operationIds: readonly string[]): Promise<'committed' | 'not_committed'>;
    reconcilePreviousExtractionOperation?(pending: { operationId: string; requestDigest: string }): Promise<'committed' | 'not_committed'>;
    /** Explicit user action after a verified switch; host awaits old teardown. */
    openSelectedArchive(expected?: ArchiveSelection): Promise<void>;
  };
  providers?: readonly ConfiguredProvider[];
  providerSettings?: Omit<ProviderSettingsOptions, "host" | "onChange">;
  /** Where the host serves the separately provisioned embedding model;
   * absent when the host cannot offer local semantic search. */
  embedding?: { modelUrl: string; preferGpu?: boolean; cacheDirectory?: string | null };
  temporaryDownloads?: {
    list(): Promise<
      readonly {
        id: string;
        name: string;
        byteLength: number;
        createdAt: number;
      }[]
    >;
    clear(id: string): Promise<void>;
  };
}
export interface DisplayMessage {
  message: Message;
  generation: Generation | null;
  parts: ContentPart[];
  nextParts: string | null;
}
export interface PendingRecovery {
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly message: string;
  readonly checking: boolean;
}
export interface LibrarySnapshot {
  workspaceId: string | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  library: ViewPage<LibraryThread>;
  archived: boolean;
  titleFilter: string;
  libraryDirty: boolean;
  thread: ThreadView | null;
  messages: DisplayMessage[];
  /** Recorded switches, compactions and fallbacks for the open conversation (bounded page). */
  events: ThreadEvent[];
  /** Where an imported conversation came from, when the open thread was
   * imported and its source record is found (bounded lookup). */
  origin: { kind: "import"; provider: string; method: string } | null;
  older: string | null;
  leaf: string | null;
  branches: ViewPage<Message>;
  branchParent: string | null;
  search: SearchPage | null;
  query: string;
  busy: boolean;
  pendingMutation: boolean;
  pendingRecovery: Readonly<PendingRecovery> | null;
}
export interface FreshBranchScope {
  threadId: string;
  revision: number;
  contextId: string;
  leaf: string;
}
const id = () => crypto.randomUUID();
const budget = { maxItems: 24, maxBytes: 200_000, cursor: null };
const empty = <T>(): ViewPage<T> => ({ items: [], nextCursor: null, bytes: 2 });
const errorText = (error: unknown) => describeStorageError(error);
export function createLibraryController(services: AppServices) {
  const storage = services.storage;
  let archiveSelectionChanged = false;
  const unsubscribeSelection = services.archiveSession?.onSelectionChange?.(() => { archiveSelectionChanged = true; });
  let state: LibrarySnapshot = Object.freeze({
    workspaceId: null,
    loading: true,
    error: null,
    notice: null,
    library: empty<LibraryThread>(),
    archived: false,
    titleFilter: "",
    libraryDirty: false,
    thread: null,
    messages: [],
    events: [],
    origin: null,
    older: null,
    leaf: null,
    branches: empty<Message>(),
    branchParent: null,
    search: null,
    query: "",
    busy: false,
    pendingMutation: false,
    pendingRecovery: null,
  });
  const listeners = new Set<() => void>();
  let disposed = false,
    initialized = false,
    viewEpoch = 0,
    listEpoch = 0,
    searchEpoch = 0,
    branchEpoch = 0,
    unsubscribe: (() => void) | null = null,
    timer: ReturnType<typeof setTimeout> | null = null;
  let activeViewLoads = 0,
    viewDirty = false,
    selectionEpoch = 0,
    pendingSelectionEpoch = 0;
  let recoveryTask: Promise<void> | null = null;
  let errorRevision = 0;
  let pending: MutationBatch | null = null,
    currentListCursor: string | null = null;
  const previousListCursors: (string | null)[] = [];
  let currentWindowCursor: string | null = null;
  let viewTarget: {
    threadId: string;
    leaf: string | null;
    cursor: string | null;
  } | null = null;
  const partCursors = new Map<string, string | null>();
  const patch = (change: Partial<LibrarySnapshot>) => {
    if (disposed) return;
    if (Object.hasOwn(change, "error")) errorRevision++;
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener();
  };
  async function perform(work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      patch({ error: errorText(error) });
    }
  }
  async function commit(
    mutations: CanonicalMutation[],
    revision?: { threadId: string; revision: number },
    stagedBlobIds: readonly string[] = [],
  ): Promise<void> {
    if (pending)
      throw new Error(
        "Reconcile the pending change before making another change.",
      );
    const batch = structuredClone({
      transactionId: id(),
      mutations,
      expectedThreadRevisions: revision ? [revision] : [],
      stagedBlobIds: [...stagedBlobIds],
    });
    const freeze = (value: object) => {
      for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
      Object.freeze(value);
    };
    freeze(batch);
    const threadIds = new Set<string>();
    if (revision) threadIds.add(revision.threadId);
    for (const item of batch.mutations) {
      const payload = item.payload as unknown as Record<string, unknown>;
      for (const value of [payload, payload.state, payload.message, payload.context, payload.generation, payload.event, payload.tombstone]) {
        if (value && typeof value === "object" && "threadId" in value && typeof value.threadId === "string") threadIds.add(value.threadId);
      }
    }
    const threadId = threadIds.size === 1 ? [...threadIds][0]! : null;
    const created = batch.mutations.find(item => item.kind === "CreateThread" && item.payload.thread.id === threadId);
    const threadTitle = threadId && state.thread?.thread.id === threadId && typeof state.thread.state.title === "string"
      ? state.thread.state.title : created?.kind === "CreateThread" ? created.payload.state.title : null;
    pending = batch;
    pendingSelectionEpoch = selectionEpoch;
    patch({ pendingMutation: true });
    try {
      await storage.request(id(), "commit", batch);
      pending = null;
    } catch (error) {
      if ((error as { code?: string }).code === "UNKNOWN_OUTCOME") {
        patch({ pendingRecovery: Object.freeze({ threadId, threadTitle, message: errorText(error), checking: false }) });
      } else pending = null;
      throw error;
    } finally {
      patch({ pendingMutation: pending !== null });
    }
  }
  async function loadLibrary(cursor: string | null = null) {
    const epoch = ++listEpoch,
      args = {
        archived: state.archived,
        title: state.titleFilter,
        page: { ...budget, cursor },
      };
    const library = await storage.request(id(), "listLibrary", args);
    if (disposed || epoch !== listEpoch) return;
    currentListCursor = cursor;
    patch({ library, libraryDirty: false });
  }
  async function loadView(
    threadId: string,
    leaf: string | null,
    cursor: string | null = null,
    automatic = false,
  ) {
    if (disposed) return;
    if (!automatic) selectionEpoch++;
    if (timer) clearTimeout(timer);
    timer = null;
    viewDirty = false;
    activeViewLoads++;
    const epoch = ++viewEpoch;
    viewTarget = { threadId, leaf, cursor };
    try {
      await readView(epoch, threadId, leaf, cursor);
    } catch (error) {
      // An older navigation must not replace the current view's error either.
      if (!disposed && epoch === viewEpoch) throw error;
    } finally {
      activeViewLoads--;
      scheduleViewRefresh();
    }
  }
  function scheduleViewRefresh() {
    if (disposed || archiveSelectionChanged || !viewDirty || !viewTarget || activeViewLoads || timer) return;
    // One dirty bit survives notifications during reads. Automatic updates wait
    // for publication instead of repeatedly superseding a slow view load.
    timer = setTimeout(() => {
      timer = null;
      if (disposed || archiveSelectionChanged || !viewDirty || !viewTarget || activeViewLoads) return;
      const target = viewTarget;
      void perform(() => loadView(target.threadId, target.leaf, target.cursor, true));
    }, 200);
  }
  async function readView(epoch: number, threadId: string, leaf: string | null, cursor: string | null) {
    const thread = await storage.request(id(), "readThreadView", { threadId });
    if (disposed || epoch !== viewEpoch) return;
    const selected = leaf ?? thread.state.activeLeafMessageId;
    const messages = await storage.request(id(), "readConversationWindow", {
      threadId,
      leafMessageId: selected,
      page: { ...budget, maxItems: 12, cursor },
    });
    if (disposed || epoch !== viewEpoch) return;
    const displayed: DisplayMessage[] = [];
    // Four controls at a time; only twelve visible messages and their current part pages are retained.
    for (let offset = 0; offset < messages.items.length; offset += 4) {
      // Wait for sibling reads even on failure so the automatic refresh slot
      // cannot reopen while a rejected group's other reads are still pending.
      const group = await Promise.allSettled(
        messages.items.slice(offset, offset + 4).map(async (message) => {
          const parts = await storage.request(id(), "readMessageParts", {
            messageId: message.id,
            page: {
              maxItems: 64,
              maxBytes: 300_000,
              cursor: partCursors.get(message.id) ?? null,
            },
          });
          if (disposed || epoch !== viewEpoch) return null;
          const generation = message.generationId
            ? ((await storage.request(id(), "readEntity", {
                collection: "generations",
                id: message.generationId,
              })) as unknown as Generation)
            : null;
          if (generation?.purpose === "context_summary") throw new Error("This is a saved summary proposal. Open its conversation and choose Review conversation summaries to inspect it.");
          return {
            message,
            generation,
            parts: parts.items as unknown as ContentPart[],
            nextParts: parts.nextCursor,
          };
        }),
      );
      if (disposed || epoch !== viewEpoch) return;
      for (const result of group) {
        if (result.status === "rejected") throw result.reason;
        if (result.value) displayed.push(result.value);
      }
    }
    const events = await storage.request(id(), "readEntities", {
      collection: "events",
      threadId,
      page: { maxItems: 24, maxBytes: 200_000, cursor: null },
    });
    if (disposed || epoch !== viewEpoch) return;
    let origin: LibrarySnapshot["origin"] = null;
    if (thread.thread.importSourceId) {
      // Import sources are few; the thread's own is found by id within a
      // bounded number of pages, else the origin stays unknown.
      let cursor: string | null = null;
      for (let pages = 0; pages < 8 && !origin; pages++) {
        const sources: EntityPage = await storage.request(id(), "readEntities", {
          collection: "importSources",
          threadId: null,
          page: { maxItems: 64, maxBytes: 200_000, cursor },
        });
        if (disposed || epoch !== viewEpoch) return;
        const source = (sources.items as unknown as ImportSource[]).find(
          (item) => item.id === thread.thread.importSourceId,
        );
        if (source)
          origin = { kind: "import", provider: source.provider, method: source.method };
        cursor = sources.nextCursor;
        if (!cursor) break;
      }
    }
    const parent = selected;
    const branchesEpoch = ++branchEpoch;
    const branches = await storage.request(id(), "readMessageChildren", {
      threadId,
      parentMessageId: parent,
      page: budget,
    });
    if (disposed || epoch !== viewEpoch) return;
    currentWindowCursor = cursor;
    for (const key of partCursors.keys())
      if (!displayed.some((item) => item.message.id === key))
        partCursors.delete(key);
    patch({
      thread,
      messages: displayed,
      events: events.items as unknown as ThreadEvent[],
      origin,
      older: messages.nextCursor,
      leaf: selected,
      ...(branchesEpoch === branchEpoch
        ? { branches, branchParent: parent }
        : {}),
    });
  }
  const mutation = <K extends CanonicalMutation["kind"]>(
    kind: K,
    payload: Extract<CanonicalMutation, { kind: K }>["payload"],
  ): Extract<CanonicalMutation, { kind: K }> =>
    ({
      version: 1,
      operationId: id(),
      recordedAt: Date.now(),
      kind,
      payload,
    }) as Extract<CanonicalMutation, { kind: K }>;
  const controller = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async initialize() {
      if (initialized || disposed) return;
      initialized = true;
      await perform(async () => {
        const workspace = await storage.request(id(), "archiveWorkspace", null);
        patch({ workspaceId: workspace.workspaceId });
        await loadLibrary();
        if (disposed) return;
        unsubscribe = storage.onChange(() => {
          if (disposed) return;
          viewDirty = true;
          patch({ libraryDirty: true });
          scheduleViewRefresh();
        });
      });
      patch({ loading: false });
    },
    async refresh() {
      previousListCursors.length = 0;
      await perform(() => loadLibrary());
    },
    async filter(archived: boolean, title: string) {
      patch({ archived, titleFilter: title });
      previousListCursors.length = 0;
      await perform(() => loadLibrary());
    },
    async nextLibrary() {
      if (!state.library.nextCursor) return;
      previousListCursors.push(currentListCursor);
      if (previousListCursors.length > 32) previousListCursors.shift();
      await perform(() => loadLibrary(state.library.nextCursor));
    },
    async previousLibrary() {
      await perform(() => loadLibrary(previousListCursors.pop() ?? null));
    },
    async open(threadId: string, leaf: string | null = null) {
      patch({ error: null });
      await perform(() => loadView(threadId, leaf));
    },
    async older() {
      if (state.thread && state.older)
        await perform(() =>
          loadView(state.thread!.thread.id, state.leaf, state.older),
        );
    },
    async latest() {
      if (state.thread)
        await perform(() => loadView(state.thread!.thread.id, state.leaf));
    },
    async branches(
      parentMessageId: string | null,
      cursor: string | null = null,
    ) {
      if (!state.thread) return;
      await perform(async () => {
        const threadId = state.thread!.thread.id,
          epoch = ++branchEpoch;
        const result = await storage.request(id(), "readMessageChildren", {
          threadId,
          parentMessageId,
          page: { ...budget, cursor },
        });
        if (epoch === branchEpoch && state.thread?.thread.id === threadId)
          patch({ branches: result, branchParent: parentMessageId });
      });
    },
    async selectBranch(messageId: string) {
      if (!state.thread) return;
      await perform(async () => {
        const { state: previous, thread } = state.thread!;
        await commit(
          [
            mutation("SetActiveBranch", {
              threadId: thread.id,
              value: messageId,
            }),
          ],
          { threadId: thread.id, revision: previous.revision },
        );
        await loadView(thread.id, messageId);
      });
    },
    async create() {
      if (!state.workspaceId || state.pendingMutation) return;
      await perform(async () => {
        const now = Date.now(),
          threadId = id(),
          contextId = id();
        await commit([
          mutation("CreateThread", {
            thread: {
              id: threadId,
              workspaceId: state.workspaceId!,
              createdAt: now,
              recordedAt: now,
              systemPrompt: "",
              preferredRoute: null,
              importSourceId: null,
            },
            context: {
              id: contextId,
              threadId,
              previousId: null,
              version: 1,
              systemPrompt: "",
              preferredRoute: null,
              recordedAt: now,
            },
            state: {
              threadId,
              title: "New conversation",
              tags: [],
              pinned: false,
              archived: false,
              activeLeafMessageId: null,
              contextSnapshotId: contextId,
              routingProfile: null,
              revision: 0,
            },
          }),
        ]);
        patch({ archived: false, titleFilter: "" });
        await loadLibrary();
        await loadView(threadId, null);
      });
    },
    async update(
      kind: "SetTitle" | "SetPinned" | "SetArchived" | "SetTags" | "SetRoutingProfile",
      value: string | boolean | string[] | JsonObject | null,
    ) {
      if (!state.thread) return;
      await perform(async () => {
        const view = state.thread!,
          leaf = state.leaf;
        const payload = { threadId: view.thread.id, value };
        await commit([mutation(kind, payload as never)], {
          threadId: view.thread.id,
          revision: view.state.revision,
        });
        if (state.thread?.thread.id === view.thread.id)
          await loadView(view.thread.id, leaf);
        await loadLibrary();
      });
    },
    async edit(previous: Message, text: string) {
      if (
        !state.thread ||
        state.thread.thread.id !== previous.threadId ||
        state.pendingMutation ||
        state.busy ||
        !previous.sealed ||
        previous.role !== "user" ||
        !text.trim() ||
        text.length > 16384
      )
        return;
      await perform(async () => {
        const view = state.thread!,
          now = Date.now(),
          message: Message = {
            ...previous,
            id: id(),
            createdAt: now,
            recordedAt: now,
            generationId: null,
            editedFromMessageId: previous.id,
            partCount: 1,
            sealed: true,
          };
        const parts: ContentPart[] = [
          {
            id: id(),
            messageId: message.id,
            order: 0,
            kind: "Text",
            data: { text },
          },
        ];
        await commit(
          [
            {
              ...mutation("EditMessage", {
                previousId: previous.id,
                message,
                parts,
              }),
              recordedAt: now,
            },
            mutation("SetActiveBranch", {
              threadId: view.thread.id,
              value: message.id,
            }),
          ],
          { threadId: view.thread.id, revision: view.state.revision },
        );
        if (state.thread?.thread.id === view.thread.id)
          await loadView(view.thread.id, message.id);
      });
    },
    async systemPrompt(value: string) {
      if (!state.thread) return;
      await perform(async () => {
        const view = state.thread!,
          leaf = state.leaf;
        await commit(
          [
            mutation("CreateContextSnapshot", {
              context: {
                ...view.context,
                id: id(),
                previousId: view.context.id,
                version: view.context.version + 1,
                systemPrompt: value,
                recordedAt: Date.now(),
              },
              select: true,
            }),
          ],
          { threadId: view.thread.id, revision: view.state.revision },
        );
        if (state.thread?.thread.id === view.thread.id)
          await loadView(view.thread.id, leaf);
      });
    },
    async excludeAttachments(expected: { threadId: string; revision: number; contextId: string; leaf: string | null }, excludedPartIds: string[]) {
      await perform(async () => {
        const view = state.thread;
        if (!view || state.busy || state.pendingMutation || view.thread.id !== expected.threadId || view.state.revision !== expected.revision || view.context.id !== expected.contextId || state.leaf !== expected.leaf)
          throw new Error("The conversation changed. Review its attachment choices again before applying.");
        const context = { ...view.context, id: id(), previousId: view.context.id, version: view.context.version + 1,
          recordedAt: Date.now(), compaction: view.context.compaction?.version === 2
            ? { ...view.context.compaction, excludedPartIds: [...excludedPartIds].sort() }
            : { version: 1 as const, excludedPartIds: [...excludedPartIds].sort() } };
        await commit([
          mutation("CreateContextSnapshot", { context, select: true }),
          mutation("CreateThreadEvent", { event: {
            id: id(), threadId: view.thread.id, type: "ContextCompaction", createdAt: context.recordedAt, recordedAt: context.recordedAt,
            messageId: state.leaf, generationId: null,
            details: { version: 1, action: "exclude_attachments", contextSnapshotId: context.id, previousContextSnapshotId: view.context.id, excludedPartIds: context.compaction.excludedPartIds },
          } }),
        ], { threadId: view.thread.id, revision: view.state.revision });
        if (state.thread?.thread.id === view.thread.id) await loadView(view.thread.id, expected.leaf);
      });
    },
    async startContextBranch(expected: FreshBranchScope) {
      await perform(async () => {
        const view = state.thread;
        if (archiveSelectionChanged || !view || state.busy || state.pendingMutation || !expected.leaf ||
          view.thread.id !== expected.threadId || view.state.revision !== expected.revision ||
          view.context.id !== expected.contextId || state.leaf !== expected.leaf || view.state.activeLeafMessageId !== expected.leaf)
          throw new Error("The conversation changed. Review the fresh branch again before starting.");
        patch({ busy: true, error: null });
        try {
          const now = Date.now(), context = { ...view.context, id: id(), previousId: view.context.id,
            version: view.context.version + 1, recordedAt: now,
            ...(view.context.compaction?.version === 2 ? { compaction: { ...view.context.compaction, summary: null } } : {}) };
          const mutations: CanonicalMutation[] = [
            mutation("CreateContextSnapshot", { context, select: true }),
            mutation("SetActiveBranch", { threadId: view.thread.id, value: null }),
            mutation("CreateThreadEvent", { event: { id: id(), threadId: view.thread.id, type: "ContextCompaction",
              createdAt: now, recordedAt: now, messageId: expected.leaf, generationId: null,
              details: { version: 1, action: "start_branch", retainedContext: "system_prompt_only",
                sourceThreadRevision: expected.revision, sourceLeafMessageId: expected.leaf,
                previousContextSnapshotId: view.context.id, contextSnapshotId: context.id } } }),
          ];
          if (view.context.compaction?.version === 2 && view.context.compaction.summary)
            mutations.push(mutation("CreateThreadEvent", { event: { id: id(), threadId: view.thread.id, type: "ContextCompaction",
              createdAt: now, recordedAt: now, messageId: expected.leaf, generationId: null,
              details: { action: "clear_summary", contextSnapshotId: context.id, previousContextSnapshotId: view.context.id, reason: "start_branch" } } }));
          await commit(mutations, { threadId: expected.threadId, revision: expected.revision });
          if (state.thread?.thread.id === expected.threadId) await loadView(expected.threadId, null);
        } finally { patch({ busy: false }); }
      });
    },
    reconcile(): Promise<void> {
      if (recoveryTask) return recoveryTask;
      const batch = pending, recovery = state.pendingRecovery;
      if (!batch || !recovery || disposed) return Promise.resolve();
      const navigation = selectionEpoch, initialErrorRevision = errorRevision;
      const task = Promise.resolve().then(async () => {
        let resolved = false;
        try {
          if (disposed) return;
          try { await storage.request(id(), "commit", batch); }
          catch (error) {
            if (!services.archiveSession || !['CONFLICT', 'CLOSED'].includes(String((error as {code?: string})?.code))) throw error;
            const result = await services.archiveSession.reconcilePreviousOperations(batch.mutations.map(item => item.operationId));
            resolved = true;
            patch({ notice: result === 'committed'
              ? 'Your pending change was saved in the previous archive. It was not applied to the newly selected archive.'
              : 'Your pending change did not commit in the previous archive. It was not applied to the newly selected archive.' });
            return;
          }
          resolved = true;
          if (disposed || archiveSelectionChanged) return;
          await loadLibrary();
          // A replay acknowledges its original batch, not a request to navigate.
          // Preserve navigation that started before or during the held reply.
          if (disposed || navigation !== selectionEpoch || activeViewLoads || !state.thread) return;
          const branch = pendingSelectionEpoch === navigation
            ? [...batch.mutations].reverse().find(item => item.kind === "SetActiveBranch" && item.payload.threadId === state.thread?.thread.id)
            : undefined;
          const leaf = branch?.kind === "SetActiveBranch" ? branch.payload.value : state.leaf;
          await loadView(state.thread.thread.id, leaf, currentWindowCursor, true);
        } catch (error) {
          if (resolved) patch({ error: errorText(error) });
          else patch({ pendingRecovery: Object.freeze({ ...recovery, checking: false,
            message: "The pending change could not be checked. Its outcome is still unknown. Try checking again." }) });
        } finally {
          if (resolved && pending === batch) {
            pending = null;
            patch({ pendingMutation: false, pendingRecovery: null, ...(errorRevision === initialErrorRevision ? { error: null } : {}) });
          } else if (state.pendingRecovery?.checking) {
            patch({ pendingRecovery: Object.freeze({ ...state.pendingRecovery, checking: false }) });
          }
        }
      }).finally(() => { if (recoveryTask === task) recoveryTask = null; });
      recoveryTask = task;
      patch({ pendingRecovery: Object.freeze({ ...recovery, checking: true }) });
      return task;
    },
    /** Best is the default (product §44). A query vector embedded by the
     * local runtime turns Best into hybrid RRF and enables Semantic. */
    async search(query: string, cursor: string | null = null, options: { mode?: "exact" | "best" | "semantic"; queryVector?: number[] } = {}) {
      const epoch = ++searchEpoch;
      await perform(async () => {
        const result = await storage.request(id(), "searchArchive", {
          query,
          mode: options.mode ?? "best",
          filters: {},
          page: { ...budget, cursor },
          ...(options.queryVector ? { queryVector: options.queryVector } : {}),
        });
        if (epoch === searchEpoch)
          patch({ search: result, query, error: null });
      });
    },
    clearSearch() {
      searchEpoch++;
      patch({ search: null, query: "" });
    },
    async moreParts(messageId: string, first = false) {
      const found = state.messages.find(
        (item) => item.message.id === messageId,
      );
      if (!found || (!found.nextParts && !first)) return;
      await perform(async () => {
        const epoch = viewEpoch;
        const parts = await storage.request(id(), "readMessageParts", {
          messageId,
          page: {
            maxItems: 64,
            maxBytes: 300_000,
            cursor: first ? null : found.nextParts,
          },
        });
        if (epoch === viewEpoch) {
          partCursors.set(messageId, first ? null : found.nextParts);
          patch({
            messages: state.messages.map((item) =>
              item.message.id === messageId
                ? {
                    ...item,
                    parts: parts.items as unknown as ContentPart[],
                    nextParts: parts.nextCursor,
                  }
                : item,
            ),
          });
        }
      });
    },
    dismissError() {
      patch({ error: null });
    },
    async dispose() {
      disposed = true;
      viewEpoch++;
      listEpoch++;
      searchEpoch++;
      branchEpoch++;
      unsubscribe?.();
      unsubscribeSelection?.();
      if (timer) clearTimeout(timer);
      timer = null;
      viewDirty = false;
      listeners.clear();
    },
    // Workflow boundary for the composer; canonical operation identities outlive component rerenders.
    commit,
    mutation,
    loadView,
    patch,
  };
  return controller;
}
export type LibraryController = ReturnType<typeof createLibraryController>;

import type {
  ChunkPosition,
  SearchHit,
  StorageClient,
} from "@quixi/core/contracts";
import { jsonByteLength } from "@quixi/core/contracts";
import type { Attachment, ContentPart, Message } from "@quixi/core/model";
import { isQuixiId, validateEntityShape } from "@quixi/core/model";

export interface ConversationSearchFocus {
  chunkId: string;
  threadId: string;
  messageId: string;
  part: ContentPart;
  position: ChunkPosition;
  filename: {
    text: string;
    startUTF16: number;
    endUTF16: number;
    totalUTF16: number;
  } | null;
}
export interface ConversationSearchSnapshot {
  busy: boolean;
  focus: ConversationSearchFocus | null;
  error: string | null;
}
const stale = () =>
  new Error(
    "This search result is no longer available at its original location. Search again to refresh the results.",
  );
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const splitScalar = (text: string, at: number) =>
  at > 0 &&
  at < text.length &&
  /[\uD800-\uDBFF]/.test(text[at - 1]!) &&
  /[\uDC00-\uDFFF]/.test(text[at]!);

/** One independently fetched canonical part; never enumerate earlier part pages or mutate a branch. */
export function createConversationSearchController(services: {
  storage: StorageClient;
  archiveSession?: {
    onSelectionChange(listener: (...args: any[]) => void): () => void;
  };
}) {
  const storage = services.storage;
  let state: ConversationSearchSnapshot = Object.freeze({
    busy: false,
    focus: null,
    error: null,
  });
  const listeners = new Set<() => void>();
  let epoch = 0,
    disposed = false,
    selectionChanged = false,
    active: Promise<ConversationSearchFocus | null> | null = null;
  const patch = (change: Partial<ConversationSearchSnapshot>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener();
  };
  const clear = (error: string | null = null) => {
    epoch++;
    patch({ focus: null, error });
  };
  const unsubscribe = services.archiveSession?.onSelectionChange(() => {
    selectionChanged = true;
    clear(
      "The selected archive changed. Open the selected archive before opening another search result.",
    );
  });
  const entity = async <T extends ContentPart | Message | Attachment>(
    collection: "parts" | "messages" | "attachments",
    id: string,
  ): Promise<T> => {
    const value = await storage.request(crypto.randomUUID(), "readEntity", {
      collection,
      id,
    });
    if (!value) throw stale();
    jsonByteLength(value, 1_048_576);
    if (validateEntityShape(collection, value).length) throw stale();
    return value as unknown as T;
  };
  const controller = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => clear(),
    refuse: (reason: string) => clear(reason),
    async resolve(hit: SearchHit): Promise<ConversationSearchFocus | null> {
      if (disposed || active) return null;
      if (selectionChanged) {
        clear(
          "The selected archive changed. Open the selected archive before opening another search result.",
        );
        return null;
      }
      // Snapshot only the small locator before any await; caller mutation cannot retarget a pending read.
      let locator: {
        chunkId: string;
        threadId: string;
        messageId: string;
        partId: string;
        position: ChunkPosition;
      };
      try {
        const position = hit.position;
        if (
          hit.documentId !== null ||
          !isQuixiId(hit.threadId) ||
          !isQuixiId(hit.messageId) ||
          hit.sourceId !== hit.messageId ||
          !isQuixiId(position.partId) ||
          !/^[0-9a-f]{64}$/.test(hit.chunkId) ||
          position.page !== null ||
          !Number.isSafeInteger(position.start) ||
          position.start < 0 ||
          !Number.isSafeInteger(position.end) ||
          position.end <= position.start ||
          position.end - position.start > 65536 ||
          position.sectionPath.length > 32 ||
          position.sectionPath.some(
            (item) => typeof item !== "string" || item.length > 1024,
          )
        )
          throw stale();
        locator = freeze({
          chunkId: hit.chunkId,
          threadId: hit.threadId,
          messageId: hit.messageId,
          partId: position.partId,
          position: { ...position, sectionPath: [...position.sectionPath] },
        });
      } catch (error) {
        clear(error instanceof Error ? error.message : String(error));
        return null;
      }
      const current = ++epoch;
      patch({ busy: true, focus: null, error: null });
      const isCurrent = () =>
        !disposed && !selectionChanged && epoch === current;
      active = (async () => {
        try {
          const part = await entity<ContentPart>("parts", locator.partId);
          if (!isCurrent()) return null;
          if (
            part.id !== locator.partId ||
            part.messageId !== locator.messageId
          )
            throw stale();
          const message = await entity<Message>("messages", locator.messageId);
          if (!isCurrent()) return null;
          if (
            message.id !== locator.messageId ||
            message.threadId !== locator.threadId ||
            part.order >= message.partCount
          )
            throw stale();
          let filename: ConversationSearchFocus["filename"] = null;
          if (locator.position.sectionPath[0] === "attachment") {
            const path = locator.position.sectionPath;
            if (
              path.length !== 3 ||
              path[2] !== "filename" ||
              part.kind !== "Image" ||
              path[1] !== part.data.attachmentId
            )
              throw stale();
            const attachment = await entity<Attachment>(
              "attachments",
              part.data.attachmentId,
            );
            if (!isCurrent()) return null;
            const text = attachment.filename;
            if (
              attachment.id !== part.data.attachmentId ||
              text === null ||
              locator.position.end > text.length ||
              splitScalar(text, locator.position.start) ||
              splitScalar(text, locator.position.end)
            )
              throw stale();
            let end = Math.min(
              locator.position.end,
              locator.position.start + 4096,
            );
            if (splitScalar(text, end)) end--;
            filename = {
              text: text.slice(locator.position.start, end),
              startUTF16: locator.position.start,
              endUTF16: end,
              totalUTF16: text.length,
            };
          }
          // Resolve last: current source digest/head and tombstone checks fence changes
          // made while the bounded canonical records above were being read.
          const resolved = await storage.request(
            crypto.randomUUID(),
            "resolveConversationSearchHit",
            {
              chunkId: locator.chunkId,
              threadId: locator.threadId,
              messageId: locator.messageId,
              partId: locator.partId,
            },
          );
          if (!isCurrent()) return null;
          if (
            resolved.threadId !== locator.threadId ||
            resolved.messageId !== locator.messageId ||
            resolved.partId !== locator.partId ||
            resolved.position.partId !== locator.partId ||
            resolved.position.start !== locator.position.start ||
            resolved.position.end !== locator.position.end ||
            resolved.position.page !== null ||
            JSON.stringify(resolved.position.sectionPath) !==
              JSON.stringify(locator.position.sectionPath)
          )
            throw stale();
          const focus = freeze({
            chunkId: locator.chunkId,
            threadId: resolved.threadId,
            messageId: resolved.messageId,
            part: structuredClone(part),
            position: {
              ...resolved.position,
              sectionPath: [...resolved.position.sectionPath],
            },
            filename,
          });
          patch({ focus });
          return focus;
        } catch (error) {
          if (isCurrent())
            patch({
              focus: null,
              error:
                (error as { code?: string })?.code === "CONFLICT" ||
                (error as { code?: string })?.code === "NOT_FOUND"
                  ? stale().message
                  : error instanceof Error
                    ? error.message
                    : String(error),
            });
          return null;
        }
      })();
      try {
        return await active;
      } finally {
        active = null;
        patch({ busy: false });
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      unsubscribe?.();
      listeners.clear();
      await active;
    },
  };
  return controller;
}
export type ConversationSearchController = ReturnType<
  typeof createConversationSearchController
>;

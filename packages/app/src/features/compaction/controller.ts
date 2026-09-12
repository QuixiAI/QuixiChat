import type { StorageClient, StorageOperations } from "@quixi/core/contracts";
import type { ContentPart } from "@quixi/core/model";
import { assertAttachmentCompaction, isAttachmentPart, MAX_EXCLUDED_PARTS } from "@quixi/core/model";

export interface CompactionScope { threadId: string; revision: number; contextId: string; leaf: string | null }
export interface AttachmentChoice { partId: string; messageId: string; kind: string; label: string; onBranch: boolean }
export function createCompactionController(storage: StorageClient) {
  let epoch = 0, pending: string | null = null;
  let state = { busy: false, scope: null as CompactionScope | null, choices: [] as AttachmentChoice[], selected: [] as string[], error: null as string | null, ready: false };
  const listeners = new Set<() => void>();
  const patch = (change: Partial<typeof state>) => { state = { ...state, ...change }; for (const listener of listeners) listener(); };
  const cancel = () => { epoch++; if (pending) void storage.cancel(pending, null).catch(() => {}); pending = null; patch({ busy: false, scope: null, choices: [], selected: [], ready: false, error: null }); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel,
    select(ids: string[]) { if (!state.ready || ids.some(id => !state.choices.some(value => value.partId === id)) || ids.length > MAX_EXCLUDED_PARTS) return; patch({ selected: [...new Set(ids)] }); },
    async open(scope: CompactionScope, selected: readonly string[]) {
      cancel(); const current = epoch;
      patch({ busy: true, scope: { ...scope } });
      let requests = 0, bytes = 0, messageCount = 0;
      const request = async <K extends keyof StorageOperations>(operation: K, args: StorageOperations[K]["args"]): Promise<StorageOperations[K]["result"]> => {
        if (current !== epoch) throw new Error("Attachment discovery cancelled");
        if (++requests > 4096) throw new Error("This branch exceeds the bounded attachment review request limit; choose a shorter branch.");
        const requestId = crypto.randomUUID(); pending = requestId;
        try {
          const result = await storage.request(requestId, operation, args);
          if (current !== epoch) throw new Error("Attachment discovery cancelled");
          bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
          if (bytes > 8 * 1024 * 1024) throw new Error("This branch exceeds the 8 MiB attachment review metadata limit; choose a shorter branch.");
          return result;
        } finally { if (pending === requestId) pending = null; }
      };
      try {
        assertAttachmentCompaction({ version: 1, excludedPartIds: [...selected] });
        const choices = new Map<string, AttachmentChoice>();
        const add = async (part: ContentPart, onBranch: boolean) => {
          if (!isAttachmentPart(part)) throw new Error("A stored exclusion no longer references an attachment occurrence.");
          if (choices.has(part.id)) return;
          if (choices.size >= MAX_EXCLUDED_PARTS) throw new Error("This review exceeds 64 attachment occurrences. Choose a shorter branch; no partial list was applied.");
          const attachment = await request("readEntity", { collection: "attachments", id: part.data.attachmentId }) as { filename?: string | null } | null;
          choices.set(part.id, { partId: part.id, messageId: part.messageId, kind: part.kind, label: (attachment?.filename ?? part.data.description ?? "Unnamed attachment").slice(0, 256), onBranch });
        };
        let cursor: string | null = null;
        if (scope.leaf) do {
          const window: StorageOperations["readConversationWindow"]["result"] = await request("readConversationWindow", { threadId: scope.threadId, leafMessageId: scope.leaf, page: { maxItems: 64, maxBytes: 131072, cursor } });
          messageCount += window.items.length;
          if (messageCount > 2047) throw new Error("This branch exceeds 2,047 messages. Choose a shorter branch for attachment review.");
          for (const message of window.items) {
            if (!message.sealed) throw new Error("Wait for the response to finish before reviewing attachments.");
            let partCursor: string | null = null;
            do {
              const parts: StorageOperations["readMessageParts"]["result"] = await request("readMessageParts", { messageId: message.id, page: { maxItems: 16, maxBytes: 131072, cursor: partCursor } });
              for (const part of parts.items as unknown as ContentPart[]) if (isAttachmentPart(part)) await add(part, true);
              partCursor = parts.nextCursor;
            } while (partCursor);
          }
          cursor = window.nextCursor;
        } while (cursor);
        for (const partId of selected) if (!choices.has(partId)) {
          const part = await request("readEntity", { collection: "parts", id: partId }) as unknown as ContentPart | null;
          if (!part) throw new Error("A previously excluded attachment occurrence is missing.");
          await add(part, false);
        }
        const latest = await request("readThreadView", { threadId: scope.threadId });
        if (latest.state.revision !== scope.revision || latest.context.id !== scope.contextId) throw new Error("The conversation changed during attachment review. Open the review again.");
        patch({ busy: false, ready: true, choices: [...choices.values()], selected: [...selected] });
      } catch (error) { if (current === epoch) patch({ busy: false, ready: false, choices: [], error: error instanceof Error ? error.message : String(error) }); }
    },
  };
}

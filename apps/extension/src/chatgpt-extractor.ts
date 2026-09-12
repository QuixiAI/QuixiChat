/// <reference path="./chrome.d.ts" />
/** Content script injected into the ChatGPT tab after the user's explicit
 * action and origin grant. It performs the same requests the page performs
 * for the signed-in user, in this tab's session, and streams the verbatim
 * conversation records to the extension page over a port. It stores nothing
 * and reads no page DOM. Serialization/shape checks live in chatgpt.ts. */
import { CHATGPT_EXTRACTOR, ExtractionError, classifyHttpFailure, conversationPage, conversationRecord, EXPORT_ARRAY, selectNewer, serializeRecord, sessionAccessToken } from "./chatgpt.ts";
import type { ConversationSummary } from "./chatgpt.ts";

type Request = { kind: "extract"; sinceUpdateTime: number | null; pageSize: number; maxConversations: number } | { kind: "cancel" } | { kind: "ping" };
type Reply =
  | { kind: "pong"; extractor: typeof CHATGPT_EXTRACTOR; origin: string }
  | { kind: "listed"; total: number | null; selected: number; newestUpdateTime: number | null }
  | { kind: "text"; text: string }
  | { kind: "conversation"; index: number; id: string; attachments: number; unavailableAttachments: number }
  | { kind: "done"; conversations: number; attachments: number; unavailableAttachments: number; newestUpdateTime: number | null }
  | { kind: "failed"; code: string; message: string; conversationsDone: number };
const listPageSize = (value: number) => Math.min(100, Math.max(1, Math.floor(value)));
(() => {
  // Injection is per user action; a repeated injection into the same tab must
  // not register a second listener (duplicate extractions/relays).
  const scope = globalThis as unknown as Record<string, boolean>;
  if (scope.__quixiChatgptExtractor) return;
  scope.__quixiChatgptExtractor = true;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "quixi-chatgpt-extract") return;
    let cancelled = false;
    const send = (reply: Reply) => { try { port.postMessage(reply); } catch { cancelled = true; } };
    port.onDisconnect.addListener(() => { cancelled = true; });
    const fetchJson = async (path: string, token: string | null): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetch(path, { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      } catch (error) { throw new ExtractionError("unavailable", `Could not reach ChatGPT: ${(error as Error).message}`); }
      if (!response.ok) throw classifyHttpFailure(response.status);
      try { return await response.json(); } catch { throw new ExtractionError("format_changed", `ChatGPT answered ${path} with something other than JSON.`); }
    };
    port.onMessage.addListener((message) => {
      const request = message as Request;
      if (request.kind === "ping") { send({ kind: "pong", extractor: CHATGPT_EXTRACTOR, origin: location.origin }); return; }
      if (request.kind === "cancel") { cancelled = true; return; }
      if (request.kind !== "extract") return;
      void (async () => {
        let done = 0, attachments = 0, unavailableAttachments = 0, newest: number | null = null;
        try {
          const token = sessionAccessToken(await fetchJson("/api/auth/session", null));
          const summaries: ConversationSummary[] = [];
          let total: number | null = null;
          const pageSize = listPageSize(request.pageSize);
          for (let offset = 0; ; offset += pageSize) {
            if (cancelled) throw new ExtractionError("cancelled", "Extraction cancelled.");
            const page = conversationPage(await fetchJson(`/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated`, token));
            total = page.total ?? total;
            summaries.push(...page.items);
            if (page.items.length < pageSize || summaries.length >= request.maxConversations) break;
            if (total !== null && summaries.length >= total) break;
          }
          const selected = selectNewer(summaries, request.sinceUpdateTime).slice(0, request.maxConversations);
          for (const item of selected) if (item.updateTime !== null && (newest === null || item.updateTime > newest)) newest = item.updateTime;
          send({ kind: "listed", total, selected: selected.length, newestUpdateTime: newest });
          send({ kind: "text", text: EXPORT_ARRAY.open });
          for (const [index, item] of selected.entries()) {
            if (cancelled) throw new ExtractionError("cancelled", "Extraction cancelled.");
            const conversation = conversationRecord(await fetchJson(`/backend-api/conversation/${encodeURIComponent(item.id)}`, token), item.id);
            send({ kind: "text", text: (index ? EXPORT_ARRAY.separator : "") + serializeRecord(conversation.record) });
            done++; attachments += conversation.attachments; unavailableAttachments += conversation.unavailableAttachments;
            send({ kind: "conversation", index, id: item.id, attachments: conversation.attachments, unavailableAttachments: conversation.unavailableAttachments });
          }
          send({ kind: "text", text: EXPORT_ARRAY.close });
          send({ kind: "done", conversations: done, attachments, unavailableAttachments, newestUpdateTime: newest });
        } catch (error) {
          const failure = error instanceof ExtractionError ? error : new ExtractionError("unavailable", (error as Error).message ?? String(error));
          send({ kind: "failed", code: failure.code, message: failure.message, conversationsDone: done });
        }
      })();
    });
  });
})();

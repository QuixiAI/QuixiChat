/** Pure helpers for the ChatGPT web extractor: response shape checks and the
 * export-compatible serialization the importer already understands
 * (`conversations.json`: an array of conversation objects with `mapping`).
 * Nothing here touches the network or the DOM, so it is unit-tested in Node.
 *
 * Observed on 2026-09-12 against the chatgpt.com web client (undocumented
 * internal API, subject to change): `GET /api/auth/session` → `{ accessToken }`;
 * `GET /backend-api/conversations?offset&limit&order=updated` →
 * `{ items: [{ id, title, create_time, update_time }], total, limit, offset }`;
 * `GET /backend-api/conversation/{id}` → `{ conversation_id|id, title,
 * create_time, update_time, current_node, mapping: { nodeId: { id, parent,
 * children, message } } }`. A response that does not match is reported as a
 * distinct `format_changed` failure, never guessed around. */
export const CHATGPT_EXTRACTOR = Object.freeze({ name: "quixi-chatgpt-web", version: "0.1.0", formatVersion: "chatgpt-web-conversation-observed-2026-v1" });
export type ExtractionFailureCode = "session_expired" | "format_changed" | "unavailable" | "cancelled" | "permission_denied";
export class ExtractionError extends Error {
  constructor(readonly code: ExtractionFailureCode, message: string) { super(message); this.name = "ExtractionError"; }
}
export interface ConversationSummary { id: string; title: string; updateTime: number | null; createTime: number | null }
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const seconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value) / 1000;
  return null;
};
export function sessionAccessToken(body: unknown): string {
  if (!isRecord(body)) throw new ExtractionError("format_changed", "The session response is not an object.");
  const token = body.accessToken;
  if (typeof token !== "string" || !token) throw new ExtractionError("session_expired", "You are not signed in to ChatGPT in this browser. Sign in, then start the extraction again.");
  return token;
}
export function conversationPage(body: unknown): { items: ConversationSummary[]; total: number | null } {
  if (!isRecord(body) || !Array.isArray(body.items)) throw new ExtractionError("format_changed", "The conversation list does not have the expected shape (items array).");
  const items: ConversationSummary[] = [];
  for (const entry of body.items) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) throw new ExtractionError("format_changed", "A conversation list entry lacks a string id.");
    items.push({ id: entry.id, title: typeof entry.title === "string" ? entry.title : "", updateTime: seconds(entry.update_time), createTime: seconds(entry.create_time) });
  }
  const total = typeof body.total === "number" && Number.isSafeInteger(body.total) ? body.total : null;
  return { items, total };
}
/** Accept only what the importer's ChatGPT profile requires; keep the record verbatim otherwise. */
export function conversationRecord(body: unknown, expectedId: string): { record: Record<string, unknown>; attachments: number; unavailableAttachments: number } {
  if (!isRecord(body) || !isRecord(body.mapping)) throw new ExtractionError("format_changed", "The conversation response lacks the expected mapping object.");
  const id = typeof body.conversation_id === "string" ? body.conversation_id : typeof body.id === "string" ? body.id : null;
  if (!id) throw new ExtractionError("format_changed", "The conversation response lacks a native conversation id.");
  if (id !== expectedId) throw new ExtractionError("format_changed", "The conversation response identifies a different conversation than requested.");
  if (!(body.current_node === null || body.current_node === undefined || typeof body.current_node === "string")) throw new ExtractionError("format_changed", "The conversation's current_node is not a string.");
  let attachments = 0, unavailable = 0;
  for (const node of Object.values(body.mapping)) {
    if (!isRecord(node)) throw new ExtractionError("format_changed", "A mapping node is not an object.");
    if (!("parent" in node) || !(node.parent === null || typeof node.parent === "string")) throw new ExtractionError("format_changed", "A mapping node lacks an explicit parent link.");
    if (!(node.message === null || node.message === undefined || isRecord(node.message))) throw new ExtractionError("format_changed", "A mapping node's message is neither an object nor null.");
    const meta = isRecord(node.message) && isRecord(node.message.metadata) ? node.message.metadata : null;
    if (meta && Array.isArray(meta.attachments)) {
      attachments += meta.attachments.length;
      // The web client never serves attachment bytes through this path; the
      // importer records each as an unavailable attachment reference.
      unavailable += meta.attachments.length;
    }
  }
  const record: Record<string, unknown> = { ...body, conversation_id: id };
  return { record, attachments, unavailableAttachments: unavailable };
}
/** Selects conversations newer than a checkpoint for "Import new conversations". */
export function selectNewer(items: readonly ConversationSummary[], sinceUpdateTime: number | null): ConversationSummary[] {
  if (sinceUpdateTime === null) return [...items];
  return items.filter((item) => item.updateTime === null || item.updateTime > sinceUpdateTime);
}
/** Streams an export-compatible JSON array. Callers write `open`, then one
 * `separator` before every record after the first, then `close`. */
export const EXPORT_ARRAY = Object.freeze({ open: "[", separator: ",", close: "]" });
export function serializeRecord(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}
export function classifyHttpFailure(status: number): ExtractionError {
  if (status === 401 || status === 403) return new ExtractionError("session_expired", `ChatGPT refused the request (HTTP ${status}). Your session may have expired; sign in again and retry.`);
  if (status === 429) return new ExtractionError("unavailable", "ChatGPT is rate limiting requests. Wait a few minutes and resume.");
  if (status >= 500) return new ExtractionError("unavailable", `ChatGPT returned HTTP ${status}. Try again later.`);
  return new ExtractionError("format_changed", `ChatGPT answered HTTP ${status} where a conversation was expected; the web client may have changed.`);
}

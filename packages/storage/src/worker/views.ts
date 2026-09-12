import { assertStorageRequest, jsonByteLength } from "@quixi/core/contracts";
import type {
  ThreadUsage,
  LibraryThread,
  PageBudget,
  ViewOperations,
  ViewPage,
} from "@quixi/core/contracts";
import type { Message } from "@quixi/core/model";
import { isQuixiId } from "@quixi/core/model";
import type {
  CanonicalRepository,
  CanonicalSqlite,
  SqlValue,
} from "./canonical/index.ts";
import { BlobStorageError } from "./blobs.ts";
type Row = Record<string, SqlValue>;
const fail = (
  code: "INVALID_REQUEST" | "CONFLICT" | "NOT_FOUND" | "OVERLOADED",
  message: string,
): never => {
  throw new BlobStorageError(code, message);
};
const recency =
  "coalesce(json_extract(payload,'$.createdAt'),json_extract(payload,'$.recordedAt'))";
export class ViewRepository {
  constructor(
    private readonly db: CanonicalSqlite,
    private readonly canonical: CanonicalRepository,
  ) {}
  private rows(sql: string, bind: SqlValue[] = []): Row[] {
    return this.db.exec({
      sql,
      bind,
      rowMode: "object",
      returnValue: "resultRows",
    }) as Row[];
  }
  private scalar(sql: string, bind: SqlValue[] = []): number {
    return Number(
      bind.length ? this.db.selectValue(sql, bind) : this.db.selectValue(sql),
    );
  }
  workspace(): { workspaceId: string } {
    this.db.exec({
      sql: "INSERT INTO quixi_local_state VALUES('defaultWorkspaceId',?) ON CONFLICT(key) DO NOTHING",
      bind: [JSON.stringify(crypto.randomUUID())],
    });
    const id = JSON.parse(
      String(
        this.db.selectValue(
          "SELECT value FROM quixi_local_state WHERE key='defaultWorkspaceId'",
        ),
      ),
    ) as unknown;
    if (!isQuixiId(id))
      return fail("CONFLICT", "Default archive workspace identity is invalid");
    return { workspaceId: id };
  }
  private hidden(threadId: string, messageId: string | null): boolean {
    if (
      !this.scalar(
        "SELECT EXISTS(SELECT 1 FROM quixi_records WHERE collection='tombstones' AND thread_id=?)",
        [threadId],
      )
    )
      return false;
    if (messageId === null)
      return !!this.scalar(
        "SELECT EXISTS(SELECT 1 FROM quixi_records WHERE collection='tombstones' AND thread_id=? AND json_extract(payload,'$.rootMessageId') IS NULL)",
        [threadId],
      );
    return !!this.scalar(
      `WITH RECURSIVE chain(id,parent_id) AS (SELECT id,parent_id FROM quixi_records WHERE collection='messages' AND id=? UNION ALL SELECT m.id,m.parent_id FROM quixi_records m JOIN chain c ON m.id=c.parent_id WHERE m.collection='messages') SELECT EXISTS(SELECT 1 FROM quixi_records WHERE collection='tombstones' AND thread_id=? AND (json_extract(payload,'$.rootMessageId') IS NULL OR json_extract(payload,'$.rootMessageId') IN(SELECT id FROM chain)))`,
      [messageId, threadId],
    );
  }
  thread(
    args: ViewOperations["readThreadView"]["args"],
  ): ViewOperations["readThreadView"]["result"] {
    const thread = this.canonical.get("threads", args.threadId),
      state = this.canonical.get("threadStates", args.threadId);
    if (!thread || !state || this.hidden(args.threadId, null))
      return fail("NOT_FOUND", "Conversation is missing or deleted");
    const context = this.canonical.get("contexts", state.contextSnapshotId);
    if (!context) return fail("NOT_FOUND", "Conversation context is missing");
    return { thread, state, context, usage: this.usage(args.threadId) };
  }
  /** Sums over the conversation's generations through the thread index;
   * SQL null semantics keep unreported values out of every sum. */
  private usage(threadId: string): ThreadUsage {
    const total=this.aggregateUsage(threadId,false), summary=this.aggregateUsage(threadId,true);
    return {...total,...(summary.attempts ? {summary} : {})};
  }
  private aggregateUsage(threadId: string,summaryOnly:boolean): Omit<ThreadUsage,"summary"> {
    const row = this.rows(
      `SELECT count(*) AS attempts,
        sum(json_extract(payload,'$.tokensIn')) AS tokens_in, count(json_extract(payload,'$.tokensIn')) AS in_count,
        sum(json_extract(payload,'$.tokensOut')) AS tokens_out, count(json_extract(payload,'$.tokensOut')) AS out_count,
        sum(json_extract(payload,'$.cachedTokens')) AS cached, count(json_extract(payload,'$.cachedTokens')) AS cached_count,
        sum(CAST(json_extract(payload,'$.estimatedCost.amount') AS REAL)) AS estimated, count(json_extract(payload,'$.estimatedCost.amount')) AS priced,
        count(DISTINCT json_extract(payload,'$.estimatedCost.currency')) AS currencies, min(json_extract(payload,'$.estimatedCost.currency')) AS currency
       FROM quixi_records WHERE collection='generations' AND thread_id=?${summaryOnly ? " AND json_extract(payload,'$.purpose')='context_summary'" : ""}`,
      [threadId],
    )[0]!;
    const attempts = Number(row.attempts), priced = Number(row.priced);
    return {
      attempts,
      tokensIn: Number(row.in_count) ? Number(row.tokens_in) : null,
      tokensOut: Number(row.out_count) ? Number(row.tokens_out) : null,
      cachedTokens: Number(row.cached_count) ? Number(row.cached) : null,
      estimatedCost:
        priced && Number(row.currencies) === 1
          ? { amount: Number(row.estimated).toFixed(6), currency: String(row.currency), attempts: priced }
          : null,
      unpricedAttempts: attempts - priced,
    };
  }
  private validate<K extends keyof ViewOperations>(
    operation: K,
    args: ViewOperations[K]["args"],
  ): void {
    assertStorageRequest({
      version: 1,
      requestId: "00000000-0000-4000-8000-000000000000",
      operation,
      args,
    } as Parameters<typeof assertStorageRequest>[0]);
  }
  private cursor(page: PageBudget): Record<string, unknown> | null {
    if (page.cursor === null) return null;
    try {
      if (page.cursor.length > 2048) throw 0;
      const value: unknown = JSON.parse(page.cursor);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
      return value as Record<string, unknown>;
    } catch {
      return fail("INVALID_REQUEST", "Invalid view cursor");
    }
  }
  library(
    args: ViewOperations["listLibrary"]["args"],
  ): ViewPage<LibraryThread> {
    this.validate("listLibrary", args);
    const revision = this.scalar(
      "SELECT coalesce(max(sequence),0) FROM quixi_sync_ops",
    );
    const cursor = this.cursor(args.page);
    if (
      cursor &&
      (cursor.title !== args.title ||
        cursor.archived !== args.archived ||
        cursor.revision !== revision ||
        !isQuixiId(cursor.id) ||
        ![0, 1].includes(Number(cursor.pinned)) ||
        !Number.isSafeInteger(cursor.activity))
    )
      return fail("CONFLICT", "The library changed; refresh its pages");
    const escaped = args.title
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const base = `SELECT s.id,json_extract(s.payload,'$.pinned') AS pinned,coalesce((SELECT ${recency} FROM quixi_records WHERE collection='messages' AND thread_id=s.id ORDER BY ${recency} DESC,id DESC LIMIT 1),json_extract(t.payload,'$.createdAt'),json_extract(t.payload,'$.recordedAt')) AS activity,substr(json_extract(s.payload,'$.title'),1,512) AS title,length(json_extract(s.payload,'$.title'))>512 AS title_long,(SELECT json_group_array(substr(value,1,128)) FROM (SELECT value FROM json_each(s.payload,'$.tags') LIMIT 8)) AS tags,json_array_length(s.payload,'$.tags')>8 OR EXISTS(SELECT 1 FROM json_each(s.payload,'$.tags') WHERE length(value)>128) AS tags_long,json_extract(s.payload,'$.revision') AS revision FROM quixi_records s JOIN quixi_records t ON t.collection='threads' AND t.id=s.id WHERE s.collection='threadStates' AND json_extract(s.payload,'$.archived')=? AND json_extract(s.payload,'$.title') LIKE ? ESCAPE '\\' AND NOT EXISTS(SELECT 1 FROM quixi_records d WHERE d.collection='tombstones' AND d.thread_id=s.id AND json_extract(d.payload,'$.rootMessageId') IS NULL)`;
    const items: LibraryThread[] = [];
    let bytes = 2,
      last = cursor,
      more = false;
    for (let index = 0; index <= args.page.maxItems; index++) {
      const where = last
        ? "WHERE pinned<? OR (pinned=? AND activity<?) OR (pinned=? AND activity=? AND id>?)"
        : "";
      const row = this.rows(
        `SELECT * FROM (${base}) ${where} ORDER BY pinned DESC,activity DESC,id LIMIT 1`,
        [
          Number(args.archived),
          `%${escaped}%`,
          ...(last
            ? [
                Number(last.pinned),
                Number(last.pinned),
                Number(last.activity),
                Number(last.pinned),
                Number(last.activity),
                String(last.id),
              ]
            : []),
        ],
      )[0];
      if (!row) break;
      const item: LibraryThread = {
        threadId: String(row.id),
        title: String(row.title),
        titleTruncated: !!row.title_long,
        tags: JSON.parse(String(row.tags)),
        tagsTruncated: !!row.tags_long,
        pinned: !!row.pinned,
        archived: args.archived,
        activityAt: Number(row.activity),
        revision: Number(row.revision),
      };
      const size = jsonByteLength(item) + (items.length ? 1 : 0);
      if (index === args.page.maxItems || bytes + size > args.page.maxBytes) {
        if (!items.length)
          return fail("OVERLOADED", "Increase the library page byte budget");
        more = true;
        break;
      }
      items.push(item);
      bytes += size;
      last = {
        id: item.threadId,
        pinned: Number(item.pinned),
        activity: item.activityAt,
      };
    }
    return {
      items,
      bytes,
      nextCursor: more
        ? JSON.stringify({
            ...last,
            title: args.title,
            archived: args.archived,
            revision,
          })
        : null,
    };
  }
  window(
    args: ViewOperations["readConversationWindow"]["args"],
  ): ViewPage<Message> {
    this.validate("readConversationWindow", args);
    const view = this.thread({ threadId: args.threadId });
    const leaf = args.leafMessageId ?? view.state.activeLeafMessageId;
    if (!leaf) return { items: [], bytes: 2, nextCursor: null };
    const message = this.canonical.get("messages", leaf);
    if (
      !message ||
      message.threadId !== args.threadId ||
      this.hidden(args.threadId, leaf)
    )
      return fail("NOT_FOUND", "Selected branch is missing or deleted");
    const cursor = this.cursor(args.page);
    if (
      cursor &&
      (cursor.threadId !== args.threadId ||
        cursor.leaf !== leaf ||
        !isQuixiId(cursor.before))
    )
      return fail("CONFLICT", "Conversation cursor belongs to another branch");
    let next = cursor ? String(cursor.before) : leaf;
    if (
      cursor &&
      !this.scalar(
        `WITH RECURSIVE chain(id,parent_id) AS (SELECT id,parent_id FROM quixi_records WHERE collection='messages' AND id=? UNION ALL SELECT m.id,m.parent_id FROM quixi_records m JOIN chain c ON m.id=c.parent_id WHERE m.collection='messages') SELECT EXISTS(SELECT 1 FROM chain WHERE id=?)`,
        [leaf, next],
      )
    )
      return fail(
        "CONFLICT",
        "Conversation cursor is outside the selected path",
      );
    const items: Message[] = [];
    let bytes = 2;
    while (next && items.length < args.page.maxItems) {
      const value = this.canonical.get("messages", next);
      if (!value || value.threadId !== args.threadId)
        return fail("NOT_FOUND", "Branch ancestor is missing");
      const size = jsonByteLength(value) + (items.length ? 1 : 0);
      if (bytes + size > args.page.maxBytes) {
        if (!items.length)
          return fail(
            "OVERLOADED",
            "Increase the conversation page byte budget",
          );
        break;
      }
      items.push(value);
      bytes += size;
      next = value.parentId ?? "";
    }
    return {
      items: items.reverse(),
      bytes,
      nextCursor: next
        ? JSON.stringify({ threadId: args.threadId, leaf, before: next })
        : null,
    };
  }
  children(
    args: ViewOperations["readMessageChildren"]["args"],
  ): ViewPage<Message> {
    this.validate("readMessageChildren", args);
    this.thread({ threadId: args.threadId });
    if (args.parentMessageId) {
      const parent = this.canonical.get("messages", args.parentMessageId);
      if (
        !parent ||
        parent.threadId !== args.threadId ||
        this.hidden(args.threadId, parent.id)
      )
        return fail("NOT_FOUND", "Branch parent is missing or deleted");
    }
    const cursor = this.cursor(args.page);
    if (
      cursor &&
      (cursor.threadId !== args.threadId ||
        cursor.parent !== args.parentMessageId ||
        !isQuixiId(cursor.after))
    )
      return fail("CONFLICT", "Branch cursor belongs to another parent");
    let after = cursor ? String(cursor.after) : "";
    const items: Message[] = [];
    let bytes = 2,
      more = false;
    for (let index = 0; index <= args.page.maxItems; index++) {
      const row = this.rows(
        "SELECT m.id,m.payload FROM quixi_records m WHERE m.collection='messages' AND m.thread_id=? AND m.parent_id IS ? AND m.id>? AND NOT EXISTS(SELECT 1 FROM quixi_records g WHERE g.collection='generations' AND g.id=m.generation_id AND json_extract(g.payload,'$.purpose')='context_summary') AND NOT EXISTS(SELECT 1 FROM quixi_records d WHERE d.collection='tombstones' AND d.thread_id=m.thread_id AND json_extract(d.payload,'$.rootMessageId')=m.id) ORDER BY m.id LIMIT 1",
        [args.threadId, args.parentMessageId, after],
      )[0];
      if (!row) break;
      const value = JSON.parse(String(row.payload)) as Message,
        size = jsonByteLength(value) + (items.length ? 1 : 0);
      if (index === args.page.maxItems || bytes + size > args.page.maxBytes) {
        if (!items.length)
          return fail("OVERLOADED", "Increase the branch page byte budget");
        more = true;
        break;
      }
      items.push(value);
      bytes += size;
      after = value.id;
    }
    return {
      items,
      bytes,
      nextCursor: more
        ? JSON.stringify({
            threadId: args.threadId,
            parent: args.parentMessageId,
            after,
          })
        : null,
    };
  }
}

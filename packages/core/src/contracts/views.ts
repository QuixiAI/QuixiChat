import type {
  ContextSnapshot,
  Message,
  QuixiId,
  Thread,
  ThreadState,
} from "../model/types.ts";
import { isQuixiId } from "../model/validation.ts";
import type { PageBudget } from "./storage.ts";
export interface LibraryThread {
  threadId: QuixiId;
  title: string;
  titleTruncated: boolean;
  tags: string[];
  tagsTruncated: boolean;
  pinned: boolean;
  archived: boolean;
  activityAt: number;
  revision: number;
}
export interface ViewPage<T> {
  items: T[];
  nextCursor: string | null;
  bytes: number;
}
/** Attempt usage across one conversation, aggregated in SQL over every
 * recorded generation, including deleted branches. A null sum means no
 * attempt reported that value; an estimate needs one currency. */
export interface ThreadUsage {
  /** Separate proposal usage, already included in the top-level totals. */
  summary?: Omit<ThreadUsage, "summary">;
  attempts: number;
  tokensIn: number | null;
  tokensOut: number | null;
  cachedTokens: number | null;
  estimatedCost: { amount: string; currency: string; attempts: number } | null;
  unpricedAttempts: number;
}
export interface ThreadView {
  thread: Thread;
  state: ThreadState;
  context: ContextSnapshot;
  usage: ThreadUsage;
}
export interface ViewOperations {
  archiveWorkspace: { args: null; result: { workspaceId: QuixiId } };
  listLibrary: {
    args: { archived: boolean; title: string; page: PageBudget };
    result: ViewPage<LibraryThread>;
  };
  readSummarySourceInfo: { args: { contextSnapshotId: QuixiId; throughMessageId: QuixiId }; result: { sourceFingerprint: string; sourceMessageCount: number; sourcePartCount: number } };
  readThreadView: { args: { threadId: QuixiId }; result: ThreadView };
  readConversationWindow: {
    args: {
      threadId: QuixiId;
      leafMessageId: QuixiId | null;
      page: PageBudget;
    };
    result: ViewPage<Message>;
  };
  readMessageChildren: {
    args: {
      threadId: QuixiId;
      parentMessageId: QuixiId | null;
      page: PageBudget;
    };
    result: ViewPage<Message>;
  };
}
export function assertViewArgs(
  operation: keyof ViewOperations,
  value: unknown,
): void {
  if (operation === "archiveWorkspace") {
    if (value !== null) throw new Error("Workspace takes null arguments");
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid view arguments");
  const args = value as Record<string, unknown>;
  if(operation === "readSummarySourceInfo"){if(Object.keys(args).sort().join(",")!=="contextSnapshotId,throughMessageId"||!isQuixiId(args.contextSnapshotId)||!isQuixiId(args.throughMessageId))throw new Error("Invalid summary source scope");return;}
  if (operation === "listLibrary") {
    if (
      typeof args.archived !== "boolean" ||
      typeof args.title !== "string" ||
      args.title.length > 512
    )
      throw new Error("Invalid library filter");
  } else {
    if (!isQuixiId(args.threadId)) throw new Error("Invalid view thread");
    for (const key of operation === "readConversationWindow"
      ? ["leafMessageId"]
      : operation === "readMessageChildren"
        ? ["parentMessageId"]
        : [])
      if (args[key] !== null && !isQuixiId(args[key]))
        throw new Error("Invalid view message");
  }
}

import { useState } from "react";
import type { LibraryThread, ThreadView } from "@quixi/core/contracts";
import type { ContentPart, Message } from "@quixi/core/model";
import { readRetainedArchive } from "@quixi/storage/client";

/** Read-only history for an archive the host could not open for writing.
 * Every read goes through the retained reader's bounded operations: no
 * migration, no owner session, no blob access, no write. Long blob-backed text
 * and non-text parts are named, not fetched. See ADR 0016. */
const id = () => crypto.randomUUID();
const LIBRARY_PAGE = { maxItems: 32, maxBytes: 262_144 };
const WINDOW_PAGE = { maxItems: 32, maxBytes: 524_288 };
const PARTS_PAGE = { maxItems: 16, maxBytes: 262_144 };

interface OpenThread {
  view: ThreadView;
  messages: Message[];
  parts: Record<string, ContentPart[]>;
  truncated: boolean;
}
function describe(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "MIGRATION_FAILED":
      return `History cannot be read by this Quixi version. Use the rescue export and restore it with the version that last opened this archive. (${message})`;
    case "CONFLICT":
      return `Another Quixi window is holding this archive; close it and try again. (${message})`;
    case "NOT_FOUND":
      return `The archive database is not present, so there is no history to show. (${message})`;
    default:
      return message;
  }
}
export function RetainedHistory({ archiveId }: { archiveId: string }) {
  const [library, setLibrary] = useState<{
    items: LibraryThread[];
    nextCursor: string | null;
  } | null>(null);
  const [open, setOpen] = useState<OpenThread | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  };
  const list = (cursor: string | null) =>
    run(async () => {
      const page = await readRetainedArchive(archiveId, id(), "listLibrary", {
        archived: false,
        title: "",
        page: { ...LIBRARY_PAGE, cursor },
      });
      setLibrary((current) => ({
        items: cursor && current ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
      }));
    });
  const show = (threadId: string) =>
    run(async () => {
      const view = await readRetainedArchive(archiveId, id(), "readThreadView", { threadId });
      const window = await readRetainedArchive(archiveId, id(), "readConversationWindow", {
        threadId,
        leafMessageId: view.state.activeLeafMessageId,
        page: { ...WINDOW_PAGE, cursor: null },
      });
      const parts: Record<string, ContentPart[]> = {};
      for (const message of window.items) {
        const page = await readRetainedArchive(archiveId, id(), "readMessageParts", {
          messageId: message.id,
          page: { ...PARTS_PAGE, cursor: null },
        });
        parts[message.id] = page.items as unknown as ContentPart[];
      }
      setOpen({ view, messages: window.items, parts, truncated: window.nextCursor !== null });
    });
  return (
    <section aria-label="Read-only history">
      <h2>Browse history (read-only)</h2>
      <p>
        Reads the archive through the bounded retained reader without opening
        it for writing. Nothing shown here changes the archive. Long text
        stored as attachments is named but not loaded.
      </p>
      {!library && (
        <button type="button" disabled={busy} onClick={() => void list(null)}>
          {busy ? "Reading history…" : "Show history"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {library && !open && (
        <>
          {library.items.length === 0 && <p>No conversations were found.</p>}
          <ul>
            {library.items.map((thread) => (
              <li key={thread.threadId}>
                <button type="button" disabled={busy} onClick={() => void show(thread.threadId)}>
                  {thread.title || "Untitled conversation"}
                </button>{" "}
                <small>{new Date(thread.activityAt).toLocaleString()}</small>
              </li>
            ))}
          </ul>
          {library.nextCursor && (
            <button type="button" disabled={busy} onClick={() => void list(library.nextCursor)}>
              More conversations
            </button>
          )}
        </>
      )}
      {open && (
        <article aria-label="Read-only conversation">
          <h3>{open.view.state.title || "Untitled conversation"}</h3>
          {open.view.context.systemPrompt && (
            <p>
              <strong>System prompt:</strong> {open.view.context.systemPrompt}
            </p>
          )}
          {open.messages.length === 0 && <p>No messages in this conversation.</p>}
          {open.messages.map((message) => (
            <div className={`message ${message.role}`} key={message.id}>
              <header>
                <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : message.role}</strong>
              </header>
              {(open.parts[message.id] ?? []).map((part) =>
                part.kind === "Text" || part.kind === "Note" ? (
                  part.data.textBlob ? (
                    <p key={part.id}>
                      <em>Long {part.kind.toLowerCase()} · {part.data.textBlob.byteLength.toLocaleString()} bytes, not loaded in recovery view.</em>
                    </p>
                  ) : (
                    <p className="message-text" key={part.id}>{part.data.text ?? ""}</p>
                  )
                ) : (
                  <p key={part.id}>
                    <em>{part.kind} content, not shown in recovery view.</em>
                  </p>
                ),
              )}
            </div>
          ))}
          {open.truncated && <p>Only the most recent part of this conversation is shown.</p>}
          <button type="button" onClick={() => setOpen(null)}>
            Close conversation
          </button>
        </article>
      )}
    </section>
  );
}

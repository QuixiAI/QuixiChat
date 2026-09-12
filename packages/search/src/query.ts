import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { SearchHit } from "@quixi/core/contracts";
export class SearchError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "UNSUPPORTED"
      | "CONFLICT"
      | "OVERLOADED"
      | "MIGRATION_FAILED"
      | "IO_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "SearchError";
  }
}
export const searchDigest = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
/** User quotes group phrases; FTS operators/column selectors are always literals. */
export function lexicalQuery(query: string): string {
  if (typeof query !== "string" || query.length > 4096)
    throw new SearchError(
      "INVALID_REQUEST",
      "Search query exceeds 4096 characters.",
    );
  query = query.replaceAll("\0", " ");
  const terms: string[] = [];
  let at = 0;
  while (at < query.length) {
    while (/\s/u.test(query[at] ?? "") && at < query.length) at++;
    if (at >= query.length) break;
    let term = "";
    if (query[at] === '"') {
      at++;
      while (at < query.length && query[at] !== '"') term += query[at++];
      if (query[at] !== '"')
        throw new SearchError(
          "INVALID_REQUEST",
          "Close the quoted search phrase.",
        );
      at++;
    } else
      while (at < query.length && !/\s/u.test(query[at]!)) term += query[at++];
    if (/[\p{L}\p{N}]/u.test(term))
      terms.push(`"${term.replaceAll('"', '""')}"`);
    if (terms.length > 64)
      throw new SearchError(
        "INVALID_REQUEST",
        "Search supports at most 64 terms or phrases.",
      );
  }
  return terms.join(" AND ");
}
export function searchExcerpt(
  original: string,
  marked: string,
  open: string,
  close: string,
): SearchHit["excerpt"] {
  let text = "",
    at = 0,
    start: number | null = null;
  const matches: { start: number; end: number }[] = [];
  while (at < marked.length) {
    if (marked.startsWith(open, at)) {
      if (start !== null)
        throw new SearchError(
          "IO_ERROR",
          "Search highlight framing is invalid.",
        );
      start = text.length;
      at += open.length;
    } else if (marked.startsWith(close, at)) {
      if (start === null)
        throw new SearchError(
          "IO_ERROR",
          "Search highlight framing is invalid.",
        );
      matches.push({ start, end: text.length });
      start = null;
      at += close.length;
    } else text += marked[at++];
  }
  // The FTS-only projection replaces NUL with one space to avoid SQLite's
  // C-string highlight truncation. UTF-16 offsets still address original text.
  if (text === original.replaceAll("\0", " ")) text = original;
  if (text !== original || start !== null)
    throw new SearchError(
      "IO_ERROR",
      "Search highlight text does not match its source.",
    );
  let from = Math.max(0, (matches[0]?.start ?? 0) - 96),
    to = Math.min(text.length, from + 512);
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from] ?? "")) from--;
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1] ?? "")) to--;
  const prefix = from ? "…" : "";
  return {
    text: prefix + text.slice(from, to) + (to < text.length ? "…" : ""),
    highlights: matches
      .filter((match) => match.end > from && match.start < to)
      .map((match) => ({
        start: Math.max(from, match.start) - from + prefix.length,
        end: Math.min(to, match.end) - from + prefix.length,
      })),
  };
}
/** Classification changes source kind/identity, never chunk boundaries or text. */
export class CodeChunkClassifier {
  private fence: string | null = null;
  private consumed = 0;
  private line = "";
  codePresent = false;
  classify<
    T extends {
      id: string;
      sourceType: string;
      text: string;
      position: { start: number; end: number };
    },
  >(chunk: T): T {
    let hasCode =
      this.fence !== null ||
      /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/.test(chunk.text);
    const from = Math.max(0, this.consumed - chunk.position.start);
    for (const char of chunk.text.slice(from)) {
      if (char === "\n") {
        const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(this.line);
        if (match) {
          if (
            this.fence &&
            match[1]![0] === this.fence[0] &&
            match[1]!.length >= this.fence.length
          )
            this.fence = null;
          else if (!this.fence) this.fence = match[1]!;
          hasCode = true;
        }
        this.line = "";
      } else if (this.line.length < 256) this.line += char;
    }
    this.consumed = Math.max(this.consumed, chunk.position.end);
    this.codePresent = hasCode;
    return hasCode && chunk.sourceType !== "tool_output"
      ? {
          ...chunk,
          sourceType: "code",
          id: searchDigest(["code-classification-v1", chunk.id]),
        }
      : chunk;
  }
}

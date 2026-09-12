import { LIMITS, protocolFailure } from "./types.ts";
export interface SSERecord {
  event: string;
  data: string;
  id: string | null;
}
/** UTF-8 framing only: no reconnection, event replay or network ownership. */
export class SSEDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private line = "";
  private data: string[] = [];
  private event = "message";
  private id: string | null = null;
  private size = 0;
  private pendingCR = false;
  *push(bytes: Uint8Array, final = false): Generator<SSERecord> {
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: !final });
    } catch {
      throw protocolFailure("Provider stream contains invalid UTF-8.");
    }
    for (const char of text) {
      this.size +=
        char.codePointAt(0)! > 0xffff
          ? 4
          : char.charCodeAt(0) > 0x7ff
            ? 3
            : char.charCodeAt(0) > 0x7f
              ? 2
              : 1;
      if (this.size > LIMITS.eventBytes)
        throw protocolFailure(
          "Provider event exceeds the 256 KiB framing limit.",
          "limit",
        );
      if (this.pendingCR) {
        this.pendingCR = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        const record = this.endLine();
        if (record) yield record;
        this.pendingCR = char === "\r";
      } else {
        this.line += char;
      }
    }
    if (final && (this.line.length || this.data.length))
      throw protocolFailure("Provider stream ended inside an SSE record.");
  }
  private endLine(): SSERecord | null {
    const line = this.line;
    this.line = "";
    if (!line) {
      const record = this.data.length
        ? { event: this.event, data: this.data.join("\n"), id: this.id }
        : null;
      this.data = [];
      this.event = "message";
      this.id = null;
      this.size = 0;
      return record;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}
export function parseEvent(data: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw protocolFailure("Provider stream contains malformed JSON.");
  }
  const pending: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++nodes > 20_000 || depth > 32)
      throw protocolFailure(
        "Provider event structure exceeds parser bounds.",
        "limit",
      );
    if (item && typeof item === "object")
      for (const key in item)
        if (Object.hasOwn(item, key)) {
          if (nodes + pending.length >= 20_000)
            throw protocolFailure(
              "Provider event structure exceeds parser bounds.",
              "limit",
            );
          pending.push([(item as Record<string, unknown>)[key], depth + 1]);
        }
  }
  return value;
}

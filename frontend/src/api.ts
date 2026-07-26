/**
 * The single client for the local service.
 *
 * Every call carries this launch's session token, which the Rust side put in
 * the window URL. Loopback binding keeps other machines out; the token keeps
 * other processes on this machine out (spec §15).
 */

const token = new URLSearchParams(location.search).get("t") ?? "";

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type LlmState = "not_installed" | "idle" | "loading" | "ready" | "failed";

export type ChatDone = {
  reply: string;
  thinking: string;
  elapsed_ms: number;
};

type ChatStreamEvent =
  | { type: "compacting"; original_tokens: number }
  | {
      type: "compacted";
      messages: ChatMessage[];
      original_tokens: number;
      compacted_tokens: number;
    }
  | { type: "thinking" }
  | { type: "thinking_delta"; text: string }
  | { type: "answering" }
  | { type: "delta"; text: string }
  | ({ type: "done" } & ChatDone)
  | { type: "error"; message: string };

export type Health = {
  app: string;
  version: string;
  greeting: string;
  address: string;
  frontend: string;
  offline: boolean;
  device: {
    backend: string;
    device: string;
    native_kernels: boolean;
  };
  smoke: {
    ok: boolean;
    value: number;
    expected: number;
  };
  llm: {
    state: LlmState;
    model: string;
    path: string;
  };
};

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { "x-quixi-chat-token": token },
  });
  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

type ChatCallbacks = {
  onDelta: (text: string) => void;
  onCompacting?: (originalTokens: number) => void;
  onCompacted?: (messages: ChatMessage[], originalTokens: number, compactedTokens: number) => void;
  onThinking?: () => void;
  onThinkingDelta?: (text: string) => void;
  onAnswering?: () => void;
};

// Fetch may deliver several NDJSON records in one browser task. Yield past a
// paint after each delta so React visibly commits every streamed chunk instead
// of batching a coalesced network read into one final update.
const afterPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function chat(messages: ChatMessage[], callbacks: ChatCallbacks): Promise<ChatDone> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-quixi-chat-token": token,
    },
    body: JSON.stringify({ messages }),
  });
  if (!response.ok) {
    throw new Error((await response.text()) || `/chat responded ${response.status}`);
  }
  if (!response.body) {
    throw new Error("the chat response did not include a stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const handle = async (line: string): Promise<ChatDone | undefined> => {
    if (line.trim() === "") return undefined;
    const event = JSON.parse(line) as ChatStreamEvent;
    switch (event.type) {
      case "compacting":
        callbacks.onCompacting?.(event.original_tokens);
        return undefined;
      case "compacted":
        callbacks.onCompacted?.(
          event.messages,
          event.original_tokens,
          event.compacted_tokens,
        );
        return undefined;
      case "thinking":
        callbacks.onThinking?.();
        return undefined;
      case "thinking_delta":
        callbacks.onThinkingDelta?.(event.text);
        await afterPaint();
        return undefined;
      case "answering":
        callbacks.onAnswering?.();
        return undefined;
      case "delta":
        callbacks.onDelta(event.text);
        await afterPaint();
        return undefined;
      case "done":
        return {
          reply: event.reply,
          thinking: event.thinking,
          elapsed_ms: event.elapsed_ms,
        };
      case "error":
        throw new Error(event.message);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const complete = await handle(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (complete) return complete;
      newline = buffered.indexOf("\n");
    }
    if (done) {
      const complete = await handle(buffered);
      if (complete) return complete;
      throw new Error("the chat stream ended before its completion event");
    }
  }
}

export const api = {
  health: () => get<Health>("/health"),
  chat,
};

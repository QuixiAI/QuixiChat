import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ChatMessage } from "./api";

type Turn = ChatMessage & { pending?: boolean; error?: boolean; thinking?: string };

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [hint, setHint] = useState("");
  const [subtitle, setSubtitle] = useState("Gemma runs on this machine. Nothing leaves it.");

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns]);

  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 192)}px`;
  }, [draft]);

  useEffect(() => {
    inputRef.current?.focus();
    api
      .health()
      .then((h) => {
        if (h.llm.state === "not_installed") setSubtitle("The model set is not installed.");
      })
      .catch(() => setSubtitle("The local service is unreachable."));
  }, []);

  // The first message loads ~3.3 GB onto the GPU. Say so, rather than leaving a
  // spinner unexplained for a minute.
  useEffect(() => {
    if (!busy) {
      setHint("");
      return;
    }
    if (compacting) {
      setHint("Compacting conversation history — preserving active instructions and work");
      return;
    }
    const tick = () =>
      api
        .health()
        .then((h) =>
          setHint(h.llm.state === "loading" ? "Loading Gemma onto the GPU — this happens once" : ""),
        )
        .catch(() => {});
    tick();
    const timer = setInterval(tick, 1200);
    return () => clearInterval(timer);
  }, [busy, compacting]);

  async function submit() {
    const content = draft.trim();
    if (!content || busy) return;

    const history: ChatMessage[] = [
      ...turns
        .filter((t) => !t.error && !t.pending)
        .map(({ role, content }) => ({ role, content })),
      { role: "user", content },
    ];

    setTurns((prev) => [
      ...prev,
      { role: "user", content },
      { role: "assistant", content: "", pending: true },
    ]);
    setDraft("");
    setBusy(true);

    try {
      const { reply, thinking, elapsed_ms } = await api.chat(history, {
        onCompacting: () => setCompacting(true),
        onCompacted: (messages, originalTokens, compactedTokens) => {
          console.info(`compacted ${originalTokens} tokens to ${compactedTokens}`);
          setTurns([
            ...messages,
            { role: "assistant", content: "", pending: true },
          ]);
          setCompacting(false);
        },
        onThinking: () => {
          setTurns((prev) => {
            const next = [...prev];
            const current = next[next.length - 1];
            next[next.length - 1] = { ...current, pending: true };
            return next;
          });
        },
        onThinkingDelta: (delta) => {
          setTurns((prev) => {
            const next = [...prev];
            const current = next[next.length - 1];
            next[next.length - 1] = {
              ...current,
              thinking: `${current.thinking ?? ""}${delta}`,
              pending: true,
            };
            return next;
          });
        },
        onAnswering: () => {
          setTurns((prev) => {
            const next = [...prev];
            const current = next[next.length - 1];
            next[next.length - 1] = { ...current, pending: false };
            return next;
          });
        },
        onDelta: (delta) => {
          setTurns((prev) => {
            const next = [...prev];
            const current = next[next.length - 1];
            next[next.length - 1] = {
              ...current,
              content: `${current.content}${delta}`,
              pending: false,
            };
            return next;
          });
        },
      });
      console.info(`reply in ${(elapsed_ms / 1000).toFixed(1)}s`);
      setTurns((prev) => [
        ...prev.slice(0, -1),
        { role: "assistant", content: reply, thinking },
      ]);
    } catch (error) {
      setTurns((prev) => {
        const current = prev[prev.length - 1];
        return [
          ...prev.slice(0, -1),
          {
            role: "assistant",
            content: error instanceof Error ? error.message : String(error),
            thinking: current?.thinking,
            error: true,
          },
        ];
      });
    } finally {
      setCompacting(false);
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <>
      <div className="log" ref={logRef}>
        <div className="inner">
          {turns.length === 0 ? (
            <div className="empty">
              <div>
                <h1>QuixiChat</h1>
                <p>{subtitle}</p>
              </div>
            </div>
          ) : (
            turns.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="turn user">
                  <div className="bubble">{turn.content}</div>
                </div>
              ) : (
                <div
                  key={i}
                  className={`turn assistant ${turn.role !== "assistant" ? "context" : ""} ${turn.error ? "error" : ""}`}
                >
                  {turn.role !== "assistant" && <div className="role-label">{turn.role}</div>}
                  {turn.role === "assistant" && (turn.pending || turn.thinking) && (
                    <details className="thought">
                      <summary>
                        <span>Thinking</span>
                        {turn.pending && (
                          <span className="thinking" aria-label="Thinking">
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                      </summary>
                      {turn.thinking && <div className="thought-body">{turn.thinking}</div>}
                    </details>
                  )}
                  {!turn.pending && turn.content}
                </div>
              ),
            )
          )}
        </div>
      </div>

      <div className="dock">
        <div className="composer">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="Ask Gemma"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button
            onClick={() => void submit()}
            disabled={busy || draft.trim() === ""}
            aria-label="Send"
          >
            ↑
          </button>
        </div>
        <div className="hint">{hint}</div>
      </div>
    </>
  );
}

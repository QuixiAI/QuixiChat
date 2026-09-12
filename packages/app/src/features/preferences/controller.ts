import { assertLocalPreferences, DEFAULT_LOCAL_PREFERENCES } from "@quixi/core/contracts";
import type { InteractionPreferences, LocalPreferences, SendKey, StorageClient } from "@quixi/core/contracts";

export interface PreferenceSnapshot {
  value: LocalPreferences;
  ready: boolean;
  busy: boolean;
  error: string | null;
}
export function createPreferenceController(storage: StorageClient) {
  let state: PreferenceSnapshot = { value: { ...DEFAULT_LOCAL_PREFERENCES }, ready: false, busy: false, error: null };
  const listeners = new Set<() => void>();
  const publish = (next: PreferenceSnapshot) => { state = next; for (const listener of listeners) listener(); };
  async function run(choice?: { kind: "sendKey"; value: SendKey } | { kind: "interaction"; value: InteractionPreferences }) {
    if (state.busy || (choice !== undefined && !state.ready)) return;
    const expectedRevision = state.value.revision;
    publish({ ...state, busy: true, ready: false, error: null });
    try {
      const value = choice === undefined
        ? await storage.request(crypto.randomUUID(), "readLocalPreferences", null)
        : choice.kind === "sendKey"
          ? await storage.request(crypto.randomUUID(), "setSendKey", { expectedRevision, sendKey: choice.value })
          : await storage.request(crypto.randomUUID(), "setInteractionPreferences", { expectedRevision, preferences: choice.value });
      assertLocalPreferences(value);
      publish({ value, ready: true, busy: false, error: null });
    } catch (error) {
      publish({ ...state, busy: false, ready: false,
        error: `${error instanceof Error ? error.message : String(error)} Reload preferences to check the saved choice. Keyboard sending is unavailable until then; the Send message button still works.` });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => run(),
    setSendKey: (value: SendKey) => run({ kind: "sendKey", value }),
    setInteractionPreferences: (value: InteractionPreferences) => run({ kind: "interaction", value: { ...value } }),
  };
}
export type PreferenceController = ReturnType<typeof createPreferenceController>;

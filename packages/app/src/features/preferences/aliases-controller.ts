import { assertRoutingAliases } from "@quixi/core/contracts";
import type { RoutingAliases, RoutingAlias, StorageClient } from "@quixi/core/contracts";

export function createAliasController(storage: StorageClient) {
  let state = { value: { version: 1, revision: 0, aliases: [] } as RoutingAliases, ready: false, busy: false, error: null as string | null };
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => { state = next; for (const listener of listeners) listener(); };
  async function run(work: () => Promise<RoutingAliases>, write = false): Promise<boolean> {
    if (state.busy || (write && !state.ready)) return false;
    publish({ ...state, ready: false, busy: true, error: null });
    try {
      const value = await work(); assertRoutingAliases(value);
      publish({ value, ready: true, busy: false, error: null }); return true;
    } catch (error) {
      publish({ ...state, ready: false, busy: false, error: `${error instanceof Error ? error.message : String(error)} Reload aliases, then reopen the editor to work from the saved version.` }); return false;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => run(() => storage.request(crypto.randomUUID(), "readRoutingAliases", null)),
    put: (alias: RoutingAlias, expectedRevision: number) => run(() => storage.request(crypto.randomUUID(), "putRoutingAlias", { alias, expectedRevision }), true),
    remove: (aliasId: string, expectedRevision: number) => run(() => storage.request(crypto.randomUUID(), "removeRoutingAlias", { aliasId, expectedRevision }), true),
  };
}
export type AliasController = ReturnType<typeof createAliasController>;
export type AliasSnapshot = ReturnType<AliasController["getSnapshot"]>;

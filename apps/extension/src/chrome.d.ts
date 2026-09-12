/** Minimal ambient declarations for the Chrome MV3 APIs this extension uses.
 * Kept local and explicit instead of a broad third-party typing package. */
declare namespace chrome {
  namespace runtime {
    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: { addListener(listener: (message: unknown, port: Port) => void): void };
      onDisconnect: { addListener(listener: (port: Port) => void): void };
      sender?: { tab?: { id?: number }; url?: string; origin?: string };
    }
    const onConnect: { addListener(listener: (port: Port) => void): void };
    const onMessage: { addListener(listener: (message: unknown, sender: { tab?: { id?: number }; url?: string }, sendResponse: (response?: unknown) => void) => boolean | void): void };
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    const lastError: { message?: string } | undefined;
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; active?: boolean; windowId?: number }
    function query(query: { url?: string | string[]; active?: boolean }): Promise<Tab[]>;
    function create(properties: { url: string; active?: boolean }): Promise<Tab>;
    function update(tabId: number, properties: { active?: boolean }): Promise<Tab>;
    function connect(tabId: number, info?: { name?: string }): runtime.Port;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function get(tabId: number): Promise<Tab>;
  }
  namespace scripting {
    function executeScript(injection: { target: { tabId: number }; files?: string[]; func?: (...args: unknown[]) => unknown; args?: unknown[]; world?: "ISOLATED" | "MAIN" }): Promise<{ result?: unknown }[]>;
  }
  namespace permissions {
    function request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  }
  namespace storage {
    interface StorageArea {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
  }
  namespace action {
    const onClicked: { addListener(listener: (tab: tabs.Tab) => void): void };
  }
}

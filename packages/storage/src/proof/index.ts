import { StorageProofClient } from "../client/index.ts";

declare global { interface Window { quixiStorageProof?: StorageProofClient } }

/** Explicit developer-only route. Contains failure probes, not canonical history. */
export function mountStorageProof(root: HTMLElement): () => void {
  const namespace = new URL(location.href).searchParams.get("namespace") ?? "development-proof";
  let client = new StorageProofClient(namespace);
  window.quixiStorageProof = client;
  let disposed = false;
  const main = document.createElement("main");
  main.className = "storage-proof";
  main.innerHTML = `<h1>Local storage proof</h1>
    <p>Developer checks for SQLite WASM, OPFS, FTS5, and sqlite-vec. These records are separate from chat history.</p>
    <p role="status" data-testid="storage-status">Opening local database…</p>
    <pre aria-label="Storage diagnostics" data-testid="diagnostics"></pre>
    <form aria-label="Save proof record">
      <label>Record ID <input name="id" required maxlength="128" value="example"></label>
      <label for="proof-text">Text</label>
      <textarea id="proof-text" name="text" required maxlength="65536">SQLite keeps this record in OPFS.</textarea>
      <button type="submit">Save record</button>
    </form>
    <form aria-label="Search proof records">
      <label>Search text <input name="query" maxlength="1024"></label>
      <button type="submit">Search</button>
    </form>
    <pre aria-label="Search results" data-testid="results"></pre>
    <div class="proof-actions">
      <button type="button" data-action="refresh">Refresh diagnostics</button>
      <button type="button" data-action="persist">Request persistent storage</button>
      <button type="button" data-action="rollbackProbe">Check transaction rollback</button>
      <button type="button" data-action="migrationProbe">Check migration rollback</button>
      <button type="button" data-action="vectorProbe">Check vector search</button>
      <button type="button" data-action="fullProbe">Check SQLite full recovery</button>
      <button type="button" data-action="reopen">Close and reopen</button>
    </div>
    <p>Open this route in another tab to exercise shared ownership. SQLite-full is a database page-limit test; it does not prove browser quota exhaustion or eviction behavior.</p>
    <pre aria-label="Check result" data-testid="probe-result"></pre>`;
  root.replaceChildren(main);
  const status = main.querySelector<HTMLElement>('[data-testid="storage-status"]')!;
  const diagnostics = main.querySelector<HTMLElement>('[data-testid="diagnostics"]')!;
  const results = main.querySelector<HTMLElement>('[data-testid="results"]')!;
  const probe = main.querySelector<HTMLElement>('[data-testid="probe-result"]')!;
  const controls = [...main.querySelectorAll<HTMLButtonElement>("button")];
  let ready = false;
  controls.forEach((button) => { button.disabled = true; });
  let refreshing: Promise<void> | undefined;

  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = client.request("diagnostics", undefined).then((report) => {
      if (disposed) return;
      diagnostics.textContent = JSON.stringify(report, null, 2);
      status.textContent = "Local database ready";
      status.dataset.state = "ready";
      if (!ready) {
        ready = true;
        controls.forEach((button) => { button.disabled = false; });
      }
    }).catch(showError).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  function showError(error: unknown): void {
    if (disposed) return;
    status.textContent = error instanceof Error ? error.message : String(error);
    status.dataset.state = "error";
  }
  async function action(run: () => Promise<unknown>): Promise<void> {
    controls.forEach((button) => { button.disabled = true; });
    try {
      const result = await run();
      probe.textContent = JSON.stringify(result, null, 2);
      await refresh();
    } catch (error) { showError(error); }
    finally { controls.forEach((button) => { button.disabled = !ready; }); }
  }
  let unsubscribe = client.onChange(() => { void refresh(); });
  const forms = main.querySelectorAll<HTMLFormElement>("form");
  forms[0]!.onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(forms[0]);
    void action(() => client.request("put", { id: String(data.get("id")), text: String(data.get("text")) }));
  };
  forms[1]!.onsubmit = (event) => {
    event.preventDefault();
    void action(async () => {
      const records = await client.request("search", { query: String(new FormData(forms[1]).get("query")) });
      results.textContent = JSON.stringify(records, null, 2);
      return { matches: records.length };
    });
  };
  main.querySelector<HTMLElement>(".proof-actions")!.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) return;
    void action(async () => {
      switch (button.dataset.action) {
        case "refresh": return client.request("diagnostics", undefined);
        case "persist": return { persisted: await navigator.storage.persist() };
        case "reopen":
          ready = false;
          unsubscribe();
          await client.close();
          client = new StorageProofClient(namespace);
          window.quixiStorageProof = client;
          unsubscribe = client.onChange(() => { void refresh(); });
          return client.request("diagnostics", undefined);
        case "rollbackProbe": return client.request("rollbackProbe", undefined);
        case "migrationProbe": return client.request("migrationProbe", undefined);
        case "vectorProbe": return client.request("vectorProbe", undefined);
        case "fullProbe": return client.request("fullProbe", undefined);
      }
    });
  };
  const pageHide = () => { client.terminate(); };
  const pageShow = (event: PageTransitionEvent) => {
    if (!event.persisted || disposed) return;
    unsubscribe();
    client = new StorageProofClient(namespace);
    window.quixiStorageProof = client;
    unsubscribe = client.onChange(() => { void refresh(); });
    void refresh();
  };
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  void refresh();
  return () => {
    disposed = true;
    unsubscribe();
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
    void client.close();
    if (window.quixiStorageProof === client) delete window.quixiStorageProof;
    main.remove();
  };
}

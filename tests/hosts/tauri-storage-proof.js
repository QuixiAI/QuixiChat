// Injected only by Cargo's opt-in storage-proof feature into actual bundled WebViews.
(async () => {
  if (window.__quixiHostProofStarted) return;
  window.__quixiHostProofStarted = true;
  const params = new URL(location.href).searchParams;
  const phase = params.get("phase");
  const follower = params.get("role") === "follower";
  const channel = new BroadcastChannel(`quixi:host-proof:${params.get("namespace")}`);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = {
    phase, url: location.href, userAgent: navigator.userAgent,
    secureContext: isSecureContext, crossOriginIsolated,
    capabilities: {
      storage: !!navigator.storage, getDirectory: !!navigator.storage?.getDirectory,
      webLocks: !!navigator.locks, worker: typeof Worker === "function",
      broadcastChannel: typeof BroadcastChannel === "function",
    }, checks: [], success: false,
  };
  const check = (name, value) => {
    report.checks.push({ name, passed: !!value });
    if (!value) throw new Error(`Failed host check: ${name}`);
  };
  const pending = new Map();
  const askFollower = (operation, args) => new Promise((resolve, reject) => {
    if (pending.size >= 8) return reject(new Error("Host coordination queue is full"));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Follower ${operation} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    channel.postMessage({ type: "request", id, operation, args });
  });
  let followerReady;
  channel.onmessage = ({ data }) => {
    if (data.type === "ready") followerReady = data;
    if (data.type !== "result") return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  const reopen = async client => {
    const deadline = Date.now() + 15000;
    const button = document.querySelector('[data-action="reopen"]');
    while (button.disabled && Date.now() < deadline) await sleep(50);
    button.click();
    while (window.quixiStorageProof === client && Date.now() < deadline) await sleep(50);
    return window.quixiStorageProof;
  };
  let stage = "shared proof startup";
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const state = document.querySelector('[data-testid="storage-status"]');
      if (state?.dataset.state === "error") throw new Error(state.textContent);
      if (state?.dataset.state === "ready" && window.quixiStorageProof) break;
      await sleep(50);
    }
    check("shared proof ready", document.querySelector('[data-testid="storage-status"]')?.dataset.state === "ready");
    let client = window.quixiStorageProof;
    if (follower) {
      // Coordination transports test results only. All storage work goes through
      // this second WebView's real shared StorageProofClient and Storage Worker.
      let busy = false;
      channel.onmessage = async ({ data }) => {
        if (data.type !== "request") return;
        if (busy) { channel.postMessage({ type: "result", id: data.id, error: "Follower coordination is busy" }); return; }
        busy = true;
        try {
          if (!["diagnostics", "put", "list", "close"].includes(data.operation)) throw new Error("Unsupported follower proof operation");
          const result = data.operation === "close" ? await client.close() : await client.request(data.operation, data.args);
          channel.postMessage({ type: "result", id: data.id, result });
        } catch (error) {
          channel.postMessage({ type: "result", id: data.id, error: String(error?.message ?? error) });
        } finally { busy = false; }
      };
      channel.postMessage({ type: "ready", diagnostics: await client.request("diagnostics"), url: location.href });
      return;
    }
    stage = "diagnostics";
    report.initial = await client.request("diagnostics");
    check("shared SQLite WASM OPFS backend", report.initial.backend === "sqlite-wasm-opfs-sahpool");
    check("database integrity", report.initial.integrity === "ok");
    stage = "persistent storage request";
    report.persistenceRequested = await navigator.storage.persist();
    if (phase === "write") {
      stage = "write";
      await client.request("put", { id: "host-durable", text: "Quixi café durable Tauri proof" });
    }
    stage = "read and FTS";
    const records = await client.request("list", {});
    check("record survives " + phase, records.some(r => r.id === "host-durable" && r.text === "Quixi café durable Tauri proof"));
    if (phase === "restart") check("follower commit survives process restart", records.some(r => r.id === "host-forwarded" && r.text === "Forwarded write"));
    const matches = await client.request("search", { query: "cafe" });
    check("FTS diacritic match", matches.length === 1 && matches[0].id === "host-durable");
    stage = "vector search";
    report.vector = await client.request("vectorProbe");
    check("sqlite-vec nearest neighbor", report.vector.nearestId === 1 && Math.abs(report.vector.distance - Math.sqrt(0.02)) < 1e-6);
    stage = "transaction rollback";
    check("transaction rollback", (await client.request("rollbackProbe")).rolledBack);
    stage = "migration rollback";
    check("migration rollback", (await client.request("migrationProbe")).rolledBack);
    stage = "SQLite full recovery";
    report.full = await client.request("fullProbe");
    check("SQLite full recovery", report.full.rejected && report.full.integrity === "ok");
    stage = "close and reopen";
    const reopened = await reopen(client);
    check("new shared client after close", reopened !== client);
    client = reopened;
    report.final = await client.request("diagnostics");
    const expectedRecords = phase === "write" ? 1 : 2;
    const expectedOperations = phase === "write" ? 1 : 2;
    check("reopen integrity", report.final.integrity === "ok" && report.final.recordCount === expectedRecords);
    check("atomic operation survived", report.final.operationCount === expectedOperations);
    stage = "interrupted transaction owner recovery";
    await client.request("beginInterruptedWrite", { id: "host-uncommitted" });
    client.terminate();
    const recoveredClient = await reopen(client);
    check("new client after owner failure", recoveredClient !== client);
    client = recoveredClient;
    const recovered = await client.request("list", {});
    check("uncommitted owner write absent", recovered.length === expectedRecords && !recovered.some(r => r.id === "host-uncommitted"));
    report.recovered = await client.request("diagnostics");
    check("recovered integrity", report.recovered.integrity === "ok" && report.recovered.operationCount === expectedOperations);

    stage = "second WebView ownership";
    await window.__TAURI_INTERNALS__.invoke("storage_proof_open_follower");
    const followerDeadline = Date.now() + 20000;
    while (!followerReady && Date.now() < followerDeadline) await sleep(50);
    check("second real WebView ready", !!followerReady && !followerReady.error);
    report.multiWindow = { mainOwnerId: report.recovered.ownerId, followerInitial: followerReady };
    check("two WebViews share one owner", followerReady.diagnostics.ownerId === report.recovered.ownerId);
    stage = "follower forwarded mutation";
    await askFollower("put", { id: "host-forwarded", text: `Forwarded ${phase}` });
    const forwarded = await client.request("list", {});
    check("follower write visible in owner WebView", forwarded.some(r => r.id === "host-forwarded" && r.text === `Forwarded ${phase}`));
    report.multiWindow.beforeTakeover = await askFollower("diagnostics");
    check("follower write atomically logged", report.multiWindow.beforeTakeover.operationCount === expectedOperations + 1);
    stage = "owner death and follower takeover";
    await client.request("beginInterruptedWrite", { id: "host-multi-uncommitted" });
    client.terminate();
    // Poll only readonly diagnostics during the owner transition. Never replay a mutation.
    const takeoverDeadline = Date.now() + 25000;
    while (Date.now() < takeoverDeadline) {
      try {
        report.multiWindow.afterTakeover = await askFollower("diagnostics");
        if (report.multiWindow.afterTakeover.ownerId !== report.recovered.ownerId) break;
      } catch (error) { report.multiWindow.transitionMessage = String(error.message); }
      await sleep(50);
    }
    const takeover = report.multiWindow.afterTakeover;
    check("follower becomes new owner", !!takeover && takeover.ownerId !== report.recovered.ownerId);
    check("takeover database integrity", takeover.integrity === "ok" && takeover.operationCount === expectedOperations + 1);
    const retained = await askFollower("list", {});
    check("takeover retains committed records only", retained.length === 2 && retained.some(r => r.id === "host-durable") && retained.some(r => r.id === "host-forwarded" && r.text === `Forwarded ${phase}`));
    await askFollower("close");
    report.success = true;
  } catch (error) {
    report.error = { stage, name: error?.name ?? "Error", message: String(error?.message ?? error) };
    report.body = document.body.innerText.slice(0, 4096);
  }
  if (follower) {
    channel.postMessage({ type: "ready", error: report.error });
    return;
  }
  channel.close();
  await window.__TAURI_INTERNALS__.invoke("storage_proof_report", { report: JSON.stringify(report), success: report.success });
})();

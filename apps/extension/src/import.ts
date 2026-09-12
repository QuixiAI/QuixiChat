/// <reference path="./chrome.d.ts" />
/** The extension's import page (a full tab, so long transfers survive). The
 * user starts every step: granting the provider and Quixi origins, extracting
 * from the signed-in ChatGPT tab or picking an official export, and sending
 * the bundle to the paired Quixi page. Bytes are staged in this extension's
 * OPFS and hashed as they arrive; the bundle envelope carries the digest. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parsePageToExtensionMessage } from "@quixi/core/contracts";
import type { PageToExtensionMessage, ProviderImportBundle } from "@quixi/core/contracts";
import { CHATGPT_EXTRACTOR } from "./chatgpt.ts";
import { runTransfer } from "./transfer.ts";
import type { SenderChannel, TransferProgress } from "./transfer.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string, level: "info" | "error" = "info") => { const node = $("status"); node.textContent = text; node.dataset.level = level; };
const uuid = () => crypto.randomUUID();
const originOf = (value: string) => { const url = new URL(value.trim()); if (!/^https?:$/.test(url.protocol)) throw new Error("Use an http(s) origin."); return url.origin; };
const settingsKey = "quixi-import-settings";
const checkpointKey = (quixiOrigin: string, account: string) => `quixi-checkpoint:${quixiOrigin}:${account}`;
async function loadSettings() {
  const stored = (await chrome.storage.local.get(settingsKey))[settingsKey] as Record<string, string> | undefined;
  if (stored?.quixiOrigin) $<HTMLInputElement>("quixi-origin").value = stored.quixiOrigin;
  if (stored?.account) $<HTMLInputElement>("account").value = stored.account;
  if (stored?.providerOrigin) $<HTMLInputElement>("provider-origin").value = stored.providerOrigin;
}
async function saveSettings() {
  await chrome.storage.local.set({ [settingsKey]: { quixiOrigin: $<HTMLInputElement>("quixi-origin").value, account: $<HTMLInputElement>("account").value, providerOrigin: $<HTMLInputElement>("provider-origin").value } });
}
/** Grant + tab + injected script + connected port, all from this user action. */
async function connectTab(origin: string, script: string, portName: string, create: boolean): Promise<{ port: chrome.runtime.Port; tabId: number }> {
  const pattern = `${origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] })) && !(await chrome.permissions.request({ origins: [pattern] })))
    throw Object.assign(new Error(`Access to ${origin} was not granted. Nothing was read from it.`), { code: "permission_denied" });
  let [tab] = await chrome.tabs.query({ url: pattern });
  if (!tab) {
    if (!create) throw new Error(`Open ${origin} in a tab first.`);
    tab = await chrome.tabs.create({ url: `${origin}/`, active: false });
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (tab.id === undefined) throw new Error("The tab has no id.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [script] });
  const port = chrome.tabs.connect(tab.id, { name: portName });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${origin} did not answer; reload that tab and try again.`)), 10_000);
    port.onMessage.addListener((message) => { if ((message as { kind?: string })?.kind === "pong") { clearTimeout(timer); resolve(); } });
    port.onDisconnect.addListener(() => { clearTimeout(timer); reject(new Error(`Lost the connection to ${origin}${chrome.runtime.lastError?.message ? `: ${chrome.runtime.lastError.message}` : ""}.`)); });
    port.postMessage({ kind: "ping" });
  });
  return { port, tabId: tab.id };
}
/** A staged bundle in this extension's private OPFS, hashed incrementally. */
class Stage {
  private constructor(private readonly handle: FileSystemFileHandle, private writable: FileSystemWritableFileStream | null, private readonly hasher: ReturnType<typeof sha256.create>, public byteLength = 0) {}
  static async open(name: string): Promise<Stage> {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("bundles", { create: true });
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return new Stage(handle, writable, sha256.create());
  }
  async write(text: string | Uint8Array): Promise<void> {
    const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
    this.hasher.update(bytes); this.byteLength += bytes.byteLength;
    await this.writable!.write(bytes as Uint8Array<ArrayBuffer>);
  }
  async seal(): Promise<string> { await this.writable!.close(); this.writable = null; return bytesToHex(this.hasher.digest()); }
  /** Failure path: abandon the open writable so no swap file lingers, then delete. */
  async discard(): Promise<void> { try { await this.writable?.abort(); } catch { /* already closed */ } this.writable = null; await this.remove(); }
  async read(start: number, end: number): Promise<Uint8Array> { const file = await this.handle.getFile(); return new Uint8Array(await file.slice(start, end).arrayBuffer()); }
  async remove(): Promise<void> { try { const root = await navigator.storage.getDirectory(); const directory = await root.getDirectoryHandle("bundles"); await directory.removeEntry(this.handle.name); } catch { /* already gone */ } }
}
let current: { cancel(reason: string): void; reconnect(): Promise<void> } | null = null;
function portChannel(port: chrome.runtime.Port): SenderChannel {
  return {
    send: (message) => port.postMessage(message),
    onMessage(listener) { const wrapped = (message: unknown) => { const parsed = parsePageToExtensionMessage(message); if (parsed) listener(parsed as PageToExtensionMessage); }; port.onMessage.addListener(wrapped); return () => {}; },
    onDisconnect(listener) { port.onDisconnect.addListener(() => listener()); return () => {}; },
  };
}
async function extract(): Promise<{ stage: Stage; discovered: ProviderImportBundle["discovered"]; newestUpdateTime: number | null; fileName: string } | null> {
  const providerOrigin = originOf($<HTMLInputElement>("provider-origin").value || "https://chatgpt.com");
  const quixiOrigin = originOf($<HTMLInputElement>("quixi-origin").value), account = $<HTMLInputElement>("account").value.trim();
  const onlyNew = $<HTMLInputElement>("only-new").checked;
  const checkpoint = onlyNew ? ((await chrome.storage.local.get(checkpointKey(quixiOrigin, account)))[checkpointKey(quixiOrigin, account)] as { sinceUpdateTime: number | null } | undefined) : undefined;
  status(`Connecting to ${providerOrigin}…`);
  const { port } = await connectTab(providerOrigin, "chatgpt-extractor.js", "quixi-chatgpt-extract", true);
  const stage = await Stage.open(`${uuid()}.json`);
  let cancelled = false;
  current = { cancel: () => { cancelled = true; port.postMessage({ kind: "cancel" }); }, reconnect: async () => {} };
  const result = await new Promise<{ discovered: ProviderImportBundle["discovered"]; newestUpdateTime: number | null }>((resolve, reject) => {
    let writes = Promise.resolve();
    port.onMessage.addListener((message) => {
      const reply = message as { kind: string } & Record<string, unknown>;
      if (reply.kind === "listed") status(`Found ${reply.selected} conversation(s)${reply.total !== null ? ` of ${reply.total}` : ""}${checkpoint ? " newer than the last import" : ""}; extracting…`);
      else if (reply.kind === "text") writes = writes.then(() => stage.write(reply.text as string));
      else if (reply.kind === "conversation") status(`Extracted conversation ${(reply.index as number) + 1}…`);
      else if (reply.kind === "done") writes.then(() => resolve({ discovered: { conversations: reply.conversations as number, attachments: reply.attachments as number, unavailableAttachments: reply.unavailableAttachments as number }, newestUpdateTime: reply.newestUpdateTime as number | null }), reject);
      else if (reply.kind === "failed") writes.then(() => reject(Object.assign(new Error(reply.message as string), { code: reply.code })), reject);
    });
    port.onDisconnect.addListener(() => reject(new Error(cancelled ? "Extraction cancelled." : "The ChatGPT tab disconnected before the extraction finished.")));
    port.postMessage({ kind: "extract", sinceUpdateTime: checkpoint?.sinceUpdateTime ?? null, pageSize: 50, maxConversations: 100_000 });
  }).catch(async (error) => { await stage.discard(); throw error; });
  port.disconnect();
  if (result.discovered.conversations === 0) { await stage.discard(); status("Nothing new to import."); current = null; return null; }
  return { stage, discovered: result.discovered, newestUpdateTime: result.newestUpdateTime, fileName: `chatgpt-web-${new Date().toISOString().slice(0, 10)}.json` };
}
async function stageFile(file: File): Promise<Stage> {
  const stage = await Stage.open(`${uuid()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`);
  const reader = file.stream().getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; await stage.write(value); }
  return stage;
}
async function send(stage: Stage, bundle: Omit<ProviderImportBundle, "file" | "bundleId" | "version" | "method">, fileName: string, mediaType: "application/json" | "application/zip", newestUpdateTime: number | null) {
  const quixiOrigin = originOf($<HTMLInputElement>("quixi-origin").value), account = $<HTMLInputElement>("account").value.trim();
  const sha = await stage.seal();
  const full: ProviderImportBundle = { version: 1, bundleId: uuid(), method: "extension", ...bundle, file: { name: fileName, mediaType, byteLength: stage.byteLength, sha256: sha } };
  status(`Connecting to ${quixiOrigin}…`);
  const connect = () => connectTab(quixiOrigin, "bridge.js", "quixi-import", true);
  const { port, tabId } = await connect();
  await chrome.tabs.update(tabId, { active: true });
  const render = (progress: TransferProgress) => {
    const bar = $<HTMLProgressElement>("progress"); bar.max = Math.max(1, progress.totalBytes); bar.value = progress.ackedBytes;
    $("transfer-state").textContent = progress.state;
    status(progress.state === "offering" ? "Offered to the Quixi page. Accept it there (enter the account label first)." : progress.state === "sending" ? `Sending ${(progress.ackedBytes / 1048576).toFixed(1)} MB of ${(progress.totalBytes / 1048576).toFixed(1)} MB…` : progress.state === "staged" ? "Received by Quixi; importing…" : progress.state === "imported" ? `Import ${progress.outcome}${progress.reason ? `: ${progress.reason}` : ""}.` : `${progress.state}${progress.reason ? `: ${progress.reason}` : ""}`, ["rejected", "failed", "cancelled"].includes(progress.state) || progress.outcome === "failed" ? "error" : "info");
  };
  const transfer = runTransfer({ channel: portChannel(port), bundle: full, source: { byteLength: stage.byteLength, read: (start, end) => stage.read(start, end) }, pairingCode: $<HTMLInputElement>("pairing-code").value.trim(), offerId: uuid(), onProgress: render });
  current = { cancel: (reason) => transfer.cancel(reason), reconnect: async () => { const again = await connect(); transfer.reconnect(portChannel(again.port)); } };
  const outcome = await transfer.done;
  if (outcome.state === "imported" && outcome.outcome === "complete" && newestUpdateTime !== null)
    await chrome.storage.local.set({ [checkpointKey(quixiOrigin, account)]: { sinceUpdateTime: newestUpdateTime, runId: outcome.runId, at: Date.now() } });
  await stage.remove();
  current = null;
  return outcome;
}
async function run(mode: "extract" | "file") {
  const button = $<HTMLButtonElement>("start"); button.disabled = true;
  try {
    const account = $<HTMLInputElement>("account").value.trim();
    if (!account) throw new Error("Enter the source account label you use in Quixi.");
    if (!/^\d{6}$/.test($<HTMLInputElement>("pairing-code").value.trim())) throw new Error("Enter the six-digit pairing code shown on the Quixi page under Import history.");
    await saveSettings();
    if (mode === "extract") {
      const extracted = await extract();
      if (!extracted) return;
      await send(extracted.stage, { provider: "openai", extractor: { name: CHATGPT_EXTRACTOR.name, version: CHATGPT_EXTRACTOR.version, source: "page_extraction" }, sourceFormatVersion: CHATGPT_EXTRACTOR.formatVersion, capturedAt: Date.now(), discovered: extracted.discovered, sourceUrl: originOf($<HTMLInputElement>("provider-origin").value || "https://chatgpt.com"), checkpoint: { cursor: null, sinceUpdateTime: extracted.newestUpdateTime } }, extracted.fileName, "application/json", extracted.newestUpdateTime);
    } else {
      const file = $<HTMLInputElement>("file").files?.[0];
      if (!file) throw new Error("Choose an official export file (JSON or ZIP).");
      const provider = $<HTMLSelectElement>("provider").value as "openai" | "anthropic";
      status(`Staging ${file.name}…`);
      const stage = await stageFile(file);
      await send(stage, { provider, extractor: { name: "quixi-official-export", version: "0.1.0", source: "official_export" }, sourceFormatVersion: provider === "openai" ? "chatgpt-official-export" : "claude-official-export", capturedAt: Date.now(), discovered: { conversations: 0, attachments: 0, unavailableAttachments: 0 }, sourceUrl: null, checkpoint: null }, file.name, /\.zip$/i.test(file.name) ? "application/zip" : "application/json", null);
    }
  } catch (error) {
    status((error as Error).message ?? String(error), "error");
    current = null;
  } finally { button.disabled = false; }
}
$("start").addEventListener("click", () => void run($<HTMLInputElement>("mode-extract").checked ? "extract" : "file"));
$("cancel").addEventListener("click", () => current?.cancel("Cancelled from the extension."));
$("reconnect").addEventListener("click", () => void current?.reconnect().catch((error) => status((error as Error).message, "error")));
void loadSettings();

import type { OnboardingController, OnboardingSnapshot, StorageStatus as StorageStatusValue } from "./controller.ts";
import type { SemanticController, SemanticSnapshot } from "../semantic/controller.ts";
import { backendLabel } from "../semantic/SemanticPanel.tsx";

const sizes = (bytes: number) => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(0)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mark = (ok: boolean | null) => ok === null ? "?" : ok ? "✓" : "⚠";
/** Product §13/§14: actual persistence grant, quota, and where the data lives. */
export function StorageStatus({ status, busy, onRequestPersistence, onExportBackup, notice }: { status: StorageStatusValue | null; busy: boolean; onRequestPersistence: () => void; onExportBackup: () => void; notice?: string | null }) {
  if (!status) return <p role="status">Reading storage status…</p>;
  const granted = status.persisted === true || status.persistence?.permission === "granted";
  const requestable = status.persistence?.available === true && !granted;
  return <dl className="storage-status" aria-label="Storage status">
    <dt>Location</dt><dd>{status.host === "desktop" ? "This computer (Quixi desktop app data)" : "This browser profile and origin"}</dd>
    <dt>Database</dt><dd data-testid="storage-backend">{status.backend === "sqlite-wasm-opfs-sahpool" ? "SQLite WASM / OPFS" : status.backend} · schema {status.schemaVersion} · integrity {status.integrity === "unchecked" ? "not checked at this size (verify from Storage health)" : status.integrity}</dd>
    <dt>Local storage</dt><dd>{status.usage === null || status.quota === null ? "Usage and quota are not reported by this browser." : `${sizes(status.usage)} used of about ${sizes(status.quota)} available`}</dd>
    <dt>Persistent storage</dt>
    <dd data-testid="storage-persistence">
      {status.host === "desktop" ? "Not subject to browser eviction" : granted ? "✓ Granted" : status.persisted === false || status.persistence?.permission === "prompt" ? "⚠ Not granted — your browser may remove local Quixi data under storage pressure." : status.persistence?.reason ?? "Unknown"}
      {requestable && <div className="actions"><button disabled={busy} onClick={onRequestPersistence}>Request persistent storage</button></div>}
    </dd>
    <dt>Backup</dt><dd>Local data belongs to this device, profile and origin; clearing site data removes it even when persistence is granted. <button disabled={busy} onClick={onExportBackup}>Export backup</button></dd>
    {notice && <><dt>Result</dt><dd role="status">{notice}</dd></>}
  </dl>;
}
export interface OnboardingNavigation { imports(): void; exports(): void; providers(): void; semantic(): void; extension(): void }
/** Product §94 steps 1–5. Rendered inside the welcome area so the landing
 * stays usable; the user can finish later and reopen it from Preferences. */
export function OnboardingPanel({ controller, snapshot, semantic, semanticState, navigate, providersConfigured }: { controller: OnboardingController; snapshot: OnboardingSnapshot; semantic: SemanticController; semanticState: SemanticSnapshot; navigate: OnboardingNavigation; providersConfigured: number }) {
  const step = snapshot.step;
  const capabilities = snapshot.capabilities;
  const storage = snapshot.storage;
  const semanticAvailable = snapshot.semantic.hostProvidesModel && snapshot.semantic.wasmSimd;
  const footer = <div className="actions onboarding-nav">
    {step > 1 && <button disabled={snapshot.busy} onClick={() => controller.back()}>Back</button>}
    {step < 5 && <button className="primary" disabled={snapshot.busy} onClick={() => controller.next()}>Next</button>}
    <button disabled={snapshot.busy} onClick={() => void controller.complete()}>{step < 5 ? "Skip setup" : "Finish"}</button>
  </div>;
  return <section className="onboarding" aria-labelledby="onboarding-title" data-step={step}>
    <p className="eyebrow">First-time setup · step {step} of 5</p>
    {step === 1 && <>
      <h2 id="onboarding-title">Your Quixi history stays on this device by default.</h2>
      <p>Nothing is stored in Quixi Cloud unless you enable it. Quixi Cloud is not available in this build; everything below runs locally.</p>
      <p>Local data belongs to this {storage?.host === "desktop" ? "computer" : "browser profile and origin"}. Export a backup whenever you want a copy elsewhere.</p>
    </>}
    {step === 2 && <>
      <h2 id="onboarding-title">Capability check</h2>
      <dl className="capability-check" data-testid="capability-check">
        <dt>Local storage</dt>
        <dd>{mark(storage ? storage.backend === "sqlite-wasm-opfs-sahpool" : null)} SQLite WASM<br />{mark(storage ? storage.backend.includes("opfs") : null)} OPFS</dd>
        <dt>Search</dt>
        <dd>{mark(snapshot.search ? snapshot.search.state !== "failed" : null)} FTS5{snapshot.search ? ` (${snapshot.search.state}, ${snapshot.search.indexedChunks} chunks indexed)` : ""}</dd>
        <dt>Semantic search</dt>
        <dd>{mark(snapshot.semantic.wasmSimd)} WASM SIMD<br />{snapshot.semantic.webGpu === "available" ? "✓ WebGPU available" : snapshot.semantic.webGpu === "unavailable" ? "– WebGPU not available (optional)" : "? WebGPU unknown"}<br />{snapshot.semantic.hostProvidesModel ? "✓ Local model provided by this host" : "⚠ This host does not provide the local model"}</dd>
        <dt>Files and extension</dt>
        <dd>{capabilities ? `${mark(capabilities.nativeFiles.available)} native file saving · ${mark(capabilities.extensionTransfers.available)} browser-extension transfers · ${mark(capabilities.notifications.available)} notifications` : "Reading host capabilities…"}</dd>
      </dl>
      <StorageStatus status={storage} busy={snapshot.busy} onRequestPersistence={() => void controller.requestPersistentStorage()} onExportBackup={navigate.exports} notice={snapshot.notice} />
      <button disabled={snapshot.busy} onClick={() => void controller.refresh()}>Check again</button>
    </>}
    {step === 3 && <>
      <h2 id="onboarding-title">Bring your history</h2>
      <p>Import earlier conversations now or later. Original files are kept beside your history.</p>
      <div className="actions">
        <button onClick={navigate.extension}>Install browser extension</button>
        <button onClick={navigate.imports}>Import provider export</button>
        <button onClick={navigate.exports}>Import Quixi archive</button>
      </div>
      <p className="muted">{capabilities?.extensionTransfers.available ? "This page can receive transfers from the Quixi extension; Import history shows the pairing code." : capabilities?.extensionTransfers.reason ?? ""}</p>
    </>}
    {step === 4 && <>
      <h2 id="onboarding-title">Connect providers</h2>
      <p>{providersConfigured > 0 ? `${providersConfigured} provider connection${providersConfigured === 1 ? " is" : "s are"} configured on this host.` : "No provider connections are configured yet."} Connect now or later; searching and reading imported history never needs a provider.</p>
      <div className="actions"><button onClick={navigate.providers}>Open Providers</button></div>
    </>}
    {step === 5 && <>
      <h2 id="onboarding-title">Enable Local Semantic Search?</h2>
      <p>Quixi can locally index the meaning of your conversations and document text. All inference stays on this device.</p>
      {!semanticAvailable && <p role="status">{!snapshot.semantic.hostProvidesModel ? "This host does not provide the local model; exact search stays available." : "This browser lacks WASM SIMD; semantic search is unavailable here."}</p>}
      {semanticState.status?.state && semanticState.status.state !== "disabled" && <p role="status">Semantic search is already enabled ({backendLabel(semanticState)}).</p>}
      <div className="actions">
        <button className="primary" disabled={snapshot.busy || semanticState.busy || !semanticAvailable || (semanticState.status?.state !== undefined && semanticState.status?.state !== "disabled")} onClick={() => { void semantic.enable(); navigate.semantic(); void controller.complete(); }}>Enable</button>
        <button disabled={snapshot.busy} onClick={() => void controller.complete()}>Later</button>
      </div>
    </>}
    {snapshot.error && <p role="alert">{snapshot.error}</p>}
    {footer}
  </section>;
}

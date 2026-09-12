import type { SemanticController, SemanticSnapshot } from "./controller.ts";
import { useFocusRecovery } from "../accessibility/useFocusRecovery.ts";

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
const duration = (seconds: number) => seconds < 60 ? `~${seconds}s` : seconds < 3600 ? `~${Math.round(seconds / 60)}m` : `~${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
export function backendLabel(snapshot: SemanticSnapshot): string {
  if (snapshot.runtime === "loading") return "Loading the local model…";
  if (snapshot.runtime === "failed") return "Unavailable";
  if (snapshot.runtime === "no-host-assets") return "Not provided by this host";
  if (!snapshot.report) return "Not loaded";
  const route = snapshot.report.route;
  if (route.startsWith("wasm-simd")) return "WASM SIMD · CPU";
  if (route.startsWith("wasm-scalar")) return "WASM scalar · CPU";
  if (/half|f16/.test(route)) return "WebGPU · FP16";
  if (route.startsWith("webgpu")) return "WebGPU · FP32";
  return route;
}
/** Product §72/§73: one status block and the five explicit controls. */
export function SemanticPanel({ controller, snapshot }: { controller: SemanticController; snapshot: SemanticSnapshot }) {
  const focus = useFocusRecovery();
  const status = snapshot.status;
  const disabled = snapshot.busy;
  const hostless = snapshot.runtime === "no-host-assets";
  const indexing = snapshot.indexer?.state === "indexing";
  const total = status ? status.indexedChunks + status.pendingChunks : 0;
  return <section aria-label="Semantic search" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h1 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Semantic search</h1>
    {(!status || status.state === "disabled") ? <>
      <p>Quixi can locally index the meaning of your conversations and document text. All inference stays on this device; nothing is sent anywhere.</p>
      {hostless && <p role="alert">This host does not provide the local embedding model, so semantic search cannot be enabled here. Exact search keeps working.</p>}
      <div className="actions">
        <button disabled={disabled || hostless} onClick={() => void controller.enable()}>Enable local semantic search</button>
        <button disabled={disabled} onClick={() => void controller.refresh()}>Later</button>
      </div>
    </> : <>
      <dl className="semantic-status">
        <dt>Indexed</dt><dd data-testid="semantic-indexed">{status.indexedChunks.toLocaleString()} / {total.toLocaleString()} chunks</dd>
        <dt>Backend</dt><dd data-testid="semantic-backend">{backendLabel(snapshot)}</dd>
        <dt>Current speed</dt><dd>{snapshot.chunksPerSecond === null ? "—" : `${snapshot.chunksPerSecond.toFixed(snapshot.chunksPerSecond < 10 ? 1 : 0)} chunks/sec`}</dd>
        <dt>Estimated remaining</dt><dd>{status.pendingChunks === 0 ? "Done" : snapshot.estimatedRemainingSeconds === null ? "Measuring…" : duration(snapshot.estimatedRemainingSeconds)}</dd>
        <dt>Index size</dt><dd>{megabytes(status.vectorBytes)} ({status.vectors.toLocaleString()} vectors)</dd>
        <dt>Candidate index</dt><dd data-testid="semantic-projection">{status.projection.projected.toLocaleString()} / {status.vectors.toLocaleString()} sign-bit ({megabytes(status.projection.projected * status.projection.bytesPerVector)}) · {status.projection.coarseRetrieval ? `coarse retrieval over ${status.projection.candidates.toLocaleString()} candidates + exact rerank${status.projection.residentBytes ? `, ${megabytes(status.projection.residentBytes)} resident` : ""}` : status.projection.threshold === null ? "exact retrieval (coarse stage off)" : status.vectors < status.projection.threshold ? `exact retrieval below ${status.projection.threshold.toLocaleString()} vectors` : "rebuilding, exact retrieval meanwhile"}</dd>
        <dt>State</dt><dd data-testid="semantic-state">{status.state === "paused" ? (snapshot.runtime === "ready" ? "Paused" : "Disabled (index kept)") : indexing ? "Indexing" : snapshot.runtime === "ready" ? (status.pendingChunks ? "Waiting for the next slice" : "Up to date") : snapshot.runtime === "loading" ? "Starting" : snapshot.runtime === "failed" ? "Runtime failed" : "Not running"}</dd>
      </dl>
      <p>Model {status.model?.modelName} · generation {status.generation}. ETA is approximate and follows recent measured throughput.</p>
      <div className="actions">
        {status.state === "enrolled" && snapshot.runtime !== "failed" && <button disabled={disabled} onClick={() => void controller.pause()}>Pause</button>}
        {(status.state === "paused" || snapshot.runtime === "failed") && <button disabled={disabled || hostless} onClick={() => void controller.resume()}>Resume</button>}
        {snapshot.runtime !== "not-loaded" && snapshot.runtime !== "no-host-assets" && <button disabled={disabled} onClick={() => void controller.disable()}>Disable</button>}
        <button disabled={disabled} onClick={() => void controller.deleteIndex()}>Delete semantic index</button>
        <button disabled={disabled || hostless} onClick={() => void controller.rebuild()}>Rebuild semantic index</button>
      </div>
      <p>Deleting the semantic index never deletes your history; exact search stays available throughout.</p>
    </>}
    <p role="status">{snapshot.busy ? "Applying semantic search change…" : snapshot.indexer?.lastError ? `Indexing problem: ${snapshot.indexer.lastError}` : snapshot.report ? `Local runtime ready on ${backendLabel(snapshot)}${snapshot.report.modelSource === "cache" ? " from the cached model" : ""}.${snapshot.report.kind === "cpu" ? snapshot.report.gpuAttempted ? ` WebGPU was not used: ${snapshot.report.initialGpuError ?? "no usable adapter"}.` : " WebGPU is not exposed by this browser." : ""}` : ""}</p>
    {snapshot.error && <p role="alert">{snapshot.error}</p>}
  </section>;
}

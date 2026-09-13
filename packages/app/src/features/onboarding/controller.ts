import { assertLocalPreferences } from "@quixi/core/contracts";
import type { CapabilityState, HostCapabilities, StorageClient, HostClient } from "@quixi/core/contracts";
import { supportsWasmSimd } from "@quixi/quixi-embed";
import { describeStorageError } from "../../runtime/storage-error.ts";

/** Product §94 first-run steps and §13/§14 storage status, all read from the
 * actual host capabilities and storage diagnostics; nothing is hardcoded as
 * a success. Completion is a device-local preference (ADR 0018 row, v3). */
export type OnboardingStep = 1 | 2 | 3 | 4 | 5;
export interface StorageStatus {
  backend: string;
  schemaVersion: number;
  integrity: string;
  usage: number | null;
  quota: number | null;
  /** The worker's own observation (`navigator.storage.persisted()`), null when unknown. */
  persisted: boolean | null;
  /** Whether this host can request persistence and its current grant. */
  persistence: CapabilityState | null;
  host: HostCapabilities["host"] | null;
}
export interface OnboardingSnapshot {
  loaded: boolean;
  /** null until preferences are read; then the stored completion time or null. */
  completedAt: number | null | undefined;
  revision: number;
  step: OnboardingStep;
  storage: StorageStatus | null;
  capabilities: HostCapabilities | null;
  search: { state: string; indexedChunks: number; semanticReady: boolean; semanticReason: string | null } | null;
  /** `modelAvailability`: what the configured model URL actually answered (a host may name a model it does not serve, as the Docker image does without a provisioned file). */
  semantic: { hostProvidesModel: boolean; modelAvailability: ModelAvailability; wasmSimd: boolean; webGpu: "available" | "unavailable" | "unknown" };
  busy: boolean;
  error: string | null;
  notice: string | null;
}
export type ModelAvailability = "available" | "missing" | "unknown" | "unchecked";
export interface OnboardingServices {
  storage: StorageClient;
  host: HostClient;
  hostProvidesModel: boolean;
  /** Answers whether the host actually serves its named model; absent when the host names none. */
  probeModel?: () => Promise<ModelAvailability>;
}
/** A same-origin HEAD of the model URL: `available` on a non-HTML success,
 * `missing` on any other HTTP answer (including an application document
 * returned by a SPA fallback), `unknown` when the request itself fails. */
export async function probeModelUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<ModelAvailability> {
  try {
    const response = await fetchImpl(url, { method: "HEAD", cache: "no-store" });
    if (!response.ok) return "missing";
    const type = response.headers.get("content-type") ?? "";
    return /text\/html/i.test(type) ? "missing" : "available";
  } catch { return "unknown"; }
}
const id = () => crypto.randomUUID();
export function createOnboardingController(services: OnboardingServices) {
  let state: OnboardingSnapshot = Object.freeze({ loaded: false, completedAt: undefined, revision: 0, step: 1, storage: null, capabilities: null, search: null, semantic: { hostProvidesModel: services.hostProvidesModel, modelAvailability: "unchecked" as ModelAvailability, wasmSimd: false, webGpu: "unknown" as const }, busy: false, error: null, notice: null });
  const listeners = new Set<() => void>();
  let disposed = false;
  const patch = (change: Partial<OnboardingSnapshot>) => { if (disposed) return; state = Object.freeze({ ...state, ...change }); for (const listener of listeners) { try { listener(); } catch { /* isolate */ } } };
  async function readPreferences(): Promise<void> {
    try {
      const value = await services.storage.request(id(), "readLocalPreferences", null);
      assertLocalPreferences(value);
      patch({ loaded: true, completedAt: value.onboardingCompletedAt, revision: value.revision });
    } catch (error) {
      patch({ loaded: true, error: describeStorageError(error) });
    }
  }
  /** Reads what the device actually offers; failures leave explicit nulls. */
  async function check(): Promise<void> {
    let capabilities: HostCapabilities | null = null;
    try { capabilities = await services.host.capabilities(); } catch { capabilities = null; }
    let storage: StorageStatus | null = null;
    try {
      const diagnostics = await services.storage.request(id(), "diagnostics", null);
      storage = { backend: diagnostics.backend, schemaVersion: diagnostics.schemaVersion, integrity: diagnostics.integrity, usage: diagnostics.usage, quota: diagnostics.quota, persisted: diagnostics.persisted, persistence: capabilities?.persistentStorage ?? null, host: capabilities?.host ?? null };
    } catch (error) { patch({ error: describeStorageError(error) }); }
    let search: OnboardingSnapshot["search"] = null;
    try {
      const status = await services.storage.request(id(), "searchStatus", null);
      search = { state: status.state, indexedChunks: status.indexedChunks, semanticReady: status.semantic.state === "ready", semanticReason: status.semantic.reason };
    } catch { search = null; }
    let webGpu: OnboardingSnapshot["semantic"]["webGpu"] = "unavailable";
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      webGpu = gpu ? ((await gpu.requestAdapter()) ? "available" : "unavailable") : "unavailable";
    } catch { webGpu = "unavailable"; }
    let wasmSimd = false;
    try { wasmSimd = supportsWasmSimd(); } catch { wasmSimd = false; }
    let modelAvailability: ModelAvailability = services.hostProvidesModel ? "unchecked" : "missing";
    if (services.hostProvidesModel && services.probeModel) { try { modelAvailability = await services.probeModel(); } catch { modelAvailability = "unknown"; } }
    patch({ capabilities, storage, search, semantic: { hostProvidesModel: services.hostProvidesModel, modelAvailability, wasmSimd, webGpu } });
  }
  async function setCompleted(completedAt: number | null): Promise<void> {
    if (state.busy) return;
    patch({ busy: true, error: null });
    try {
      const value = await services.storage.request(id(), "setOnboardingState", { expectedRevision: state.revision, onboardingCompletedAt: completedAt });
      assertLocalPreferences(value);
      patch({ completedAt: value.onboardingCompletedAt, revision: value.revision, step: 1 });
      // Showing the steps again re-reads what the device offers now.
      if (value.onboardingCompletedAt === null) await check();
    } catch (error) {
      patch({ error: describeStorageError(error) });
      await readPreferences();
    } finally { patch({ busy: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async initialize() { await readPreferences(); if (!disposed && state.completedAt === null) await check(); },
    refresh: check,
    go(step: OnboardingStep) { patch({ step, error: null, notice: null }); },
    next() { if (state.step < 5) patch({ step: (state.step + 1) as OnboardingStep, error: null, notice: null }); },
    back() { if (state.step > 1) patch({ step: (state.step - 1) as OnboardingStep, error: null, notice: null }); },
    /** Product §14: the browser's actual answer, then a fresh status read. */
    async requestPersistentStorage() {
      if (state.busy) return;
      patch({ busy: true, error: null });
      try {
        const result = await services.host.requestPersistentStorage(id());
        patch({ notice: result.persisted ? "Persistent storage granted. Your browser will not evict Quixi data under storage pressure; clearing site data still removes it." : "The browser did not grant persistent storage. Export a backup regularly; you can ask again later." });
      } catch (error) {
        patch({ error: describeStorageError(error) });
      } finally { patch({ busy: false }); await check(); }
    },
    complete: () => setCompleted(Date.now()),
    /** Preferences: show the steps again on this device. */
    reset: () => setCompleted(null),
    async dispose() { disposed = true; listeners.clear(); },
  };
}
export type OnboardingController = ReturnType<typeof createOnboardingController>;

import type {
  ArchiveExportFormat,
  ArchiveJobStatus,
} from "@quixi/core/contracts";
import type { AppServices } from "../../runtime/library.ts";
import {
  prepareArchiveDownload,
  prepareExistingArchiveDownload,
  type PreparedArchiveDownload,
} from "./index.ts";
export interface ExportSnapshot {
  busy: boolean;
  cancellable: boolean;
  saving: boolean;
  prepared: boolean;
  job: ArchiveJobStatus | null;
  error: string | null;
  notice: string | null;
  jobs: ArchiveJobStatus[];
  nextJobId: string | null;
  retained: readonly {
    id: string;
    name: string;
    byteLength: number;
    createdAt: number;
  }[];
}
export function createExportController(services: AppServices) {
  let state: ExportSnapshot = {
      busy: false,
      cancellable: false,
      saving: false,
      prepared: false,
      job: null,
      error: null,
      notice: null,
      jobs: [],
      nextJobId: null,
      retained: [],
    },
    prepared: PreparedArchiveDownload | null = null,
    abort: AbortController | null = null,
    active: Promise<void> | null = null,
    disposed = false;
  const listeners = new Set<() => void>();
  const patch = (value: Partial<ExportSnapshot>) => {
    if (disposed) return;
    state = { ...state, ...value };
    for (const listener of listeners) listener();
  };
  const loadJobs = async (afterJobId: string | null = null) => {
    const page = await services.storage.request(
      crypto.randomUUID(),
      "listArchiveJobs",
      { afterJobId, maxItems: 16 },
    );
    patch({ jobs: page.items, nextJobId: page.nextJobId });
  };
  const refresh = async () => {
    await loadJobs();
    if (services.temporaryDownloads)
      patch({ retained: await services.temporaryDownloads.list() });
  };
  const work = async (action: () => Promise<void>) => {
    if (disposed || active) return;
    const task = Promise.resolve().then(async () => {
      if (disposed) return;
      try {
        await action();
      } catch (error) {
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    active = task;
    patch({ busy: true, error: null });
    await task;
    if (active === task) {
      active = null;
      patch({ busy: false });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async initialize() {
      await work(refresh);
    },
    async prepare(format: ArchiveExportFormat) {
      await work(async () => {
        patch({
          busy: true,
          prepared: false,
          error: null,
          notice: null,
          job: null,
        });
        abort = new AbortController();
        patch({ cancellable: true });
        try {
          await prepared?.release();
          prepared = null;
          const result = await prepareArchiveDownload(
            services.storage,
            services.host,
            format,
            { signal: abort.signal, onProgress: (job) => patch({ job }) },
          );
          if (disposed) {
            await result.release();
            return;
          }
          prepared = result;
          patch({ prepared: true, job: result.job });
        } finally {
          abort = null;
          patch({ cancellable: false });
        }
      });
    },
    async resume(jobId: string) {
      await work(async () => {
        patch({ busy: true, prepared: false, error: null, notice: null });
        abort = new AbortController();
        patch({ cancellable: true });
        try {
          await prepared?.release();
          prepared = null;
          const result = await prepareExistingArchiveDownload(
            services.storage,
            services.host,
            jobId,
            { signal: abort.signal, onProgress: (job) => patch({ job }) },
          );
          if (disposed) {
            await result.release();
            return;
          }
          prepared = result;
          patch({ prepared: true, job: result.job });
        } finally {
          abort = null;
          patch({ cancellable: false });
        }
      });
    },
    async refreshJobs() {
      await work(refresh);
    },
    async nextJobs() {
      if (state.nextJobId) await work(() => loadJobs(state.nextJobId));
    },
    async releaseJob(jobId: string) {
      await work(async () => {
        if (prepared?.job.jobId === jobId) {
          await prepared.release();
          prepared = null;
          patch({ prepared: false, job: null });
        } else
          await services.storage.request(
            crypto.randomUUID(),
            "releaseArchiveJob",
            { operationId: crypto.randomUUID(), jobId },
          );
        await refresh();
      });
    },
    cancel() {
      abort?.abort();
      if (abort) patch({ cancellable: false });
    },
    async save() {
      if (!prepared) return;
      await work(async () => {
        patch({ saving: true, error: null });
        try {
          await prepared!.save(crypto.randomUUID());
          await prepared!.release();
          prepared = null;
          patch({
            prepared: false,
            notice:
              "Save request handed to your host. Check the saved file before clearing any temporary download.",
          });
          await refresh();
        } finally {
          patch({ saving: false });
        }
      });
    },
    async release() {
      await work(async () => {
        await prepared?.release();
        prepared = null;
        patch({ prepared: false, job: null });
        await refresh();
      });
    },
    async clearDownload(id: string) {
      await work(async () => {
        await services.temporaryDownloads?.clear(id);
        await refresh();
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      abort?.abort();
      await active;
      await prepared?.release();
      prepared = null;
      listeners.clear();
    },
  };
}
export type ExportController = ReturnType<typeof createExportController>;

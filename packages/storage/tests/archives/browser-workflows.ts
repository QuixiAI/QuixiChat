import { createIsolatedStorageClient as createStorageClient } from "../isolated-client.ts";
import { createWebHost } from "../../../../apps/web/src/host/index.ts";
import {
  prepareArchiveDownload,
  prepareExistingArchiveDownload,
  stageArchiveRestore,
} from "../../../app/src/features/archives/index.ts";
const id = () => crypto.randomUUID();
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
export async function archiveWorkflowProof() {
  let drop = true,
    droppedJob: string | null = null;
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", (event) => {
        const value = event.data;
        if (
          drop &&
          value.type === "reply" &&
          value.ok &&
          value.result?.kind === "export" &&
          value.result?.phase === "snapshot"
        ) {
          drop = false;
          droppedJob = value.result.jobId;
          event.stopImmediatePropagation();
        }
      });
    }
  };
  const client = createStorageClient({ archiveId: `test-${id()}`, timeoutMs: 2000 });
  globalThis.Worker = NativeWorker;
  const host = createWebHost({ destinations: [], fileStagingNamespace: id() });
  try {
    let unknown = false;
    try {
      await prepareArchiveDownload(client, host, "portable");
    } catch (error) {
      unknown = (error as { code?: string }).code === "UNKNOWN_OUTCOME";
    }
    check(
      unknown && droppedJob,
      "Workflow did not exercise a lost successful begin reply.",
    );
    check(
      (await client.request(id(), "archiveJobStatus", { jobId: droppedJob }))
        .state === "released",
      "Lost begin reply left an undiscoverable active job.",
    );
    const prepared = await prepareArchiveDownload(client, host, "portable");
    check(
      prepared.job.output!.byteLength > 0,
      "Shared export did not stage disk-backed output.",
    );
    const directory = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("quixi-workflow-fixture-" + id(), { create: true }),
      saved = await directory.getFileHandle("fixture.tar", { create: true });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => saved,
    });
    await prepared.save(id());
    const file = await saved.getFile();
    const choose = (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
      event.preventDefault();
      const files = new DataTransfer();
      files.items.add(file);
      input.files = files.files;
      input.dispatchEvent(new Event("change"));
    };
    document.addEventListener("click", choose, true);
    let selected: Awaited<ReturnType<typeof host.chooseFiles>>;
    try {
      selected = await host.chooseFiles(id(), {
        multiple: false,
        mediaTypes: ["application/x-tar"],
      });
    } finally {
      document.removeEventListener("click", choose, true);
    }
    await prepared.release();
    await prepared.release();
    const restored = await stageArchiveRestore(client, host, selected[0]!);
    check(
      restored.kind === "restore" &&
        restored.state === "ready" &&
        restored.candidate?.archiveId !== client.archiveId,
      "Shared file restore did not produce an isolated candidate.",
    );
    await client.request(id(), "releaseArchiveJob", {
      operationId: id(),
      jobId: restored.jobId,
    });

    let existing = await client.request(id(), "beginArchiveExport", {
      operationId: id(),
      format: "open",
    });
    while (existing.state === "working")
      existing = await client.request(id(), "advanceArchiveJob", {
        operationId: id(),
        jobId: existing.jobId,
        maxRecords: 64,
        maxBytes: 262144,
      });
    const outstanding = await client.request(id(), "listArchiveJobs", {
      afterJobId: null,
      maxItems: 16,
    });
    check(
      outstanding.items.length === 1 &&
        outstanding.items[0]!.jobId === existing.jobId,
      "Outstanding export list did not recover the ready job.",
    );
    const resumed = await prepareExistingArchiveDownload(
      client,
      host,
      existing.jobId,
    );
    check(
      resumed.job.jobId === existing.jobId && resumed.job.format === "open",
      "Existing export staging created a different archive job.",
    );
    await resumed.release();
    check(
      (
        await client.request(id(), "listArchiveJobs", {
          afterJobId: null,
          maxItems: 16,
        })
      ).items.length === 0,
      "Released archive jobs remained in outstanding list.",
    );
    return {
      checks: [
        "shared workflow lost successful begin reply reconciles by preallocated job identity",
        "shared export streams into real browser disk staging",
        "shared restore consumes actual disk File through programmatic file-selection fixture and produces isolated candidate",
        "released jobs disappear from bounded outstanding-job list",
        "ready open export stages again without a new archive job",
      ],
    };
  } finally {
    await host.dispose();
    await client.close();
    globalThis.Worker = NativeWorker;
  }
}

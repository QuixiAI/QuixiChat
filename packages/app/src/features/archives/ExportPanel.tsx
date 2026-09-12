import { useEffect, useSyncExternalStore } from "react";
import type { ExportController } from "./controller.ts";
import { useFocusRecovery } from '../accessibility/useFocusRecovery.ts';
const phaseNames = {
  snapshot: "Preparing a consistent copy",
  encoding: "Building archive files",
  receiving: "Receiving archive",
  container_validation: "Checking archive files",
  schema_validation: "Checking database format",
  record_validation: "Checking history",
  blob_validation: "Checking attachments",
  ready: "Ready to save",
  cleanup: "Cleaning temporary files",
};
export function ExportPanel({ controller, onReviewRestore }: { controller: ExportController; onReviewRestore?: (jobId: string) => void }) {
  const focus = useFocusRecovery();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.initialize();
  }, [controller]);
  return (
    <section aria-labelledby="exports-title" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
      <p className="eyebrow">Keep a copy</p>
      <h1 id="exports-title" ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Export your history</h1>
      <p>
        A portable archive contains your conversations, branches, original
        sources and available attachments. Open export includes JSONL and
        Markdown you can read without Quixi.
      </p>
      <p>
        Credentials, downloaded models and derived search indexes are excluded.
      </p>
      <div className="actions">
        <button
          className="primary"
          disabled={state.busy || state.saving}
          onClick={() => void controller.prepare("portable")}
        >
          Prepare Quixi archive
        </button>
        <button
          disabled={state.busy || state.saving}
          onClick={() => void controller.prepare("open")}
        >
          Prepare open export
        </button>
        {state.cancellable && (
          <button onClick={() => controller.cancel()}>
            Cancel preparation
          </button>
        )}
      </div>
      {state.job && (
        <div className="archive-progress">
          <div className="archive-phase" role="status" aria-atomic="true"><h2>{phaseNames[state.job.phase]}</h2></div>
          <p>
            {state.job.completedRecords > 0 && <>{state.job.completedRecords.toLocaleString()} records processed · </>}
            {state.job.completedBytes.toLocaleString()} bytes written
          </p>
          {state.job.output && (
            <p>
              {state.job.output.name} ·{" "}
              {state.job.output.byteLength.toLocaleString()} bytes
            </p>
          )}
        </div>
      )}
      {state.prepared && (
        <div className="actions">
          <button
            disabled={state.busy || state.saving}
            onClick={() => void controller.save()}
          >
            {state.saving ? "Saving…" : "Save prepared export"}
          </button>
          <button
            disabled={state.busy || state.saving}
            onClick={() => void controller.release()}
          >
            Release prepared export
          </button>
        </div>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.notice && <p role="status">{state.notice}</p>}
      <section aria-label="Saved archive work">
        <h2>Saved archive work</h2>
        <p>
          Prepared exports and interrupted work remain available here after
          reopening Quixi.
        </p>
        <button
          disabled={state.busy || state.saving}
          onClick={() => void controller.refreshJobs()}
        >
          Refresh archive work
        </button>
        <ul>
          {state.jobs.map((job) => (
            <li key={job.jobId}>
              {job.kind === "export"
                ? job.format === "portable"
                  ? "Quixi archive"
                  : "Open export"
                : "Restore candidate"}{" "}
              · {job.state} · {job.jobId.slice(0, 8)}{" "}
              <div className="actions">
                {job.kind === "export" && job.state === "ready" && (
                  <button
                    disabled={state.busy || state.saving || state.prepared}
                    onClick={() => void controller.resume(job.jobId)}
                  >
                    Prepare saved export download
                  </button>
                )}
                {job.kind === 'restore' && job.state === 'ready' && onReviewRestore && (
                  <button disabled={state.busy || state.saving} onClick={() => onReviewRestore(job.jobId)}>Review saved restore</button>
                )}
                <button
                  disabled={state.busy || state.saving}
                  onClick={() => void controller.releaseJob(job.jobId)}
                >
                  Release archive work
                </button>
              </div>
              {job.failure && <p>{job.failure.reason}</p>}
            </li>
          ))}
        </ul>
        {state.nextJobId && (
          <button
            disabled={state.busy || state.saving}
            onClick={() => void controller.nextJobs()}
          >
            Next archive work
          </button>
        )}
      </section>
      {state.retained.length > 0 && (
        <section aria-label="Temporary browser downloads">
          <h2>Temporary browser downloads</h2>
          <p>
            Your browser does not report when a download finishes. Keep its
            temporary copy until you have checked the saved file.
          </p>
          <ul>
            {state.retained.map((file) => (
              <li key={file.id}>
                {file.name} · {file.byteLength.toLocaleString()} bytes{" "}
                <button
                  disabled={state.busy || state.saving}
                  onClick={() => void controller.clearDownload(file.id)}
                >
                  I checked the download — clear temporary copy
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

import { createElement, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HostClient } from "@quixi/core/contracts";
import { describeStartupFailure } from "./runtime/startup-failure.ts";
import {
  prepareRescueDownload,
  type PreparedRescueDownload,
} from "./features/archives/rescue.ts";
import { RetainedHistory } from "./features/recovery/RetainedHistory.tsx";

export interface StartupRescueServices {
  /** The literal selected archive to rescue; never resolved from the view. */
  archiveId: string;
  host: HostClient;
  temporaryDownloads?: {
    list(): Promise<
      readonly { id: string; name: string; byteLength: number }[]
    >;
    clear(id: string): Promise<void>;
  };
}
export interface StartupFailureOptions {
  error: unknown;
  retry: () => Promise<void>;
  /** Present only when the host knows which archive failed to open. */
  rescue?: StartupRescueServices;
}

function RescueControls({ rescue }: { rescue: StartupRescueServices }) {
  const [phase, setPhase] = useState<
    "idle" | "preparing" | "prepared" | "saving" | "saved"
  >("idle");
  const [staged, setStaged] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retained, setRetained] = useState<
    readonly { id: string; name: string; byteLength: number }[]
  >([]);
  const prepared = useRef<PreparedRescueDownload | null>(null);
  const refreshRetained = async () => {
    if (!rescue.temporaryDownloads) return;
    try {
      setRetained(await rescue.temporaryDownloads.list());
    } catch {
      /* Listing is informational; the saved file is unaffected. */
    }
  };
  useEffect(() => {
    void refreshRetained();
    return () => {
      void prepared.current?.release().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const prepare = async () => {
    setPhase("preparing");
    setError(null);
    setStaged(0);
    try {
      await prepared.current?.release().catch(() => {});
      prepared.current = await prepareRescueDownload(rescue.host, rescue.archiveId, {
        onProgress: setStaged,
      });
      setPhase("prepared");
    } catch (failure) {
      prepared.current = null;
      setPhase("idle");
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const save = async () => {
    if (!prepared.current) return;
    setPhase("saving");
    setError(null);
    try {
      await prepared.current.save(crypto.randomUUID());
      setPhase("saved");
      await refreshRetained();
    } catch (failure) {
      setPhase("prepared");
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const summary = prepared.current?.summary;
  return (
    <section aria-label="Archive recovery export">
      <h2>Export archive for recovery</h2>
      <p>
        Copies the exact archive database bytes and attachment files into a
        rescue archive without opening or changing them. Restore it with a
        Quixi version that can open this archive.
      </p>
      {phase === "idle" || phase === "preparing" ? (
        <button
          type="button"
          disabled={phase === "preparing"}
          onClick={() => void prepare()}
        >
          {phase === "preparing" ? "Preparing rescue archive…" : "Prepare rescue archive"}
        </button>
      ) : (
        <button
          type="button"
          disabled={phase === "saving"}
          onClick={() => void save()}
        >
          {phase === "saved" ? "Save rescue archive again" : "Save rescue archive"}
        </button>
      )}
      {phase === "preparing" && (
        <p role="status">{staged.toLocaleString()} bytes staged so far.</p>
      )}
      {summary && phase !== "preparing" && (
        <p role="status">
          Rescue archive ready: {summary.byteLength.toLocaleString()} bytes,{" "}
          {summary.manifest.recovery.blobFiles.toLocaleString()} attachment
          files, schema ledger{" "}
          {summary.manifest.recovery.ledger
            ? `${summary.manifest.recovery.ledger.length} entries${summary.manifest.recovery.ledgerCompatible ? "" : " (not readable by this Quixi version)"}`
            : "not readable"}
          . SHA-256 <code>{summary.sha256}</code>.
          {phase === "saved" &&
            " Save request handed to your host. Check the saved file before clearing any temporary copy."}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {retained.length > 0 && rescue.temporaryDownloads && (
        <div>
          <p>
            Your browser does not report when a download finishes. Keep its
            temporary copy until you have checked the saved file.
          </p>
          <ul>
            {retained.map((file) => (
              <li key={file.id}>
                {file.name} · {file.byteLength.toLocaleString()} bytes{" "}
                <button
                  type="button"
                  onClick={() =>
                    void rescue.temporaryDownloads!
                      .clear(file.id)
                      .then(refreshRetained)
                      .catch((failure) =>
                        setError(failure instanceof Error ? failure.message : String(failure)),
                      )
                  }
                >
                  I checked the download — clear temporary copy
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function StartupFailureView({ error, retry, rescue }: StartupFailureOptions) {
  const failure = describeStartupFailure(error);
  const [retrying, setRetrying] = useState(false);
  return (
    <main className="workspace startup-failure" id="workspace" tabIndex={-1}>
      <section role="alert" aria-labelledby="startup-failure-title">
        <h1 id="startup-failure-title">{failure.title}</h1>
        <p>{failure.guidance}</p>
        <p>
          This screen reads no history and changes no archive data. Your
          archive files stay exactly as they were.
        </p>
        <details>
          <summary>Technical details</summary>
          <p>
            Code: <code>{failure.code}</code>
          </p>
          <pre className="quixi-content-source">{failure.message}</pre>
        </details>
        <div className="actions">
          <button
            className="primary"
            type="button"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void retry().finally(() => setRetrying(false));
            }}
          >
            Try again
          </button>
          {retrying && <p role="status">Trying to open the archive again…</p>}
        </div>
      </section>
      {rescue && <RetainedHistory archiveId={rescue.archiveId} />}
      {rescue && <RescueControls rescue={rescue} />}
    </main>
  );
}

/** Replace the host root with the startup-failure outcome. Returns the
 * unmount function; hosts call it before mounting the application after a
 * successful retry. */
export function mountStartupFailure(
  root: HTMLElement,
  options: StartupFailureOptions,
): () => void {
  const renderer = createRoot(root);
  renderer.render(createElement(StartupFailureView, options));
  return () => renderer.unmount();
}

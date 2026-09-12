import { sameArchiveSelection } from "@quixi/core/contracts";
import type { ArchiveSelection } from "@quixi/core/contracts";
import { mountApp, mountStartupFailure } from "@quixi/app";
import { archiveActivationStatus, openActiveStorageClient, readArchiveSelection, reconcilePreviousArchiveOperations, reconcilePreviousArchiveExtraction } from "@quixi/storage/client";
import { createDesktopHost } from "./host/index.ts";
import { desktopProviderConnections } from "./host/provider-connections.ts";
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing application root");
if (location.pathname === "/storage-proof") mountApp(root);
else
  void (async () => {
    const host = await createDesktopHost();
    let storage: Awaited<ReturnType<typeof openActiveStorageClient>> | undefined;
    let unmount: (() => Promise<void>) | undefined;
    let failureView: (() => void) | undefined;
    let reopening = false;
    const openSelectedArchive = async (expected?: ArchiveSelection) => {
      if (reopening) return;
      reopening = true;
      let next: Awaited<ReturnType<typeof openActiveStorageClient>> | undefined;
      try {
        next = await openActiveStorageClient();
      if (expected && !sameArchiveSelection(next.selection, expected)) throw new Error('The active archive changed again. Review the selected archive before opening it.');
        await unmount?.();
        failureView?.();
        failureView = undefined;
        await storage?.close();
        storage = next;
      const selectedStorage = next;
        unmount = mountApp(root, {
      archiveId: selectedStorage.archiveId,
    archiveSession: { selection: selectedStorage.selection, activationStatus: archiveActivationStatus, reconcilePreviousOperations: ids => reconcilePreviousArchiveOperations(selectedStorage, ids), reconcilePreviousExtractionOperation: pending => reconcilePreviousArchiveExtraction(selectedStorage, pending), onSelectionChange: listener => selectedStorage.onSelectionChange(listener), openSelectedArchive },
      storage: selectedStorage,
      embedding: { modelUrl: '/models/arctic-xs.qxmodel' },
      host,
      providerSettings: {
        connections: desktopProviderConnections(),
        credentialCapability: {
          ...host.secretStore,
          permission: "not_required",
        },
      },
        });
        next = undefined;
      } finally {
        if (next) await next.close();
        reopening = false;
      }
    };
    // A failed open keeps the archive untouched and shows the typed outcome
    // with a retry; a later successful open unmounts that view first.
    const attempt = async (): Promise<void> => {
      try {
        await openSelectedArchive();
      } catch (error) {
        let archiveId: string | null = null;
        try { archiveId = (await readArchiveSelection()).archiveId; } catch { archiveId = null; }
        failureView?.();
        failureView = mountStartupFailure(root, {
          error,
          retry: attempt,
          ...(archiveId ? { rescue: { archiveId, host } } : {}),
        });
      }
    };
    await attempt();
  })().catch((error) => {
    root.textContent = `Could not open Quixi: ${error instanceof Error ? error.message : String(error)}`;
  });

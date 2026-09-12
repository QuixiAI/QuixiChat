import "./styles.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { mountStorageProof } from "@quixi/storage/proof";
import { AppRoot } from "./AppRoot.tsx";
import type { AppServices } from "./runtime/library.ts";
export type { AppServices, ConfiguredProvider } from "./runtime/library.ts";
export { mountStartupFailure } from "./StartupFailure.tsx";
export type { StartupFailureOptions, StartupRescueServices } from "./StartupFailure.tsx";
export { describeStartupFailure } from "./runtime/startup-failure.ts";
export type { StartupFailureDescription } from "./runtime/startup-failure.ts";
/** Hosts own service lifetime; the shared UI owns only its controllers. */
export function mountApp(
  root: HTMLElement,
  services?: AppServices,
): () => Promise<void> {
  if (location.pathname === "/storage-proof") {
    const dispose = mountStorageProof(root);
    return async () => {
      dispose();
    };
  }
  if (!services)
    throw new Error(
      "The application host must provide storage and capabilities.",
    );
  const renderer = createRoot(root);
  let shutdown = Promise.resolve();
  renderer.render(
    createElement(AppRoot, {
      services,
      onShutdown: (task) => {
        shutdown = task;
      },
    }),
  );
  return async () => {
    renderer.unmount();
    await shutdown;
  };
}

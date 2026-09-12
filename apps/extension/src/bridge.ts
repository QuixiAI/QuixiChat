/// <reference path="./chrome.d.ts" />
/** Content script injected into the paired Quixi tab on the user's action.
 * It relays JSON port messages from the extension page to the page as
 * `window.postMessage` (chunk bytes decoded from base64 into ArrayBuffers) and
 * forwards the page's replies back over the port. It reads nothing else. */
(() => {
  // Injection is per user action; a repeated injection into the same tab must
  // not register a second listener (duplicate extractions/relays).
  const scope = globalThis as unknown as Record<string, boolean>;
  if (scope.__quixiImportBridge) return;
  scope.__quixiImportBridge = true;
  const CHANNEL = "quixi-extension-import";
  const VERSION = 1;
  const decode = (base64: string): ArrayBuffer => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };
  const ports = new Set<chrome.runtime.Port>();
  const relayToPage = (message: Record<string, unknown>) => {
    const outgoing: Record<string, unknown> = { ...message, channel: CHANNEL, version: VERSION };
    if (message.kind === "chunk" && typeof message.bytesBase64 === "string") {
      const bytes = decode(message.bytesBase64);
      delete outgoing.bytesBase64;
      outgoing.bytes = bytes;
      window.postMessage(outgoing, location.origin, [bytes]);
      return;
    }
    window.postMessage(outgoing, location.origin);
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.channel !== CHANNEL || data.version !== VERSION || typeof data.kind !== "string") return;
    if (!["accepted", "rejected", "ack", "staged", "failed", "imported"].includes(data.kind)) return;
    for (const port of ports) { try { port.postMessage(data); } catch { /* disconnected */ } }
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "quixi-import") return;
    ports.add(port);
    port.onMessage.addListener((message) => {
      const data = message as Record<string, unknown> | null;
      if (!data || typeof data.kind !== "string") return;
      if (data.kind === "ping") { port.postMessage({ kind: "pong", origin: location.origin }); return; }
      if (["offer", "chunk", "resume", "cancel"].includes(data.kind)) relayToPage(data);
    });
    port.onDisconnect.addListener(() => { ports.delete(port); });
  });
})();

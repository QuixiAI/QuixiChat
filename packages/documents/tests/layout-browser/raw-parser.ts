// Proof-owned raw PDF.js parser. It never imports Quixi's normalizer or worker.
// @ts-expect-error The pinned package does not declare its worker entry.
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs';
const deny = () => { throw new Error('Raw reference parser external I/O is forbidden'); };
Object.assign(globalThis, { fetch: deny, XMLHttpRequest: deny, WebSocket: deny, importScripts: deny, eval: deny, Function: deny });
self.onmessage = ({ data }) => {
  self.onmessage = null;
  WorkerMessageHandler.initializeFromPort(data.port);
  data.port.start();
};

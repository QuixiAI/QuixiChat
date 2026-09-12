// PDF.js parser is initialized exclusively on an owned MessagePort; no fake-worker fallback.
// @ts-expect-error PDF.js supplies no declaration for its worker entry.
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs';
const denied = () => { throw new Error('External network is disabled in document extraction.'); };
Object.assign(globalThis, { fetch: denied, XMLHttpRequest: denied, WebSocket: denied, importScripts: denied, eval: denied, Function: denied });
self.onmessage = ({ data }) => { self.onmessage = null; WorkerMessageHandler.initializeFromPort(data.port); data.port.start(); };

import { getDocument, PDFWorker } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { extractDocument, LIMITS, NORMALIZER_VERSION } from '../../src/index.ts';
import type { ExtractionEvent } from '../../src/contracts.ts';
import { LOCAL_ASSETS } from '../../src/worker/assets.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import manifest from '../fixtures/layout-manifest.json';
import columnsURL from '../fixtures/layout-columns.pdf?url';
import tableURL from '../fixtures/layout-table-code.pdf?url';
import unsupportedURL from '../fixtures/layout-unsupported.pdf?url';

const files = [
  { name: 'layout-columns.pdf', url: columnsURL },
  { name: 'layout-table-code.pdf', url: tableURL },
  { name: 'layout-unsupported.pdf', url: unsupportedURL },
] as const;
type RawItem = Pick<TextItem, 'str' | 'transform' | 'width' | 'height' | 'dir' | 'hasEOL'>;
type AuthoredBlock = { kind: string; lines?: string[]; rows?: string[][] };
type ExpectedPage = { page: number; expectedBlocks?: AuthoredBlock[]; sourceAnchors?: string[] };
type PageEnd = Extract<ExtractionEvent, { kind: 'page-end' }> & { layout?: { mode: 'geometric' | 'source_order'; reasons: string[]; columns: 1 | 2 } };
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const hash = (value: string | Uint8Array) => bytesToHex(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();
let activeWorkers = 0, terminatedWorkers = 0;
const workers: { name: string; url: string }[] = [];
const NativeWorker = Worker;
globalThis.Worker = class extends NativeWorker {
  ended = false;
  constructor(url: URL | string, options?: WorkerOptions) {
    super(url, options); activeWorkers++;
    assert(workers.length < 32, 'Worker observation budget');
    workers.push({ name: options?.name ?? '', url: new URL(String(url), location.href).href });
  }
  override terminate() { if (!this.ended) { this.ended = true; activeWorkers--; terminatedWorkers++; } super.terminate(); }
};
class ReferenceAssets {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = LOCAL_ASSETS[`${kind}/${filename}`];
    assert(url && new URL(url, location.href).origin === location.origin, 'Reference asset must be an exact bundled local asset');
    const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
    assert(response.ok, 'Reference font asset unavailable');
    const data = new Uint8Array(await response.arrayBuffer());
    assert(data.length <= 1024 * 1024, 'Reference font asset budget');
    return data;
  }
}

async function reference(bytes: Uint8Array) {
  assert(bytes.length <= 4096, 'Proof-only source buffer is limited to 4 KiB');
  const parser = new Worker(new URL('./raw-parser.ts', import.meta.url), { type: 'module', name: 'quixi-layout-reference-parser' });
  const channel = new MessageChannel();
  parser.postMessage({ port: channel.port2 }, [channel.port2]);
  // @ts-expect-error Runtime supports the MessagePort; pinned declaration says null.
  const worker = new PDFWorker({ port: channel.port1 }); channel.port1.start();
  const task = getDocument({ data: bytes.slice(), worker, disableAutoFetch: true, disableStream: true, stopAtErrors: true,
    useWorkerFetch: false, useWasm: false, disableFontFace: true, useSystemFonts: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 0, enableXfa: false, BinaryDataFactory: ReferenceAssets });
  try {
    const pdf = await task.promise;
    return {
      pages: pdf.numPages,
      async page(number: number): Promise<RawItem[]> {
        const page = await pdf.getPage(number), items: RawItem[] = [];
        let units = 0;
        try {
          const reader = page.streamTextContent({ disableNormalization: true, includeMarkedContent: false }).getReader();
          try {
            for (;;) {
              const next = await reader.read(); if (next.done) break;
              for (const item of next.value.items) if ('str' in item) {
                units += item.str.length;
                assert(items.length < 256 && units <= 16384, 'One-page raw reference budget');
                items.push({ str: item.str, transform: [...item.transform], width: item.width, height: item.height, dir: item.dir, hasEOL: item.hasEOL });
              }
            }
          } finally { await reader.cancel(); reader.releaseLock(); }
        } finally { assert(page.cleanup(), 'Raw reference page cleanup'); }
        return items;
      },
      async close() { try { await task.destroy(); } finally { worker.destroy(); channel.port1.close(); parser.terminate(); } },
    };
  } catch (error) { try { await task.destroy(); } finally { worker.destroy(); channel.port1.close(); parser.terminate(); } throw error; }
}

function authoredOrder(name: string, expected: ExpectedPage, text: string, generated: boolean[], raw: RawItem[], end: PageEnd) {
  assert(end.layout, 'Production PDF page-end lacks explicit layout metadata');
  if (name === 'layout-unsupported.pdf') {
    assert(end.layout.mode === 'source_order' && end.layout.reasons.includes('rotated_or_skewed') && end.layout.columns === 1, 'Mixed rotations must report source-order fallback explicitly');
    assert(text === raw.map(item => item.str + (item.hasEOL ? '\n' : '')).join(''), 'Fallback must preserve every raw item in original order');
    for (const anchor of expected.sourceAnchors ?? []) assert(text.includes(anchor), `Fallback lost authored anchor: ${anchor}`);
    assert(raw.some(item => Math.abs(item.transform[1]!) > 1) && raw.some(item => Math.abs(item.transform[2]!) > 1), 'Reference did not exercise real rotated geometry');
    return;
  }
  assert(end.layout.mode === 'geometric' && end.layout.reasons.length === 0, 'Supported authored layout did not use geometric normalization');
  assert(end.layout.columns === (name === 'layout-columns.pdf' ? 2 : 1), 'Wrong authored column count');
  if (name === 'layout-columns.pdf') {
    const prefix = `P${expected.page}`;
    assert(raw.findIndex(item => item.str.includes(`${prefix}-R1`)) < raw.findIndex(item => item.str.includes(`${prefix}-L1`)), 'Actual raw PDF.js reference lost adversarial right-before-left order');
  }
  const blocks = expected.expectedBlocks!;
  if (name === 'layout-table-code.pdf' && expected.page === 1) {
    assert(raw.findIndex(item => item.str === 'Note') < raw.findIndex(item => item.str === 'Item') && raw.findIndex(item => item.str === 'Item') < raw.findIndex(item => item.str === 'Quantity'), 'Actual raw table is not adversarial column-major order');
    let previous = -1;
    for (const row of blocks.find(block => block.kind === 'table')!.rows!) {
      const rowText = row.join('\t'), position = text.indexOf(rowText);
      assert(position > previous, `Table row/cell association missing: ${rowText}`); previous = position;
      let offset = position;
      for (const cell of row.slice(0, -1)) { offset += cell.length; assert(generated[offset], 'Table separator must have null provenance'); offset++; }
    }
    assert(text.indexOf('TABLE-TITLE') < text.indexOf('Item\tQuantity\tNote') && text.indexOf('TABLE-AFTER') > previous && text.indexOf('TABLE-FOOTER') > text.indexOf('TABLE-AFTER'), 'Table surrounding block order');
  } else {
    const actual = text.trimEnd().split(/\n{2,}/);
    assert(actual.length === blocks.length, `Authored paragraph boundaries differ: ${name} page${expected.page}: ${JSON.stringify(actual)}`);
    for (const [index, block] of blocks.entries()) {
      const exact = block.lines!.join('\n');
      assert(block.kind === 'code' || block.kind === 'list' ? actual[index] === exact : squeeze(actual[index]!) === squeeze(exact), `Authored ${block.kind} block ${index} differs: ${JSON.stringify(actual[index])}`);
    }
  }
}

async function run() {
  assert(NORMALIZER_VERSION === 'quixi-layout-2', 'Expected production normalizer version quixi-layout-2');
  const cases: unknown[] = [];
  let maxReferenceItems = 0, maxPageUTF16 = 0, maxRange = 0, maxInFlight = 0;
  for (const file of files) {
    const attachmentId = crypto.randomUUID();
    const expected = manifest.documents[file.name];
    const response = await fetch(file.url, { credentials: 'omit', redirect: 'error' });
    assert(response.ok, 'Authored fixture unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.length === expected.bytes && hash(bytes) === expected.sha256, 'Authored fixture hash changed');
    const ref = await reference(bytes);
    const pages: unknown[] = [];
    let raw: RawItem[] | null = null, text = '', generated: boolean[] = [], intervals: { start: number; end: number }[][] = [], sourceSpans = 0, generatedSpans = 0, current = 0, inFlight = 0, complete = false;
    try {
      assert(ref.pages === expected.pages.length, 'Raw reference page count differs from authored fixture');
      for await (const event of extractDocument({ attachmentId, sha256: expected.sha256, byteLength: bytes.length, mediaType: 'application/pdf',
        async readRange(offset, length, signal) {
          assert(!signal.aborted && Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length > 0 && length <= 65536 && offset + length <= bytes.length, 'Production source range boundary');
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); maxRange = Math.max(maxRange, length);
          try { return bytes.slice(offset, offset + length); } finally { inFlight--; }
        },
      })) {
        assert(event.attachmentId === attachmentId && event.sha256 === expected.sha256, 'Frozen fixture provenance changed');
        if (event.kind === 'document') assert(event.pages === expected.pages.length && event.parser.includes('dedicated worker'), 'Production did not use real PDF worker');
        if (event.kind === 'page-start') {
          assert(raw === null && event.page === pages.length + 1, 'Page boundary overlap/reordering');
          current = event.page; raw = await ref.page(current); text = ''; generated = []; sourceSpans = 0; generatedSpans = 0;
          intervals = raw.map(() => []); maxReferenceItems = Math.max(maxReferenceItems, raw.length);
        }
        if (event.kind === 'text') {
          assert(raw && event.page === current && event.text.length <= LIMITS.batchUTF16 && text.length + event.text.length <= 16384, 'Bounded active page text');
          let covered = 0;
          for (const span of event.spans) {
            assert(span.outputStart === covered && span.outputEnd > covered && span.outputEnd <= event.text.length, 'Output spans must partition each text event');
            const part = event.text.slice(span.outputStart, span.outputEnd);
            if (span.source === null) {
              assert(/^[\t\n ]+$/.test(part), 'Generated separator is not whitespace'); generatedSpans++;
              generated.push(...Array<boolean>(part.length).fill(true));
            } else {
              assert('itemIndex' in span.source, 'PDF output has a non-PDF source range');
              const source = span.source, item = raw[source.itemIndex];
              assert(item && Number.isInteger(source.itemStart) && Number.isInteger(source.itemEnd) && source.itemStart >= 0 && source.itemEnd <= item.str.length && source.itemEnd > source.itemStart, 'Source item range is invalid');
              assert(item.str.slice(source.itemStart, source.itemEnd) === part, 'Output does not equal exact independent raw PDF.js item slice');
              assert(equal(source.transform, item.transform) && source.width === item.width && source.height === item.height && source.direction === item.dir, 'Source geometry differs from independent raw PDF.js item');
              intervals[source.itemIndex]!.push({ start: source.itemStart, end: source.itemEnd }); sourceSpans++;
              generated.push(...Array<boolean>(part.length).fill(false));
            }
            covered = span.outputEnd;
          }
          assert(covered === event.text.length, 'Output text lacks complete provenance'); text += event.text;
        }
        if (event.kind === 'page-end') {
          assert(raw && event.page === current && event.items === raw.length && event.utf16 === text.length && event.cleanup && event.classification === 'text', 'Page-end count/cleanup differs from bounded independent reference');
          for (const [index, item] of raw.entries()) {
            let covered = 0;
            for (const range of intervals[index]!.sort((a, b) => a.start - b.start)) { assert(range.start === covered, 'Raw item was duplicated or lost'); covered = range.end; }
            assert(covered === item.str.length, 'Normalizer omitted original raw text characters');
          }
          assert(raw.every(item => !/[\n\t]/.test(item.str)), 'Fixture precondition: line/cell separators are geometry, not literal PDF characters');
          for (let offset = 0; offset < text.length; offset++) if (text[offset] === '\n' || text[offset] === '\t') assert(generated[offset], 'Generated line/cell separator must have null source');
          authoredOrder(file.name, expected.pages[current - 1]! as ExpectedPage, text, generated, raw, event);
          maxPageUTF16 = Math.max(maxPageUTF16, text.length);
          pages.push({ page: current, items: raw.length, utf16: text.length, normalizedSha256: hash(text), rawItemsSha256: hash(JSON.stringify(raw)), sourceSpans, generatedSpans, layout: (event as PageEnd).layout, exactSourceCoverage: true, authoredOrder: true });
          raw = null; text = ''; generated = []; intervals = [];
        }
        if (event.kind === 'complete') { assert(raw === null && event.pages === pages.length && pages.length === expected.pages.length, 'Complete event crossed page boundaries'); complete = true; }
      }
      assert(complete, 'No production complete event');
    } finally { await ref.close(); }
    assert(Number(activeWorkers) === 0, 'Actual production/reference worker leaked');
    cases.push({ name: file.name, sha256: expected.sha256, pages, workersReleased: true });
  }
  assert(maxInFlight <= 4, 'Source queue exceeded production limit');
  return { cases, normalizerVersion: NORMALIZER_VERSION, maxReferenceItems, maxPageUTF16, maxRange, maxInFlight, activeWorkers, terminatedWorkers, workers, userAgent: navigator.userAgent, referenceScope: 'One bounded raw page at a time; proof fixtures <=4KiB; output/raw text discarded at page-end. No production normalizer imported by raw reference.' };
}
(globalThis as typeof globalThis & { runLayoutProof: typeof run }).runLayoutProof = run;

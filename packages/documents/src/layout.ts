import { ExtractionError, LIMITS } from './contracts.ts';
import type { SourceSpan } from './contracts.ts';

export interface PdfLayoutItem {
  itemIndex: number;
  str: string;
  transform: number[];
  width: number;
  height: number;
  dir: string;
  hasEOL: boolean;
  monospace: boolean;
}
type Item = PdfLayoutItem & { x: number; y: number; size: number };
type Row = { items: Item[]; y: number; size: number; block: number };
type Piece = { text: string; item: Item | null };
export interface PdfPageLayout {
  mode: 'geometric' | 'source_order';
  reasons: ('non_ltr' | 'rotated_or_skewed')[];
  columns: 1 | 2;
  utf16: number;
  /** One bounded event at a time; synthetic whitespace has no source range. */
  text(): Generator<{ text: string; spans: SourceSpan[] }>;
}

/** Conservative page-local geometry. No document-wide text or chunk collection.
 * Ambiguous/mixed writing directions retain source order with an explicit reason.
 * A repeated wide gutter between substantial prose lines can establish two
 * columns; short table cells retain row order and explicit cell separators. */
export function normalizePdfPage(input: readonly PdfLayoutItem[]): PdfPageLayout {
  if (input.length > LIMITS.pageItems) throw new ExtractionError('CAPACITY', 'PDF page item budget exceeded.');
  let rawUnits = 0;
  const reasons = new Set<'non_ltr' | 'rotated_or_skewed'>();
  const items: Item[] = input.map(value => {
    rawUnits += value.str.length;
    if (rawUnits > LIMITS.pageUTF16) throw new ExtractionError('CAPACITY', 'PDF page text budget exceeded.');
    if (!Number.isInteger(value.itemIndex) || value.itemIndex < 0 || value.itemIndex >= LIMITS.pageItems ||
      value.transform.length !== 6 || ![...value.transform, value.width, value.height].every(Number.isFinite))
      throw new ExtractionError('PARSE_FAILED', 'Invalid PDF source layout coordinates.');
    const transform = [...value.transform];
    const size = Math.max(0.001, Math.hypot(transform[2]!, transform[3]!), Math.abs(value.height));
    if (value.str.trim()) {
      if (value.dir !== 'ltr') reasons.add('non_ltr');
      if (transform[0]! <= 0 || transform[3]! <= 0 || Math.abs(transform[1]!) > size * 0.01 || Math.abs(transform[2]!) > size * 0.01)
        reasons.add('rotated_or_skewed');
    }
    return { ...value, transform, x: transform[4]!, y: transform[5]!, size };
  });
  const pieces: Piece[] = [];
  let utf16 = 0;
  const append = (text: string, item: Item | null = null) => {
    if (!text) return;
    utf16 += text.length;
    if (utf16 > LIMITS.pageUTF16) throw new ExtractionError('CAPACITY', 'Normalized PDF page text budget exceeded.');
    pieces.push({ text, item });
  };
  let columns: 1 | 2 = 1;
  if (reasons.size) {
    for (const item of items) {
      append(item.str, item);
      if (item.hasEOL) append('\n');
    }
  } else {
    const rows: Row[] = [];
    const sorted = items.filter(item => item.str.length).sort((a, b) => b.y - a.y || a.x - b.x || a.itemIndex - b.itemIndex);
    for (const item of sorted) {
      const row = rows.at(-1);
      if (row && Math.abs(row.y - item.y) <= Math.min(row.size, item.size) * 0.25) {
        row.items.push(item); row.size = Math.max(row.size, item.size);
      } else rows.push({ items: [item], y: item.y, size: item.size, block: 0 });
    }
    for (const row of rows) row.items.sort((a, b) => a.x - b.x || a.itemIndex - b.itemIndex);
    const gutter = findGutter(rows);
    let ordered = rows;
    if (gutter !== null) {
      columns = 2;
      ordered = [];
      let left: Row[] = [], right: Row[] = [], block = 0;
      const flush = () => {
        for (const group of [left, right]) {
          for (const row of group) ordered.push({ ...row, block });
          block++;
        }
        left = []; right = [];
      };
      for (const row of rows) {
        if (row.items.some(item => item.x < gutter && item.x + Math.abs(item.width) > gutter)) {
          flush(); ordered.push({ ...row, block: block++ });
        } else {
          const l = row.items.filter(item => item.x < gutter), r = row.items.filter(item => item.x >= gutter);
          if (l.length) left.push({ ...row, items: l });
          if (r.length) right.push({ ...row, items: r });
        }
      }
      flush();
    }
    // Bound inferred indentation to a local contiguous block. It is generated
    // whitespace, distinct from any literal spaces retained by PDF.js.
    let blockStart = 0;
    while (blockStart < ordered.length) {
      let blockEnd = blockStart + 1;
      while (blockEnd < ordered.length && !separate(ordered[blockEnd - 1]!, ordered[blockEnd]!)) blockEnd++;
      const block = ordered.slice(blockStart, blockEnd);
      const left = Math.min(...block.map(row => row.items[0]!.x));
      for (let at = blockStart; at < blockEnd; at++) {
        const row = ordered[at]!;
        if (at) append(at === blockStart ? '\n\n' : '\n');
        const first = row.items[0]!;
        if (row.items.every(item => item.monospace)) {
          const indent = Math.min(32, Math.max(0, Math.round((first.x - left) / (first.size * 0.6))));
          append(' '.repeat(indent));
        }
        for (let index = 0; index < row.items.length; index++) {
          const item = row.items[index]!, previous = row.items[index - 1];
          if (previous) {
            const gap = item.x - previous.x - Math.abs(previous.width);
            if (gap > row.size * 2) append('\t');
            else if (gap > row.size * 0.18 && !/\s$/.test(previous.str) && !/^\s/.test(item.str)) append(' ');
          }
          append(item.str, item);
        }
      }
      blockStart = blockEnd;
    }
    if (ordered.length) append('\n');
  }
  return {
    mode: reasons.size ? 'source_order' : 'geometric', reasons: [...reasons], columns, utf16,
    *text() {
      for (const piece of pieces) for (let start = 0; start < piece.text.length;) {
        let end = Math.min(piece.text.length, start + LIMITS.batchUTF16);
        if (end < piece.text.length && /[\uD800-\uDBFF]/.test(piece.text[end - 1]!)) end--;
        const text = piece.text.slice(start, end), item = piece.item;
        yield { text, spans: [{ outputStart: 0, outputEnd: text.length, source: item ? {
          itemIndex: item.itemIndex, itemStart: start, itemEnd: end,
          transform: [...item.transform], width: item.width, height: item.height, direction: item.dir,
        } : null }] };
        start = end;
      }
    },
  };
}

function separate(before: Row, after: Row): boolean {
  return before.block !== after.block || before.y - after.y > Math.max(before.size, after.size) * 2.1 ||
    Math.max(before.size, after.size) > Math.min(before.size, after.size) * 1.25 ||
    before.items.every(item => item.monospace) !== after.items.every(item => item.monospace);
}

function findGutter(rows: Row[]): number | null {
  const all = rows.flatMap(row => row.items);
  if (!all.length) return null;
  const left = Math.min(...all.map(item => item.x)), right = Math.max(...all.map(item => item.x + Math.abs(item.width)));
  if (right <= left) return null;
  // Fixed 64 probes: O(items * 64), no all-pairs geometric comparison.
  const votes = new Uint32Array(64);
  for (const row of rows) {
    const total = row.items.reduce((sum, item) => sum + item.str.trim().length, 0);
    let length = 0;
    for (let at = 0; at + 1 < row.items.length; at++) {
      const item = row.items[at]!, next = row.items[at + 1]!;
      length += item.str.trim().length;
      const start = item.x + Math.abs(item.width), end = next.x;
      if (length < 16 || total - length < 16 || end - start < row.size * 2) continue;
      for (let probe = 1; probe < 63; probe++) {
        const x = left + (right - left) * probe / 64;
        if (x > start + row.size && x < end - row.size) votes[probe] = votes[probe]! + 1;
      }
    }
  }
  let best = -1, count = 2;
  // Prefer a middle probe on ties so small line-length changes do not hug text.
  for (let probe = 1; probe < 63; probe++) if (votes[probe]! > count ||
    (votes[probe] === count && best !== -1 && Math.abs(probe - 32) < Math.abs(best - 32))) {
    best = probe; count = votes[probe]!;
  }
  return best === -1 ? null : left + (right - left) * best / 64;
}

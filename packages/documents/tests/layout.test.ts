import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePdfPage } from '../src/layout.ts';
import type { PdfLayoutItem } from '../src/layout.ts';
import { LIMITS } from '../src/contracts.ts';

function item(itemIndex: number, str: string, x = 40, y = 700, extra: Partial<PdfLayoutItem> = {}): PdfLayoutItem {
  return { itemIndex, str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, dir: 'ltr', hasEOL: true, monospace: false, ...extra };
}
const text = (input: PdfLayoutItem[]) => [...normalizePdfPage(input).text()].map(value => value.text).join('');

test('interleaved prose columns become complete columns without losing original item offsets', () => {
  const input: PdfLayoutItem[] = [];
  for (let line = 0; line < 4; line++) {
    input.push(item(input.length, `Right paragraph continuation ${line}`, 330, 700 - line * 15));
    input.push(item(input.length, `Left paragraph continuation ${line}`, 40, 700 - line * 15));
  }
  const page = normalizePdfPage(input), output = [...page.text()];
  assert.equal(page.columns, 2);
  assert.equal(page.mode, 'geometric');
  assert.match(output.map(value => value.text).join(''), /Left paragraph continuation 3\n\nRight paragraph continuation 0/);
  const indices: number[] = [];
  for (const part of output) for (const span of part.spans) {
    if (!span.source) { assert.match(part.text, /^\s+$/); continue; }
    assert.ok('itemIndex' in span.source);
    const source = span.source;
    indices.push(source.itemIndex);
    assert.equal(part.text.slice(span.outputStart, span.outputEnd), input[source.itemIndex]!.str.slice(source.itemStart, source.itemEnd));
  }
  assert.deepEqual(indices, [1, 3, 5, 7, 0, 2, 4, 6]);
});

test('short cell columns remain row-associated and use generated tab separators', () => {
  const input = [item(0, 'blue', 300, 685), item(1, 'red', 300, 700), item(2, 'apple', 40, 700), item(3, 'berry', 40, 685)];
  assert.equal(normalizePdfPage(input).columns, 1);
  assert.equal(text(input), 'apple\tred\nberry\tblue\n');
});

test('monospace indentation comes from local block geometry and separates prose blocks', () => {
  const input = [item(0, 'function f() {', 64, 700, { monospace: true }), item(1, 'return 1;', 76, 685, { monospace: true }),
    item(2, '}', 64, 670, { monospace: true }), item(3, 'Following paragraph.', 40, 600)];
  assert.equal(text(input), 'function f() {\n  return 1;\n}\n\nFollowing paragraph.\n');
});

test('unsupported rotated or RTL geometry is explicit and preserves source text and transforms', () => {
  const input = [item(0, 'rotated', 0, 0, { transform: [0, 10, -10, 0, 100, 100] }), item(1, 'עברית', 30, 20, { dir: 'rtl' })];
  const page = normalizePdfPage(input);
  assert.equal(page.mode, 'source_order');
  assert.deepEqual(page.reasons, ['rotated_or_skewed', 'non_ltr']);
  assert.equal(text(input), 'rotated\nעברית\n');
  assert.deepEqual([...page.text()][0]!.spans[0]!.source, {
    itemIndex: 0, itemStart: 0, itemEnd: 7, transform: input[0]!.transform, width: 35, height: 10, direction: 'ltr',
  });
});

test('snapshot and output credits preserve surrogate boundaries and honest source slices', () => {
  const original = 'a'.repeat(4095) + '😀tail';
  const input = [item(0, original)];
  const page = normalizePdfPage(input);
  input[0]!.str = 'changed'; input[0]!.transform[4] = 999;
  let actual = '';
  for (const part of page.text()) {
    assert.ok(part.text.length <= LIMITS.batchUTF16);
    assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text));
    actual += part.text;
    const source = part.spans[0]!.source;
    if (source && 'itemIndex' in source) {
      assert.equal(part.text, original.slice(source.itemStart, source.itemEnd));
      assert.equal(source.transform[4], 40);
    }
  }
  assert.equal(actual, original + '\n');
});

test('raw inputs and synthetic separators share the strict page budget', () => {
  assert.throws(() => normalizePdfPage([item(0, 'x'.repeat(LIMITS.pageUTF16 + 1))]), { code: 'CAPACITY' });
  assert.throws(() => normalizePdfPage([item(0, 'x'.repeat(LIMITS.pageUTF16))]), { code: 'CAPACITY' });
  assert.throws(() => normalizePdfPage(Array.from({ length: LIMITS.pageItems + 1 }, (_, at) => item(at, ''))), { code: 'CAPACITY' });
  assert.throws(() => normalizePdfPage([item(0, 'text', 0, 0, { transform: [10, 0, 0, 10, Infinity, 0] })]), { code: 'PARSE_FAILED' });
});

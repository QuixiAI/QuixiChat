/** One-time synthetic pre-upgrade fixture capture; requires the actual v1 schema. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fixture, begin, page, span, stage, publish, rows } from '../extraction-search/fixture.ts';
import { EXTRACTION_SCHEMA_VERSION } from '../../src/worker/extraction/schema.ts';
assert.equal(EXTRACTION_SCHEMA_VERSION, 1, 'Never regenerate legacy evidence using the upgraded implementation');
const f = fixture();
try {
  const run = begin(f), text = 'Legacy page 日本語 preserved source order.';
  const p = page(f, run.runId, 1, 2), map = span(0, text);
  const staged = stage(f, p, text, 0, 0, [map]);
  const published = publish(f, p, text, [map]);
  const second = page(f, run.runId, 2, 2), pending = stage(f, second, 'Interrupted second page checkpoint.');
  const objects = rows(f.db, "SELECT type,name,sql FROM sqlite_schema WHERE name GLOB 'quixi_extract_*' AND sql IS NOT NULL ORDER BY type,name");
  const tables = objects.filter(object => object.type === 'table');
  const records = Object.fromEntries(tables.map(table => [String(table.name), rows(f.db, `SELECT * FROM ${table.name}`)]));
  const claims = rows(f.db, 'SELECT * FROM proof_operation_claims ORDER BY id');
  await writeFile(new URL('./fixtures/v1.json', import.meta.url), JSON.stringify({ capturedAt: new Date().toISOString(), schemaVersion: 1, objects, records, claims, run, text, staged, published, second, pending }, null, 2) + '\n');
} finally { f.close(); }

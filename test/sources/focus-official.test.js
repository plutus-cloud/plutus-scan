import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';

// The FinOps Foundation's FOCUS 1.0 sample (CC BY 4.0), committed unchanged; see
// test/fixtures/focus/official-sample.NOTICE.md. It covers September 2024 for AWS,
// Microsoft and Oracle.
const sample = new URL('../fixtures/focus/official-sample.csv', import.meta.url).pathname;

test('ingests the official FOCUS 1.0 sample', async () => {
  const transport = createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
  const window = { start: '2024-09-01', end: '2024-09-30', days: 30 };
  const res = await fetchFocus(transport, { paths: [sample], window });
  assert.ok(res.rows.length > 0);
  const providers = new Set(res.rows.map((r) => r.provider));
  assert.ok(providers.size > 1, `providers: ${[...providers]}`);
  assert.deepEqual([...providers].sort(), ['aws', 'azure', 'oci']);
  assert.ok(res.rows.every((r) => Number.isFinite(r.cost) && r.currency === 'USD'));
});

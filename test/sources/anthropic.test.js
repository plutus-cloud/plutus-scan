import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, SourceError } from '../../src/transport.js';
import { describeAnthropic, fetchAnthropic } from '../../src/sources/anthropic.js';
import { fakeFetch, fixture } from '../helpers/http-fake.js';

const window = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const KEY = 'sk-ant-admin01-test-secret';
// Priority Tier is stated once, in the basis line, not again as a note.

function setup(costsHandler) {
  const calls = [];
  const fetchImpl = fakeFetch((u) => {
    if (u.pathname === '/v1/organizations/workspaces') return { body: fixture('anthropic/workspaces.json') };
    return costsHandler(u);
  }, calls);
  return { calls, transport: createTransport({ fetchImpl }) };
}
const pages = () => ({
  null: fixture('anthropic/cost-report-page1.json'),
  p2: fixture('anthropic/cost-report-page2.json'),
  p3: fixture('anthropic/cost-report-page3.json'),
});
const paged = (u) => ({ body: pages()[u.searchParams.get('page')] });

test('anthropic converts cent strings to dollars', async () => {
  const { calls, transport } = setup(paged);
  const res = await fetchAnthropic(transport, { window, key: KEY });
  const first = calls.find((c) => c.url.pathname === '/v1/organizations/cost_report');
  assert.equal(first.url.host, 'api.anthropic.com');
  assert.equal(first.url.searchParams.get('starting_at'), '2026-07-31T00:00:00Z');
  assert.equal(first.url.searchParams.get('ending_at'), '2026-10-29T00:00:00Z');
  assert.equal(first.url.searchParams.get('bucket_width'), '1d');
  assert.equal(first.url.searchParams.get('limit'), '31');
  assert.deepEqual(first.url.searchParams.getAll('group_by[]'), ['description', 'workspace_id']);
  assert.equal(first.headers['x-api-key'], KEY);
  assert.equal(first.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(res.rows[0], {
    date: '2026-10-01', provider: 'anthropic', kind: 'ai', service: 'model-beta', account: null,
    project: 'Production', usageType: null, cost: 1.2345, currency: 'USD',
  });
  assert.equal(res.rows[1].cost, 2.5);
  assert.equal(res.rows.length, 6); // the zero-amount result is dropped
  assert.equal(res.rows[2].service, 'Web search'); // no model: description
  assert.equal(res.rows[3].service, 'code_execution'); // no model or description: cost_type
  assert.ok(!res.notes.some((n) => n.includes('Priority Tier')), 'stated once, in the basis line');
  assert.deepEqual(res.basis, ['Anthropic: as reported by the cost report API; Priority Tier not included.']);
  assert.ok(transport.log.every((r) => r.source === 'anthropic' && r.credential === 'ANTHROPIC_ADMIN_KEY'));
  assert.ok(!JSON.stringify(transport.log).includes(KEY));
});

test('anthropic names the default workspace', async () => {
  const { transport } = setup(paged);
  const res = await fetchAnthropic(transport, { window, key: KEY });
  assert.equal(res.rows[1].service, 'model-gamma');
  assert.equal(res.rows[1].project, 'Default workspace');
  assert.equal(res.rows[3].project, 'Default workspace');
});

test('anthropic pages across a 90-day window', async () => {
  const { calls, transport } = setup(paged);
  const res = await fetchAnthropic(transport, { window, key: KEY });
  const costs = calls.filter((c) => c.url.pathname === '/v1/organizations/cost_report');
  assert.equal(costs.length, 3);
  assert.deepEqual(costs.map((c) => c.url.searchParams.get('page')), [null, 'p2', 'p3']);
  assert.deepEqual([...new Set(res.rows.map((r) => r.date))], ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('anthropic 401 and 403 ask to check the admin key', async () => {
  for (const status of [401, 403]) {
    const { transport } = setup(() => ({ status, body: { error: { message: `bad key ${KEY}` } } }));
    await assert.rejects(fetchAnthropic(transport, { window, key: KEY }), (e) => {
      assert.ok(e instanceof SourceError);
      assert.match(e.message, /check the admin key/i);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  }
});

test('anthropic describe lists the first-page requests without calling', () => {
  const reqs = describeAnthropic({ window });
  assert.equal(reqs.length, 2);
  for (const r of reqs) {
    assert.equal(r.source, 'anthropic');
    assert.equal(r.kind, 'http');
    assert.equal(r.credential, 'ANTHROPIC_ADMIN_KEY');
    assert.equal(r.billed, false);
    assert.ok(r.target.startsWith('https://api.anthropic.com/v1/organizations/'));
  }
  assert.ok(reqs[0].target.includes('starting_at=2026-07-31T00:00:00Z'));
  assert.ok(reqs[1].target.includes('/workspaces?limit=100'));
});

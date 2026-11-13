import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, SourceError } from '../../src/transport.js';
import { describeOpenAI, fetchOpenAI } from '../../src/sources/openai.js';
import { fakeFetch, fixture } from '../helpers/http-fake.js';

const window = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const KEY = 'sk-admin-test-secret-123';
const unix = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;

function setup(costsHandler) {
  const calls = [];
  const fetchImpl = fakeFetch((u) => {
    if (u.pathname === '/v1/organization/projects') return { body: fixture('openai/projects.json') };
    return costsHandler(u);
  }, calls);
  return { calls, transport: createTransport({ fetchImpl }) };
}

test('openai maps model and project name', async () => {
  const { calls, transport } = setup(() => ({ body: fixture('openai/costs.json') }));
  const res = await fetchOpenAI(transport, { window, key: KEY });
  const costs = calls.find((c) => c.url.pathname === '/v1/organization/costs');
  assert.equal(costs.url.host, 'api.openai.com');
  assert.equal(costs.url.searchParams.get('start_time'), String(unix('2026-07-31')));
  assert.equal(costs.url.searchParams.get('end_time'), String(unix('2026-10-29')));
  assert.equal(costs.url.searchParams.get('bucket_width'), '1d');
  assert.equal(costs.url.searchParams.get('limit'), '180');
  assert.deepEqual(costs.url.searchParams.getAll('group_by[]'), ['line_item', 'project_id']);
  assert.equal(costs.headers.Authorization, `Bearer ${KEY}`);
  const projects = calls.find((c) => c.url.pathname === '/v1/organization/projects');
  assert.equal(projects.url.searchParams.get('limit'), '100');
  assert.equal(res.rows.length, 4); // the zero-amount result is dropped
  assert.deepEqual(res.rows[0], {
    date: '2026-10-01', provider: 'openai', kind: 'ai', service: 'model-alpha', account: null,
    project: 'Support bot', usageType: null, cost: 12.5, currency: 'USD',
  });
  assert.equal(res.rows[1].service, 'web search');
  assert.equal(res.rows[1].project, 'proj_unknown'); // unknown id keeps the id
  assert.equal(res.rows[2].service, 'OpenAI (other)');
  assert.equal(res.rows[2].project, null);
  assert.equal(res.rows[3].date, '2026-10-02');
  assert.deepEqual(res.basis, ['OpenAI: as reported by the organization costs API.']);
  assert.deepEqual(res.notes, []);
  assert.ok(transport.log.every((r) => r.source === 'openai' && r.credential === 'OPENAI_ADMIN_KEY'));
  assert.ok(!JSON.stringify(transport.log).includes(KEY));
});

test('openai follows next_page', async () => {
  const page1 = { ...fixture('openai/costs.json'), has_more: true, next_page: 'pg2' };
  const page2 = fixture('openai/costs-line-item-only.json');
  const { calls, transport } = setup((u) => ({ body: u.searchParams.get('page') === 'pg2' ? page2 : page1 }));
  const res = await fetchOpenAI(transport, { window, key: KEY });
  const costs = calls.filter((c) => c.url.pathname === '/v1/organization/costs');
  assert.equal(costs.length, 2);
  assert.equal(costs[1].url.searchParams.get('page'), 'pg2');
  assert.equal(res.rows.length, 5);
});

test('openai falls back to line_item on 400 and notes it', async () => {
  const { calls, transport } = setup((u) => (u.searchParams.getAll('group_by[]').length > 1
    ? { status: 400, body: { error: { message: 'bad group_by' } } }
    : { body: fixture('openai/costs-line-item-only.json') }));
  const res = await fetchOpenAI(transport, { window, key: KEY });
  const costs = calls.filter((c) => c.url.pathname === '/v1/organization/costs');
  assert.equal(costs.length, 2);
  assert.deepEqual(costs[1].url.searchParams.getAll('group_by[]'), ['line_item']);
  assert.deepEqual(res.notes, ['OpenAI: project breakdown unavailable for this organization.']);
  assert.equal(res.rows[0].project, null);
  assert.equal(res.rows[0].service, 'model-alpha');
});

test('openai 404 becomes the admin-key note', async () => {
  const { transport } = setup(() => ({ status: 404, body: { error: { message: 'not found' } } }));
  await assert.rejects(fetchOpenAI(transport, { window, key: KEY }), (e) => {
    assert.ok(e instanceof SourceError);
    assert.equal(e.message, 'OpenAI: the costs API returned 404. Check this is an organization admin key (sk-admin-...).');
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('openai 401 and 403 ask to check the admin key', async () => {
  for (const status of [401, 403]) {
    const { transport } = setup(() => ({ status, body: { error: { message: `bad key ${KEY}` } } }));
    await assert.rejects(fetchOpenAI(transport, { window, key: KEY }), (e) => {
      assert.ok(e instanceof SourceError);
      assert.match(e.message, /check the admin key/i);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  }
});

test('openai describe lists the first-page requests without calling', () => {
  const reqs = describeOpenAI({ window });
  assert.equal(reqs.length, 2);
  for (const r of reqs) {
    assert.equal(r.source, 'openai');
    assert.equal(r.kind, 'http');
    assert.equal(r.credential, 'OPENAI_ADMIN_KEY');
    assert.equal(r.billed, false);
    assert.ok(r.target.startsWith('https://api.openai.com/v1/organization/'));
  }
  assert.ok(reqs[0].target.includes(`start_time=${unix('2026-07-31')}`));
  assert.ok(reqs[1].target.includes('/projects?limit=100'));
});

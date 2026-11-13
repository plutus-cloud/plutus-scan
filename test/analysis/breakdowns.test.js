import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untaggedShare, aiByProject } from '../../src/analysis/breakdowns.js';

const ai = (provider, project, cost, kind = 'ai') => ({
  date: '2026-10-20', provider, kind, service: 'x', account: null, project, usageType: null, cost, currency: 'USD',
});

test('untaggedShare keeps order and computes percent', () => {
  const out = untaggedShare([
    { provider: 'aws', key: 'team', taggedCost: 9864, untaggedCost: 1362.9 },
    { provider: 'aws', key: 'env', taggedCost: 3, untaggedCost: 1 },
  ]);
  assert.deepEqual(out.map((o) => o.key), ['team', 'env']);
  assert.equal(out[0].label, 'Untagged');
  assert.equal(out[0].untaggedPct, 12.1);
  assert.equal(out[1].untaggedPct, 25);
});

test('untaggedPct is null with zero spend', () => {
  const [o] = untaggedShare([{ provider: 'aws', key: 'team', taggedCost: 0, untaggedCost: 0 }]);
  assert.equal(o.untaggedPct, null);
  assert.equal(o.label, 'Untagged');
});

test('aiByProject shares sum to 100', () => {
  const out = aiByProject([
    ai('openai', 'proj_a', 50), ai('openai', 'proj_a', 25), ai('anthropic', null, 100),
    ai('openai', 'proj_b', 25), ai('aws', null, 999, 'cloud'),
  ]);
  assert.deepEqual(out.map((o) => [o.provider, o.project, o.cost, o.sharePct]), [
    ['anthropic', '(no project)', 100, 50],
    ['openai', 'proj_a', 75, 37.5],
    ['openai', 'proj_b', 25, 12.5],
  ]);
  assert.equal(out.reduce((s, o) => s + o.sharePct, 0), 100);
});

test('aiByProject with no ai spend', () => {
  assert.deepEqual(aiByProject([ai('aws', null, 5, 'cloud')]), []);
  assert.equal(aiByProject([ai('openai', 'p', 0)])[0].sharePct, 0);
});

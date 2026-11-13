import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findCandidates, RULES_BY_PROVIDER, CANDIDATE_RULES } from '../../src/analysis/candidates.js';
import { AZURE_CANDIDATE_RULES, GCP_CANDIDATE_RULES } from '../../src/analysis/candidate-rules-focus.js';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/candidates/focus-strings.json', import.meta.url), 'utf8'));
const ENTRIES = Object.entries(FIXTURE.rules);

/** @returns {import('../../src/model.js').Row} */
const row = (provider, usageType, service, cost = 20, over = {}) => ({
  date: '2026-10-20', provider, kind: 'cloud', service, account: null, project: null, usageType, cost, currency: 'USD', ...over,
});
const matching = (provider, description, service) =>
  RULES_BY_PROVIDER[provider].filter((r) => r.test(description, service, description)).map((r) => r.id);

test('the Azure and Google Cloud tables have a fixture entry per rule, unique ids, a provider and house wording', () => {
  for (const [provider, rules] of [['azure', AZURE_CANDIDATE_RULES], ['gcp', GCP_CANDIDATE_RULES]]) {
    const ids = rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ids].sort(), ENTRIES.filter(([, e]) => e.provider === provider).map(([id]) => id).sort());
    assert.ok(ids.length >= 8 && ids.length <= 15, `${provider}: ${ids.length} rules`);
    for (const r of rules) {
      assert.equal(r.provider, provider, r.id);
      assert.ok(r.id.startsWith(`${provider}-`), r.id);
      assert.ok(r.strength === 'strong' || r.strength === 'look', r.id);
      assert.equal(r.plutusFix, undefined, `${r.id}: Plutus fixes no ${provider} waste yet`);
      assert.ok(r.title.length > 0 && r.why.length > 0 && typeof r.test === 'function', r.id);
      assert.doesNotMatch(r.why, /\bsav|waste|\bwill\b|%/i, `${r.id}: no promised saving, no percentage`);
      assert.ok(!/\b[A-Z]{4,}\b/.test(r.why.replace(/\b(?:HDD|SSD|NAT|VPN|IP)\b/g, '')), `${r.id}: no capitals for emphasis`);
    }
  }
  assert.ok(CANDIDATE_RULES.every((r) => r.provider === 'aws'));
  const all = [...CANDIDATE_RULES, ...AZURE_CANDIDATE_RULES, ...GCP_CANDIDATE_RULES].map((r) => r.id);
  assert.equal(new Set(all).size, all.length, 'ids are unique across providers');
});

test('every recorded real string matches its own rule, once', () => {
  for (const [id, e] of ENTRIES) {
    assert.ok(e.source?.url && e.source?.fetched, `${id} records its source`);
    assert.ok(e.match.length > 0, id);
    for (const { chargeDescription, serviceName } of e.match) {
      assert.deepEqual(matching(e.provider, chargeDescription, serviceName), [id], `${chargeDescription} (${serviceName})`);
      const found = findCandidates([row(e.provider, chargeDescription, serviceName)], WIN);
      assert.deepEqual(found.map((f) => [f.id, f.provider]), [[id, e.provider]]);
      assert.deepEqual(found[0].usageTypes, [{ usageType: chargeDescription, cost: 20 }]);
    }
  }
});

test('a near miss does not match its rule', () => {
  for (const [id, e] of ENTRIES) {
    assert.ok(e.miss.length >= 2, id);
    for (const { chargeDescription, serviceName } of e.miss) {
      assert.ok(!matching(e.provider, chargeDescription, serviceName).includes(id), `${id} must not match ${chargeDescription} (${serviceName})`);
    }
  }
});

test('one billing row matches at most one rule, per provider, over every string and service in the fixture', () => {
  for (const provider of ['azure', 'gcp']) {
    const entries = ENTRIES.filter(([, e]) => e.provider === provider);
    const services = new Set(entries.flatMap(([, e]) => [...e.match, ...e.miss].map((x) => x.serviceName)).concat(['', 'Compute Engine', 'Cloud SQL', 'Networking']));
    const strings = new Set(entries.flatMap(([, e]) => [...e.match, ...e.miss].map((x) => x.chargeDescription)));
    for (const d of strings) for (const s of services) assert.ok(matching(provider, d, s).length <= 1, `${d} (${s}): ${matching(provider, d, s)}`);
  }
});

test('a provider is tested against its own rules only', () => {
  const [azure] = ENTRIES.filter(([, e]) => e.provider === 'azure');
  const [gcp] = ENTRIES.filter(([, e]) => e.provider === 'gcp');
  for (const [, e] of [azure, gcp]) {
    const { chargeDescription, serviceName } = e.match[0];
    for (const other of ['aws', 'oci', 'openai', 'azure', 'gcp'].filter((p) => p !== e.provider)) {
      assert.deepEqual(findCandidates([row(other, chargeDescription, serviceName)], WIN), [], `${other} row, ${chargeDescription}`);
    }
  }
  // The AWS region strip must not touch a description: a leading token and a hyphen is not a region here.
  assert.deepEqual(findCandidates([row('azure', 'IP Addresses - Standard IPv4 Static Public IP', 'Virtual Network')], WIN).map((f) => f.id), ['azure-public-ip']);
  assert.deepEqual(findCandidates([row('aws', 'USE1-NatGateway-Hours', 'Amazon Virtual Private Cloud')], WIN).map((f) => [f.id, f.provider]), [['nat', 'aws']]);
});

test('the strong Azure and Google Cloud rules are the older VM series and the idle Cloud SQL address', () => {
  const strong = [...AZURE_CANDIDATE_RULES, ...GCP_CANDIDATE_RULES].filter((r) => r.strength === 'strong').map((r) => r.id);
  assert.deepEqual(strong, ['azure-old-vm-series', 'gcp-sql-idle-ip']);
});

test('candidates of every provider share one order: strong before look, each by cost', () => {
  const found = findCandidates([
    row('azure', 'Premium SSD Managed Disks - P10 LRS - US East', 'Virtual Machines', 900),
    row('azure', 'Virtual Machines Dv2/DSv2 Series - D2 v2/DS2 v2 - US East', 'Virtual Machines', 40),
    row('gcp', 'Networking Cloud NAT gateway uptime', 'Networking', 500),
    row('gcp', 'IP address idling in seconds', 'Cloud SQL', 15),
    row('aws', 'USE1-DataTransfer-Out-Bytes', 'Amazon Elastic Compute Cloud', 700),
    row('aws', 'USE1-EBS:VolumeUsage.gp2', 'EC2 - Other', 12),
  ], WIN);
  assert.deepEqual(found.map((f) => f.id), ['gp2', 'azure-old-vm-series', 'gcp-sql-idle-ip', 'azure-premium-disks', 'egress', 'gcp-nat']);
});

test('the official FOCUS sample yields Azure candidates through the FOCUS source', async () => {
  const transport = createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
  const file = new URL('../fixtures/focus/official-sample.csv', import.meta.url).pathname;
  const { detailRows } = await fetchFocus(transport, { paths: [file], window: { start: '2024-01-01', end: '2024-12-31', days: 366 } });
  const azureRows = detailRows.filter((r) => r.provider === 'azure');
  assert.ok(azureRows.length > 0);
  // The sample's amounts are cents, so size each row to clear the $10 floor and put it inside the window.
  const sized = azureRows.map((r) => ({ ...r, cost: 20, date: '2024-09-15' }));
  const found = findCandidates(sized, { start: '2024-08-01', end: '2024-09-30', days: 61 });
  assert.ok(found.length >= 3, `${found.map((c) => c.id)}`);
  for (const c of found) {
    assert.equal(c.provider, 'azure');
    for (const u of c.usageTypes) {
      const service = azureRows.find((r) => r.usageType === u.usageType).service;
      assert.deepEqual(matching('azure', u.usageType, service), [c.id]);
    }
  }
});

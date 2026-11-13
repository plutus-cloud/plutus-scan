import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { addDays, emptyResult } from '../../src/model.js';
import { buildReport } from '../../src/report/data.js';
import { fetchAws } from '../../src/sources/aws.js';
import { fakeAwsExec } from '../helpers/aws-fake.js';
import { headlineSentence, freshnessLine, providerName } from '../../src/report/headline.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const cents = (n) => Math.round(n * 100);
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;

const row = (date, cost, extra = {}) => ({
  date, provider: 'aws', kind: 'cloud', service: 'S3', account: null, project: null,
  usageType: null, cost, currency: 'USD', ...extra,
});

/** Walk every value and collect numbers that are not finite. */
function nonFinite(value, path = '$', out = []) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinite(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nonFinite(v, `${path}.${k}`, out);
  }
  return out;
}

test('buildReport over the synthetic fixture', async () => {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  const report = buildReport({
    window: WIN, results: [{ name: 'focus', result }],
    version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z',
  });

  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.tool, { name: 'plutus-scan', version: '0.1.0' });
  assert.equal(report.generatedAt, '2026-10-30T12:00:00Z');
  assert.deepEqual(report.window, WIN);
  assert.equal(report.currency, 'USD');
  assert.deepEqual(report.excludedCurrencies, {});
  assert.deepEqual(report.sources, [{ name: 'focus', rowCount: 631 }]);
  assert.deepEqual(report.basis, ['FOCUS: BilledCost, including credit and tax rows when present.']);
  assert.equal(report.lastCompleteDay, '2026-10-28');
  assert.equal(report.empty, false);
  assert.equal(report.aws, null);

  assert.equal(cents(report.totals.total), 5193344);
  assert.equal(cents(report.totals.cloud), 5193344);
  assert.equal(report.totals.ai, 0);

  const h = report.headline;
  assert.equal(cents(h.last30.total), 1940430);
  assert.equal(cents(h.last30.cloud), 1940430);
  assert.equal(h.last30.ai, 0);
  assert.equal(cents(h.previous30Total), 1713524);
  assert.equal(cents(h.change), 1940430 - 1713524);
  assert.equal(Math.round(h.changePct * 100), Math.round((226906 / 1713524) * 10000));
  assert.deepEqual(h.movers.map((m) => [m.provider, m.service, m.usageType, cents(m.change)]), [
    ['aws', 'Amazon Elastic Compute Cloud', 'USE1-BoxUsage:m7g.large', 123840],
    ['azure', 'Virtual Machines', 'D4s v5 usage', 43200],
    ['azure', 'Azure SQL Database', 'Gen Purpose compute', 21600],
  ]);
  assert.equal(h.largestAnomaly.date, '2026-10-13');
  assert.equal(h.monthEnd.month, '2026-10');
  assert.equal(h.sentence,
    'Last 30 days: $19,404 ($19,404 cloud, $0.00 AI), +13% vs the previous 30. '
    + 'Biggest mover: AWS Amazon Elastic Compute Cloud / BoxUsage:m7g.large +$1,238. '
    + 'Projected October total: $20,143.');

  assert.equal(report.daily.length, 90);
  assert.deepEqual(report.daily[0].date, '2026-07-31');
  assert.equal(report.daily.at(-1).date, '2026-10-28');
  assert.equal(cents(report.daily.reduce((s, d) => s + d.cloud + d.ai, 0)), 5193344);
  assert.equal(report.forecastExtension.length, 14);
  assert.equal(report.forecastExtension[0].date, '2026-10-29');

  assert.equal(report.anomalies.length, 1);
  const [a] = report.anomalies;
  assert.equal(a.date, '2026-10-13');
  assert.equal(a.provider, 'aws');
  assert.equal(a.service, 'Amazon Elastic Compute Cloud');
  assert.equal(a.cost, 777.6);
  assert.equal(a.baseline, 245.2);
  assert.equal(a.delta, 532.4);
  assert.equal(a.deltaPct, 217);
  assert.equal(a.severity, 'high');

  assert.deepEqual(report.candidates.map((c) => c.id), ['gp2', 's3-standard', 'nat']);
  assert.deepEqual(report.candidates.map((c) => c.strength), ['strong', 'look', 'look']);
  assert.equal(cents(report.candidates[1].cost30d), 155760);
  assert.equal(cents(report.candidates[2].cost30d), 77880);
  assert.equal(cents(report.candidates[0].cost30d), 58410);

  assert.equal(report.drivers.items.length, 6);
  const keys = Object.keys(report.serviceDaily).sort();
  assert.equal(keys.length, 6);
  assert.ok(keys.includes('aws|Amazon Elastic Compute Cloud'));
  const ec2 = report.serviceDaily['aws|Amazon Elastic Compute Cloud'];
  assert.equal(ec2.length, 90);
  assert.equal(ec2[74], 777.6);

  assert.deepEqual(report.untagged.map((u) => [u.provider, u.key, cents(u.untaggedCost)]), [['aws', 'team', 136290]]);
  assert.deepEqual(report.aiProjects, []);
  assert.deepEqual(report.releases, []);
  assert.deepEqual(nonFinite(report), []);
});

test('headline sentence matches the design shape', () => {
  const headline = {
    last30: { total: 12340, cloud: 9870, commitment: 0, ai: 2470 },
    previous30Total: 10457.63, change: 1882.37, changePct: 18.0,
    movers: [
      { provider: 'aws', service: 'EC2-Other', usageType: 'USE1-NatGateway-Bytes', change: 1610 },
      { provider: 'openai', service: 'model-delta', usageType: null, change: 300 },
    ],
    largestAnomaly: null,
    monthEnd: { month: '2026-10', monthToDate: 11000, projected: 13100 },
  };
  assert.equal(headlineSentence(headline, 'USD'),
    'Last 30 days: $12,340 ($9,870 cloud, $2,470 AI), +18% vs the previous 30. '
    + 'Biggest mover: AWS EC2-Other / NatGateway-Bytes +$1,610. Projected October total: $13,100.');
});

test('headline sentence names commitments only when there are some', () => {
  const headline = {
    last30: { total: 15540, cloud: 9870, commitment: 3200, ai: 2470 },
    previous30Total: 13169.49, change: 2370.51, changePct: 18.0,
    movers: [{ provider: 'aws', service: 'EC2-Other', usageType: 'USE1-NatGateway-Bytes', change: 1610 }],
    largestAnomaly: null,
    monthEnd: { month: '2026-10', monthToDate: 14000, projected: 16500 },
  };
  assert.equal(headlineSentence(headline, 'USD'),
    'Last 30 days: $15,540 ($9,870 cloud, $3,200 commitments, $2,470 AI), +18% vs the previous 30. '
    + 'Biggest mover: AWS EC2-Other / NatGateway-Bytes +$1,610. Projected October total: $16,500.');
  assert.equal(headlineSentence({ ...headline, last30: { total: 12340, cloud: 9870, commitment: 0, ai: 2470 } }, 'USD'),
    'Last 30 days: $12,340 ($9,870 cloud, $2,470 AI), +18% vs the previous 30. '
    + 'Biggest mover: AWS EC2-Other / NatGateway-Bytes +$1,610. Projected October total: $16,500.');
});

test('headline shows a decrease with a minus sign', () => {
  const headline = {
    last30: { total: 900, cloud: 400, commitment: 0, ai: 500 },
    previous30Total: 1000, change: -100, changePct: -10,
    movers: [{ provider: 'anthropic', service: 'Model API', usageType: null, change: -1610 }],
    largestAnomaly: null, monthEnd: null,
  };
  assert.equal(headlineSentence(headline, 'USD'),
    'Last 30 days: $900 ($400 cloud, $500 AI), -10% vs the previous 30. '
    + 'Biggest mover: Anthropic Model API -$1,610.');
});

test('headline drops missing clauses and says when there is no previous period', () => {
  const headline = {
    last30: { total: 100, cloud: 100, commitment: 0, ai: 0 },
    previous30Total: null, change: null, changePct: null,
    movers: [], largestAnomaly: null, monthEnd: null,
  };
  assert.equal(headlineSentence(headline, 'USD'),
    'Last 30 days: $100 ($100 cloud, $0.00 AI), no previous 30 days to compare.');
  assert.equal(headlineSentence({ ...headline, previous30Total: 100, change: 0, changePct: 0.3 }, 'USD'),
    'Last 30 days: $100 ($100 cloud, $0.00 AI), 0% vs the previous 30.');
});

test('provider names and the freshness line', () => {
  assert.deepEqual(['aws', 'azure', 'gcp', 'oci', 'openai', 'anthropic', 'Other'].map(providerName),
    ['AWS', 'Azure', 'GCP', 'OCI', 'OpenAI', 'Anthropic', 'Other']);
  assert.equal(freshnessLine({ lastCompleteDay: '2026-10-28', currency: 'EUR' }),
    'Last complete day: 2026-10-28. Currency: EUR.');
  assert.equal(freshnessLine({ lastCompleteDay: '2026-10-28', currency: null }),
    'Last complete day: 2026-10-28. Currency: USD.');
});

test('buildReport handles empty rows', () => {
  const report = buildReport({
    window: WIN, results: [{ name: 'aws', result: emptyResult() }],
    awsBilledRequests: 3, version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z',
  });
  assert.equal(report.empty, true);
  assert.equal(report.currency, 'USD');
  assert.equal(report.daily.length, 90);
  assert.deepEqual(report.daily[0], { date: '2026-07-31', cloud: 0, commitment: 0, ai: 0, monthly: { cloud: 0, commitment: 0, ai: 0 }, spread: { cloud: 0, commitment: 0, ai: 0 } });
  assert.ok(report.daily.every((d) => d.cloud === 0 && d.commitment === 0 && d.ai === 0));
  assert.deepEqual(report.totals, { total: 0, cloud: 0, commitment: 0, ai: 0 });
  assert.equal(report.drivers, null);
  assert.equal(report.headline.monthEnd, null);
  assert.deepEqual(report.forecastExtension, []);
  assert.equal(report.headline.largestAnomaly, null);
  assert.deepEqual(report.headline.movers, []);
  assert.deepEqual(report.anomalies, []);
  assert.deepEqual(report.candidates, []);
  assert.deepEqual(report.serviceDaily, {});
  assert.equal(report.headline.sentence, 'No spend found in this window.');
  assert.deepEqual(report.aws, { billedRequests: 3, cost: 0.03 });
  assert.deepEqual(nonFinite(report), []);
});

test('short window has no previous period', () => {
  const window = { start: '2026-10-01', end: '2026-10-20', days: 20 };
  const result = emptyResult();
  result.rows = [row('2026-10-01', 5), row('2026-10-20', 5)];
  const report = buildReport({ window, results: [{ name: 'aws', result }], version: '0.1.0', generatedAt: 'x' });
  assert.equal(report.headline.previous30Total, null);
  assert.equal(report.headline.change, null);
  assert.equal(report.headline.changePct, null);
  assert.equal(report.drivers, null);
  assert.deepEqual(report.aws, { billedRequests: 0, cost: 0 });
  assert.ok(report.headline.sentence.startsWith('Last 30 days: $10.00 ($10.00 cloud, $0.00 AI), no previous 30 days to compare.'));
  assert.deepEqual(nonFinite(report), []);
});

test('excluded currencies become a note', () => {
  const window = { start: '2026-10-01', end: '2026-10-05', days: 5 };
  const result = emptyResult();
  result.notes = ['source note'];
  result.rows = [
    row('2026-10-01', 100), row('2026-10-02', 2000, { currency: 'EUR' }),
    row('2026-10-03', 1234.5, { currency: 'GBP' }), row('2026-10-04', 3),
    row('2026-09-01', 50000), // outside the window, dropped after the currency pick
  ];
  result.detailRows = [row('2026-10-01', 100, { usageType: 'x' }), row('2026-10-02', 2000, { currency: 'EUR', usageType: 'y' })];
  const report = buildReport({ window, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: 'x' });
  assert.equal(report.currency, 'USD');
  assert.deepEqual(report.excludedCurrencies, { EUR: 2000, GBP: 1234.5 });
  assert.deepEqual(report.notes, [
    'source note',
    'Excluded 2,000.00 EUR in other currencies (no conversion).',
    'Excluded 1,234.50 GBP in other currencies (no conversion).',
  ]);
  assert.equal(report.totals.total, 103);
});

test('results are combined across sources', () => {
  const window = { start: '2026-10-01', end: '2026-10-05', days: 5 };
  const a = emptyResult();
  a.rows = [row('2026-10-01', 10)];
  a.basis = ['AWS: basis'];
  a.releases = [{ date: '2026-10-04', repo: 'r', name: 'v2', url: 'u' }];
  const b = emptyResult();
  b.rows = [row('2026-10-02', 4, { provider: 'openai', kind: 'ai', service: 'model-alpha', project: 'p' })];
  b.basis = ['OpenAI: basis'];
  b.releases = [{ date: '2026-10-02', repo: 'r', name: 'v1', url: 'u' }];
  const report = buildReport({ window, results: [{ name: 'aws', result: a }, { name: 'openai', result: b }],
    awsBilledRequests: 2, version: '0.1.0', generatedAt: 'x' });
  assert.deepEqual(report.sources, [{ name: 'aws', rowCount: 1 }, { name: 'openai', rowCount: 1 }]);
  assert.deepEqual(report.basis, ['AWS: basis', 'OpenAI: basis']);
  assert.deepEqual(report.releases.map((r) => r.name), ['v1', 'v2']);
  assert.deepEqual(report.totals, { total: 14, cloud: 10, commitment: 0, ai: 4 });
  assert.deepEqual(report.daily[1], { date: '2026-10-02', cloud: 0, commitment: 0, ai: 4,
    monthly: { cloud: 0, commitment: 0, ai: 0 }, spread: { cloud: 0, commitment: 0, ai: 0 } });
  assert.deepEqual(report.aiProjects, [{ provider: 'openai', project: 'p', cost: 4, sharePct: 100 }]);
  assert.deepEqual(report.aws, { billedRequests: 2, cost: 0.02 });
});

test('live AWS: usage types sum to their service and candidates are counted once', async () => {
  const transport = createTransport({ execImpl: fakeAwsExec() });
  const result = await fetchAws(transport, { window: WIN });
  const report = buildReport({ window: WIN, results: [{ name: 'aws', result }],
    awsBilledRequests: transport.billedCount(), version: '0.1.0', generatedAt: 'x' });
  for (const item of report.drivers.items) {
    if (item.usageTypes.length === 0) continue;
    const sum = (k) => cents(item.usageTypes.reduce((s, u) => s + u[k], 0));
    assert.equal(sum('current'), cents(item.current), `${item.service} current`);
    assert.equal(sum('previous'), cents(item.previous), `${item.service} previous`);
    assert.equal(sum('change'), cents(item.change), `${item.service} change`);
  }
  const ec2 = report.drivers.items.find((i) => i.service === 'Amazon Elastic Compute Cloud - Compute');
  assert.deepEqual(ec2.usageTypes.map((u) => [u.usageType, u.current, u.previous, u.change]), [
    ['BoxUsage:m5.large', 90, 40, 50], ['DataTransfer-Out-Bytes', 10, 0, 10]]);
  const rds = report.drivers.items.find((i) => i.service === 'Amazon Relational Database Service');
  assert.deepEqual(rds.usageTypes.map((u) => [u.usageType, u.current, u.previous, u.change]), [
    ['InstanceUsage:db.r5.large', 80, 60, 20]]);
  assert.equal(report.headline.movers[0].usageType, 'BoxUsage:m5.large');
  assert.deepEqual(report.candidates.map((c) => [c.id, c.cost30d]), [['egress', 10]]);
  const ri = report.drivers.items.find((i) => i.service === 'Amazon Elastic Compute Cloud - Compute reservations');
  assert.equal(ri.kind, 'commitment');
  assert.deepEqual(ri.usageTypes, []);
  assert.equal(report.totals.commitment, 55);
  assert.equal(report.headline.last30.commitment, 55);
  assert.ok(report.headline.sentence.includes('$55.00 commitments'), report.headline.sentence);
});

test('commitments are their own total, stay out of anomalies and still count in the forecast', () => {
  const window = { start: '2026-07-31', end: '2026-10-28', days: 90 };
  const result = emptyResult();
  for (let d = window.start; d <= window.end; d = addDays(d, 1)) {
    result.rows.push(row(d, 100, { service: 'EC2' }));
    if (d.endsWith('-01')) result.rows.push(row(d, 3000, { service: 'EC2 reservations', kind: 'commitment' }));
  }
  const report = buildReport({ window, results: [{ name: 'aws', result }], version: '0.1.0', generatedAt: 'x' });
  // As billed the fee sits on the 1st; spread, it is a 31st of $3,000 on every October day.
  assert.deepEqual(report.daily.find((d) => d.date === '2026-10-01'), { date: '2026-10-01', cloud: 100, commitment: 3000, ai: 0,
    monthly: { cloud: 0, commitment: 3000, ai: 0 }, spread: { cloud: 0, commitment: 3000 / 31, ai: 0 } });
  assert.deepEqual(report.totals, { total: 9000 + 9000, cloud: 9000, commitment: 9000, ai: 0 });
  assert.deepEqual(report.headline.last30, { total: 6000, cloud: 3000, commitment: 3000, ai: 0 });
  assert.deepEqual(report.anomalies, []);
  assert.equal(report.headline.largestAnomaly, null);
  assert.ok(report.headline.sentence.startsWith('Last 30 days: $6,000 ($3,000 cloud, $3,000 commitments, $0.00 AI)'), report.headline.sentence);
  // The forecast reads the daily total of every kind: October to date is 28 days of usage plus the fee.
  assert.equal(report.headline.monthEnd.monthToDate, 28 * 100 + 3000);
  // The projection carries the spread fee's daily rate, so it lands near usage for the month plus one fee.
  assert.ok(Math.abs(report.headline.monthEnd.projected - (31 * 100 + 3000)) < 1, String(report.headline.monthEnd.projected));
});

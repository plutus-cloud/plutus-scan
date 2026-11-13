import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { main } from '../../src/cli.js';
import { createTransport } from '../../src/transport.js';
import { addDays, computeWindow } from '../../src/model.js';
import { detectAnomalies } from '../../src/analysis/anomalies.js';
import { buildReport, spreadTotal } from '../../src/report/data.js';
import { DEMO_EVENTS, DEMO_NOTE, demoCsv, demoRecords, fetchDemo } from '../../src/sources/demo.js';

const END = '2026-10-30';
const window = computeWindow({ days: 90, end: END });
const dayOf = (/** @type {number} */ offset) => addDays(window.start, offset);
const cents = (/** @type {number} */ n) => Math.round(n * 100) / 100;
// A transport that fails the test if any source tries to reach a provider.
const offline = () => createTransport({
  fetchImpl: async () => { throw new Error('the demo must not make HTTP requests'); },
  execImpl: async () => { throw new Error('the demo must not run the aws CLI'); },
});

async function demoReport() {
  const result = await fetchDemo(offline(), { window });
  return { result, report: buildReport({ window, results: [{ name: 'demo', result }], version: 'test', generatedAt: 'test' }) };
}

test('the demo CSV is byte-identical on every run', () => {
  const a = demoCsv({ end: END });
  assert.equal(demoCsv({ end: END }), a);
  // Pinned so an accidental change to the generator shows up here. A deliberate change updates the hash.
  assert.equal(createHash('sha256').update(a).digest('hex'), '19f55b3814450b3d5aee554040b106463ea31515ece57665e3ea3aaa8294b03a');
});

test('the demo covers 90 days of every kind of charge', () => {
  const records = demoRecords({ end: END });
  const dates = new Set(records.map((r) => r.ChargePeriodStart.slice(0, 10)));
  assert.equal(dates.size, 90);
  assert.deepEqual(new Set(records.map((r) => r.ChargeCategory)), new Set(['Usage', 'Tax', 'Purchase']));
  assert.deepEqual(new Set(records.map((r) => r.ProviderName)), new Set(['AWS', 'OpenAI', 'Anthropic']));
  assert.ok(records.every((r) => r.BillingAccountName === 'Example Corp'));
});

test('the injected spike is the one anomaly, on its day and service', async () => {
  const { report } = await demoReport();
  assert.deepEqual(report.anomalies.map((a) => [a.date, a.provider, a.service, a.severity]),
    [[dayOf(DEMO_EVENTS.spike.day), DEMO_EVENTS.spike.provider, DEMO_EVENTS.spike.service, 'high']]);
});

test('the immaterial wobble is not flagged', async () => {
  const { result, report } = await demoReport();
  const kms = (/** @type {string} */ date) => cents(result.rows
    .filter((r) => r.service === DEMO_EVENTS.wobble.service && r.date === date).reduce((s, r) => s + r.cost, 0));
  const wobbleDay = dayOf(DEMO_EVENTS.wobble.day);
  // The wobble is really there: more than double the same weekday a week before, but only a few dollars.
  assert.ok(kms(wobbleDay) > 2 * kms(addDays(wobbleDay, -7)));
  assert.ok(kms(wobbleDay) - kms(addDays(wobbleDay, -7)) < 10);
  assert.equal(report.anomalies.some((a) => a.service === DEMO_EVENTS.wobble.service), false);
});

test('the step change is the top mover without being flagged', async () => {
  const { report } = await demoReport();
  assert.equal(report.drivers?.items[0].service, DEMO_EVENTS.step.service);
  assert.ok(DEMO_EVENTS.step.day >= 60, 'the step falls inside the last 30 days');
  assert.equal(report.anomalies.some((a) => a.service === DEMO_EVENTS.step.service), false);
});

test('commitment fees and purchases are left out of anomalies', async () => {
  const { result, report } = await demoReport();
  const commitments = result.rows.filter((r) => r.kind === 'commitment');
  assert.ok(commitments.some((r) => r.service === DEMO_EVENTS.purchase.service && r.date === dayOf(DEMO_EVENTS.purchase.day)));
  assert.ok(commitments.some((r) => r.date.endsWith('-01')), 'a monthly fee posts on the 1st');
  assert.equal(report.anomalies.some((a) => commitments.some((c) => c.service === a.service)), false);
  // Read as usage of the service it covers, the upfront purchase would be flagged on its day, so the
  // exclusion is what keeps it out.
  const asUsage = result.rows.map((r) => (r.kind === 'commitment'
    ? { ...r, kind: /** @type {'cloud'} */ ('cloud'), service: r.service.replace(/ purchases$/, '') } : r));
  assert.ok(detectAnomalies(asUsage, window).some((a) => a.date === dayOf(DEMO_EVENTS.purchase.day)
    && a.service === DEMO_EVENTS.purchase.service.replace(/ purchases$/, '')));
});

test('EBS snapshots in many regions make a candidate with a long list of usage types', async () => {
  const { report } = await demoReport();
  const snapshots = report.candidates.find((c) => c.id === 'snapshots');
  assert.equal(snapshots?.usageTypes.length, 12);
  assert.equal(snapshots?.usageTypes[0].usageType, 'USE1-EBS:SnapshotUsage');
});

test('tax and the RI fee are billed on the 1st and spread over their month in the daily views', async () => {
  const { report } = await demoReport();
  const firsts = report.daily.filter((d) => d.date.endsWith('-01'));
  assert.deepEqual(firsts.map((d) => d.date), ['2026-09-01', '2026-10-01']);
  for (const d of firsts) {
    assert.ok(d.monthly.cloud > 1500, `tax on ${d.date}: ${d.monthly.cloud}`);
    assert.equal(d.monthly.commitment, 3600, 'the EC2 and RDS RI fees');
  }
  // September is whole in the window, so its spread portions add back to what was billed on the 1st.
  const sept = report.daily.filter((d) => d.date.startsWith('2026-09'));
  const spreadSum = sept.reduce((a, d) => a + d.spread.cloud + d.spread.commitment, 0);
  assert.ok(Math.abs(spreadSum - (firsts[0].monthly.cloud + firsts[0].monthly.commitment)) < 1e-6);
  // The upfront purchase is one-off, so it stays on its day.
  assert.equal(report.daily[DEMO_EVENTS.purchase.day].monthly.commitment, 0);
  assert.equal(report.anomalies.some((a) => a.service === 'Tax' || a.date.endsWith('-01')), false);
});

test('the large EC2 RI fee with no usage type is spread, so the 1st no longer peaks', async () => {
  const { result, report } = await demoReport();
  const fee = result.rows.find((r) => r.date === '2026-10-01' && r.service === 'Amazon Elastic Compute Cloud purchases');
  assert.deepEqual([fee?.cost, fee?.usageType, fee?.monthly], [3000, null, true]);
  // The prorated fee for an instance bought mid-month bills the same service on another day; it stays there.
  assert.ok(result.rows.some((r) => r.date === dayOf(DEMO_EVENTS.prorated.day) && r.service === fee?.service && r.cost === DEMO_EVENTS.prorated.cost));
  const billed = report.daily.map((d) => d.cloud + d.commitment + d.ai);
  const spread = report.daily.map(spreadTotal);
  const median = [...spread].sort((a, b) => a - b)[Math.floor(spread.length / 2)];
  for (const date of ['2026-09-01', '2026-10-01']) {
    const i = report.daily.findIndex((d) => d.date === date);
    assert.ok(billed[i] > 4 * median, `as billed ${date} towers: ${billed[i]}`);
    assert.ok(spread[i] < 1.5 * median, `spread ${date} is an ordinary day: ${spread[i]} against ${median}`);
  }
  // Spread, the tallest day is the one-off upfront purchase.
  assert.equal(spread.indexOf(Math.max(...spread)), DEMO_EVENTS.purchase.day);
});

test('demo totals are stable', async () => {
  const { report } = await demoReport();
  const t = report.totals;
  assert.deepEqual([cents(t.total), cents(t.cloud), cents(t.commitment), cents(t.ai)], [137392.03, 111187.5, 22340, 3864.53]);
  assert.equal(report.headline.sentence, 'Last 30 days: $49,733 ($40,500 cloud, $7,800 commitments, $1,433 AI), +7% vs the previous 30. '
    + 'Biggest mover: AWS Amazon Relational Database Service / InstanceUsage:db.r6g.xlarge +$1,476. Projected October total: $51,326.');
  assert.deepEqual(report.untagged.map((u) => [u.provider, u.key, u.untaggedPct]), [['aws', 'team', 26.5], ['aws', 'env', 33.5]]);
  assert.deepEqual(report.aiProjects.map((p) => [p.provider, p.project]),
    [['openai', 'support-bot'], ['anthropic', 'support-bot'], ['openai', 'search-assist']]);
});

test('--demo writes a report without reading any account, even with keys in the environment', async () => {
  const stdout = { text: '', write(/** @type {string} */ s) { this.text += s; return true; } };
  const stderr = { text: '', write(/** @type {string} */ s) { this.text += s; return true; } };
  const env = { OPENAI_ADMIN_KEY: 'sk-test', ANTHROPIC_ADMIN_KEY: 'sk-ant-test' };
  const code = await main(['--demo', '--end', END, '--json', '-'], { env, stdout, stderr, transport: offline() });
  assert.equal(code, 0, stderr.text);
  const report = JSON.parse(stdout.text);
  assert.deepEqual(report.sources.map((s) => s.name), ['demo']);
  assert.equal(report.notes[0], DEMO_NOTE);
  assert.equal(report.anomalies[0].date, dayOf(DEMO_EVENTS.spike.day));
});

test('--demo refuses flags that would read an account', async () => {
  for (const args of [['--focus', 'x.csv'], ['--aws'], ['--openai-key', 'k'], ['--profile', 'p'], ['--github', 'o/r']]) {
    const stderr = { text: '', write(/** @type {string} */ s) { this.text += s; return true; } };
    const code = await main(['--demo', ...args], { env: {}, stdout: { write() { return true; } }, stderr, transport: offline() });
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr.text, new RegExp(`--demo reads no account, so it cannot be combined with ${args[0]}\\.`));
  }
});

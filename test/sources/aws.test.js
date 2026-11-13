import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { awsAvailable, classifyRecord, describeAws, fetchAws, shellQuote } from '../../src/sources/aws.js';
import { fakeAwsExec } from '../helpers/aws-fake.js';
import { addDays, eachDay } from '../../src/model.js';
import { detectAnomalies } from '../../src/analysis/anomalies.js';

const window = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const EC2 = 'Amazon Elastic Compute Cloud - Compute';

function run(opts = {}, fetchOpts = {}) {
  const calls = [];
  const transport = createTransport({ execImpl: fakeAwsExec({ calls, ...opts }) });
  return { calls, transport, promise: fetchAws(transport, { window, ...fetchOpts }) };
}
const isCe = (a) => a[1] === 'get-cost-and-usage';

const COMMITMENT_TYPES = ['SavingsPlanRecurringFee', 'SavingsPlanUpfrontFee', 'RIFee', 'Recurring',
  'Recurring reservation fee', 'Fee', 'Upfront', 'Upfront reservation fee'];
const NOT_COMMITMENT = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: COMMITMENT_TYPES } } };

test('maps daily SERVICE x RECORD_TYPE groups to cloud and commitment rows and follows NextPageToken', async () => {
  const { calls, promise } = run();
  const res = await promise;
  const daily = calls.filter((a) => isCe(a) && a.includes('Type=DIMENSION,Key=RECORD_TYPE'));
  assert.equal(daily.length, 2);
  assert.ok(!calls.some((a) => a.includes('Type=DIMENSION,Key=LINKED_ACCOUNT')));
  assert.ok(daily[0].includes('Start=2026-07-31,End=2026-10-29'));
  assert.ok(daily[0].includes('DAILY'));
  assert.ok(!daily[0].includes('--filter'));
  assert.equal(daily[1][daily[1].indexOf('--next-page-token') + 1], 'page2-token');
  // Zero groups are dropped, and so is EC2 on 2026-10-01, whose covered usage and negation net to zero.
  assert.equal(res.rows.length, 13);
  assert.deepEqual(res.rows[0], {
    date: '2026-09-10', provider: 'aws', kind: 'cloud', service: EC2, account: null,
    project: null, usageType: null, cost: 20, currency: 'USD',
  });
  const first = res.rows.filter((r) => r.date === '2026-10-01');
  const base = { date: '2026-10-01', provider: 'aws', account: null, project: null, usageType: null, currency: 'USD' };
  assert.deepEqual(first, [
    // Tax and the reservation and Savings Plan recurring fees on the 1st may be billed for the month.
    { ...base, kind: 'commitment', service: `${EC2} reservations`, cost: 30, monthly: true },
    { ...base, kind: 'commitment', service: 'Savings Plans for AWS Compute usage', cost: 25, monthly: true },
    { ...base, kind: 'cloud', service: 'Tax', cost: 2.5, monthly: true },
  ]);
  assert.ok(!res.notes.some((n) => n.includes('linked account')), res.notes.join('\n'));
  assert.deepEqual(res.basis, ['AWS: UnblendedCost from Cost Explorer, including credits, refunds and tax as billed.']);
});

test('drill-down filters to the top 3 services by change and leaves out commitment record types', async () => {
  const { calls, promise } = run();
  await promise;
  const drill = calls.find((a) => isCe(a) && a.includes('Type=DIMENSION,Key=USAGE_TYPE') && a.includes('DAILY'));
  assert.ok(drill.includes('Start=2026-08-30,End=2026-10-29'));
  const filter = JSON.parse(drill[drill.indexOf('--filter') + 1]);
  assert.deepEqual(filter, { And: [
    { Dimensions: { Key: 'SERVICE', Values: [EC2, 'Amazon Simple Storage Service', 'Amazon Relational Database Service'] } },
    NOT_COMMITMENT,
  ] });
});

test('candidate rows land in candidateRows, apart from rows and the drill-down', async () => {
  const { calls, promise } = run();
  const res = await promise;
  const cand = calls.find((a) => isCe(a) && a.includes('MONTHLY') && a.includes('Type=DIMENSION,Key=USAGE_TYPE'));
  assert.ok(cand.includes('Start=2026-09-29,End=2026-10-29'));
  assert.deepEqual(JSON.parse(cand[cand.indexOf('--filter') + 1]), NOT_COMMITMENT);
  assert.ok(res.rows.every((r) => r.usageType === null));
  const c = res.candidateRows.find((r) => r.usageType === 'InstanceUsage:db.r5.large');
  assert.equal(c.date, '2026-09-29');
  assert.equal(c.cost, 80);
  assert.ok(res.candidateRows.some((r) => r.usageType === 'DataTransfer-Out-Bytes'));
  assert.ok(res.detailRows.every((r) => r.date !== '2026-09-29'), 'no monthly candidate row in the drill-down');
});

test('untagged comes from the empty tag value', async () => {
  const { calls, promise } = run();
  const res = await promise;
  assert.deepEqual(res.tagCoverage, [{ provider: 'aws', key: 'Team', taggedCost: 60, untaggedCost: 40 }]);
  const tag = calls.find((a) => a.includes('Type=TAG,Key=Team'));
  assert.deepEqual(JSON.parse(tag[tag.indexOf('--filter') + 1]), NOT_COMMITMENT);
  assert.ok(calls.some((a) => a[1] === 'list-cost-allocation-tags'));
});

test('stops at maxRequests and names what was skipped when the daily query is cut', async () => {
  const { calls, transport, promise } = run({}, { maxRequests: 1 });
  const res = await promise;
  assert.equal(calls.length, 1);
  assert.equal(transport.billedCount(), 1);
  assert.deepEqual(res.notes, ['AWS: stopped at 1 Cost Explorer requests (--max-aws-requests); skipped part of the daily spend, '
    + 'the usage type drill-down, candidates and tag coverage. Totals are incomplete.']);
  assert.equal(res.rows.length, 4);
});

test('--max-aws-requests 3 names the skipped steps and says totals are complete', async () => {
  const { calls, promise } = run({}, { maxRequests: 3 });
  const res = await promise;
  assert.equal(calls.length, 3);
  assert.deepEqual(res.notes, ['AWS: stopped at 3 Cost Explorer requests (--max-aws-requests); '
    + 'skipped candidates and tag coverage. Totals are complete.']);
  assert.deepEqual(res.candidateRows, []);
  assert.deepEqual(res.tagCoverage, []);
});

test('no cap by default: a daily query of more than 20 pages completes', async () => {
  const PAGES = 25;
  const exec = fakeAwsExec();
  const calls = [];
  const transport = createTransport({ execImpl: async (c, a) => {
    calls.push(a);
    const isDaily = a[1] === 'get-cost-and-usage' && !a.join(' ').includes('USAGE_TYPE') && !a.join(' ').includes('Type=TAG');
    if (!isDaily) return exec(c, a);
    const i = a.includes('--next-page-token') ? Number(a[a.indexOf('--next-page-token') + 1]) : 0;
    const page = { ResultsByTime: [{ TimePeriod: { Start: addDays('2026-09-01', i), End: addDays('2026-09-01', i + 1) },
      Groups: [{ Keys: [EC2, 'Usage'], Metrics: { UnblendedCost: { Amount: '1', Unit: 'USD' } } }] }],
      ...(i + 1 < PAGES ? { NextPageToken: String(i + 1) } : {}) };
    return { code: 0, stdout: Buffer.from(JSON.stringify(page)), stderr: '' };
  } });
  const res = await fetchAws(transport, { window });
  assert.equal(res.rows.length, PAGES);
  assert.ok(!res.notes.some((n) => n.includes('stopped')), res.notes.join('\n'));
  assert.ok(transport.billedCount() > 20);
  assert.equal(res.tagCoverage.length, 1);
});

test('access denied becomes the named-permission note', async () => {
  const { promise } = run({ overrides: { 'daily-page1.json': {
    code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the GetCostAndUsage operation: nope' } } });
  await assert.rejects(promise, (e) => {
    assert.equal(e.source, 'aws');
    assert.ok(e.message.startsWith('AWS: '));
    assert.ok(e.message.includes('ce:GetCostAndUsage'));
    assert.ok(e.message.includes('management account'));
    return true;
  });
});

test('cost explorer not enabled links the console', async () => {
  const { promise } = run({ overrides: { 'daily-page1.json': {
    code: 254, stderr: 'An error occurred (DataUnavailableException) when calling the GetCostAndUsage operation: x' } } });
  await assert.rejects(promise, /AWS: Cost Explorer is not enabled.*https:\/\/console\.aws\.amazon\.com\/cost-management\/home/);
});

test('a failing later call becomes a note and keeps the daily rows', async () => {
  const { promise } = run({ overrides: { 'drilldown.json': {
    code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the GetCostAndUsage operation: nope' } } });
  const res = await promise;
  assert.equal(res.rows.length, 13);
  assert.ok(res.notes.some((n) => n.includes('ce:GetCostAndUsage')));
  assert.equal(res.tagCoverage.length, 1);
});

test('no active tags is noted', async () => {
  const exec = fakeAwsExec();
  const transport = createTransport({ execImpl: async (c, a) => {
    if (a[1] === 'list-cost-allocation-tags') return { code: 0, stdout: Buffer.from('{"CostAllocationTags":[]}'), stderr: '' };
    return exec(c, a);
  } });
  const res = await fetchAws(transport, { window });
  assert.ok(res.notes.includes("AWS: no cost allocation tags are activated, so untagged share can't be measured."));
  assert.deepEqual(res.tagCoverage, []);
});

test('awsAvailable uses the unbilled sts call', async () => {
  const calls = [];
  const transport = createTransport({ execImpl: fakeAwsExec({ calls }) });
  assert.deepEqual(await awsAvailable(transport), { ok: true });
  assert.equal(transport.billedCount(), 0);
  assert.deepEqual(calls[0].slice(0, 2), ['sts', 'get-caller-identity']);
  const bad = createTransport({ execImpl: fakeAwsExec({ overrides: { 'sts.json': { code: 255, stderr: 'Unable to locate credentials' } } }) });
  const r = await awsAvailable(bad);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('Unable to locate credentials'));
});

test('describeAws calls nothing and estimates 5 requests or more, or up to the cap', () => {
  assert.deepEqual(describeAws({ window }).estimate, { min: 5, max: null });
  assert.deepEqual(describeAws({ window, maxRequests: 3 }).estimate, { min: 3, max: 3 });
  const d = describeAws({ window, maxTagKeys: 5, maxRequests: 20, profile: 'dev' });
  assert.deepEqual(d.estimate, { min: 5, max: 20 });
  assert.equal(d.requests.length, 5);
  assert.ok(d.requests.every((r) => r.source === 'aws' && r.kind === 'aws-cli' && r.billed && r.credential === null));
  assert.ok(d.requests[0].target.startsWith('aws ce get-cost-and-usage --time-period Start=2026-07-31,End=2026-10-29'));
  assert.ok(d.requests[0].target.endsWith('--output json --no-cli-pager --profile dev'));
});

const TYPES_JSON = JSON.stringify(COMMITMENT_TYPES);

test('describeAws shell-quotes arguments so each line can be pasted', () => {
  const d = describeAws({ window, maxRequests: 20, profile: "my profile" });
  const drill = d.requests[1].target;
  assert.ok(drill.includes(`--filter '{"And":[{"Dimensions":{"Key":"SERVICE","Values":[<top 3 services by 30-day change>]}},`
    + `{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":${TYPES_JSON}}}}]}'`), drill);
  assert.ok(d.requests[2].target.includes(`--filter '{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":${TYPES_JSON}}}}'`), d.requests[2].target);
  assert.ok(drill.endsWith("--profile 'my profile'"), drill);
  assert.ok(d.requests[4].target.includes("--group-by 'Type=TAG,Key=<active tag key>'"), d.requests[4].target);
  assert.ok(d.requests[4].target.includes(`--filter '{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":${TYPES_JSON}}}}'`), d.requests[4].target);
  assert.ok(d.requests[0].target.includes('--group-by Type=DIMENSION,Key=SERVICE Type=DIMENSION,Key=RECORD_TYPE'));
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('commitment record types get readable labels', () => {
  assert.deepEqual(['SavingsPlanRecurringFee', 'SavingsPlanUpfrontFee', 'RIFee', 'Recurring', 'Fee', 'Usage', 'Tax']
    .map((t) => classifyRecord('Svc', t)), [
    { kind: 'commitment', service: 'Svc' }, { kind: 'commitment', service: 'Svc' },
    { kind: 'commitment', service: 'Svc reservations' }, { kind: 'commitment', service: 'Svc reservations' },
    { kind: 'commitment', service: 'Svc upfront fees' }, { kind: 'cloud', service: 'Svc' }, { kind: 'cloud', service: 'Svc' },
  ]);
});

test('upfront and monthly reservation fees under any spelling are commitments', () => {
  const spellings = ['Upfront', 'Upfront reservation fee', 'Recurring reservation fee', 'recurring_reservation_fee', 'SAVINGSPLANUPFRONTFEE'];
  assert.deepEqual(spellings.map((t) => classifyRecord('Svc', t)), [
    { kind: 'commitment', service: 'Svc upfront fees' }, { kind: 'commitment', service: 'Svc upfront fees' },
    { kind: 'commitment', service: 'Svc reservations' }, { kind: 'commitment', service: 'Svc reservations' },
    { kind: 'commitment', service: 'Svc' },
  ]);
  for (const t of ['Usage', 'DiscountedUsage', 'SavingsPlanCoveredUsage', 'SavingsPlanNegation', 'Credit', 'Refund', 'Tax', 'Support']) {
    assert.equal(classifyRecord('Svc', t).kind, 'cloud', t);
  }
});

/**
 * An account with steady EC2 usage and, on the 1st of each month, a large upfront Reserved Instance
 * fee and a monthly reservation fee booked under the same service, as Cost Explorer returns them.
 */
function feeAccountExec() {
  const days = eachDay(window).map((d) => ({
    TimePeriod: { Start: d, End: addDays(d, 1) },
    Groups: [
      { Keys: [EC2, 'Usage'], Metrics: { UnblendedCost: { Amount: '500', Unit: 'USD' } } },
      ...(d.endsWith('-01') ? [
        { Keys: [EC2, 'Upfront'], Metrics: { UnblendedCost: { Amount: '12000', Unit: 'USD' } } },
        { Keys: [EC2, 'Recurring reservation fee'], Metrics: { UnblendedCost: { Amount: '3000', Unit: 'USD' } } },
      ] : []),
    ],
  }));
  const json = (o) => ({ code: 0, stdout: Buffer.from(JSON.stringify(o)), stderr: '' });
  return async (_cmd, args) => {
    if (args[1] === 'list-cost-allocation-tags') return json({ CostAllocationTags: [] });
    if (args.includes('Type=DIMENSION,Key=RECORD_TYPE')) return json({ ResultsByTime: days });
    // A drill-down that still returned a reservation fee usage type keeps it out of the usage rows.
    return json({ ResultsByTime: [{ TimePeriod: { Start: '2026-10-01', End: '2026-10-02' }, Groups: [
      { Keys: [EC2, 'USE1-HeavyUsage:m7g.xlarge'], Metrics: { UnblendedCost: { Amount: '3000', Unit: 'USD' } } },
      { Keys: [EC2, 'USE1-BoxUsage:m7g.xlarge'], Metrics: { UnblendedCost: { Amount: '500', Unit: 'USD' } } },
    ] }] });
  };
}

test('reservation fees on the 1st land in commitments and are not anomalies', async () => {
  const res = await fetchAws(createTransport({ execImpl: feeAccountExec() }), { window });
  const firsts = res.rows.filter((r) => r.date === '2026-10-01');
  assert.deepEqual(firsts.map((r) => [r.kind, r.service, r.cost]), [
    ['cloud', EC2, 500],
    ['commitment', `${EC2} upfront fees`, 12000],
    ['commitment', `${EC2} reservations`, 3000],
  ]);
  assert.ok(res.rows.every((r) => r.kind === 'commitment' || r.cost === 500));
  assert.deepEqual(detectAnomalies(res.rows, window), []);
  assert.ok(![...res.detailRows, ...(res.candidateRows ?? [])].some((r) => /HeavyUsage/.test(r.usageType ?? '')));
});

test('a credit or refund keeps its own row, apart from the same day of usage', async () => {
  const day = { TimePeriod: { Start: '2026-10-14', End: '2026-10-15' }, Groups: [
    { Keys: [EC2, 'Usage'], Metrics: { UnblendedCost: { Amount: '400', Unit: 'USD' } } },
    { Keys: [EC2, 'Credit'], Metrics: { UnblendedCost: { Amount: '-300', Unit: 'USD' } } },
    { Keys: [EC2, 'Refund'], Metrics: { UnblendedCost: { Amount: '-20', Unit: 'USD' } } },
  ] };
  const json = (o) => ({ code: 0, stdout: Buffer.from(JSON.stringify(o)), stderr: '' });
  const execImpl = async (_cmd, args) => (args[1] === 'list-cost-allocation-tags'
    ? json({ CostAllocationTags: [] })
    : json({ ResultsByTime: args.includes('Type=DIMENSION,Key=RECORD_TYPE') ? [day] : [] }));
  const res = await fetchAws(createTransport({ execImpl }), { window });
  assert.deepEqual(res.rows.map((r) => [r.kind, r.service, r.cost]), [['cloud', EC2, 400], ['cloud', EC2, -320]]);
});

test('denied tag listing keeps the spend and says only the tags are off limits', async () => {
  const day = { TimePeriod: { Start: '2026-10-14', End: '2026-10-15' }, Groups: [
    { Keys: ['Amazon EC2', 'Usage'], Metrics: { UnblendedCost: { Amount: '400', Unit: 'USD' } } },
  ] };
  const execImpl = async (_cmd, args) => (args[1] === 'list-cost-allocation-tags'
    ? { code: 254, stdout: Buffer.alloc(0), stderr: Buffer.from("An error occurred (AccessDeniedException) when calling the ListCostAllocationTags operation: Linked account doesn't have access to cost allocation tags.") }
    : { code: 0, stdout: Buffer.from(JSON.stringify({ ResultsByTime: [day] })), stderr: '' });
  const res = await fetchAws(createTransport({ execImpl }), { window });
  assert.ok(res.rows.length > 0, 'spend rows survive');
  assert.equal(res.notes.length, 1);
  assert.match(res.notes[0], /cost allocation tags can't be listed/);
  assert.doesNotMatch(res.notes[0], /GetCostAndUsage/);
});

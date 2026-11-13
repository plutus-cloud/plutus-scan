import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCsvParser, parseCsvStream } from '../../src/sources/focus/csv.js';
import { currencyCode } from '../../src/model.js';
import { FocusInputError, focusRecordToRow, providerSlug, recordTags } from '../../src/sources/focus/rows.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { createTransport } from '../../src/transport.js';

const parseAll = (text, step) => {
  const out = [];
  const p = createCsvParser((r) => out.push(r));
  if (step) for (let i = 0; i < text.length; i += step) p.push(text.slice(i, i + step));
  else p.push(text);
  p.end();
  return out;
};

const HEAD = 'BilledCost,BillingCurrency,ChargePeriodStart';

test('parses quoted commas and escaped quotes', () => {
  const recs = parseAll(`${HEAD},ServiceName\n1.5,USD,2026-10-01T00:00:00Z,"a, ""b"" c"\r\n`);
  assert.deepEqual(recs, [
    { BilledCost: '1.5', BillingCurrency: 'USD', ChargePeriodStart: '2026-10-01T00:00:00Z', ServiceName: 'a, "b" c' },
  ]);
});

test('parser handles quoted newline split across chunks', () => {
  const text = `${HEAD},ChargeDescription\n1,USD,2026-10-01,"line1\nline2"\n2,USD,2026-10-02,plain`;
  const whole = parseAll(text);
  assert.equal(whole.length, 2);
  assert.equal(whole[0].ChargeDescription, 'line1\nline2');
  assert.deepEqual(parseAll(text, 1), whole);
});

test('missing BilledCost throws FocusInputError naming the column', () => {
  assert.throws(
    () => parseAll('BillingCurrency,ChargePeriodStart\nUSD,2026-10-01\n'),
    (e) => e instanceof FocusInputError && /BilledCost/.test(e.message),
  );
});

test('parseCsvStream yields records from a readable', async () => {
  const stream = Readable.from([`${HEAD}\n1,USD,2026-10-01\n`, '2,USD,2026-10-02\n']);
  const got = [];
  for await (const r of parseCsvStream(stream)) got.push(r.BilledCost);
  assert.deepEqual(got, ['1', '2']);
});

const base = { BilledCost: '10', BillingCurrency: 'usd', ChargePeriodStart: '2026-10-01T05:00:00Z' };

test('FOCUS 1.0 ProviderName and 1.2 ServiceProviderName map to the same provider', () => {
  const a = focusRecordToRow({ ...base, ProviderName: 'AWS', ServiceName: 'S3' });
  const b = focusRecordToRow({ ...base, ServiceProviderName: 'Amazon Web Services', ServiceName: 'S3' });
  assert.equal(a.provider, 'aws');
  assert.equal(b.provider, 'aws');
  assert.equal(providerSlug('Microsoft'), 'azure');
  assert.equal(providerSlug('Google Cloud'), 'gcp');
  assert.equal(providerSlug('Oracle'), 'oci');
  assert.equal(providerSlug('Acme Corp!'), 'acme-corp');
});

test('credit rows keep their negative cost', () => {
  const row = focusRecordToRow({ ...base, BilledCost: '-2.5', ChargeCategory: 'Credit', ProviderName: 'AWS' });
  assert.equal(row.cost, -2.5);
});

test('a Purchase row is commitment spend under a purchases label; every other category is cloud', () => {
  const purchase = focusRecordToRow({ ...base, ProviderName: 'AWS', ServiceName: 'Amazon EC2', ChargeCategory: 'Purchase' });
  assert.equal(purchase.kind, 'commitment');
  assert.equal(purchase.service, 'Amazon EC2 purchases');
  for (const category of ['Usage', 'Tax', 'Credit', 'Adjustment', '']) {
    const r = focusRecordToRow({ ...base, ProviderName: 'AWS', ServiceName: 'Amazon EC2', ChargeCategory: category });
    assert.equal(r.kind, 'cloud', category);
    assert.equal(r.service, 'Amazon EC2', category);
  }
});

test('AI providers, AI publishers and the AI and Machine Learning category are AI spend by project', () => {
  const ai = [
    { ProviderName: 'OpenAI', ServiceName: 'OpenAI API', SubAccountName: 'support-bot' },
    { ProviderName: 'Anthropic', ServiceName: 'Claude API', SubAccountId: 'proj-1' },
    { ProviderName: 'AWS', PublisherName: 'Anthropic', ServiceName: 'Claude (Amazon Bedrock Edition)', SubAccountName: 'prod' },
    { ProviderName: 'Microsoft', ServiceCategory: 'AI and Machine Learning', ServiceName: 'Azure OpenAI', SubAccountName: 'research' },
  ].map((r) => focusRecordToRow({ ...base, ChargeCategory: 'Usage', ...r }));
  assert.deepEqual(ai.map((r) => [r.provider, r.kind, r.project, r.account]), [
    ['openai', 'ai', 'support-bot', null],
    ['anthropic', 'ai', 'proj-1', null],
    ['aws', 'ai', 'prod', null],
    ['azure', 'ai', 'research', null],
  ]);
  const cloud = focusRecordToRow({ ...base, ProviderName: 'AWS', ServiceCategory: 'Compute', ServiceName: 'Amazon EC2', SubAccountName: 'prod' });
  assert.deepEqual([cloud.kind, cloud.account, cloud.project], ['cloud', 'prod', null]);
  // A prepaid purchase from an AI provider stays commitment spend.
  assert.equal(focusRecordToRow({ ...base, ProviderName: 'OpenAI', ChargeCategory: 'Purchase' }).kind, 'commitment');
});

test('AI rows read from a FOCUS file stay out of tag coverage', async () => {
  const csv = [
    'BilledCost,BillingCurrency,ChargePeriodStart,ChargeCategory,ProviderName,ServiceName,SubAccountName,Tags',
    '100,USD,2026-10-20T00:00:00Z,Usage,AWS,Amazon EC2,prod,"{""team"":""web""}"',
    '50,USD,2026-10-20T00:00:00Z,Usage,OpenAI,OpenAI API,support-bot,',
  ].join('\n');
  const file = { name: 'x.csv', unit: 'x', mtime: 0, records: () => parseCsvStream(Readable.from([csv])) };
  const transport = createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
  const res = await fetchFocus(transport, { paths: [], window: { start: '2026-10-01', end: '2026-10-28', days: 28 }, files: [file] });
  assert.deepEqual(res.rows.map((r) => [r.provider, r.kind]).sort(), [['aws', 'cloud'], ['openai', 'ai']]);
  assert.deepEqual(res.tagCoverage.map((t) => [t.provider, t.key, t.untaggedCost]), [['aws', 'team', 0]]);
});

test('usage type comes from x_UsageType, then ChargeDescription', () => {
  const r1 = focusRecordToRow({ ...base, ProviderName: 'AWS', x_UsageType: 'USE1-NatGateway-Bytes', ChargeDescription: 'desc' });
  assert.equal(r1.usageType, 'USE1-NatGateway-Bytes');
  const r2 = focusRecordToRow({ ...base, ProviderName: 'AWS', ChargeDescription: 'desc' });
  assert.equal(r2.usageType, 'desc');
  assert.equal(focusRecordToRow({ ...base, ProviderName: 'AWS' }).usageType, null);
});

test('row fields, fallbacks and rejects', () => {
  const r = focusRecordToRow({ ...base, ProviderName: 'AWS', SubAccountId: '123' });
  assert.deepEqual(r, {
    date: '2026-10-01', provider: 'aws', kind: 'cloud', service: 'Unknown', account: '123',
    project: null, usageType: null, cost: 10, currency: 'USD',
  });
  assert.equal(focusRecordToRow({ ...base, SubAccountName: 'prod', SubAccountId: '1' }).account, 'prod');
  assert.equal(focusRecordToRow({ ...base, BilledCost: 'abc' }), null);
  assert.equal(focusRecordToRow({ ...base, BilledCost: '' }), null);
  assert.equal(focusRecordToRow({ ...base, ChargePeriodStart: '' }), null);
  assert.equal(focusRecordToRow({ ...base, ChargePeriodStart: 'nope' }), null);
});

test('recordTags parses the Tags column', () => {
  assert.deepEqual(recordTags({ Tags: '{"team":"web"}' }), { team: 'web' });
  assert.deepEqual(recordTags({ Tags: 'NULL' }), {});
  assert.deepEqual(recordTags({ Tags: '{bad' }), {});
  assert.deepEqual(recordTags({}), {});
});

test('synthetic fixture has the documented totals', async () => {
  const { createReadStream } = await import('node:fs');
  const rows = [];
  const tags = [];
  for await (const rec of parseCsvStream(createReadStream(new URL('../fixtures/focus/synthetic.csv', import.meta.url)))) {
    rows.push(focusRecordToRow(rec));
    tags.push(recordTags(rec));
  }
  const cents = (n) => Math.round(n * 100);
  const sum = (f) => cents(rows.reduce((a, r) => a + (f(r) ? r.cost : 0), 0));
  assert.equal(rows.length, 631);
  assert.equal(sum(() => true), 5193344);
  assert.equal(sum((r) => r.provider === 'aws' && r.date >= '2026-09-29'), 1122690);
  assert.equal(sum((r) => r.provider === 'azure' && r.date >= '2026-09-29'), 817740);
  assert.equal(rows.filter((r) => r.cost < 0).length, 1);
  assert.equal(tags.filter((t) => t.team).length, 181);
});

test('a currency that is not three capital letters maps to XXX', () => {
  const base = { BilledCost: '1', ChargePeriodStart: '2026-10-01T00:00:00Z' };
  assert.equal(focusRecordToRow({ ...base, BillingCurrency: 'U\x1b[2JSD' }).currency, 'XXX');
  assert.equal(focusRecordToRow({ ...base, BillingCurrency: '' }).currency, 'XXX');
  assert.equal(focusRecordToRow({ ...base, BillingCurrency: 'eur' }).currency, 'EUR');
  assert.equal(currencyCode(undefined), 'XXX');
});

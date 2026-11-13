import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { emptyResult } from '../../src/model.js';
import { buildReport } from '../../src/report/data.js';
import { renderMarkdown } from '../../src/report/markdown.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const GENERATED = '2026-10-30T12:00:00Z';
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const goldenDir = new URL('../fixtures/golden/', import.meta.url);
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const FOOTER = '[This is a snapshot. Plutus tracks it daily, per team and per customer, with alerts.](https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=report)';

async function fixtureReport(win = WIN) {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: win });
  return buildReport({ window: win, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
}

function golden(name, actual) {
  const file = new URL(name, goldenDir);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.equal(actual, readFileSync(file, 'utf8'));
}

const count = (text, needle) => text.split(needle).length - 1;

/** The synthetic fixture plus a $1,500 Reserved Instance purchase on the 1st of each month. */
async function commitmentReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  for (const date of ['2026-08-01', '2026-09-01', '2026-10-01']) {
    result.rows.push({ date, provider: 'aws', kind: 'commitment', service: 'Amazon Elastic Compute Cloud purchases',
      account: null, project: null, usageType: null, cost: 1500, currency: 'USD' });
  }
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

test('markdown of the synthetic fixture', async () => {
  const md = renderMarkdown(await fixtureReport());
  golden('markdown.md', md);
  assert.ok(md.startsWith('**plutus-scan** · 2026-07-31 to 2026-10-28 (90 days)\n'));
  assert.ok(md.includes('Last 30 days: $19,404 ($19,404 cloud, $0.00 AI), +13% vs the previous 30.'));
  // Savings may only appear as the labelled ceiling, never as a claim.
  assert.match(md, /Possible savings: up to \$[\d,]+ in 30 days if .* waste\. The bill cannot say\./);
  assert.equal((md.match(/savings/gi) ?? []).length, 1);
  assert.doesNotMatch(md, /(you will save|found|saved|savings found)/i);
});

test('markdown escapes pipes in table cells', async () => {
  const report = await fixtureReport();
  report.drivers.items[0].service = 'a|b*c_d`e<f>g[h](i)\x1b[2J\\';
  report.drivers.items[0].usageTypes[0].usageType = 'x|y';
  report.notes.push('note | with <b>tags</b>');
  report.candidates[0].title = 'T|<script>';
  const md = renderMarkdown(report);
  assert.ok(md.includes('AWS a\\|b\\*c\\_d\\`e&lt;f&gt;g\\[h\\](i)\\\\'));
  assert.ok(md.includes('x\\|y'));
  assert.ok(md.includes('note \\| with &lt;b&gt;tags&lt;/b&gt;'));
  assert.ok(md.includes('T\\|&lt;script&gt;'));
  assert.doesNotMatch(md, /\x1b/);
  const rows = md.split('\n').filter((l) => l.startsWith('| '));
  for (const row of rows) assert.equal(row.replace(/\\\|/g, '').split('|').length, 7, row);
});

test('footer appears exactly once', async () => {
  const md = renderMarkdown(await fixtureReport());
  assert.equal(count(md, FOOTER), 1);
  assert.equal(count(md, 'This is a snapshot.'), 1);
  assert.ok(md.trimEnd().endsWith(FOOTER));
  const empty = renderMarkdown(buildReport({ window: WIN, results: [{ name: 'focus', result: emptyResult() }], version: '0.1.0', generatedAt: GENERATED }));
  assert.equal(count(empty, FOOTER), 1);
});

test('empty report has the window line, no-spend line, basis and footer', () => {
  const md = renderMarkdown(buildReport({ window: WIN, results: [{ name: 'focus', result: emptyResult() }], version: '0.1.0', generatedAt: GENERATED }));
  assert.match(md, /^\*\*plutus-scan\*\* · 2026-07-31 to 2026-10-28 \(90 days\)\n\nNo spend found in this window\.\n/);
  assert.match(md, /<sub>.*Last complete day: 2026-10-28\. Currency: USD\.<\/sub>/);
  assert.doesNotMatch(md, /Drivers|Anomalies|Candidates/);
});

test('short history gives a one-line drivers note and omits empty sections', async () => {
  const md = renderMarkdown(await fixtureReport({ start: '2026-10-22', end: '2026-10-28', days: 7 }));
  assert.match(md, /^Drivers: not enough history \(7 days, needs 60\)\.$/m);
  assert.doesNotMatch(md, /\| Service/);
});

test('markdown states the AWS request count and cost when AWS was queried', async () => {
  const report = await fixtureReport();
  assert.ok(!renderMarkdown(report).includes('AWS Cost Explorer:'));
  const md = renderMarkdown({ ...report, aws: { billedRequests: 7, cost: 0.07 } });
  assert.ok(md.includes('AWS Cost Explorer: 7 requests, $0.07.'));
  assert.ok(md.indexOf('AWS Cost Explorer:') < md.indexOf('</sub>'));
});

test('markdown states the AWS request cost in US dollars whatever the report currency', async () => {
  const report = await fixtureReport();
  const md = renderMarkdown({ ...report, currency: 'EUR', aws: { billedRequests: 6, cost: 0.06 } });
  assert.ok(md.includes('AWS Cost Explorer: 6 requests, $0.06.'));
});

test('markdown names commitments in the headline sentence when there are some', async () => {
  const md = renderMarkdown(await commitmentReport());
  assert.ok(md.includes('Last 30 days: $20,904 ($19,404 cloud, $1,500 commitments, $0.00 AI)'), md);
});

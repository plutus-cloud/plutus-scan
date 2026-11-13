import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { emptyResult, formatMoney } from '../../src/model.js';
import { buildReport, spreadTotal } from '../../src/report/data.js';
import { renderTerminal, sanitize } from '../../src/report/terminal.js';
import { sparkline } from '../../src/report/sparkline.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const GENERATED = '2026-10-30T12:00:00Z';
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const goldenDir = new URL('../fixtures/golden/', import.meta.url);
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });

async function fixtureReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
}

function golden(name, actual) {
  const file = new URL(name, goldenDir);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.equal(actual, readFileSync(file, 'utf8'));
}

const longest = (text) => Math.max(...text.split('\n').map((l) => Array.from(l).length));

/** The synthetic fixture plus a $1,500 Reserved Instance purchase on the 1st of each month. */
async function commitmentReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  for (const date of ['2026-08-01', '2026-09-01', '2026-10-01']) {
    result.rows.push({ date, provider: 'aws', kind: 'commitment', service: 'Amazon Elastic Compute Cloud purchases',
      account: null, project: null, usageType: null, cost: 1500, currency: 'USD' });
  }
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

test('summary of the synthetic fixture', async () => {
  const text = renderTerminal(await fixtureReport(), { color: false, columns: 120, braille: false });
  golden('terminal-120.txt', text);
  assert.ok(longest(text) <= 120);
  assert.ok(text.includes('Last 30 days: $19,404 ($19,404 cloud, $0.00 AI), +13% vs the previous 30.'));
});

test('compact layout below 100 columns', async () => {
  const text = renderTerminal(await fixtureReport(), { color: false, columns: 79, braille: false });
  golden('terminal-79.txt', text);
  assert.ok(longest(text) <= 79, `longest line ${longest(text)}`);
});

test('no ANSI when color is false', async () => {
  const text = renderTerminal(await fixtureReport(), { color: false, columns: 120, braille: false });
  assert.doesNotMatch(text, /\x1b/);
  const colored = renderTerminal(await fixtureReport(), { color: true, columns: 120, braille: false });
  assert.match(colored, /\x1b\[1m/);
});

test('braille sparkline fits and uses braille cells', async () => {
  const text = renderTerminal(await fixtureReport(), { color: false, columns: 79, braille: true });
  assert.match(text, /[⠀-⣿]{10}/);
  assert.ok(longest(text) <= 79);
});

test('terminal strips control characters from names', async () => {
  const report = await fixtureReport();
  report.drivers.items[0].service = 'evil\x1b[2J\x1b]0;title\x07x\ty\u009b';
  report.notes.push('note\r\nline\x1b');
  const text = renderTerminal(report, { color: false, columns: 120, braille: false });
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  assert.match(text, /AWS evilx y/);
  assert.equal(sanitize('a\x1b[31mb\x1b]8;;u\x1b\\c\x00\x7f\u0085d'), 'abc   d');
});

test('empty report prints the no-spend line', () => {
  const report = buildReport({ window: WIN, results: [{ name: 'focus', result: emptyResult() }], version: '0.1.0', generatedAt: GENERATED });
  const text = renderTerminal(report, { color: false, columns: 80, braille: false });
  assert.match(text, /^No spend found in this window\.$/m);
  assert.match(text, /Last complete day: 2026-10-28\. Currency: USD\./);
});

test('short history states what each section needs', async () => {
  const win = { start: '2026-10-22', end: '2026-10-28', days: 7 };
  const result = await fetchFocus(noAws(), { paths: [fixture], window: win });
  const report = buildReport({ window: win, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
  const text = renderTerminal(report, { color: false, columns: 100, braille: false });
  assert.match(text, /Drivers: not enough history \(7 days, needs 60\)\./);
  assert.match(text, /Anomalies: not enough history \(7 days, needs 8\)\./);
  assert.match(text, /not enough history \(7 days, needs 14\)/);
});

test('AWS request line', async () => {
  const report = await fixtureReport();
  report.aws = { billedRequests: 12, cost: 0.12 };
  const text = renderTerminal(report, { color: false, columns: 120, braille: false });
  assert.match(text, /^AWS Cost Explorer: 12 requests, \$0\.12\.$/m);
});

test('sparkline maps min to ▁ and max to █', () => {
  assert.equal(sparkline([1, 5, 9], { width: 3, braille: false }), '▁▅█');
  assert.equal(sparkline([-5, 4], { width: 2, braille: false }), '▁█');
  assert.equal(sparkline([0, 0, 0], { width: 3, braille: false }), '▁▁▁');
  assert.equal(sparkline([1, 2, 3, 4, 5, 6], { width: 3, braille: false }).length, 3);
  assert.equal(sparkline([1, 2, 3, 4], { width: 2, braille: true }).length, 2);
});

test('a currency containing an escape sequence prints no ESC', async () => {
  const report = await fixtureReport();
  report.currency = 'U\x1b[2JSD';
  report.aws = { billedRequests: 1, cost: 0.01 };
  const text = renderTerminal(report, { color: false, columns: 120, braille: false });
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});

test('truncation never drops the colour reset', async () => {
  const text = renderTerminal(await fixtureReport(), { color: true, columns: 50, braille: false });
  for (const line of text.split('\n')) {
    assert.equal((line.match(/\x1b\[[1-9]/g) ?? []).length, (line.match(/\x1b\[0m/g) ?? []).length);
  }
});

test('no trailing whitespace in any line', async () => {
  const text = renderTerminal(await fixtureReport(), { color: false, columns: 120, braille: false });
  assert.doesNotMatch(text, /[ \t]$/m);
});

test('headline block lists the top three movers', async () => {
  const text = renderTerminal(await fixtureReport(), { color: false, columns: 120, braille: false });
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('Top movers'));
  assert.ok(i > 0, text);
  assert.deepEqual(lines.slice(i, i + 3).map((l) => l.slice(16)), [
    'AWS Amazon Elastic Compute Cloud / BoxUsage:m7g.large +$1,238',
    'Azure Virtual Machines / D4s v5 usage +$432',
    'Azure Azure SQL Database / Gen Purpose compute +$216',
  ]);
  assert.ok(i < lines.findIndex((l) => l.startsWith('Largest anomaly')));
});

test('the AWS request cost is always in US dollars', async () => {
  const report = await fixtureReport();
  report.currency = 'EUR';
  report.aws = { billedRequests: 6, cost: 0.06 };
  const text = renderTerminal(report, { color: false, columns: 120, braille: false });
  assert.match(text, /^AWS Cost Explorer: 6 requests, \$0\.06\.$/m);
});

test('commitments show in the headline block and the daily totals, and every line fits', async () => {
  const report = await commitmentReport();
  // A purchase billed on every 1st is spread over its month in the daily views, so the peak is the spread one.
  const peak = Math.max(...report.daily.map(spreadTotal));
  for (const columns of [120, 79]) {
    const text = renderTerminal(report, { color: false, columns, braille: false });
    assert.ok(longest(text) <= columns, `longest line ${longest(text)} at ${columns}`);
    assert.ok(text.includes('Last 30 days    $20,904 (cloud $19,404, commitments $1,500, AI $0.00)'), text);
    assert.ok(text.includes(`peak ${formatMoney(peak, 'USD')} a day`), text);
  }
  const wide = renderTerminal(report, { color: false, columns: 120, braille: false });
  assert.ok(wide.includes('Last 30 days: $20,904 ($19,404 cloud, $1,500 commitments, $0.00 AI)'), wide);
});

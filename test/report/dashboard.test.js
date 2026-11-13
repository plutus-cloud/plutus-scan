import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { emptyResult } from '../../src/model.js';
import { buildReport } from '../../src/report/data.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { colorDepth, createTheme } from '../../src/ui/theme.js';
import { hbar, stackedBars, panel, beside, axis } from '../../src/ui/widgets.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const GENERATED = '2026-10-30T12:00:00Z';
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

async function fixtureReport(win = WIN) {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: win });
  return buildReport({ window: win, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
}

const dashboard = (report, opts) => renderTerminal(report, { layout: 'dashboard', ...opts });
const cells = (l) => Array.from(l.replace(ANSI, '')).length;

test('piped output keeps the plain summary', async () => {
  // node --test runs with standard output piped, so the default is the plain layout.
  const report = await fixtureReport();
  const text = renderTerminal(report, { columns: 120 });
  assert.equal(text, renderTerminal(report, { columns: 120, layout: 'plain' }));
  assert.match(text, /^Headline$/m);
  assert.doesNotMatch(text, /[╭│]/);
});

test('dashboard lines fit every width, with and without colour', async () => {
  const report = await fixtureReport();
  for (const columns of [80, 99, 100, 120, 140, 200]) {
    for (const color of [0, 4, 8, 24]) {
      const text = dashboard(report, { columns, color });
      for (const line of text.split('\n')) assert.ok(cells(line) <= Math.min(columns, 160), `${columns}/${color}: "${line}"`);
      if (!color) assert.doesNotMatch(text, /\x1b/);
    }
  }
});

test('dashboard has panels, tiles, the chart and the exact headline sentence', async () => {
  const text = dashboard(await fixtureReport(), { columns: 120, color: 0 });
  assert.match(text, /^◆ plutus-scan 0\.1\.0 +2026-07-31 → 2026-10-28 · 90 days · USD$/m);
  assert.ok(text.includes('Last 30 days: $19,404 ($19,404 cloud, $0.00 AI), +13% vs the previous 30.'));
  for (const title of ['Last 30 days', 'Change', 'Forecast', 'Commitments', 'Daily spend', 'Top movers', 'Largest anomaly', 'Top drivers', 'Anomalies', 'Candidates to review']) {
    assert.match(text, new RegExp(`╭─ ${title} ─`), title);
  }
  assert.match(text, /│ ▲ \+\$2,269 +│/);
  assert.match(text, /\$1,147 │ +█/);
  assert.match(text, /█ cloud {3}░ forecast {3}▲ anomaly/);
  assert.match(text, /│ AWS Amazon Elastic Compute Cloud +\$8,306 +\$7,068 +\+\$1,238 +█+ 54\.6% +[▁-█]+/);
  assert.match(text, /│ 2026-10-13 +AWS Amazon Elastic Compute Cloud +\$778 +\$245 +\+\$532 +● high/);
  assert.match(text, /^AWS|^Last complete day: 2026-10-28\. Currency: USD\.$/m);
});

test('compact dashboard below 100 columns', async () => {
  const text = dashboard(await fixtureReport(), { columns: 80, color: 0 });
  assert.match(text, /│ Service +Change +Share +Trend +│/);
  assert.doesNotMatch(text, /Previous/);
  assert.match(text, /│ Largest anomaly \+\$532 on 2026-10-13, AWS Amazon Elastic Compute Cloud +│/);
});

test('colour depth picks the escape form and severity gets its colour', async () => {
  const report = await fixtureReport();
  const brand = { 24: '\x1b[38;2;233;54;143m', 8: '\x1b[38;5;', 4: '\x1b[95m' };
  for (const depth of [24, 8, 4]) {
    const text = dashboard(report, { columns: 120, color: depth });
    assert.ok(text.includes(brand[depth]), String(depth));
    for (const line of text.split('\n')) {
      // Every colour is closed on its own line.
      const opened = (line.match(/\x1b\[(?!0m)[0-9;]*m/g) ?? []).length;
      assert.ok(opened === 0 || line.endsWith('\x1b[0m') || /\x1b\[0m[^\x1b]*$/.test(line), JSON.stringify(line));
    }
  }
  const high = dashboard(report, { columns: 120, color: 24 }).split('\n').find((l) => l.includes('2026-10-13') && l.includes('● high'));
  assert.ok(high.includes('\x1b[38;2;248;113;113m● high'), JSON.stringify(high));
});

test('color true reads the depth from the environment, and NO_COLOR there does not undo an explicit choice', async () => {
  const report = await fixtureReport();
  assert.match(dashboard(report, { columns: 100, color: true, env: { COLORTERM: 'truecolor' } }), /\x1b\[38;2;/);
  assert.match(dashboard(report, { columns: 100, color: true, env: { TERM: 'xterm-256color' } }), /\x1b\[38;5;/);
  assert.doesNotMatch(dashboard(report, { columns: 100, color: true, env: { TERM: 'xterm' } }), /\x1b\[38;[25];/);
  assert.doesNotMatch(dashboard(report, { columns: 100, color: false, env: { COLORTERM: 'truecolor' } }), /\x1b/);
});

test('colorDepth', () => {
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }), 24);
  assert.equal(colorDepth({ COLORTERM: '24bit', TERM: 'xterm' }), 24);
  assert.equal(colorDepth({ TERM: 'xterm-256color' }), 8);
  assert.equal(colorDepth({ TERM: 'xterm-direct' }), 24);
  assert.equal(colorDepth({ TERM: 'xterm' }), 4);
  assert.equal(colorDepth({}), 4);
  assert.equal(colorDepth({ TERM: 'dumb' }), 0);
  assert.equal(colorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 0);
});

test('dashboard strips control characters from data', async () => {
  const report = await fixtureReport();
  report.drivers.items[0].service = 'evil\x1b[2J\x1b]0;title\x07x\ty\u009b';
  report.anomalies[0].service = 'bad\x1b[31m\r\nname';
  report.candidates[0].why = 'why\x1b[2Jnot';
  report.notes.push('note\r\nline\x1b');
  report.currency = 'U\x1b[2JSD';
  for (const color of [0, 24]) {
    const text = dashboard(report, { columns: 120, color });
    assert.doesNotMatch(text.replace(ANSI, ''), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    assert.doesNotMatch(text, /\x1b\[2J|\x1b\]/);
  }
  assert.match(dashboard(report, { columns: 120, color: 0 }), /AWS evilx y/);
});

test('dashboard states what each section needs on short history', async () => {
  const text = dashboard(await fixtureReport({ start: '2026-10-22', end: '2026-10-28', days: 7 }), { columns: 100, color: 0 });
  assert.match(text, /Drivers: not enough history \(7 days, needs 60\)\./);
  assert.match(text, /Anomalies: not enough history \(7 days, needs 8\)\./);
  assert.match(text, /needs 14 days/);
});

test('dashboard of an empty report prints the no-spend line', () => {
  const report = buildReport({ window: WIN, results: [{ name: 'focus', result: emptyResult() }], version: '0.1.0', generatedAt: GENERATED });
  const text = dashboard(report, { columns: 80, color: 0 });
  assert.match(text, /^No spend found in this window\.$/m);
  assert.match(text, /Last complete day: 2026-10-28\. Currency: USD\./);
});

test('dashboard keeps the AWS request line whole', async () => {
  const report = await fixtureReport();
  report.aws = { billedRequests: 12, cost: 0.12 };
  assert.match(dashboard(report, { columns: 80, color: 0 }), /^AWS Cost Explorer: 12 requests, \$0\.12\.$/m);
});

test('widgets: bars, panels, columns and axis', () => {
  const t = createTheme(0);
  assert.equal(hbar(5, 10, 4), '██  ');
  assert.equal(hbar(8, 8, 1), '█');
  assert.equal(hbar(1, 8, 1), '▏');
  assert.equal(hbar(1, 2, 1), '▌');
  assert.equal(hbar(0, 0, 3), '   ');
  const p = panel(t, { title: 'T', width: 12, lines: ['abc'] });
  assert.deepEqual(p, ['╭─ T ──────╮', '│ abc      │', '╰──────────╯']);
  assert.deepEqual(beside([{ lines: ['a', 'b'], width: 2 }, { lines: ['c'], width: 1 }]), ['a  c', 'b']);
  assert.equal(axis(['2026-01-01', '2026-01-31'], 24), '2026-01-01    2026-01-31');
  // Two series without colour: whole cells of the second series' shade above the first.
  const bars = stackedBars(t, { series: [{ role: 'cloud', glyph: '█', values: [2, 4] }, { role: 'ai', glyph: '▒', values: [2, 0] }], height: 2 });
  assert.deepEqual(bars, ['▒█', '██']);
  const colored = stackedBars(createTheme(24), { series: [{ role: 'cloud', glyph: '█', values: [1, 1] }], height: 1 });
  assert.deepEqual(colored, ['\x1b[38;2;29;156;230m██\x1b[0m']);
});

test('the dashboard chart spreads monthly charges in a shade of their own and peaks on a real day', async () => {
  const { fetchDemo } = await import('../../src/sources/demo.js');
  const { computeWindow } = await import('../../src/model.js');
  const window = computeWindow({ days: 90, end: '2026-10-30' });
  const result = await fetchDemo(noAws(), { window });
  const report = buildReport({ window, results: [{ name: 'demo', result }], version: '0.1.0', generatedAt: GENERATED });
  const text = renderTerminal(report, { layout: 'dashboard', color: 0, columns: 120 }).replace(ANSI, '');
  assert.match(text, /▞ monthly charges, spread/);
  assert.ok(text.includes('▞'), 'the spread share is drawn');
  // The tallest day is the one-off upfront purchase, not a 1st carrying a month of tax.
  assert.match(text, /peak \$3,583 · avg/);
});

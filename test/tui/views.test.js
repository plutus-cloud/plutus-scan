import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { buildReport } from '../../src/report/data.js';
import { createApp } from '../../src/tui/app.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

async function fixtureReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

const key = (name, extra = {}) => ({ name, sequence: name, ctrl: false, ...extra });
const press = (app, ...names) => names.forEach((n) => app.handleKey(key(n)));
const mk = (report, opts = {}) => createApp(report, { columns: 80, rows: 24, color: false, ...opts });

/** the fixture report with 30 drivers */
async function manyDrivers() {
  const report = await fixtureReport();
  const base = report.drivers.items;
  report.drivers.items = Array.from({ length: 30 }, (_, i) => ({ ...base[i % base.length], service: `Svc ${i}` }));
  for (const d of report.drivers.items) report.serviceDaily[`${d.provider}|${d.service}`] = report.serviceDaily[`${base[0].provider}|${base[0].service}`];
  return report;
}

test('drivers list scrolls past the visible rows', async () => {
  const app = mk(await manyDrivers());
  press(app, '2');
  let lines = app.render();
  assert.ok(lines.some((l) => l.startsWith('› ') && l.includes('Svc 0')));
  assert.ok(!lines.some((l) => l.includes('Svc 25')));
  for (let i = 0; i < 25; i++) press(app, 'j');
  lines = app.render();
  assert.equal(lines.length, 24);
  const sel = lines.filter((l) => l.startsWith('› '));
  assert.equal(sel.length, 1);
  assert.match(sel[0], /Svc 25/);
  assert.ok(!lines.some((l) => l.includes('Svc 0 ')));
  press(app, 'k');
  assert.match(app.render().find((l) => l.startsWith('› ')), /Svc 24/);
  for (let i = 0; i < 100; i++) press(app, 'down');
  assert.match(app.render().find((l) => l.startsWith('› ')), /Svc 29/);
});

test('drivers selected row is inverse with colour', async () => {
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: true });
  press(app, '2');
  const sel = app.render().filter((l) => l.startsWith('\x1b[7m'));
  assert.equal(sel.length, 1);
  assert.doesNotMatch(sel[0].replace(ANSI, ''), /›/);
});

test('enter on a driver shows its usage types', async () => {
  const report = await fixtureReport();
  const app = mk(report);
  press(app, '2', 'return');
  const text = app.render().join('\n');
  const top = report.drivers.items[0];
  assert.match(text, /Usage type\s+Previous\s+Current\s+Change/);
  assert.match(text, /USE1-BoxUsage:m7g\.large\s+\$\d/);
  assert.match(text, /\+\$1,238/);
  assert.match(text, /Last 60 days/);
  assert.match(text, /▁|▂|█/);
  assert.match(text, /│ +2026-08-30 .*2026-10-28 +│/);
  assert.ok(top.usageTypes.length > 0);
  assert.equal(app.render().length, 24);
});

test('esc returns to the list with selection kept', async () => {
  const app = mk(await fixtureReport());
  press(app, '2', 'j', 'j', 'return');
  assert.equal(app.state.drivers.open, true);
  press(app, 'escape');
  assert.equal(app.state.drivers.open, false);
  assert.equal(app.state.drivers.selected, 2);
  const lines = app.render();
  assert.equal(lines.filter((l) => l.startsWith('› ')).length, 1);
  press(app, 'return', 'backspace');
  assert.equal(app.state.drivers.open, false);
  press(app, '1', '2');
  assert.equal(app.state.drivers.selected, 2);
});

test('enter on an anomaly shows the surrounding days and release', async () => {
  const report = await fixtureReport();
  report.anomalies[0].release = { date: '2026-10-12', repo: 'acme/web', name: 'v1.4.0', url: 'https://x' };
  const app = mk(report);
  press(app, '3');
  let lines = app.render();
  const row = () => app.render().find((l) => l.startsWith('› '));
  assert.match(lines[2], /^\s+Date\s+Service\s+Change\s+Severity$/);
  assert.match(row(), /^› 2026-10-13\s+AWS Amazon Elastic Compute Cloud\s+\+\$532\s+● high$/);
  press(app, 'return');
  lines = app.render();
  // A bar per day, three cells wide with a gap; the flagged day's bar is the tallest and marked under it.
  const top = lines.findIndex((l) => l.includes('█'));
  assert.ok(top >= 0, lines.join('\n'));
  const marks = lines.findIndex((l) => l.includes('▲'));
  const at = lines[top].indexOf('█');
  assert.equal(lines[marks].indexOf('▲'), at + 1);
  const bar = lines[marks - 1];
  assert.equal(bar.match(/█{3}/g).length, 15, bar);
  assert.match(lines[marks + 1], /│ +2026-10-06 +2026-10-13 +2026-10-20 +│/);
  const text = lines.join('\n');
  assert.match(text, /15 days around 2026-10-13/);
  assert.match(text, /Baseline \$245/);
  assert.match(text, /Cost \$778/);
  assert.match(text, /Delta \+\$532/);
  assert.match(text, /Nearest release \(context, not a cause\): acme\/web v1\.4\.0 on 2026-10-12/);
  assert.equal(lines.length, 24);
  press(app, 'escape');
  assert.match(row(), /^› 2026-10-13/);
});

test('the detail lists every release of the nearest release day, the chart giving up the room', async () => {
  const report = await fixtureReport();
  const rel = (repo, name) => ({ date: '2026-10-12', repo, name, url: 'https://x' });
  const list = ['web', 'api', 'jobs', 'shop', 'auth', 'docs', 'cli'].map((n, i) => rel(`acme/${n}`, `v${i}`));
  report.anomalies[0].release = list[0];
  report.anomalies[0].releases = list;
  const app = mk(report);
  press(app, '3', 'return');
  const lines = app.render();
  const text = lines.join('\n');
  assert.match(text, /Nearest releases \(context, not a cause\): 7 on 2026-10-12/);
  assert.ok(lines.includes('  acme/web v0') && lines.includes('  acme/shop v3'), text);
  assert.ok(!lines.includes('  acme/auth v4'), 'four named, the rest counted');
  assert.ok(lines.includes('  and 3 more'), text);
  assert.equal(lines.length, 24);
});

test('anomaly without a release omits the line and window is clipped', async () => {
  const report = await fixtureReport();
  report.anomalies[0].date = '2026-08-01';
  report.anomalies[0].release = null;
  const app = mk(report);
  press(app, '3', 'return');
  const lines = app.render();
  assert.ok(!lines.join('\n').includes('Nearest release'));
  // The window is cut at the start of the data: 9 days, the flagged one second.
  const marks = lines.findIndex((l) => l.includes('▲'));
  const bar = lines[marks - 1];
  const axisAt = bar.indexOf('│', 2);
  assert.equal(bar.match(/█{3}/g).length, 9, bar);
  assert.equal(lines[marks].indexOf('▲') - axisAt, 4 + 2);
  assert.match(lines[marks + 1], /│ +2026-07-31 .*2026-08-08 +│/);
});

test('views render placeholder text when drivers or anomalies are null or empty', async () => {
  const short = { start: '2026-10-01', end: '2026-10-05', days: 5 };
  const result = await fetchFocus(noAws(), { paths: [fixture], window: short });
  const r = buildReport({ window: short, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
  let app = mk(r);
  press(app, '2');
  assert.ok(app.render().some((l) => l === 'Not enough history (5 days, needs 60).'));
  press(app, 'return', 'j');
  press(app, '3');
  assert.ok(app.render().some((l) => l === 'Not enough history (5 days, needs 8).'));
  press(app, 'return');
  assert.equal(app.render().length, 24);

  const full = await fixtureReport();
  full.drivers.items = [];
  full.anomalies = [];
  app = mk(full);
  press(app, '2');
  assert.ok(app.render().some((l) => l === 'No drivers.'));
  press(app, 'return', 'j');
  press(app, '3');
  assert.ok(app.render().some((l) => l === 'No anomalies.'));
  press(app, 'return', 'escape');

  const empty = mk(buildReport({ window: WIN, results: [], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' }));
  press(empty, '2');
  assert.ok(empty.render().some((l) => l.startsWith('Not enough') || l === 'No drivers.'));
});

test('list and detail lines fit and carry no control characters', async () => {
  const report = await manyDrivers();
  report.drivers.items[0].service = 'Evil \x1b[2J\x07 ' + 'x'.repeat(200);
  report.drivers.items[0].usageTypes[0].usageType = 'ut \x1b[31m' + 'y'.repeat(200);
  report.anomalies[0].service = 'Evil \x1b[2J ' + 'z'.repeat(200);
  report.serviceDaily[`${report.drivers.items[0].provider}|${report.drivers.items[0].service}`] = report.serviceDaily[Object.keys(report.serviceDaily)[0]];
  for (const columns of [80, 140]) {
    for (const color of [false, true]) {
      const app = createApp(report, { columns, rows: 24, color });
      for (const steps of [['2'], ['return'], ['escape', '3'], ['return']]) {
        press(app, ...steps);
        const lines = app.render();
        assert.equal(lines.length, 24);
        for (const l of lines) {
          const plain = l.replace(ANSI, '');
          assert.ok(Array.from(plain).length <= columns, `${columns}: "${plain}"`);
          assert.doesNotMatch(plain, /[\x00-\x09\x0b-\x1f\x7f]/);
        }
      }
    }
  }
});

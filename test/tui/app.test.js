import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { buildReport } from '../../src/report/data.js';
import { UsageError } from '../../src/model.js';
import { createApp, runTui } from '../../src/tui/app.js';
import { createScreen } from '../../src/tui/screen.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const goldenDir = new URL('../fixtures/golden/', import.meta.url);
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

async function fixtureReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

function emptyReport() {
  return buildReport({ window: WIN, results: [], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

function golden(name, actual) {
  const file = new URL(name, goldenDir);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.equal(actual, readFileSync(file, 'utf8'));
}

const key = (name, extra = {}) => ({ name, sequence: name, ctrl: false, ...extra });

/** The synthetic fixture plus a $1,500 Reserved Instance purchase on the 1st of each month. */
async function commitmentReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  for (const date of ['2026-08-01', '2026-09-01', '2026-10-01']) {
    result.rows.push({ date, provider: 'aws', kind: 'commitment', service: 'Amazon Elastic Compute Cloud purchases',
      account: null, project: null, usageType: null, cost: 1500, currency: 'USD' });
  }
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

test('tui overview renders the headline', async () => {
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: false });
  const lines = app.render();
  golden('tui-overview-80x24.txt', `${lines.join('\n')}\n`);
  assert.equal(lines.length, 24);
  assert.match(lines[0], /^◆ plutus-scan  \[1 Overview\]  2 Drivers  3 Anomalies\s+2026-07-31 → 2026-10-28$/);
  assert.equal(lines[23], '←→ tabs  ↑↓/jk move  enter open  esc back  h html  q quit');
  assert.ok(lines.some((l) => l.includes('Last 30 days: $19,404 ($19,404 cloud, $0.00 AI), +13% vs the previous 30.')));
});

test('tui overview renders an empty report', () => {
  const lines = createApp(emptyReport(), { columns: 80, rows: 24, color: false }).render();
  assert.equal(lines.length, 24);
  assert.ok(lines.some((l) => l.includes('No spend found in this window.')));
});

test('tab cycles views and 1-3 jump', async () => {
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: false });
  const active = () => app.render()[0].match(/\[([^\]]+)\]/)?.[1];
  assert.equal(active(), '1 Overview');
  app.handleKey(key('tab'));
  assert.equal(active(), '2 Drivers');
  app.handleKey(key('tab'));
  assert.equal(active(), '3 Anomalies');
  app.handleKey(key('tab'));
  assert.equal(active(), '1 Overview');
  app.handleKey(key('3'));
  assert.equal(active(), '3 Anomalies');
  app.handleKey(key('2'));
  assert.equal(active(), '2 Drivers');
  app.handleKey(key('1'));
  assert.equal(active(), '1 Overview');
});

test('left and right switch tabs and wrap at both ends; shift+tab goes back', async () => {
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: false });
  const active = () => app.render()[0].match(/\[([^\]]+)\]/)?.[1];
  const seen = [];
  for (const k of ['right', 'right', 'right', 'left', 'left', 'left']) {
    app.handleKey(key(k));
    seen.push(active());
  }
  assert.deepEqual(seen, ['2 Drivers', '3 Anomalies', '1 Overview', '3 Anomalies', '2 Drivers', '1 Overview']);
  app.handleKey(key('tab', { shift: true }));
  assert.equal(active(), '3 Anomalies');
});

test('in a detail view the arrows still switch tabs, and the detail stays open for its tab', async () => {
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: false });
  const active = () => app.render()[0].match(/\[([^\]]+)\]/)?.[1];
  app.handleKey(key('2'));
  app.handleKey(key('return'));
  const detail = app.render().join('\n');
  app.handleKey(key('right'));
  assert.equal(active(), '3 Anomalies');
  app.handleKey(key('left'));
  assert.equal(active(), '2 Drivers');
  assert.equal(app.render().join('\n'), detail, 'back on Drivers, its detail is still open');
  app.handleKey(key('escape'));
  assert.notEqual(app.render().join('\n'), detail, 'Esc goes back to the list');
  // Up and down still move within the list.
  const before = app.render().join('\n');
  app.handleKey(key('down'));
  assert.notEqual(app.render().join('\n'), before);
  assert.equal(active(), '2 Drivers');
});

test('arrow escape sequences, normal and application mode, reach the app as left and right', async () => {
  const input = new PassThrough();
  readline.emitKeypressEvents(input);
  const names = [];
  input.on('keypress', (_s, k) => names.push(k?.name));
  for (const seq of ['\x1b[C', '\x1b[D', '\x1bOC', '\x1bOD']) {
    input.write(seq);
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(names, ['right', 'left', 'right', 'left']);
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: false });
  const tabs = [];
  input.removeAllListeners('keypress');
  input.on('keypress', (_s, k) => { app.handleKey(k); tabs.push(app.state.tab); });
  for (const seq of ['\x1bOC', '\x1b[C', '\x1b[D', '\x1bOD', '\x1bOD']) {
    input.write(seq);
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(tabs, [1, 2, 1, 0, 2]);
});

test('the key hints show the arrows for tabs', async () => {
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: false });
  assert.match(app.render().at(-1), /^←→ tabs {2}↑↓\/jk move/);
});

test('q and ctrl-c quit', async () => {
  const app = createApp(await fixtureReport(), { columns: 80, rows: 24, color: false });
  assert.equal(app.handleKey(key('j')), undefined);
  assert.equal(app.handleKey(key('q')), 'quit');
  assert.equal(app.handleKey(key('c', { ctrl: true })), 'quit');
});

test('h writes the html and the status line says so', async () => {
  const calls = [];
  let changed = 0;
  const app = createApp(await fixtureReport(), {
    columns: 80, rows: 24, color: false,
    writeHtml: async (p) => { calls.push(p); return 'Warning: ...'; },
    onChange: () => { changed += 1; },
  });
  app.handleKey(key('h'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['plutus-scan-report.html']);
  assert.equal(changed, 1);
  assert.equal(app.render()[22].trim(), 'Wrote plutus-scan-report.html');
});

test('h shows a failure message on the status line', async () => {
  const app = createApp(await fixtureReport(), {
    columns: 80, rows: 24, color: false,
    writeHtml: async () => { throw new Error('EACCES: permission denied\n  at x'); },
  });
  app.handleKey(key('h'));
  await new Promise((r) => setImmediate(r));
  assert.match(app.render()[22], /^EACCES: permission denied/);
});

test('every rendered line fits the width', async () => {
  const report = await fixtureReport();
  report.headline.sentence += ' \x1b[31mEvil\x1b[0m name ' + 'x'.repeat(200);
  for (const columns of [80, 140]) {
    for (const color of [false, true]) {
      const app = createApp(report, { columns, rows: 24, color });
      for (const k of ['1', '2', '3']) {
        app.handleKey(key(k));
        const lines = app.render();
        assert.equal(lines.length, 24);
        for (const l of lines) {
          const plain = l.replace(ANSI, '');
          assert.ok(Array.from(plain).length <= columns, `${columns}: "${plain}"`);
          if (!color) assert.doesNotMatch(l, /\x1b/);
        }
      }
    }
  }
});

test('control characters in data never reach the screen', async () => {
  const report = await fixtureReport();
  report.headline.sentence = 'Hello \x1b[2J\x07 world';
  const text = createApp(report, { columns: 80, rows: 24, color: false }).render().join('\n');
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f]/);
});

function fakeOutput(columns, rows, isTTY = true) {
  const out = new EventEmitter();
  Object.assign(out, { isTTY, columns, rows, writes: [], write(s) { this.writes.push(s); return true; } });
  return out;
}

function fakeInput() {
  const inp = new EventEmitter();
  Object.assign(inp, { isTTY: true, raw: [], setRawMode(v) { this.raw.push(v); }, resume() {}, pause() {}, setEncoding() {} });
  return inp;
}

test('tui refuses below 80x24', async () => {
  const report = await fixtureReport();
  const base = { input: fakeInput(), env: {}, writeHtml: async () => '' };
  for (const output of [fakeOutput(79, 24), fakeOutput(80, 23), fakeOutput(120, 40, false)]) {
    await assert.rejects(
      runTui(report, { ...base, output }),
      (e) => e instanceof UsageError && e.message === '--tui needs an interactive terminal of at least 80x24.',
    );
    assert.deepEqual(output.writes, []);
  }
});

test('restore is idempotent and leaves the alternate screen', () => {
  const output = fakeOutput(80, 24);
  const input = fakeInput();
  const proc = new EventEmitter();
  proc.exit = () => { throw new Error('exit must not be called'); };
  const before = input.listenerCount('keypress');
  const screen = createScreen({ input, output, proc, onKey() {}, onResize() {} });
  screen.start();
  assert.equal(output.writes[0], '\x1b[?1049h\x1b[?25l');
  assert.deepEqual(input.raw, [true]);
  for (const ev of ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException']) assert.equal(proc.listenerCount(ev), 1, ev);

  screen.restore();
  screen.restore();
  const last = output.writes.at(-1);
  assert.ok(last.endsWith('\x1b[?25h\x1b[?1049l'), JSON.stringify(last));
  assert.equal(output.writes.filter((w) => w.includes('\x1b[?1049l')).length, 1);
  assert.deepEqual(input.raw, [true, false]);
  for (const ev of ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException']) assert.equal(proc.listenerCount(ev), 0, ev);
  assert.equal(input.listenerCount('keypress'), before);
  assert.equal(output.listenerCount('resize'), 0);
});

test('screen repaints only changed lines and handles resize', () => {
  const output = fakeOutput(80, 24);
  const input = fakeInput();
  const proc = new EventEmitter();
  let resized = 0;
  const screen = createScreen({ input, output, proc, onKey() {}, onResize() { resized += 1; } });
  screen.start();
  screen.paint(['one', 'two', 'three']);
  const n = output.writes.length;
  screen.paint(['one', 'TWO', 'three']);
  const diff = output.writes.slice(n).join('');
  assert.ok(diff.includes('\x1b[2;1H\x1b[2KTWO'));
  assert.ok(!diff.includes('one') && !diff.includes('three'));
  output.emit('resize');
  assert.equal(resized, 1);
  screen.restore();
});

test('runTui runs until q and restores the terminal', async () => {
  const output = fakeOutput(80, 24);
  const input = fakeInput();
  const proc = new EventEmitter();
  proc.exit = () => {};
  const done = runTui(await fixtureReport(), { input, output, env: { NO_COLOR: '1' }, writeHtml: async () => 'w', proc });
  await new Promise((r) => setImmediate(r));
  input.emit('keypress', '2', key('2'));
  input.emit('keypress', 'q', key('q'));
  await done;
  const all = output.writes.join('');
  assert.match(all, /2 Drivers/);
  assert.doesNotMatch(all, /\x1b\[7m/);
  assert.ok(output.writes.at(-1).endsWith('\x1b[?25h\x1b[?1049l'));
});

const LEAVE_TAIL = '\x1b[?25h\x1b[?1049l';

function started({ exit } = {}) {
  const output = fakeOutput(80, 24);
  const input = fakeInput();
  const proc = new EventEmitter();
  const exits = [];
  proc.exit = (c) => { exits.push(c); exit?.(c); };
  return { output, input, proc, exits };
}

test('repaint clears the line before writing so a last-column glyph survives', () => {
  const { output, input, proc } = started();
  const screen = createScreen({ input, output, proc, onKey() {}, onResize() {} });
  screen.start();
  const full = '█'.repeat(80);
  screen.paint([full]);
  const all = output.writes.join('');
  assert.ok(all.includes(`\x1b[1;1H\x1b[2K${full}`));
  assert.ok(!all.includes(`${full}\x1b[K`));
  screen.restore();
});

test('SIGINT, SIGTERM and uncaughtException restore the terminal and exit with the right code', () => {
  for (const [ev, arg, code] of [['SIGINT', undefined, 130], ['SIGTERM', undefined, 143], ['uncaughtException', new Error('boom'), 1]]) {
    const { output, input, proc, exits } = started();
    const screen = createScreen({ input, output, proc, stderr: { write() {} }, onKey() {}, onResize() {} });
    screen.start();
    proc.emit(ev, arg);
    assert.ok(output.writes.at(-1).endsWith(LEAVE_TAIL), ev);
    assert.deepEqual(exits, [code], ev);
    assert.equal(proc.listenerCount(ev), 0);
  }
});

test('ctrl-c through runTui resolves with the terminal restored', async () => {
  const { output, input, proc } = started();
  const done = runTui(await fixtureReport(), { input, output, env: {}, proc, writeHtml: async () => '' });
  await new Promise((r) => setImmediate(r));
  input.emit('keypress', '\x03', key('c', { ctrl: true }));
  await done;
  assert.ok(output.writes.at(-1).endsWith(LEAVE_TAIL));
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('start restores and rethrows when setup fails', () => {
  const { output, input, proc } = started();
  input.setRawMode = (v) => { if (v) throw new Error('no raw mode'); };
  const screen = createScreen({ input, output, proc, onKey() {}, onResize() {} });
  assert.throws(() => screen.start(), /no raw mode/);
  assert.ok(output.writes.at(-1).endsWith(LEAVE_TAIL));
  assert.equal(proc.listenerCount('exit'), 0);
});

test('pending html warning goes to stderr once, even on a signal exit', async () => {
  const { output, input, proc } = started();
  const errs = [];
  const done = runTui(await fixtureReport(), {
    input, output, env: {}, proc, writeHtml: async () => 'Warning: real spend', stderr: { write: (s) => errs.push(s) },
  });
  await new Promise((r) => setImmediate(r));
  input.emit('keypress', 'h', key('h'));
  await new Promise((r) => setImmediate(r));
  proc.emit('SIGTERM');
  proc.emit('exit');
  assert.deepEqual(errs, ['Warning: real spend\n']);
  assert.deepEqual(errs, ['Warning: real spend\n']);
  void done; // a signal exit ends the process, so the promise never settles
});

test('--no-color is honoured by runTui', async () => {
  const { output, input, proc } = started();
  const done = runTui(await fixtureReport(), { input, output, env: {}, proc, noColor: true, writeHtml: async () => '' });
  await new Promise((r) => setImmediate(r));
  input.emit('keypress', 'q', key('q'));
  await done;
  assert.doesNotMatch(output.writes.join(''), /\x1b\[7m/);
});

test('tui overview shows movers, the largest anomaly, notes, basis and the AWS request line', async () => {
  const report = await fixtureReport();
  report.currency = 'EUR';
  report.notes = ['A source note.'];
  report.aws = { billedRequests: 6, cost: 0.06 };
  for (const [columns, rows] of [[80, 24], [120, 40]]) {
    const lines = createApp(report, { columns, rows, color: false }).render();
    assert.equal(lines.length, rows);
    assert.ok(lines.every((l) => Array.from(l).length <= columns));
    const text = lines.join('\n');
    assert.match(text, /Top movers/);
    assert.match(text, /AWS Amazon Elastic Compute Cloud \/ BoxUsage:m7g\.large\s+\+€1,238/);
    assert.match(text, /Azure Azure SQL Database \/ Gen Purpose compute\s+\+€216/);
    assert.match(text, /Largest anomaly\s+\+€532 on 2026-10-13, AWS Amazon Elastic Compute Cloud/);
    assert.match(text, /AWS Cost Explorer: 6 requests, \$0\.06\./);
    if (rows === 40) {
      assert.ok(text.includes('A source note.'));
      assert.ok(text.includes('FOCUS: BilledCost, including credit and tax rows when present.'));
      assert.ok(text.includes('Last complete day: 2026-10-28. Currency: EUR.'));
    }
  }
});

test('tui overview shows the commitment total and every line fits', async () => {
  const lines = createApp(await commitmentReport(), { columns: 80, rows: 24, color: false }).render();
  assert.equal(lines.length, 24);
  assert.ok(lines.every((l) => Array.from(l).length <= 80));
  assert.ok(lines.some((l) => l.includes('cloud $51,933  commitments $4,500  AI $0.00  total $56,433')), lines.join('\n'));
  assert.ok(lines.join(' ').includes('$1,500 commitments'), lines.join('\n'));
});

test('tui totals keep every amount at 80 columns for a large bill', async () => {
  for (const currency of ['USD', 'CHF']) {
    const report = await fixtureReport();
    report.currency = currency;
    report.totals = { total: 1370368, cloud: 1234567, commitment: 123456, ai: 12345 };
    const lines = createApp(report, { columns: 80, rows: 24, color: false }).render();
    assert.ok(lines.every((l) => Array.from(l).length <= 80));
    const p = currency === 'USD' ? '$' : 'CHF ';
    const text = lines.join('\n');
    for (const part of [`total ${p}1,370,368`, `cloud ${p}1,234,567`, `commitments ${p}123,456`, `AI ${p}12,345`]) {
      assert.ok(text.includes(part), `${part}\n${text}`);
    }
  }
});

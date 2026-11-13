import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProgress, noProgress, sourceSummary, elapsed, SPINNER, FRAME_MS } from '../../src/ui/progress.js';
import { createTheme } from '../../src/ui/theme.js';
import { visible } from '../../src/ui/widgets.js';
import { emptyResult } from '../../src/model.js';

const WINDOW = { start: '2026-08-02', end: '2026-10-30', days: 90 };
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A fake clock, interval timer, stream and process, so every frame is predictable. */
function rig({ depth = 0, columns = 90 } = {}) {
  let clock = 1000;
  const timer = { fn: null, ms: null, cleared: false, unref() {} };
  const stream = { text: '', columns, write(s) { this.text += s; return true; } };
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.exit = (code) => { proc.exitCode = code; };
  const stats = { requests: 0, billed: 0, cost: 0 };
  const view = createProgress({
    stream, theme: createTheme(depth), version: '0.1.0', window: WINDOW, stats: () => stats,
    now: () => clock,
    timers: { setInterval: (fn, ms) => { timer.fn = fn; timer.ms = ms; return timer; }, clearInterval: (t) => { t.cleared = true; } },
    proc,
  });
  return { view, stream, timer, proc, stats, tick: (ms = FRAME_MS) => { clock += ms; timer.fn(); } };
}

test('starting hides the cursor, draws the header and panel, and redraws about ten times a second', () => {
  const { view, stream, timer } = rig();
  view.source('AWS Cost Explorer').step('checking the aws CLI');
  view.start();
  assert.ok(stream.text.startsWith('\x1b[?25l'));
  assert.equal(timer.ms, 100);
  const text = strip(stream.text);
  assert.match(text, /◆ plutus-scan 0\.1\.0 +2026-08-02 → 2026-10-30 · 90 days/);
  assert.match(text, /╭─ Scanning ─+ AWS Cost Explorer ─╮/);
  assert.match(text, new RegExp(`${SPINNER[0]} AWS Cost Explorer +checking the aws CLI…`));
});

test('each redraw moves up over the last frame and repaints it in place', () => {
  const { view, stream, tick } = rig();
  view.source('Demo data').step('generating');
  view.start();
  const first = view.frame().length;
  stream.text = '';
  tick();
  assert.ok(stream.text.startsWith(`\x1b[?2026h\x1b[${first}F\x1b[2K`), JSON.stringify(stream.text.slice(0, 30)));
  assert.ok(stream.text.endsWith('\x1b[J\x1b[?2026l'));
  assert.equal(stream.text.split('\n').length - 1, first, 'one newline per line, so the next redraw lands on the same rows');
  // The spinner turns with the clock.
  assert.match(strip(stream.text), new RegExp(`${SPINNER[1]} Demo data`));
});

test('a source line moves from waiting through its steps to a tick, a cross or a skip', () => {
  const { view } = rig();
  const aws = view.source('AWS Cost Explorer');
  const openai = view.source('OpenAI');
  const anthropic = view.source('Anthropic');
  const line = (label) => strip(view.frame().find((l) => l.includes(label) && !l.includes('Scanning')) ?? '');
  assert.match(line('OpenAI'), /· OpenAI +waiting/);
  aws.step('fetching usage types');
  assert.match(line('AWS Cost Explorer'), /fetching usage types…/);
  aws.ok('90 days, 14 services, 19 requests, $0.19');
  openai.skip('skipped, no key');
  anthropic.fail('request failed');
  assert.match(line('AWS Cost Explorer'), /✓ AWS Cost Explorer +90 days, 14 services, 19 requests, \$0\.19/);
  assert.match(line('OpenAI'), /– OpenAI +skipped, no key/);
  assert.match(line('Anthropic'), /✗ Anthropic +request failed/);
});

test('the running totals show requests, the billed cost and the elapsed time', () => {
  const { view, stats, tick } = rig();
  view.start();
  stats.requests = 21;
  stats.billed = 19;
  stats.cost = 0.19;
  tick(2300);
  assert.match(strip(view.frame().join('\n')), /21 requests · 19 billed, \$0\.19 · 2\.3s/);
});

test('analysis steps run together and tick as each finishes', () => {
  const { view } = rig();
  const steps = view.analysis(['drivers', 'anomalies', 'forecast', 'candidates']);
  steps.done('drivers');
  steps.done('anomalies');
  const row = strip(view.frame().find((l) => l.includes('Analysis')) ?? '');
  assert.match(row, new RegExp(`Analysis +✓ drivers +✓ anomalies +${SPINNER[0]} forecast +${SPINNER[0]} candidates`));
});

test('every line fits the terminal, cut rather than wrapped, so the redraw count stays right', () => {
  for (const columns of [50, 80, 200]) {
    const { view } = rig({ columns, depth: 24 });
    view.source('AWS Cost Explorer').fail('a very long failure message '.repeat(10));
    const w = Math.max(40, Math.min(100, columns - 1));
    for (const l of view.frame()) assert.equal(visible(l), w, `${columns} columns: ${strip(l)}`);
  }
});

test('colour follows the theme depth, and none at all without colour', () => {
  const plain = rig({ depth: 0 });
  plain.view.source('AWS Cost Explorer').ok('done');
  assert.ok(!/\x1b\[[0-9;]*m/.test(plain.view.frame().join('')), 'no SGR codes with NO_COLOR or --no-color');
  const truecolor = rig({ depth: 24 });
  truecolor.view.source('AWS Cost Explorer').ok('done');
  assert.match(truecolor.view.frame().join(''), /\x1b\[38;2;/);
  const sixteen = rig({ depth: 4 });
  sixteen.view.source('AWS Cost Explorer').ok('done');
  assert.ok(!/38;2;|38;5;/.test(sixteen.view.frame().join('')));
});

test('finishing replaces the panel with one summary line and gives the cursor back', () => {
  const { view, stream, timer, proc, stats, tick } = rig();
  view.source('Demo data').ok('90 days, 15 services');
  view.source('OpenAI').skip('skipped, no key');
  view.start();
  stats.requests = 3;
  tick(1400);
  const drawn = view.frame().length;
  stream.text = '';
  view.finish();
  assert.ok(stream.text.includes(`\x1b[${drawn}F\x1b[J`), 'the panel is erased, leaving no lines behind');
  assert.equal(strip(stream.text), '✓ Scanned Demo data · 3 requests · 1.4s\n');
  assert.ok(stream.text.includes('\x1b[?25h'));
  assert.equal(timer.cleared, true);
  assert.equal(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM') + proc.listenerCount('exit'), 0);
  // Nothing more is drawn after the end.
  stream.text = '';
  view.render();
  view.finish();
  view.stop();
  assert.equal(stream.text, '');
});

test('a run where nothing could be read ends on a cross', () => {
  const { view, stream } = rig();
  view.source('AWS Cost Explorer').fail('access denied');
  view.start();
  stream.text = '';
  view.finish();
  assert.equal(strip(stream.text), '✗ No source could be read · 0 requests · 0.0s\n');
});

test('stopping after an error erases the panel, writes nothing else and restores the cursor', () => {
  const { view, stream } = rig();
  view.source('AWS Cost Explorer').step('fetching daily spend');
  view.start();
  const drawn = view.frame().length;
  stream.text = '';
  view.stop();
  assert.equal(stream.text, `\x1b[?2026h\x1b[${drawn}F\x1b[J\x1b[?25h\x1b[?2026l`);
});

test('Ctrl-C mid-run takes the panel down, says it stopped, restores the cursor and exits 130', () => {
  const { view, stream, proc } = rig();
  view.source('AWS Cost Explorer').step('fetching daily spend');
  view.start();
  stream.text = '';
  proc.emit('SIGINT');
  assert.equal(proc.exitCode, 130);
  assert.ok(stream.text.includes('\x1b[?25h'));
  assert.equal(strip(stream.text), 'Stopped.\n');
  assert.equal(proc.listenerCount('SIGINT'), 0);
});

test('any process exit while the panel is up shows the cursor', () => {
  const { view, stream, proc } = rig();
  view.start();
  stream.text = '';
  proc.emit('exit');
  assert.equal(stream.text, '\x1b[?25h');
});

test('noProgress draws nothing and takes every call', () => {
  const v = noProgress();
  assert.equal(v.live, false);
  v.start();
  const s = v.source('AWS');
  s.step('x'); s.ok('y'); s.fail('z'); s.skip('w');
  v.analysis(['drivers']).done('drivers');
  v.render();
  v.finish();
  v.stop();
  assert.deepEqual(v.frame(), []);
});

test('source summaries count days, services or projects, requests and cost', () => {
  const rows = (n, extra) => Array.from({ length: n }, (_, i) => ({
    date: `2026-10-${String(1 + (i % 30)).padStart(2, '0')}`, provider: 'aws', kind: 'cloud', service: `S${i % 14}`,
    account: null, project: null, usageType: null, cost: 1, currency: 'USD', ...extra,
  }));
  assert.equal(sourceSummary('aws', { ...emptyResult(), rows: rows(90) }, { requests: 19, cost: 0.19 }), '30 days, 14 services, 19 requests, $0.19');
  assert.equal(sourceSummary('openai', { ...emptyResult(), rows: rows(5, { project: 'p' }) }, { requests: 1 }), '5 days, 1 project, 1 request');
  assert.equal(sourceSummary('focus', emptyResult(), { requests: 0 }), '0 days, 0 services');
  const releases = [{ date: '2026-10-01', repo: 'a/b', name: 'v1', url: 'https://example.com' }];
  assert.equal(sourceSummary('github', { ...emptyResult(), releases }, { requests: 1 }), '1 release');
});

test('elapsed time reads in tenths of a second, then minutes', () => {
  assert.equal(elapsed(0), '0.0s');
  assert.equal(elapsed(2340), '2.3s');
  assert.equal(elapsed(65000), '1m 05s');
});

/**
 * The live progress view of an interactive run: a panel on stderr with one status line per source, the
 * analysis steps and running totals, redrawn in place about ten times a second. It hides the cursor while
 * it runs and always gives it back, on Ctrl-C and on errors too. When the run is done the panel collapses
 * to one summary line. Runs that are not interactive never create it and keep their plain lines.
 */

import { panel, fitTo, alignRight, visible } from './widgets.js';
import { sanitize } from '../report/terminal.js';

export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
export const FRAME_MS = 100;
const MAX_WIDTH = 100;
const LABEL_WIDTH = 19;
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
// Terminals that support it paint a whole frame at once; the others ignore these.
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const SIGNALS = /** @type {const} */ ([['SIGINT', 130], ['SIGTERM', 143]]);

/** @typedef {'wait'|'run'|'ok'|'fail'|'skip'} Status */
/** @typedef {{ step: (text: string) => void, ok: (text: string) => void, fail: (text: string) => void, skip: (text: string) => void }} SourceHandle */
/** @typedef {{ requests: number, billed: number, cost: number }} Stats */

/** @param {number} ms @returns {string} elapsed time such as 2.4s or 1m 05s */
export function elapsed(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * GitHub's status line: each org as "acme: 143 repos, 37 releases", the single repos after it, then the calls
 * and where the token came from ("3 requests via gh login").
 * @param {import('../model.js').SourceResult} result @param {number} requests
 */
function githubSummary(result, requests) {
  const g = result.github;
  if (!g) return count(result.releases.length, 'release');
  const parts = g.owners.map((o) => `${o.login}: ${count(o.repos, 'repo')}, ${count(o.releases, 'release')}`);
  if (g.repos.length === 1) parts.push(`${g.repos[0].repo}: ${count(g.repos[0].releases, 'release')}`);
  else if (g.repos.length > 1) parts.push(`${count(g.repos.length, 'repo')}: ${count(g.repos.reduce((n, r) => n + r.releases, 0), 'release')}`);
  if (parts.length === 0) parts.push(count(result.releases.length, 'release'));
  const via = g.tokenSource ? `via ${g.tokenSource}` : '';
  if (requests > 0) parts.push([count(requests, 'request'), via].filter(Boolean).join(' '));
  else if (via) parts.push(via);
  return parts.join('; ');
}

/**
 * The short result a source's status line ends with, such as "90 days, 14 services, 19 requests, $0.19".
 * @param {string} name source name @param {import('../model.js').SourceResult} result
 * @param {{ requests: number, cost?: number }} calls this source's requests, and their cost when billed
 */
export function sourceSummary(name, result, { requests, cost = 0 }) {
  if (name === 'github') return githubSummary(result, requests);
  const days = new Set(result.rows.map((r) => r.date)).size;
  const parts = [count(days, 'day')];
  if (name === 'openai' || name === 'anthropic') {
    parts.push(count(new Set(result.rows.map((r) => r.project ?? '')).size, 'project'));
  } else {
    parts.push(count(new Set(result.rows.map((r) => `${r.provider}\0${r.service}`)).size, 'service'));
  }
  if (requests > 0) parts.push(count(requests, 'request'));
  if (cost > 0) parts.push(`$${cost.toFixed(2)}`);
  return parts.join(', ');
}

/**
 * A stand-in with the same calls that draws nothing, for runs that keep their plain lines.
 */
export function noProgress() {
  const handle = { step() {}, ok() {}, fail() {}, skip() {} };
  return {
    live: false,
    start() {},
    source: (/** @type {string} */ _label) => handle,
    analysis: (/** @type {string[]} */ _names) => ({ done: (/** @type {string} */ _name) => {} }),
    render() {},
    frame: () => /** @type {string[]} */ ([]),
    finish() {},
    stop() {},
  };
}

/**
 * @param {{ stream: { write: (s: string) => unknown, columns?: number }, theme: import('./theme.js').Theme,
 *   version: string, window: import('../model.js').Window, stats?: () => Stats, now?: () => number,
 *   timers?: { setInterval: (fn: () => void, ms: number) => any, clearInterval: (id: any) => void },
 *   proc?: { on: Function, removeListener: Function, exit: (code: number) => void } | null }} o
 *   `proc` receives the Ctrl-C and exit handlers; null installs none (tests).
 */
export function createProgress({ stream, theme: t, version, window, stats = () => ({ requests: 0, billed: 0, cost: 0 }),
  now = Date.now, timers = globalThis, proc = process }) {
  const startedAt = now();
  /** @type {{ label: string, status: Status, text: string }[]} */
  const sources = [];
  /** @type {{ name: string, status: Status }[]} */
  const steps = [];
  let drawn = 0;
  let active = false;
  let timer = null;
  /** @type {[string, Function][]} */
  const handlers = [];

  const width = () => Math.max(40, Math.min(MAX_WIDTH, (stream.columns || 80) - 1));
  const spin = () => SPINNER[Math.floor((now() - startedAt) / FRAME_MS) % SPINNER.length];
  /** @param {Status} s */
  const mark = (s) => (s === 'run' ? t.fg('brand', spin())
    : s === 'ok' ? t.fg('down', '✓')
      : s === 'fail' ? t.fg('up', '✗')
        : s === 'skip' ? t.fg('muted', '–') : t.fg('muted', '·'));

  /** The panel as it stands now. @returns {string[]} */
  const frame = () => {
    const w = width();
    const inner = w - 4;
    const lines = sources.map((s) => {
      const text = s.status === 'run' ? t.fg('muted', `${s.text}…`) : s.status === 'skip' ? t.fg('muted', s.text)
        : s.status === 'fail' ? t.fg('up', s.text) : s.text;
      return `${mark(s.status)} ${t.bold(fitTo(s.label, LABEL_WIDTH))} ${fitTo(text, Math.max(0, inner - LABEL_WIDTH - 3))}`;
    });
    if (steps.length) {
      lines.push('', [t.fg('muted', 'Analysis'), ...steps.map((s) => `${mark(s.status)} ${s.status === 'wait' ? t.fg('muted', s.name) : s.name}`)].join('   '));
    }
    lines.push('', t.fg('muted', totals()));
    // The dashboard's top line, then the panel, whose edge names the sources being read.
    const left = `${t.fg('brand', '◆')} ${t.bold(`plutus-scan ${sanitize(version)}`)}`;
    const right = t.fg('muted', `${window.start} → ${window.end} · ${window.days} days`);
    const head = visible(left) + 2 + visible(right) <= w ? left + alignRight(right, w - visible(left)) : fitTo(left, w);
    const names = sources.map((x) => x.label).join(' · ');
    return [head, ...panel(t, { title: 'Scanning', aside: names, width: w, lines })];
  };

  /** Requests so far, what the billed ones cost, and the time since the start. */
  const totals = () => {
    const st = stats();
    const calls = [count(st.requests, 'request')];
    if (st.billed > 0) calls.push(`${st.billed} billed, $${st.cost.toFixed(2)}`);
    return `${calls.join(' · ')} · ${elapsed(now() - startedAt)}`;
  };

  /** Clear what was drawn and leave the cursor where the panel began. */
  const erase = () => (drawn ? `\x1b[${drawn}F\x1b[J` : '');

  const render = () => {
    if (!active) return;
    const lines = frame();
    let out = SYNC_START + (drawn ? `\x1b[${drawn}F` : '');
    for (const line of lines) out += `\x1b[2K${line}\n`;
    out += `\x1b[J${SYNC_END}`;
    drawn = lines.length;
    stream.write(out);
  };

  const release = () => {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
    if (proc) for (const [event, fn] of handlers.splice(0)) proc.removeListener(event, fn);
  };

  /** @param {string} [line] what replaces the panel */
  const end = (line) => {
    if (!active) return;
    active = false;
    release();
    stream.write(`${SYNC_START}${erase()}${line ? `${line}\n` : ''}${SHOW}${SYNC_END}`);
    drawn = 0;
  };

  return {
    live: true,
    start() {
      if (active) return;
      active = true;
      stream.write(HIDE);
      if (proc) {
        for (const [sig, code] of SIGNALS) {
          const fn = () => { end(t.fg('muted', 'Stopped.')); proc.exit(code); };
          proc.on(sig, fn);
          handlers.push([sig, fn]);
        }
        // Whatever ends the process, the cursor comes back.
        const onExit = () => { if (active) stream.write(SHOW); };
        proc.on('exit', onExit);
        handlers.push(['exit', onExit]);
      }
      timer = timers.setInterval(render, FRAME_MS);
      timer?.unref?.();
      render();
    },
    /** A status line for one source, waiting until its first step. @param {string} label @returns {SourceHandle} */
    source(label) {
      const s = { label, status: /** @type {Status} */ ('wait'), text: 'waiting' };
      sources.push(s);
      const set = (/** @type {Status} */ status, /** @type {string} */ text) => { s.status = status; s.text = sanitize(text); };
      return {
        step: (text) => set('run', text),
        ok: (text) => set('ok', text),
        fail: (text) => set('fail', text),
        skip: (text) => set('skip', text),
      };
    },
    /** The analysis steps, all running until each is done. @param {string[]} names */
    analysis(names) {
      for (const name of names) steps.push({ name, status: 'run' });
      return {
        done: (/** @type {string} */ name) => {
          const s = steps.find((x) => x.name === name);
          if (s) s.status = 'ok';
        },
      };
    },
    /** Draw now, outside the timer: before work that holds the event loop. */
    render,
    frame,
    /** Replace the panel with one summary line (what was read, or that nothing could be, then the requests and
     * the time) and give the cursor back. */
    finish: () => {
      const read = sources.filter((x) => x.status === 'ok').map((x) => x.label);
      end(read.length ? `${t.fg('down', '✓')} Scanned ${read.join(', ')} ${t.fg('muted', `· ${totals()}`)}`
        : `${t.fg('up', '✗')} No source could be read ${t.fg('muted', `· ${totals()}`)}`);
    },
    /** Take the panel down after an error, leaving nothing behind. Safe to call twice. */
    stop: () => end(),
  };
}

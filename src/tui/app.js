/** The full-screen view: pure state and rendering (createApp), plus the loop that drives it (runTui). */

import { UsageError } from '../model.js';
import { sanitize } from '../report/terminal.js';
import { createScreen } from './screen.js';
import { clip, truncate, width } from './text.js';
import { createTheme, colorDepth } from '../ui/theme.js';
import { overview } from './views/overview.js';
import { driversView } from './views/drivers.js';
import { anomaliesView } from './views/anomalies.js';

const MIN_COLUMNS = 80;
const MIN_ROWS = 24;
const HTML_PATH = 'plutus-scan-report.html';
const HINTS = '←→ tabs  ↑↓/jk move  enter open  esc back  h html  q quit';
const KEYS = [['←→', 'tabs'], ['↑↓/jk', 'move'], ['enter', 'open'], ['esc', 'back'], ['h', 'html'], ['q', 'quit']];

const VIEWS = [overview, driversView, anomaliesView];

/**
 * @param {import('../report/data.js').ReportData} report
 * @param {{ columns: number, rows: number, color: boolean|import('../ui/theme.js').Depth,
 *   writeHtml?: (path: string) => Promise<string|void>, onChange?: () => void }} opts
 *   `color` true means 16 colours; a depth picks more
 */
export function createApp(report, { columns, rows, color, writeHtml, onChange = () => {} }) {
  const size = { columns, rows };
  /** @type {{ report: typeof report, tab: number, status: string, warnings: string[] }} */
  const state = { report, tab: 0, status: '', warnings: [] };
  const theme = createTheme(color);

  function writeReport() {
    state.status = `Writing ${HTML_PATH}...`;
    Promise.resolve()
      .then(() => (writeHtml ? writeHtml(HTML_PATH) : undefined))
      .then((warning) => {
        state.status = `Wrote ${HTML_PATH}`;
        if (typeof warning === 'string' && warning) state.warnings.push(warning);
      }, (e) => {
        state.status = sanitize(String(e instanceof Error ? e.message : e).split('\n')[0]) || 'Could not write the report.';
      })
      .then(() => onChange());
  }

  /** Move by `step` tabs, wrapping at both ends. @param {number} step */
  function moveTab(step) {
    state.tab = (state.tab + step + VIEWS.length) % VIEWS.length;
    state.status = '';
  }

  /**
   * Left and Right, like Tab and Shift+Tab, switch tabs from anywhere, a detail view included: Esc
   * and Backspace are the only keys that go back, and each tab keeps its own detail open.
   * @param {{ name?: string, sequence?: string, ctrl?: boolean, shift?: boolean }} key @returns {'quit'|undefined}
   */
  function handleKey(key) {
    if (key.ctrl && key.name === 'c') return 'quit';
    if (!key.ctrl) {
      switch (key.name) {
        case 'q': return 'quit';
        case '1': case '2': case '3': state.tab = Number(key.name) - 1; state.status = ''; return undefined;
        case 'tab': moveTab(key.shift ? -1 : 1); return undefined;
        case 'right': moveTab(1); return undefined;
        case 'left': moveTab(-1); return undefined;
        case 'h': writeReport(); return undefined;
        default: break;
      }
    }
    VIEWS[state.tab].handleKey(state, key);
    return undefined;
  }

  /** The top line: the mark, the tabs, and the window on the right. @param {number} cols */
  function tabBar(cols) {
    const t = theme;
    const tabs = VIEWS.map((v, i) => {
      const label = `${i + 1} ${v.title}`;
      if (i !== state.tab) return t.color ? t.fg('muted', ` ${label} `) : label;
      return t.color ? t.bold(t.bg('accent', ` ${label} `)) : `[${label}]`;
    }).join(t.color ? '' : '  ');
    const left = `${t.fg('brand', '◆')} ${t.bold('plutus-scan')}  ${tabs}`;
    const right = `${report.window.start} → ${report.window.end}`;
    const used = width(`◆ plutus-scan  `) + VIEWS.reduce((a, v, i) => a + width(`${i + 1} ${v.title}`) + 2, 0);
    return used + width(right) + 2 <= cols ? `${left}${' '.repeat(cols - used - width(right))}${t.fg('muted', right)}` : left;
  }

  /** @returns {string[]} exactly `rows` lines of at most `columns` cells */
  function render() {
    const { columns: cols, rows: rws } = size;
    const t = theme;
    const bodyRows = Math.max(0, rws - 3);
    const body = VIEWS[state.tab].render(state, { columns: cols, rows: bodyRows, color: t.color, theme: t })
      .slice(0, bodyRows);
    while (body.length < bodyRows) body.push('');
    const status = t.fg('warn', truncate(state.status, cols));
    const hints = t.color ? KEYS.map(([k, what]) => `${t.fg('brand', k)} ${t.fg('muted', what)}`).join('  ') : HINTS;
    const lines = [tabBar(cols), ...body, status, hints];
    return lines.slice(0, rws).map((l) => clip(l, cols));
  }

  /** @param {number} columns @param {number} rows */
  function resize(columns, rows) {
    size.columns = columns;
    size.rows = rows;
  }

  return { state, handleKey, render, resize };
}

/**
 * Run the full-screen view until the user quits.
 * @param {import('../report/data.js').ReportData} report
 * @param {{ input?: any, output?: any, env?: NodeJS.ProcessEnv,
 *   writeHtml?: (path: string) => Promise<string|void>, proc?: any }} [io]
 * @returns {Promise<void>}
 */
export function runTui(report, { input = process.stdin, output = process.stdout, env = process.env, writeHtml, proc, noColor = false, stderr = process.stderr } = {}) {
  const sizeOf = () => ({ columns: output.columns || 0, rows: output.rows || 0 });
  const { columns, rows } = sizeOf();
  if (!output.isTTY || !input?.isTTY || columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return Promise.reject(new UsageError(`--tui needs an interactive terminal of at least ${MIN_COLUMNS}x${MIN_ROWS}.`));
  }
  const color = !env.NO_COLOR && !noColor ? Math.max(4, colorDepth(env)) : 0;

  return new Promise((resolve) => {
    /** @type {ReturnType<typeof createScreen>} */
    let screen;
    const app = createApp(report, { columns, rows, color, writeHtml, onChange: () => screen.paint(app.render()) });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      screen.restore();
      resolve();
    };
    screen = createScreen({
      input,
      output,
      proc,
      onEnd: () => finish(),
      onRestore: () => {
        for (const w of app.state.warnings.splice(0)) stderr.write(`${w}\n`);
      },
      onKey: (_str, key) => {
        if (!key) return;
        if (app.handleKey(key) === 'quit') finish();
        else screen.paint(app.render());
      },
      onResize: () => {
        const s = sizeOf();
        app.resize(s.columns, s.rows);
        screen.paint(app.render());
      },
    });
    screen.start();
    screen.paint(app.render());
  });
}

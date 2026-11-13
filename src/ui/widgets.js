/**
 * Drawing blocks shared by the terminal summary and the full-screen view: panels, tiles, tables, bars and
 * a stacked bar chart. Every block returns lines of exactly the width it was given, so blocks can sit side
 * by side. Text passed in as plain strings is cut before it is coloured, so a colour is never cut open.
 */

import { clip, stripAnsi, truncate, width } from '../tui/text.js';

const EIGHTHS = ' ▁▂▃▄▅▆▇█';
const LEFT_EIGHTHS = ' ▏▎▍▌▋▊▉█';

/** @param {string} s @returns {number} visible cells of a line that may hold colour */
export const visible = (s) => width(stripAnsi(s));

/** @param {string} s @param {number} n @returns {string} exactly n visible cells: cut, or padded with spaces */
export function fitTo(s, n) {
  const w = visible(s);
  if (w > n) return clip(s, n);
  return s + ' '.repeat(n - w);
}

/** @param {string} s @param {number} n @returns {string} right-aligned in n cells */
export function alignRight(s, n) {
  const w = visible(s);
  return w >= n ? clip(s, n) : ' '.repeat(n - w) + s;
}

/**
 * A panel with a rounded border and a title in the top edge.
 * @param {import('./theme.js').Theme} t
 * @param {{ title?: string, aside?: string, width: number, lines: string[], height?: number }} p
 *   `aside` sits at the right of the top edge; `height` pads or cuts the body to that many lines
 * @returns {string[]}
 */
export function panel(t, { title = '', aside = '', width: w, lines, height }) {
  const inner = Math.max(1, w - 4);
  const b = (s) => t.fg('border', s);
  const head = title ? truncate(title, Math.max(0, w - 6)) : '';
  const side = aside ? truncate(aside, Math.max(0, w - 8 - width(head))) : '';
  const fill = Math.max(0, w - 2 - (head ? width(head) + 3 : 0) - (side ? width(side) + 3 : 0));
  const top = b('╭') + (head ? `${b('─')} ${t.bold(t.fg('brand', head))} ` : '') + b('─'.repeat(fill))
    + (side ? ` ${t.fg('muted', side)} ${b('─')}` : '') + b('╮');
  const body = height === undefined ? lines.slice() : lines.slice(0, height);
  while (height !== undefined && body.length < height) body.push('');
  return [
    top,
    ...body.map((l) => `${b('│')} ${fitTo(l, inner)} ${b('│')}`),
    b('╰') + b('─'.repeat(Math.max(0, w - 2))) + b('╯'),
  ];
}

/**
 * Put blocks next to each other. Each block is lines of one width; shorter blocks are padded below.
 * @param {{ lines: string[], width: number }[]} blocks @param {number} [gap] @returns {string[]}
 */
export function beside(blocks, gap = 1) {
  const rows = Math.max(0, ...blocks.map((b) => b.lines.length));
  const out = [];
  for (let i = 0; i < rows; i++) {
    out.push(blocks.map((b) => fitTo(b.lines[i] ?? '', b.width)).join(' '.repeat(gap)).trimEnd());
  }
  return out;
}

/**
 * Split `total` cells into `n` widths that differ by at most one, leaving `gap` between them.
 * @param {number} total @param {number} n @param {number} [gap] @returns {number[]}
 */
export function split(total, n, gap = 1) {
  const room = total - gap * (n - 1);
  return Array.from({ length: n }, (_, i) => Math.floor(room / n) + (i < room % n ? 1 : 0));
}

/**
 * A KPI tile: a label in the edge, a big figure, then one or two quiet lines under it.
 * @param {import('./theme.js').Theme} t
 * @param {{ label: string, value: string, valueRole?: import('./theme.js').Role, sub?: string[], width: number }} p
 *   `sub` lines may already hold colour
 */
export function tile(t, { label, value, valueRole, sub = [], width: w }) {
  const v = truncate(value, Math.max(1, w - 4));
  return panel(t, {
    title: label,
    width: w,
    lines: [t.bold(valueRole ? t.fg(valueRole, v) : v), ...sub],
  });
}

/**
 * A horizontal bar in eighths of a cell.
 * @param {number} value @param {number} max @param {number} cells @returns {string} exactly `cells` wide
 */
export function hbar(value, max, cells) {
  if (cells <= 0) return '';
  const eighths = max > 0 ? Math.round((Math.max(0, value) / max) * cells * 8) : 0;
  const full = Math.min(cells, Math.floor(eighths / 8));
  const part = full < cells ? LEFT_EIGHTHS[eighths % 8] : '';
  return ('█'.repeat(full) + part).padEnd(cells, ' ');
}

/**
 * A table: a quiet header row, then aligned rows. One column is `flex` and takes the room left over.
 * Cells are plain text, cut to fit, then painted by the column's `paint` (given the row index).
 * @param {import('./theme.js').Theme} t
 * @param {{ width: number, gap?: number,
 *   columns: { head: string, align?: 'left'|'right', flex?: boolean, min?: number,
 *     paint?: (text: string, row: number) => string, raw?: boolean }[],
 *   rows: string[][] }} p `raw` columns hold cells that are already drawn (bars, sparklines) at a fixed width
 * @returns {{ header: string, lines: string[] }}
 */
export function table(t, { width: w, gap = 2, columns, rows }) {
  const widths = columns.map((c, i) => (c.flex ? 0 : Math.max(width(c.head), ...rows.map((r) => visible(r[i] ?? '')))));
  const fixed = widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1);
  const flexAt = columns.findIndex((c) => c.flex);
  if (flexAt >= 0) {
    const need = Math.max(width(columns[flexAt].head), ...rows.map((r) => width(r[flexAt] ?? '')));
    widths[flexAt] = Math.max(columns[flexAt].min ?? 4, Math.min(need, w - fixed));
  }
  const cell = (text, i, row) => {
    const c = columns[i];
    const cut = c.raw ? text : truncate(text, widths[i]);
    const placed = c.align === 'right' ? alignRight(cut, widths[i]) : fitTo(cut, widths[i]);
    if (!c.paint || row < 0) return placed;
    // Paint only the text, not the padding, so a highlight hugs the value.
    const pad = widths[i] - visible(cut);
    return c.align === 'right' ? ' '.repeat(Math.max(0, pad)) + c.paint(cut, row) : c.paint(cut, row) + ' '.repeat(Math.max(0, pad));
  };
  const line = (cells, row) => fitTo(cells.map((x, i) => cell(x ?? '', i, row)).join(' '.repeat(gap)), w).trimEnd();
  const header = t.fg('muted', line(columns.map((c) => c.head), -1));
  return { header, lines: rows.map((r, i) => line(r, i)) };
}

/**
 * A vertical bar chart, one column per value, stacked by series, drawn in eighths of a cell.
 * With colour, each series has its own colour; without, its own shade of block. A `shade` series (the
 * forecast) keeps its glyph in colour too, so it reads as an estimate.
 * @param {import('./theme.js').Theme} t
 * @param {{ series: { role: import('./theme.js').Role, glyph: string, shade?: boolean, values: number[] }[],
 *   height: number, max?: number, mark?: number, markRole?: import('./theme.js').Role }} p
 *   `mark` is a column drawn in `markRole` whatever its series
 * @returns {string[]} `height` lines, each as wide as the series are long
 */
export function stackedBars(t, { series, height, max, mark = -1, markRole = 'up' }) {
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const totals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
  const top = max ?? Math.max(0, ...totals);
  const scale = top > 0 ? (height * 8) / top : 0;
  /** For each column, the series boundaries in eighths from the bottom. */
  const stacks = Array.from({ length: n }, (_, i) => {
    let acc = 0;
    return series.map((s) => {
      acc += Math.max(0, s.values[i] ?? 0);
      return Math.round(acc * scale);
    });
  });
  const lines = [];
  for (let r = height - 1; r >= 0; r--) {
    let line = '';
    let open = '';
    for (let i = 0; i < n; i++) {
      const bounds = stacks[i];
      const peak = bounds[bounds.length - 1] ?? 0;
      const lo = r * 8;
      let ch = ' ';
      let s = -1;
      if (peak >= lo + 8) {
        s = bounds.findIndex((b) => b > lo + 4);
        ch = t.color && !series[s].shade ? '█' : series[s].glyph;
      } else if (peak > lo) {
        s = bounds.findIndex((b) => b >= peak);
        // A shaded series, or any series but the first without colour, is drawn in whole cells of its glyph.
        if (series[s].shade || (!t.color && s > 0)) ch = peak - lo >= 4 ? series[s].glyph : ' ';
        else ch = EIGHTHS[peak - lo];
        if (ch === ' ') s = -1;
      }
      const role = s < 0 ? '' : i === mark ? markRole : series[s].role;
      const code = role && t.color ? t.code(role) : '';
      if (code !== open) {
        line += open ? '\x1b[0m' : '';
        line += code ? `\x1b[${code}m` : '';
        open = code;
      }
      line += ch;
    }
    lines.push(open ? `${line}\x1b[0m` : line);
  }
  return lines;
}

/**
 * Average `values` into `n` buckets (n may exceed the length, then values repeat).
 * @param {number[]} values @param {number} n @returns {number[]}
 */
export function bucket(values, n) {
  if (values.length === 0 || n <= 0) return [];
  if (n >= values.length) return values.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * values.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / n));
    const slice = values.slice(from, to);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

/**
 * A line of labels placed under a chart: the first at the left, the last flush right, any others centred.
 * @param {string[]} labels @param {number} w @returns {string}
 */
export function axis(labels, w) {
  if (labels.length === 0) return '';
  const cells = Array(w).fill(' ');
  const put = (text, at) => {
    const chars = Array.from(text);
    const start = Math.max(0, Math.min(w - chars.length, at));
    if (cells.slice(start, start + chars.length).some((c) => c !== ' ') && at !== 0) return;
    chars.forEach((c, k) => { if (start + k < w) cells[start + k] = c; });
  };
  put(labels[0], 0);
  if (labels.length > 1) put(labels[labels.length - 1], w - width(labels[labels.length - 1]));
  for (let k = 1; k < labels.length - 1; k++) {
    const at = Math.round((k * (w - 1)) / (labels.length - 1)) - Math.floor(width(labels[k]) / 2);
    const chars = Array.from(labels[k]);
    const start = Math.max(0, Math.min(w - chars.length, at));
    const clear = cells.slice(Math.max(0, start - 1), start + chars.length + 1).every((c) => c === ' ');
    if (clear) chars.forEach((c, j) => { cells[start + j] = c; });
  }
  return cells.join('').trimEnd();
}

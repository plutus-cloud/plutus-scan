/** Small text helpers for the full-screen view. Widths are counted in code points. */

const ANSI_AT = /^\x1b\[[0-9;?]*[A-Za-z]/;

/** @param {string} s @returns {string} the text without colour sequences */
export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** @param {string} s @returns {number} display cells of plain text */
export function width(s) {
  return Array.from(s).length;
}

/** @param {string} s @param {number} n @returns {string} plain text of at most n cells, ending in … when cut */
export function truncate(s, n) {
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  return n <= 1 ? chars.slice(0, Math.max(n, 0)).join('') : `${chars.slice(0, n - 1).join('')}…`;
}

/** @param {string} s @param {number} n @returns {string[]} lines of at most n cells */
export function wrap(s, n) {
  const lines = [];
  let line = '';
  for (const word of s.split(' ').filter(Boolean)) {
    const w = truncate(word, n);
    if (line && width(`${line} ${w}`) > n) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Cut a line that may hold colour sequences to n visible cells, closing any open colour.
 * @param {string} line @param {number} n @returns {string}
 */
export function clip(line, n) {
  let out = '';
  let cells = 0;
  let coloured = false;
  for (let i = 0; i < line.length;) {
    const m = line.slice(i).match(ANSI_AT);
    if (m) {
      out += m[0];
      coloured = m[0] !== '\x1b[0m';
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(/** @type {number} */ (line.codePointAt(i)));
    if (cells >= n) break;
    out += ch;
    cells += 1;
    i += ch.length;
  }
  return coloured ? `${out}\x1b[0m` : out;
}

/** @param {string} s @param {number} n @returns {string} padded with spaces to n cells */
export function padEnd(s, n) {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}

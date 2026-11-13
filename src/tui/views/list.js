/** Shared helpers for the list views: selection movement, scrolling and row painting. */

import { formatMoney } from '../../model.js';
import { padEnd, truncate, width, stripAnsi } from '../text.js';
import { fitTo } from '../../ui/widgets.js';

/** @param {number} n @param {string} currency @returns {string} money with an explicit sign, none when it rounds to zero */
export function signedMoney(n, currency) {
  const body = formatMoney(Math.abs(n), currency);
  if (!/[1-9]/.test(body)) return body;
  return `${n > 0 ? '+' : '-'}${body}`;
}

/** @param {string} left @param {string} right @param {number} columns @returns {string} right text flush to the right edge */
export function spread(left, right, columns) {
  const l = truncate(left, Math.max(0, columns - width(right) - 1));
  return `${padEnd(l, columns - width(right))}${right}`;
}

/**
 * Apply a navigation key to a list state. Returns true when the key was handled.
 * @param {{ selected: number, offset: number, open: boolean }} s
 * @param {{ name?: string }} key @param {number} count
 */
export function navigate(s, key, count) {
  const last = Math.max(0, count - 1);
  switch (key.name) {
    case 'down': case 'j': if (!s.open) s.selected = Math.min(last, s.selected + 1); return true;
    case 'up': case 'k': if (!s.open) s.selected = Math.max(0, s.selected - 1); return true;
    case 'return': case 'enter': if (!s.open && count > 0) s.open = true; return true;
    case 'escape': case 'backspace': s.open = false; return true;
    default: return false;
  }
}

/**
 * Keep the selection inside the visible window.
 * @param {{ selected: number, offset: number }} s @param {number} count @param {number} visible
 */
export function scrollTo(s, count, visible) {
  s.selected = Math.min(Math.max(0, s.selected), Math.max(0, count - 1));
  if (s.selected < s.offset) s.offset = s.selected;
  if (s.selected >= s.offset + visible) s.offset = s.selected - visible + 1;
  s.offset = Math.max(0, Math.min(s.offset, Math.max(0, count - visible)));
}

/**
 * Paint one list row: the whole width inverse with colour, a `›` prefix without.
 * @param {string} line the row, which may hold colour @param {boolean} selected @param {number} columns
 * @param {import('../../ui/theme.js').Theme} t
 */
export function listRow(line, selected, columns, t) {
  if (!selected) return fitTo(`  ${line}`, columns).trimEnd();
  if (!t.color) return fitTo(`› ${line}`, columns).trimEnd();
  return t.inverse(fitTo(`  ${stripAnsi(line)}`, columns));
}

/**
 * The title line over a list: a bold name, a quiet description, and the position on the right.
 * @param {import('../../ui/theme.js').Theme} t @param {string} name @param {string} about
 * @param {number} at @param {number} count @param {number} columns
 */
export function listTitle(t, name, about, at, count, columns) {
  const pos = `${at}/${count}`;
  const text = truncate(`${name}  ${about}`, Math.max(1, columns - width(pos) - 2));
  const styled = text.startsWith(name) ? t.bold(t.fg('brand', name)) + t.fg('muted', text.slice(name.length)) : text;
  return `${styled}${' '.repeat(Math.max(2, columns - width(text) - width(pos)))}${t.fg('muted', pos)}`;
}

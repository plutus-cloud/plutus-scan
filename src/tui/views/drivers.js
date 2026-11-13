/**
 * Drivers: the biggest movers as a table, with a chart of the selected one under it; Enter opens its
 * usage types and a 60-day chart.
 */

import { formatMoney } from '../../model.js';
import { sanitize } from '../../report/terminal.js';
import { DRIVERS_MIN_DAYS } from '../../analysis/drivers.js';
import { driversTable, barChart, serviceName, tint, signedPct } from '../../report/dashboard.js';
import { table, hbar, beside, split, panel } from '../../ui/widgets.js';
import { truncate } from '../text.js';
import { signedMoney, navigate, scrollTo, listRow, listTitle } from './list.js';

const SPARK_DAYS = 60;
const PREVIEW_MIN = 8;
const AI_PROVIDERS = new Set(['openai', 'anthropic']);

/** @param {any} state */
function own(state) {
  return (state.drivers ??= { selected: 0, offset: 0, open: false });
}

/** @returns {string[]|null} a placeholder, or null when there are drivers to show */
function placeholder(report) {
  if (report.drivers === null) return ['', `Not enough history (${report.window.days} days, needs ${DRIVERS_MIN_DAYS}).`];
  if (report.drivers.items.length === 0) return ['', 'No drivers.'];
  return null;
}

/**
 * The last `days` days of one service as a bar chart panel.
 * @param {import('../../ui/theme.js').Theme} t @param {any} report @param {any} d
 * @param {{ width: number, height: number, title: string, days?: number }} o
 */
function serviceChart(t, report, d, { width: w, height, title, days = SPARK_DAYS }) {
  const series = report.serviceDaily[`${d.provider}|${d.service}`];
  if (!series || series.length === 0) return ['No daily data.'];
  const values = series.slice(-days);
  const dates = report.daily.slice(-values.length).map((x) => x.date);
  const cur = sanitize(report.currency);
  const role = AI_PROVIDERS.has(d.provider) ? 'ai' : 'cloud';
  return barChart(t, {
    series: [{ role, glyph: '█', label: serviceName(d), values }], dates, width: w, height, legend: false,
    money: (n) => formatMoney(n, cur), title, aside: `${values.length} days`,
  });
}

function renderList(state, { columns, rows, theme: t }) {
  const report = state.report;
  const s = own(state);
  const items = report.drivers.items;
  const listRows = Math.min(items.length, Math.max(3, rows - 2 - PREVIEW_MIN - 1));
  scrollTo(s, items.length, listRows);
  const tbl = driversTable(t, report, { width: columns - 2, usageTypes: false, offset: s.offset, rows: listRows, selected: s.selected });
  const about = `${report.drivers.current.start} → ${report.drivers.current.end} vs the previous 30`;
  const out = [listTitle(t, 'Drivers', about, s.selected + 1, items.length, columns), `  ${tbl.header}`];
  tbl.lines.forEach((l, k) => out.push(listRow(l, tbl.index[k] === s.selected, columns, t)));
  const left = rows - out.length - 1;
  if (left >= PREVIEW_MIN) {
    const d = items[s.selected];
    out.push('', ...serviceChart(t, report, d, { width: columns, height: Math.min(20, left - 4), title: `${serviceName(d)} · enter for detail` }));
  }
  return out;
}

function renderDetail(state, { columns, rows, theme: t }) {
  const report = state.report;
  const d = report.drivers.items[own(state).selected];
  const cur = sanitize(report.currency);
  const money = (n) => formatMoney(n, cur);
  const pct = d.previous ? ` ${signedPct((d.change / Math.abs(d.previous)) * 100)}` : '';
  const head = truncate(serviceName(d), Math.max(1, columns - 30));
  const out = [`${t.bold(t.fg('brand', head))}  ${tint(t, d.change, `${signedMoney(d.change, cur)}${pct}`)}  ${t.fg('muted', `${money(d.previous)} → ${money(d.current)}`)}`];

  // Figures as tiles, one line each.
  const widths = split(columns, 4);
  const tiles = [
    ['Last 30', money(d.current)], ['Previous 30', money(d.previous)],
    ['Change', tint(t, d.change, signedMoney(d.change, cur))], ['Share', `${d.sharePct.toFixed(1)}% of spend`],
  ].map(([label, value], k) => ({ width: widths[k], lines: panel(t, { title: label, width: widths[k], lines: [t.bold(value)] }) }));
  out.push(...beside(tiles));

  const ut = d.usageTypes.map((u) => [sanitize(u.usageType) || '(none)', money(u.previous), money(u.current), signedMoney(u.change, cur)]);
  if (ut.length === 0) {
    out.push('No usage type detail.');
  } else {
    const max = Math.max(1, ...d.usageTypes.map((u) => Math.max(0, u.current)));
    const rowsOf = ut.map((r, k) => [...r, hbar(d.usageTypes[k].current, max, 12)]);
    const tbl = table(t, {
      width: columns,
      columns: [{ head: 'Usage type', flex: true, min: 10 }, { head: 'Previous', align: 'right', paint: (x) => t.fg('muted', x) },
        { head: 'Current', align: 'right' }, { head: 'Change', align: 'right', paint: (x, r) => tint(t, d.usageTypes[r].change, x) },
        { head: 'Of current', raw: true, paint: (x) => t.fg('rank', x) }],
      rows: rowsOf,
    });
    out.push(tbl.header, ...tbl.lines);
  }
  const left = rows - out.length;
  if (left >= 6) out.push(...serviceChart(t, report, d, { width: columns, height: Math.min(14, left - 4), title: `Last ${SPARK_DAYS} days` }));
  else out.push(`Last ${SPARK_DAYS} days`);
  return out;
}

export const driversView = {
  title: 'Drivers',
  render(state, ctx) {
    const p = placeholder(state.report);
    if (p) return p;
    return own(state).open ? renderDetail(state, ctx) : renderList(state, ctx);
  },
  handleKey(state, key) {
    const p = placeholder(state.report);
    navigate(own(state), key, p ? 0 : state.report.drivers.items.length);
  },
};

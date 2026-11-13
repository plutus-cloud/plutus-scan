/**
 * Anomalies: the flagged days as a table with severity colour, a chart of the selected one under it, and
 * on Enter the surrounding 15 days and the nearest release (every release of that day, when several shipped).
 */

import { formatMoney } from '../../model.js';
import { sanitize } from '../../report/terminal.js';
import { ANOMALY_MIN_DAYS } from '../../analysis/anomalies.js';
import { anomaliesTable, barChart, serviceName, severityBadge, tint } from '../../report/dashboard.js';
import { truncate } from '../text.js';
import { nearbyReleases, releaseLabel } from '../../report/releases.js';
import { signedMoney, navigate, scrollTo, listRow, listTitle } from './list.js';

const SIDE = 7;
const PREVIEW_MIN = 8;
// Releases of one day listed in the detail before the rest are counted.
const RELEASES_LISTED = 5;
const SEVERITY_ROLE = /** @type {Record<string, import('../../ui/theme.js').Role>} */ ({ high: 'up', medium: 'warn', low: 'muted' });

/** @param {any} state */
function own(state) {
  return (state.anomalies ??= { selected: 0, offset: 0, open: false });
}

function placeholder(report) {
  if (report.window.days < ANOMALY_MIN_DAYS) return ['', `Not enough history (${report.window.days} days, needs ${ANOMALY_MIN_DAYS}).`];
  if (report.anomalies.length === 0) return ['', 'No anomalies.'];
  return null;
}

/**
 * The days around an anomaly as a bar chart, the flagged day marked under its bar.
 * @param {import('../../ui/theme.js').Theme} t @param {any} report @param {any} a
 * @param {{ width: number, height: number, title?: string }} o
 * @returns {string[]|null} null when there is no daily data for it
 */
function aroundChart(t, report, a, { width: w, height, title }) {
  const series = report.serviceDaily[`${a.provider}|${a.service}`];
  const at = report.daily.findIndex((d) => d.date === a.date);
  if (!series || at < 0 || at >= series.length) return null;
  const from = Math.max(0, at - SIDE);
  const to = Math.min(series.length, at + SIDE + 1);
  const cur = sanitize(report.currency);
  return barChart(t, {
    series: [{ role: 'cloud', glyph: '█', label: serviceName(a), values: series.slice(from, to) }],
    dates: report.daily.slice(from, to).map((d) => d.date), width: w, height, legend: false,
    money: (n) => formatMoney(n, cur), title: title ?? `${to - from} days around ${a.date}`,
    aside: `baseline ${formatMoney(a.baseline, cur)}`, marks: [{ index: at - from, role: SEVERITY_ROLE[sanitize(a.severity)] ?? 'muted' }],
  });
}

function renderList(state, { columns, rows, theme: t }) {
  const report = state.report;
  const s = own(state);
  const items = report.anomalies;
  const listRows = Math.min(items.length, Math.max(3, rows - 2 - PREVIEW_MIN - 1));
  scrollTo(s, items.length, listRows);
  const tbl = anomaliesTable(t, report, { width: columns - 2, releases: false, offset: s.offset, rows: listRows });
  const out = [listTitle(t, 'Anomalies', 'days well above their baseline', s.selected + 1, items.length, columns), `  ${tbl.header}`];
  tbl.lines.forEach((l, k) => out.push(listRow(l, tbl.index[k] === s.selected, columns, t)));
  const left = rows - out.length - 1;
  if (left >= PREVIEW_MIN) {
    const a = items[s.selected];
    const chart = aroundChart(t, report, a, { width: columns, height: Math.min(14, left - 4), title: `${serviceName(a)} · enter for detail` });
    if (chart) out.push('', ...chart);
  }
  return out;
}

function renderDetail(state, { columns, rows, theme: t }) {
  const report = state.report;
  const a = report.anomalies[own(state).selected];
  const cur = sanitize(report.currency);
  const delta = signedMoney(a.delta, cur);
  const head = truncate(`${a.date}  ${serviceName(a)}`, Math.max(1, columns - 22));
  const out = [`${t.bold(t.fg('brand', head))}  ${tint(t, a.delta, delta)}  ${severityBadge(t, a.severity)}`, ''];

  // Several releases on one day are listed one per line, the chart giving up the room.
  const nearby = nearbyReleases(a);
  const releaseLines = [];
  if (nearby.length === 1) {
    releaseLines.push(`Nearest release (context, not a cause): ${releaseLabel(nearby[0], sanitize)} on ${sanitize(nearby[0].date)}`);
  } else if (nearby.length > 1) {
    releaseLines.push(`Nearest releases (context, not a cause): ${nearby.length} on ${sanitize(nearby[0].date)}`);
    const listed = nearby.length > RELEASES_LISTED ? RELEASES_LISTED - 1 : nearby.length;
    for (const r of nearby.slice(0, listed)) releaseLines.push(`  ${releaseLabel(r, sanitize)}`);
    if (listed < nearby.length) releaseLines.push(`  and ${nearby.length - listed} more`);
  }
  const room = rows - out.length - 2 - Math.max(1, releaseLines.length);
  const chart = room >= 6 ? aroundChart(t, report, a, { width: columns, height: Math.min(12, room - 4) }) : null;
  if (chart) out.push(...chart);
  else out.push('No daily data.');
  const label = (s) => t.fg('muted', s);
  out.push(`${label('Baseline')} ${formatMoney(a.baseline, cur)}  ${label('Cost')} ${t.bold(formatMoney(a.cost, cur))}  ${label('Delta')} ${tint(t, a.delta, delta)}`);
  for (const line of releaseLines) out.push(truncate(line, columns));
  return out;
}

export const anomaliesView = {
  title: 'Anomalies',
  render(state, ctx) {
    const p = placeholder(state.report);
    if (p) return p;
    return own(state).open ? renderDetail(state, ctx) : renderList(state, ctx);
  },
  handleKey(state, key) {
    const p = placeholder(state.report);
    navigate(own(state), key, p ? 0 : state.report.anomalies.length);
  },
};

/**
 * The dashboard sections drawn in the terminal: brand bar, KPI tiles, the daily spend chart and the driver,
 * anomaly, candidate and AI tables. The terminal summary stacks all of them; the full-screen view picks
 * the ones each tab needs. Each section returns lines no wider than the width it is given.
 */

import { formatMoney } from '../model.js';
import { providerName, moverName, freshnessLine, awsRequestLine, hasCommitment, signedMoney, moreCandidatesLine, possibleSavingsCaveat, STRENGTH_LABEL } from './headline.js';
import { spreadDay, spreadTotal } from './data.js';
import { sanitize } from './terminal.js';
import { sparkline } from './sparkline.js';
import { releaseContext } from './releases.js';
import { PR_LINE_COMPACT, plutusSectionUrl } from './plutus-link.js';
import { truncate, wrap, width, stripAnsi } from '../tui/text.js';
import { panel, tile, beside, split, table, hbar, stackedBars, bucket, axis, fitTo, alignRight } from '../ui/widgets.js';

export const COMPACT_BELOW = 100;
export const MAX_WIDTH = 160;
export const ANOMALY_MIN_DAYS = 8;
export const DRIVERS_MIN_DAYS = 60;
export const FORECAST_MIN_DAYS = 14;
const TREND_DAYS = 60;

/** @typedef {import('./data.js').ReportData} ReportData */
/** @typedef {import('../ui/theme.js').Theme} Theme */

/** @param {string} month YYYY-MM @returns {string} */
export function monthName(month) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

/** @param {number} pct @returns {string} */
export function signedPct(pct) {
  const r = Math.round(pct);
  return r === 0 ? '0%' : `${r > 0 ? '+' : '-'}${Math.abs(r)}%`;
}

/**
 * Wrap a paragraph so each sentence starts on its own line, which keeps each one whole where it fits.
 * @param {string} text @param {number} w @returns {string[]}
 */
export function sentences(text, w) {
  return text.split(/(?<=\.) (?=[A-Z])/).flatMap((s) => wrap(s, w));
}

/** @param {{ provider: string, service: string }} x @returns {string} */
export const serviceName = (x) => `${providerName(sanitize(x.provider))} ${sanitize(x.service)}`;

/** Red for more spend, green for less. @param {Theme} t @param {number} n @param {string} text */
export const tint = (t, n, text) => (n > 0 ? t.fg('up', text) : n < 0 ? t.fg('down', text) : text);

/**
 * One bar split into cloud, commitments and AI by their share of the total.
 * @param {Theme} t @param {{ cloud: number, commitment: number, ai: number }} split @param {number} cells @returns {string}
 */
export function shareBar(t, split, cells) {
  const parts = [['cloud', '█', split.cloud], ['commitment', '▓', split.commitment], ['ai', '▒', split.ai]];
  const total = parts.reduce((a, p) => a + Math.max(0, /** @type {number} */ (p[2])), 0);
  if (total <= 0) return '';
  let used = 0;
  return parts.map(([role, glyph, v], i) => {
    const n = i === parts.length - 1 ? cells - used : Math.round((Math.max(0, /** @type {number} */ (v)) / total) * cells);
    used += n;
    return t.fg(/** @type {import('../ui/theme.js').Role} */ (role), (t.color ? '█' : /** @type {string} */ (glyph)).repeat(Math.max(0, n)));
  }).join('');
}

/** @param {number} n @returns {string} an arrow for the direction of a change */
const arrow = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '•');

const SEVERITY_ROLE = /** @type {Record<string, import('../ui/theme.js').Role>} */ ({ high: 'up', medium: 'warn', low: 'muted' });

/** @param {Theme} t @param {string} severity @returns {string} a coloured dot and the word */
export function severityBadge(t, severity) {
  const s = sanitize(severity);
  return t.fg(SEVERITY_ROLE[s] ?? 'muted', `● ${s}`);
}

/**
 * The top line: the mark and name on the left, the window on the right.
 * @param {Theme} t @param {ReportData} report @param {number} w @returns {string}
 */
export function brandBar(t, report, w) {
  const name = `plutus-scan ${sanitize(report.tool.version)}`;
  const right = `${report.window.start} → ${report.window.end} · ${report.window.days} days · ${sanitize(report.currency)}`;
  const left = `◆ ${name}`;
  if (width(left) + 2 + width(right) > w) return truncate(`${left}  ${right}`, w).replace(left, `${t.fg('brand', '◆')} ${t.bold(name)}`);
  return `${t.fg('brand', '◆')} ${t.bold(name)}${' '.repeat(w - width(left) - width(right))}${t.fg('muted', right)}`;
}

/**
 * Four KPI tiles: last 30 days, the change against the 30 before, the month-end forecast and commitments.
 * @param {Theme} t @param {ReportData} report @param {{ width: number, detail?: boolean, inline?: boolean, braille?: boolean }} o
 *   `detail` adds a second line under each figure; `inline` puts the figure and its first detail on one line
 * @returns {string[]}
 */
export function kpiTiles(t, report, { width: w, detail = true, inline = false, braille = false }) {
  const cur = sanitize(report.currency);
  const money = (n) => formatMoney(n, cur);
  const h = report.headline;
  const perRow = w >= 72 ? 4 : 2;
  const widths = split(w, perRow);
  const inner = Math.min(...widths) - 4;
  const fit = (s) => truncate(s, inner);

  const last30 = report.daily.slice(-30).map(spreadTotal);
  const sw = Math.min(inner, braille ? Math.ceil(last30.length / 2) : last30.length);
  const spark = t.fg('cloud', sparkline(last30, { width: sw, braille }));
  const committed = hasCommitment(h.last30.commitment);
  const splitLine = [`cloud ${money(h.last30.cloud)}`, ...(committed ? [`RI/SP ${money(h.last30.commitment)}`] : []), `AI ${money(h.last30.ai)}`].join(' · ');
  const quiet = (s) => t.fg('muted', fit(s));
  const tiles = [];
  tiles.push({
    label: 'Last 30 days', value: money(h.last30.total),
    sub: [spark, ...(detail ? [width(splitLine) <= inner ? t.fg('muted', splitLine) : shareBar(t, h.last30, inner)] : [])],
  });
  if (h.previous30Total === null || h.change === null) {
    tiles.push({ label: 'Change', value: '—', sub: [quiet(`needs ${DRIVERS_MIN_DAYS} days`)] });
  } else {
    const pct = h.changePct === null ? 'from nothing' : `${signedPct(h.changePct)} vs before`;
    tiles.push({
      label: 'Change', value: `${arrow(h.change)} ${signedMoney(h.change, cur)}`, valueRole: h.change > 0 ? 'up' : h.change < 0 ? 'down' : undefined,
      sub: [tint(t, h.change, fit(pct)), ...(detail ? [quiet(`was ${money(h.previous30Total)}`)] : [])],
    });
  }
  if (h.monthEnd) {
    tiles.push({
      label: 'Forecast', value: money(h.monthEnd.projected),
      sub: [quiet(`${monthName(h.monthEnd.month)} total`), ...(detail ? [quiet(`${money(h.monthEnd.monthToDate)} so far`)] : [])],
    });
  } else {
    tiles.push({ label: 'Forecast', value: '—', sub: [quiet(`needs ${FORECAST_MIN_DAYS} days`)] });
  }
  const share = h.last30.total > 0 ? (h.last30.commitment / h.last30.total) * 100 : 0;
  tiles.push({
    label: 'Commitments', value: committed ? money(h.last30.commitment) : 'none',
    sub: [quiet(committed ? `${share.toFixed(0)}% of spend` : 'no purchases'), ...(detail ? [quiet('last 30 days')] : [])],
  });

  const lines = [];
  for (let i = 0; i < tiles.length; i += perRow) {
    const row = tiles.slice(i, i + perRow).map((x, k) => {
      const height = Math.max(...tiles.slice(i, i + perRow).map((y) => y.sub.length));
      const sub = x.sub.slice();
      while (sub.length < height) sub.push('');
      if (inline) {
        // One line: the figure, then its first detail when both fit.
        const v = t.bold(x.valueRole ? t.fg(x.valueRole, x.value) : x.value);
        const both = width(x.value) + 1 + width(stripAnsi(x.sub[0] ?? '')) <= widths[k] - 4;
        return { width: widths[k], lines: panel(t, { title: x.label, width: widths[k], lines: [both ? `${v} ${x.sub[0]}` : v] }) };
      }
      return { width: widths[k], lines: tile(t, { ...x, sub, width: widths[k] }) };
    });
    lines.push(...beside(row));
  }
  return lines;
}

/**
 * @typedef {{ role: import('../ui/theme.js').Role, glyph: string, label: string, shade?: boolean, values: number[] }} Series
 */

/**
 * A bar chart in a panel: one bar per date, stacked by series, a money axis on the left, a row of marks
 * (anomalies) under the bars, the dates under that and an optional legend. Few dates get wide bars with
 * gaps; more dates than columns are averaged into buckets.
 * @param {Theme} t
 * @param {{ series: Series[], dates: string[], width: number, height: number, money: (n: number) => string,
 *   title?: string, aside?: string, marks?: { index: number, role: import('../ui/theme.js').Role }[],
 *   markLabel?: string, legend?: boolean }} o `height` is the number of bar rows
 * @returns {string[]} a panel
 */
export function barChart(t, { series, dates, width: w, height, money, title = '', aside = '', marks = [], markLabel = '', legend = true }) {
  const inner = w - 4;
  const n = dates.length;
  const totals = dates.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
  const top = Math.max(0, ...totals);
  const labels = [money(top), money(top / 2), money(0)];
  const yw = Math.max(...labels.map(width)) + 1;
  const room = Math.max(1, inner - yw - 1);
  const per = n > 0 && n * 2 <= room ? Math.min(4, Math.floor(room / n)) : 1;
  const cols = per > 1 ? n * per : Math.min(room, n);
  const expand = per > 1
    ? (/** @type {number[]} */ v) => v.flatMap((x) => [...Array(per - 1).fill(x), 0])
    : (/** @type {number[]} */ v) => bucket(v, cols);
  const colOf = (i) => (per > 1 ? i * per + Math.floor((per - 2) / 2) : Math.min(cols - 1, Math.floor((i * cols) / Math.max(1, n))));
  const shown = series.filter((s, k) => k === 0 || s.values.some((v) => v > 0));
  const bars = stackedBars(t, { series: shown.map((s) => ({ ...s, values: expand(s.values) })), height, max: top });

  const rowLabel = (r) => {
    if (r === 0) return labels[0];
    if (r === height - 1) return labels[2];
    if (height >= 5 && r === Math.floor((height - 1) / 2)) return labels[1];
    return '';
  };
  const lines = bars.map((b, r) => `${t.fg('muted', alignRight(rowLabel(r), yw - 1))} ${t.fg('border', '│')}${b}`);

  const cells = Array(cols).fill('');
  for (const m of marks) if (m.index >= 0 && m.index < n) cells[colOf(m.index)] = m.role;
  const markLine = cells.map((role) => (role ? t.fg(role, '▲') : ' ')).join('');
  lines.push(`${' '.repeat(yw)}${t.fg('border', '└')}${marks.length ? markLine : t.fg('border', '─'.repeat(cols))}`);
  const mid = dates[Math.floor((n - 1) / 2)];
  const ticks = n === 0 ? [] : n === 1 ? [dates[0]] : cols >= 40 && n > 2 ? [dates[0], mid, dates[n - 1]] : [dates[0], dates[n - 1]];
  lines.push(`${' '.repeat(yw + 1)}${t.fg('muted', axis(ticks, cols))}`);
  if (legend) {
    const items = shown.map((s) => `${t.fg(s.role, t.color && !s.shade ? '■' : s.glyph)} ${s.label}`);
    if (marks.length && markLabel) items.push(`${t.fg('up', '▲')} ${markLabel}`);
    lines.push(items.join('   '));
  }
  return panel(t, { title, aside: w >= 60 ? aside : '', width: w, lines });
}

const SEVERITY_RANK = /** @type {Record<string, number>} */ ({ low: 1, medium: 2, high: 3 });

/**
 * The daily spend chart: bars stacked by cloud, commitments and AI, then monthly charges spread over their
 * month (see analysis/monthly.js) in a shade of their own, the forecast after them, and a mark under each
 * flagged day.
 * @param {Theme} t @param {ReportData} report @param {{ width: number, height: number, title?: string, legend?: boolean }} o
 * @returns {string[]} a panel
 */
export function spendChart(t, report, { width: w, height, title = 'Daily spend', legend = true }) {
  const cur = sanitize(report.currency);
  const money = (n) => formatMoney(n, cur);
  // The forecast only when every day still gets its own column.
  const ext = report.forecastExtension.length + report.daily.length <= w - 14 ? report.forecastExtension : [];
  const pad = (/** @type {number[]} */ v) => [...v, ...ext.map(() => 0)];
  /** @type {Series[]} */
  const days = report.daily.map(spreadDay);
  const series = [
    { role: 'cloud', glyph: '█', label: 'cloud', values: pad(days.map((d) => d.cloud)) },
    { role: 'commitment', glyph: '▓', label: 'commitments', values: pad(days.map((d) => d.commitment)) },
    { role: 'ai', glyph: '▒', label: 'AI', values: pad(days.map((d) => d.ai)) },
    { role: 'monthly', glyph: '▞', shade: true, label: 'monthly charges, spread', values: pad(days.map((d) => d.monthly)) },
    { role: 'forecast', glyph: '░', shade: true, label: 'forecast', values: [...report.daily.map(() => 0), ...ext.map((e) => e.value)] },
  ];
  const at = new Map(report.daily.map((d, i) => [d.date, i]));
  const marks = report.anomalies.slice()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 0) - (SEVERITY_RANK[b.severity] ?? 0))
    .map((a) => ({ index: at.get(a.date) ?? -1, role: SEVERITY_ROLE[sanitize(a.severity)] ?? 'muted' }));
  const totals = report.daily.map(spreadTotal);
  const peak = Math.max(0, ...totals);
  const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
  return barChart(t, {
    series, dates: [...report.daily.map((d) => d.date), ...ext.map((e) => e.date)], width: w, height, money, title,
    aside: `peak ${money(peak)} · avg ${money(avg)}/day`, marks, markLabel: 'anomaly', legend,
  });
}

/**
 * The drivers table: each service's last 30 days, change, share bar and a 60-day trend.
 * @param {Theme} t @param {ReportData} report
 * @param {{ width: number, limit?: number, usageTypes?: boolean, selected?: number, offset?: number, rows?: number, braille?: boolean }} o
 *   `selected` and `offset` are for the full-screen list
 * @returns {{ header: string, lines: string[], index: number[] }} `index` maps each line to its driver
 */
export function driversTable(t, report, { width: w, limit = Infinity, usageTypes = true, selected = -1, offset = 0, rows = Infinity, braille = false }) {
  const drivers = /** @type {NonNullable<ReportData['drivers']>} */ (report.drivers);
  const cur = sanitize(report.currency);
  const compact = w < COMPACT_BELOW - 4;
  const items = drivers.items.slice(offset, Math.min(drivers.items.length, offset + Math.min(limit, rows)));
  const maxShare = Math.max(1, ...drivers.items.map((d) => d.sharePct));
  const barW = compact ? 6 : 10;
  const trendW = compact ? 8 : Math.max(16, Math.min(30, w - 90));
  /** @type {string[][]} */
  const cells = [];
  const index = [];
  const kinds = [];
  items.forEach((d, k) => {
    const series = report.serviceDaily[`${d.provider}|${d.service}`] ?? [];
    const recent = series.slice(-TREND_DAYS);
    const trend = recent.length ? sparkline(recent, { width: Math.min(trendW, braille ? Math.ceil(recent.length / 2) : recent.length), braille }) : '';
    const share = `${hbar(d.sharePct, maxShare, barW)} ${d.sharePct.toFixed(1).padStart(4)}%`;
    const row = [serviceName(d), formatMoney(d.current, cur), formatMoney(d.previous, cur), signedMoney(d.change, cur), share, trend];
    cells.push(compact ? [row[0], row[3], row[4], row[5]] : row);
    index.push(offset + k);
    kinds.push({ change: d.change, sub: false });
    if (!usageTypes) return;
    for (const u of d.usageTypes) {
      const sub = [`  ↳ ${sanitize(u.usageType) || '(none)'}`, formatMoney(u.current, cur), formatMoney(u.previous, cur), signedMoney(u.change, cur), '', ''];
      cells.push(compact ? [sub[0], sub[3], '', ''] : sub);
      index.push(offset + k);
      kinds.push({ change: u.change, sub: true });
    }
  });
  const quiet = (paint) => (text, r) => (kinds[r].sub ? t.fg('muted', text) : paint(text, r));
  const name = { head: 'Service', flex: true, min: 12, paint: (s, r) => (kinds[r].sub ? t.fg('muted', s) : index[r] === selected ? s : t.bold(s)) };
  const change = { head: 'Change', align: /** @type {const} */ ('right'), paint: (s, r) => tint(t, kinds[r].change, s) };
  const share = { head: 'Share', raw: true, paint: quiet((s) => t.fg('rank', s.slice(0, barW)) + s.slice(barW)) };
  const trend = { head: `${TREND_DAYS}-day trend`, raw: true, paint: quiet((s) => t.fg('cloud', s)) };
  const columns = compact
    ? [name, change, share, { ...trend, head: 'Trend' }]
    : [name, { head: 'Last 30', align: /** @type {const} */ ('right'), paint: quiet((s) => s) },
      { head: 'Previous', align: /** @type {const} */ ('right'), paint: (s) => t.fg('muted', s) }, change, share, trend];
  const out = table(t, { width: w, columns, rows: cells });
  return { ...out, index };
}

/**
 * The anomalies table: date, service, cost against baseline, the change and a severity badge.
 * @param {Theme} t @param {ReportData} report
 * @param {{ width: number, limit?: number, releases?: boolean, offset?: number, rows?: number }} o
 * @returns {{ header: string, lines: string[], index: number[] }}
 */
export function anomaliesTable(t, report, { width: w, limit = Infinity, releases = true, offset = 0, rows = Infinity }) {
  const cur = sanitize(report.currency);
  const compact = w < COMPACT_BELOW - 4;
  const items = report.anomalies.slice(offset, Math.min(report.anomalies.length, offset + Math.min(limit, rows)));
  const cells = [];
  const index = [];
  const kinds = [];
  items.forEach((a, k) => {
    const row = [a.date, serviceName(a), formatMoney(a.cost, cur), formatMoney(a.baseline, cur), signedMoney(a.delta, cur), `● ${sanitize(a.severity)}`];
    cells.push(compact ? [row[0], row[1], row[4], row[5]] : row);
    index.push(offset + k);
    kinds.push({ a, sub: false });
    const context = releases ? releaseContext(a, sanitize) : null;
    if (context) {
      const note = `  ↳ nearby release (context, not a cause): ${context}`;
      cells.push(compact ? ['', note, '', ''] : ['', note, '', '', '', '']);
      index.push(offset + k);
      kinds.push({ a, sub: true });
    }
  });
  const sev = { head: 'Severity', paint: (s, r) => (kinds[r].sub ? s : t.fg(SEVERITY_ROLE[sanitize(kinds[r].a.severity)] ?? 'muted', s)) };
  const change = { head: 'Change', align: /** @type {const} */ ('right'), paint: (s, r) => tint(t, kinds[r].a.delta, s) };
  const date = { head: 'Date', paint: (s) => t.fg('muted', s) };
  const svc = { head: 'Service', flex: true, min: 12, paint: (s, r) => (kinds[r].sub ? t.fg('muted', s) : s) };
  const columns = compact
    ? [date, svc, change, sev]
    : [date, svc, { head: 'Cost', align: /** @type {const} */ ('right') }, { head: 'Baseline', align: /** @type {const} */ ('right'), paint: (s) => t.fg('muted', s) }, change, sev];
  // A release note spans the row: give it the service column only and let the table cut it.
  return { ...table(t, { width: w, columns, rows: cells }), index };
}

/**
 * @param {Theme} t @param {ReportData} report @param {{ width: number, limit?: number }} o @returns {string[]}
 */
export function candidatesTable(t, report, { width: w, limit = Infinity }) {
  const cur = sanitize(report.currency);
  const shown = report.candidates.slice(0, limit);
  const rows = shown.map((c) => [sanitize(c.title), formatMoney(c.cost30d, cur), sanitize(c.why)]);
  const out = table(t, {
    width: w,
    columns: [{ head: 'Candidate', paint: (s) => t.bold(s) }, { head: '30 days', align: 'right' }, { head: 'Why', flex: true, min: 10, paint: (s) => t.fg('muted', s) }],
    rows,
  });
  // A candidate Plutus can fix gets a second, quieter line under its own figure. It is a line of its own
  // rather than a table row, so a narrow Why column does not cut it.
  // A quiet label opens each group, the strong candidates and then the ones worth a look.
  const savings = report.possibleSavings
    ? [t.fg('muted', truncate(`Possible savings: up to ${formatMoney(report.possibleSavings.cost30d, cur)} ${possibleSavingsCaveat(report.possibleSavings)}`, w))]
    : [];
  const lines = [...savings, ...shown.flatMap((c, i) => [
    ...(i === 0 || shown[i - 1].strength !== c.strength ? [t.fg('muted', truncate(STRENGTH_LABEL[c.strength], w))] : []),
    out.lines[i],
    ...(c.plutusFix === 'pull_request' ? [t.fg('muted', truncate(`  ${PR_LINE_COMPACT}`, w))] : [])])];
  if (shown.some((c) => c.plutusFix === 'pull_request')) lines.push(t.fg('muted', truncate(`  ${plutusSectionUrl()}`, w)));
  if (report.candidates.length > shown.length) lines.push(t.fg('muted', truncate(`  ${moreCandidatesLine(report.candidates.length - shown.length)}`, w)));
  return [out.header, ...lines];
}

/**
 * @param {Theme} t @param {ReportData} report @param {{ width: number, limit?: number }} o @returns {string[]}
 */
export function aiTable(t, report, { width: w, limit = Infinity }) {
  const cur = sanitize(report.currency);
  const max = Math.max(1, ...report.aiProjects.map((p) => p.sharePct));
  const barW = w < COMPACT_BELOW - 4 ? 8 : 16;
  const rows = report.aiProjects.slice(0, limit).map((p) => [
    `${providerName(sanitize(p.provider))} ${sanitize(p.project)}`, formatMoney(p.cost, cur), `${hbar(p.sharePct, max, barW)} ${p.sharePct.toFixed(1).padStart(4)}%`,
  ]);
  const out = table(t, {
    width: w,
    columns: [{ head: 'Project', flex: true, min: 12 }, { head: 'Cost', align: 'right' },
      { head: 'Share', raw: true, paint: (s) => t.fg('ai', s.slice(0, barW)) + s.slice(barW) }],
    rows,
  });
  return [out.header, ...out.lines];
}

/**
 * The quiet lines at the end: freshness, the AWS request line, then basis and notes.
 * @param {Theme} t @param {ReportData} report @param {number} w @returns {string[]}
 */
export function footerLines(t, report, w) {
  const cur = sanitize(report.currency);
  return [
    truncate(sanitize(freshnessLine({ ...report, currency: cur })), w),
    ...(report.aws ? [truncate(awsRequestLine(report.aws), w)] : []),
    ...[...report.basis, ...report.notes].flatMap((l) => wrap(sanitize(l), w)),
  ].map((l) => t.fg('muted', l));
}

/**
 * The top movers as short lines with a direction arrow: `▲ AWS EC2 / BoxUsage +$1,238`.
 * @param {Theme} t @param {ReportData} report @param {number} w @returns {string[]}
 */
export function moverLines(t, report, w) {
  const cur = sanitize(report.currency);
  const items = report.headline.movers.map((m) => ({ name: sanitize(moverName(m)), change: signedMoney(m.change, cur), n: m.change }));
  const cw = Math.max(0, ...items.map((m) => width(m.change)));
  return items.map((m) => {
    const name = truncate(m.name, Math.max(1, w - cw - 4));
    return `${tint(t, m.n, arrow(m.n))} ${fitTo(name, w - cw - 3)} ${tint(t, m.n, alignRight(m.change, cw))}`;
  });
}

/**
 * The whole report as a dashboard, for the default terminal output.
 * @param {ReportData} report @param {{ theme: Theme, columns: number, braille?: boolean }} o @returns {string}
 */
export function renderDashboard(report, { theme: t, columns, braille = false }) {
  const w = Math.max(40, Math.min(columns, MAX_WIDTH));
  const compact = columns < COMPACT_BELOW;
  /** @type {string[]} */
  const out = [brandBar(t, report, w), ''];

  if (report.empty) {
    out.push(...wrap(sanitize(report.headline.sentence), w), '', ...footerLines(t, report, w));
    return `${out.map((l) => l.trimEnd()).join('\n')}\n`;
  }

  // The sentence stays outside any border, so it copies cleanly.
  out.push(...sentences(sanitize(report.headline.sentence), w).map((l) => t.bold(l)), '');
  out.push(...kpiTiles(t, report, { width: w, detail: true, braille }));
  out.push(...spendChart(t, report, { width: w, height: compact ? 8 : 10 }));

  const inner = w - 4;
  const section = (title, lines, aside = '') => panel(t, { title, aside, width: w, lines });

  // Top movers and the largest anomaly, beside each other when there is room.
  const h = report.headline;
  const cur = sanitize(report.currency);
  if (h.movers.length > 0 || h.largestAnomaly) {
    const anomalyLines = h.largestAnomaly
      ? [t.bold(tint(t, h.largestAnomaly.delta, signedMoney(h.largestAnomaly.delta, cur))) + t.fg('muted', ` on ${h.largestAnomaly.date}`),
        truncate(serviceName(h.largestAnomaly), compact ? inner : 40), severityBadge(t, h.largestAnomaly.severity)]
      : [t.fg('muted', 'None flagged.')];
    if (!compact && h.movers.length > 0) {
      const [mw, aw] = [w - 46, 45];
      out.push(...beside([
        { width: mw, lines: panel(t, { title: 'Top movers', width: mw, lines: moverLines(t, report, mw - 4), height: 3 }) },
        { width: aw, lines: panel(t, { title: 'Largest anomaly', width: aw, lines: anomalyLines, height: 3 }) },
      ]));
    } else if (h.movers.length > 0) {
      const a = h.largestAnomaly;
      const largest = a ? ['', truncate(`Largest anomaly ${signedMoney(a.delta, cur)} on ${a.date}, ${serviceName(a)}`, inner)
        .replace(signedMoney(a.delta, cur), tint(t, a.delta, signedMoney(a.delta, cur)))] : [];
      out.push(...section('Top movers', [...moverLines(t, report, inner), ...largest]));
    } else {
      out.push(...section('Largest anomaly', anomalyLines));
    }
  }

  // Drivers.
  if (!report.drivers) {
    out.push(...section('Top drivers', [t.fg('muted', `Drivers: not enough history (${report.window.days} days, needs ${DRIVERS_MIN_DAYS}).`)]));
  } else if (report.drivers.items.length === 0) {
    out.push(...section('Top drivers', [t.fg('muted', 'No drivers.')]));
  } else {
    const d = driversTable(t, report, { width: inner, limit: compact ? 5 : 8, braille });
    out.push(...section('Top drivers', [d.header, ...d.lines], 'last 30 days vs the previous 30'));
  }

  // Anomalies and candidates, side by side on a wide screen.
  let anomalies;
  if (report.window.days < ANOMALY_MIN_DAYS) {
    anomalies = [t.fg('muted', `Anomalies: not enough history (${report.window.days} days, needs ${ANOMALY_MIN_DAYS}).`)];
  } else if (report.anomalies.length === 0) {
    anomalies = [t.fg('muted', 'No anomalies.')];
  }
  const candidates = (cw) => (report.candidates.length === 0 ? [t.fg('muted', 'No candidates.')] : candidatesTable(t, report, { width: cw, limit: 5 }));
  if (w >= 140) {
    const [lw, rw] = split(w, 2);
    const a = anomalies ?? (() => { const x = anomaliesTable(t, report, { width: lw - 4, limit: 5 }); return [x.header, ...x.lines]; })();
    const c = candidates(rw - 4);
    const height = Math.max(a.length, c.length);
    out.push(...beside([
      { width: lw, lines: panel(t, { title: 'Anomalies', width: lw, lines: a, height }) },
      { width: rw, lines: panel(t, { title: 'Candidates to review', width: rw, lines: c, height }) },
    ]));
  } else {
    const a = anomalies ?? (() => { const x = anomaliesTable(t, report, { width: inner, limit: 5 }); return [x.header, ...x.lines]; })();
    out.push(...section('Anomalies', a), ...section('Candidates to review', candidates(inner)));
  }

  if (report.aiProjects.length > 0) out.push(...section('AI by project', aiTable(t, report, { width: inner, limit: 5 })));

  out.push('', ...footerLines(t, report, w));
  return `${out.map((l) => l.trimEnd()).join('\n')}\n`;
}

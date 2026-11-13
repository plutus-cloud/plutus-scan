/**
 * Overview: KPI tiles, the headline sentence, the daily spend chart, the top movers with the largest
 * anomaly, then the freshness, AWS request, basis and note lines. The chart takes whatever height is left.
 */

import { formatMoney } from '../../model.js';
import { sanitize } from '../../report/terminal.js';
import { signedMoney, hasCommitment } from '../../report/headline.js';
import { kpiTiles, spendChart, moverLines, footerLines, serviceName, tint, sentences } from '../../report/dashboard.js';
import { panel } from '../../ui/widgets.js';
import { truncate, wrap, width } from '../text.js';

const CHART_MIN = 6;
const CHART_MAX_BARS = 14;
const CHART_ROOMY = 12;

/**
 * @param {{ report: import('../../report/data.js').ReportData }} state
 * @param {{ columns: number, rows: number, theme: import('../../ui/theme.js').Theme }} ctx
 * @returns {string[]}
 */
function render(state, { columns, rows, theme: t }) {
  const report = state.report;
  const w = columns;
  const footer = footerLines(t, report, w);
  // Freshness and the AWS request line always fit; basis and notes take what is left.
  const footerMin = report.aws ? 2 : 1;
  if (report.empty) {
    return ['', ...wrap(sanitize(report.headline.sentence), w), '', ...footer];
  }

  const h = report.headline;
  const cur = sanitize(report.currency);
  const tiles = kpiTiles(t, report, { width: w, inline: rows < 30, detail: rows >= 34 });
  const sentence = sentences(sanitize(h.sentence), w).map((l) => t.bold(l));

  /** @type {string[]} */
  let movers = [];
  const a = h.largestAnomaly;
  const largest = a
    ? [truncate(`Largest anomaly  ${signedMoney(a.delta, cur)} on ${a.date}, ${serviceName(a)}`, w - 4)
      .replace(signedMoney(a.delta, cur), tint(t, a.delta, signedMoney(a.delta, cur)))]
    : [];
  // On a short screen the movers drop their border, so the chart keeps some height.
  const section = (title, lines) => (rows >= 30
    ? panel(t, { title, width: w, lines })
    : [t.bold(t.fg('brand', title)), ...lines.map((l) => `  ${l}`)]);
  if (h.movers.length > 0) movers = section('Top movers', [...moverLines(t, report, rows >= 30 ? w - 4 : w - 2), ...largest]);
  else if (a) movers = section('Largest anomaly', largest);

  // The window totals, on one line when they fit; otherwise the total beside the label and the split below.
  const money = (n) => formatMoney(n, cur);
  const label = `Totals, ${report.window.days} days`;
  const commitments = hasCommitment(report.totals.commitment) ? `  commitments ${money(report.totals.commitment)}` : '';
  const parts = `cloud ${money(report.totals.cloud)}${commitments}  AI ${money(report.totals.ai)}`;
  const total = `total ${money(report.totals.total)}`;
  const totals = width(`${label}  ${parts}  ${total}`) <= w
    ? [`${t.bold(label)}  ${parts}  ${t.bold(total)}`]
    : [`${t.bold(label)}  ${t.bold(truncate(total, Math.max(1, w - width(label) - 2)))}`, truncate(`  ${parts}`, w)];

  const fixed = tiles.length + sentence.length + movers.length + totals.length;
  const room = rows - fixed - footerMin;
  /** @type {string[]} */
  let chart = [];
  if (room >= CHART_MIN) {
    // Basis and notes when the chart can spare them and still be a good size; otherwise the chart first.
    const extra = footer.length - footerMin;
    const chartRows = Math.min(room - extra >= CHART_ROOMY ? room - extra : room, CHART_MAX_BARS + 5);
    const legend = chartRows >= 9;
    chart = spendChart(t, report, { width: w, height: chartRows - (legend ? 5 : 4), legend });
  }
  const out = [...tiles, ...sentence, ...chart, ...totals, ...movers];
  const left = rows - out.length;
  return [...out, ...footer.slice(0, Math.max(footerMin, left))];
}

export const overview = {
  title: 'Overview',
  render,
  /** The overview has nothing to select. */
  handleKey() {},
};

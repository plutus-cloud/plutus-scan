/** The self-contained HTML report: one file, data as escaped JSON, the chart drawn as inline SVG. */

import { readFileSync } from 'node:fs';
import { formatMoney } from '../model.js';
import { providerName, freshnessLine, moverName, awsRequestLine, splitText, hasCommitment, STRENGTH_LABEL, possibleSavingsCaveat } from './headline.js';
import { spreadDay } from './data.js';
import { sanitize } from './terminal.js';
import { releaseContext, releaseLabel as labelOf } from './releases.js';
import { PR_LINE, PR_LINE_COMPACT, plutusFixUrl } from './plutus-link.js';

const DRIVERS_MIN_DAYS = 60;
const ANOMALY_MIN_DAYS = 8;
const DEMO_BANNER = 'Demo: synthetic spend for a fictional company. None of these figures are real.';
const FORECAST_MIN_DAYS = 14;
const LIMIT = 10;
// A bar more than this many times the 90th-percentile day (a fee on the 1st, a refund) would set
// the y-axis on its own and flatten every ordinary day, so the axis stops short and the bar is cut.
const CLIP_RATIO = 2.5;
const CLIP_HEADROOM = 1.6;
// Release days drawn on the daily chart; past this an org's markers would hide the bars. Days an
// anomaly points at are kept first, then the busiest.
const MAX_RELEASE_MARKERS = 30;
// Releases named in a marker's tooltip before the rest are counted.
const RELEASES_IN_TIP = 8;
const SPARK_BEFORE_DAYS = 21;
const SPARK_AFTER_DAYS = 7;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** @param {string} source @param {string} label @returns {string} the source, refused if it could end its script element */
function inlineable(source, label) {
  if (/<\/script|<!--/i.test(source)) throw new Error(`${label} cannot be inlined: it contains a script-closing sequence`);
  return source;
}

/**
 * JSON safe inside a script element: `<`, U+2028 and U+2029 become JSON escapes,
 * so the text can never close the element and JSON.parse returns the same value.
 * @param {unknown} value @returns {string}
 */
export function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** @param {string} date YYYY-MM-DD @returns {string} e.g. `Oct 13` */
const shortDate = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

/** @param {string} date YYYY-MM-DD @returns {string} e.g. `Tue Oct 13, 2026` */
const longDate = (date) => `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${shortDate(date)}, ${date.slice(0, 4)}`;

/** @param {string} start @param {string} end @returns {string} e.g. `Oct 12`, `Oct 12 to 15`, `Sep 30 to Oct 2` */
function dateRange(start, end) {
  if (start === end) return shortDate(start);
  return start.slice(0, 7) === end.slice(0, 7) ? `${shortDate(start)} to ${Number(end.slice(8, 10))}` : `${shortDate(start)} to ${shortDate(end)}`;
}

/** @param {number[]} values @param {number} q 0..1 @returns {number} nearest-rank quantile */
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * About five round y-axis ticks from min (0, or below it for a net-negative day) to at least max.
 * @param {number} max @param {number} [min] at most 0 @returns {number[]}
 */
function niceTicks(max, min = 0) {
  const top = Math.max(0, max);
  const bottom = Math.min(0, min);
  if (!(top - bottom > 0)) return [0, 1];
  const raw = (top - bottom) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks = [];
  for (let v = Math.floor(bottom / step) * step; v < top + step / 2 && ticks.length < 12; v += step) {
    ticks.push(Math.round(v * 100) / 100 || 0);
  }
  if (ticks[ticks.length - 1] < top) ticks.push(Math.round((ticks[ticks.length - 1] + step) * 100) / 100);
  return ticks;
}

// AWS usage type prefixes and the regions they stand for. A usage type with no prefix, or one not
// listed here (such as the CloudFront edge codes), gets no region.
const REGIONS = {
  USE1: 'us-east-1', USE2: 'us-east-2', USW1: 'us-west-1', USW2: 'us-west-2', CAN1: 'ca-central-1', CAN2: 'ca-west-1',
  SAE1: 'sa-east-1', MXC1: 'mx-central-1', EUW1: 'eu-west-1', EUW2: 'eu-west-2', EUW3: 'eu-west-3', EUC1: 'eu-central-1',
  EUC2: 'eu-central-2', EUN1: 'eu-north-1', EUS1: 'eu-south-1', EUS2: 'eu-south-2', APN1: 'ap-northeast-1',
  APN2: 'ap-northeast-2', APN3: 'ap-northeast-3', APS1: 'ap-southeast-1', APS2: 'ap-southeast-2', APS3: 'ap-south-1',
  APS4: 'ap-southeast-3', APS5: 'ap-south-2', APS6: 'ap-southeast-4', APS7: 'ap-southeast-5', APE1: 'ap-east-1',
  MES1: 'me-south-1', MEC1: 'me-central-1', AFS1: 'af-south-1', ILC1: 'il-central-1', UGW1: 'us-gov-west-1',
  UGE1: 'us-gov-east-1',
};
// Usage type rows shown before an "N more" row in a sub-table.
const USAGE_SHOWN = 8;

/**
 * Split a usage type into its region and the rest, when it starts with a known region prefix.
 * @param {string} usageType @returns {{ region: string, rest: string }}
 */
export function usageRegion(usageType) {
  const m = /^([A-Z]{3}\d)-(.+)$/.exec(usageType);
  const region = m ? REGIONS[/** @type {keyof typeof REGIONS} */ (m[1])] : undefined;
  return region && m ? { region, rest: m[2] } : { region: '', rest: usageType };
}

/**
 * Everything the page shows, with money already formatted, so the client holds no formatting rules.
 * @param {import('./data.js').ReportData} report
 */
export function buildView(report) {
  const cur = sanitize(report.currency);
  const money = (n) => formatMoney(n, cur);
  const signed = (n) => {
    const body = money(Math.abs(n));
    if (!/[1-9]/.test(body)) return body;
    return `${n > 0 ? '+' : '-'}${body}`;
  };
  const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  const name = (provider, service) => `${providerName(sanitize(provider))} ${sanitize(service)}`;
  const releaseLabel = (r) => labelOf(r, sanitize);
  const w = report.window;
  const short = (needs) => `Not enough history (${w.days} days). This section needs ${needs} days.`;
  const noSpend = 'No spend found in this window.';
  const h = report.headline;

  /**
   * The usage types a driver or candidate opens to, as one sub-table: sorted by last-30-day cost, the
   * region read from the prefix, and each one's share of the parent row. `previous` and `change`
   * are present only when the data has them. Rows past the first eight sit behind `more`.
   * @param {{ usageType: string|null, current: number, previous?: number, change?: number }[]} items
   * @param {number} total the parent row's last-30-day cost
   */
  const usageTable = (items, total) => {
    const compare = items.length > 0 && items.every((u) => u.previous !== undefined);
    const sorted = [...items].sort((a, b) => b.current - a.current);
    const rows = sorted.map((u) => {
      const { region, rest } = usageRegion(sanitize(u.usageType ?? ''));
      const pct = total > 0 ? (u.current / total) * 100 : 0;
      return {
        name: rest || '(none)',
        region,
        current: money(u.current),
        ...(compare ? { previous: money(u.previous ?? 0), change: signed(u.change ?? 0), dir: dir(u.change ?? 0) } : {}),
        pct: Math.round(pct * 10) / 10,
        share: `${pct.toFixed(1)}%`,
      };
    });
    const hidden = sorted.slice(USAGE_SHOWN);
    return {
      compare,
      rows,
      shown: Math.min(rows.length, USAGE_SHOWN),
      more: hidden.length ? `${hidden.length} more, ${money(hidden.reduce((sum, u) => sum + u.current, 0))}` : null,
    };
  };

  // Headline.
  /** @type {{ label: string, value: string, detail: string, tone?: string, chip?: string|null }[]} */
  const stats = [];
  if (!report.empty) {
    stats.push({ label: 'Last 30 days', value: money(h.last30.total), detail: splitText(h.last30, cur) });
    if (h.previous30Total !== null && h.change !== null) {
      const pct = h.changePct === null ? null : `${Math.round(h.changePct) > 0 ? '+' : ''}${Math.round(h.changePct)}%`;
      stats.push({ label: 'Change vs previous 30 days', value: signed(h.change), detail: `against ${money(h.previous30Total)}`, tone: dir(h.change), chip: pct });
    } else {
      stats.push({ label: 'Change vs previous 30 days', value: '-', detail: 'No previous 30 days to compare' });
    }
    if (h.largestAnomaly) {
      const a = h.largestAnomaly;
      stats.push({ label: 'Largest anomaly', value: signed(a.delta), detail: `${name(a.provider, a.service)} on ${shortDate(a.date)}`, tone: 'up', chip: a.severity });
    } else {
      stats.push({ label: 'Largest anomaly', value: '-', detail: w.days < ANOMALY_MIN_DAYS ? `Not enough history (${w.days} days)` : 'None found' });
    }
    if (h.monthEnd) {
      stats.push({ label: 'Month-end projection', value: money(h.monthEnd.projected), detail: `${h.monthEnd.month}, ${money(h.monthEnd.monthToDate)} so far` });
    } else {
      stats.push({ label: 'Month-end projection', value: '-', detail: `Not enough history (${w.days} days)` });
    }
    if (report.possibleSavings) {
      stats.push({ label: 'Possible savings', value: `Up to ${money(report.possibleSavings.cost30d)}`, detail: possibleSavingsCaveat(report.possibleSavings) });
    }
  }
  const headline = {
    title: `plutus-scan ${sanitize(report.tool.version)}`,
    demo: report.sources.some((s) => s.name === 'demo') ? DEMO_BANNER : null,
    window: `${w.start} to ${w.end} (${w.days} days)`,
    sentence: sanitize(h.sentence),
    stats,
    movers: report.empty ? [] : h.movers.map((m) => ({ name: sanitize(moverName(m)), change: signed(m.change), dir: dir(m.change) })),
  };

  // Daily chart.
  let daily;
  if (report.empty) {
    daily = { reason: noSpend, chart: null, note: null };
  } else {
    const ext = report.forecastExtension;
    const n = report.daily.length;
    const dates = [...report.daily.map((d) => d.date), ...ext.map((e) => e.date)];
    const pad = (arr) => [...arr, ...ext.map(() => null)];
    const forecast = [...report.daily.map(() => null), ...ext.map((e) => e.value)];
    const index = new Map(dates.map((d, i) => [d, i]));

    // Anomaly markers, one per day: every flagged day of every episode, so a run of high days
    // shows as a run of marks, each traceable to its service.
    /** @type {Map<number, { index: number, severity: string, items: { name: string, delta: string, actual: string, expected: string, row: number }[] }>} */
    const marks = new Map();
    const rank = { low: 0, medium: 1, high: 2 };
    report.anomalies.slice(0, LIMIT).forEach((a, row) => {
      for (const f of a.flaggedDays ?? [a]) {
        const i = index.get(f.date);
        if (i === undefined || i >= n) continue;
        const m = marks.get(i) ?? { index: i, severity: 'low', items: [] };
        if (rank[a.severity] > rank[m.severity]) m.severity = a.severity;
        m.items.push({ name: name(a.provider, a.service), delta: signed(f.delta), actual: money(f.cost), expected: money(f.baseline), row });
        marks.set(i, m);
      }
    });
    const anomalyText = dates.map((_, i) => (marks.has(i) ? marks.get(i).items.map((m) => `${m.delta} ${m.name}`).join('; ') : null));

    // One marker per day: "3 releases" when an org shipped several, each named in the tooltip.
    const byDay = new Map();
    for (const r of report.releases) {
      const i = index.get(r.date);
      if (i === undefined || i >= n) continue;
      if (!byDay.has(i)) byDay.set(i, []);
      byDay.get(i).push(releaseLabel(r));
    }
    const pinned = new Set(report.anomalies.flatMap((a) => (a.release ? [index.get(a.release.date)] : [])));
    const kept = [...byDay.keys()]
      .sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)) || byDay.get(b).length - byDay.get(a).length || b - a)
      .slice(0, MAX_RELEASE_MARKERS);
    const releases = kept.sort((a, b) => a - b).map((i) => {
      const labels = byDay.get(i);
      if (labels.length === 1) return { index: i, label: labels[0], items: [] };
      const items = labels.length > RELEASES_IN_TIP
        ? [...labels.slice(0, RELEASES_IN_TIP - 1), `and ${labels.length - RELEASES_IN_TIP + 1} more`] : labels;
      return { index: i, label: `${labels.length} releases`, items };
    });
    const releaseCaption = byDay.size > releases.length
      ? `Release markers show ${releases.length} of ${byDay.size} release days: any an anomaly points at, then the busiest.` : null;

    /**
     * What the bars, the axis and the captions are in one view of the days: with monthly charges spread
     * over their month (the default) or as billed. Stacked from the bottom: cloud, commitments, AI, then
     * the spread monthly charges.
     * @param {{ cloud: number, commitment: number, ai: number, monthly: number }[]} days
     */
    const mode = (days, spread) => {
      const cloudCommitment = days.map((d) => d.cloud + d.commitment);
      const stacked = days.map((d) => d.cloud + d.commitment + d.ai + d.monthly);
      const tops = [...stacked, ...ext.map((e) => e.value)];
      const max = Math.max(0, ...tops);
      const min = Math.min(0, ...stacked, ...cloudCommitment, ...days.map((d) => d.cloud), ...ext.map((e) => e.value));
      const p90 = quantile(tops.filter((v) => v > 0), 0.9) ?? 0;
      const clip = p90 > 0 && max > p90 * CLIP_RATIO;
      const ticks = niceTicks(clip ? p90 * CLIP_HEADROOM : max, min);
      const yMax = ticks[ticks.length - 1];
      const clipped = tops.map((v, i) => (v > yMax ? { index: i, label: money(v) } : null)).filter((c) => c !== null);
      const peak = stacked.reduce((best, v, i) => (v > stacked[best] ? i : best), 0);
      const captions = [`Peak ${money(stacked[peak])} on ${shortDate(dates[peak])}.`];
      if (spread) captions.push('Charges billed once a month, such as tax, are spread over the month they cover; every total is as billed.');
      if (clipped.length) captions.push(`The axis stops at ${money(yMax)} so ordinary days stay readable; ${clipped.length === 1 ? 'one taller bar is' : `${clipped.length} taller bars are`} cut and labelled.`);
      if (ext.length) captions.push(`Outlined bars: forecast for the next ${ext.length} days.`);
      if (releaseCaption) captions.push(releaseCaption);
      return {
        caption: captions.join(' '),
        cloud: pad(days.map((d) => d.cloud)),
        commitment: pad(days.map((d) => d.commitment)),
        ai: pad(days.map((d) => d.ai)),
        monthly: pad(days.map((d) => d.monthly)),
        cloudCommitment: pad(cloudCommitment),
        stacked: pad(stacked),
        anomaly: dates.map((_, i) => (marks.has(i) ? stacked[i] : null)),
        clipped,
        yTicks: ticks,
        yLabels: ticks.map((t) => (t === 0 ? money(0).replace(/\.00$/, '') : money(t))),
        text: {
          cloud: pad(days.map((d) => money(d.cloud))),
          commitment: pad(days.map((d) => money(d.commitment))),
          ai: pad(days.map((d) => money(d.ai))),
          monthly: pad(days.map((d) => money(d.monthly))),
          total: pad(stacked.map(money)),
          forecast: forecast.map((v) => (v === null ? null : money(v))),
          anomaly: anomalyText,
        },
      };
    };
    const spreadDays = report.daily.map(spreadDay);
    const hasMonthly = spreadDays.some((d) => d.monthly !== 0);
    const billed = mode(report.daily.map((d) => ({ cloud: d.cloud, commitment: d.commitment, ai: d.ai, monthly: 0 })), false);
    const shown = hasMonthly ? mode(spreadDays, true) : billed;
    daily = {
      reason: null,
      note: ext.length === 0 ? `Forecast: not enough history (${w.days} days). The forecast needs ${FORECAST_MIN_DAYS} days.` : null,
      caption: shown.caption,
      chart: {
        labels: dates.map(shortDate),
        dates,
        longDates: dates.map(longDate),
        actualDays: n,
        forecast,
        marks: [...marks.values()].sort((a, b) => a.index - b.index),
        releases,
        hasAi: report.daily.some((d) => d.ai !== 0),
        hasCommitment: hasCommitment(report.totals.commitment),
        // The view drawn first; with monthly charges, `billed` holds the same fields as billed.
        hasMonthly,
        ...shown,
        billed: hasMonthly ? billed : null,
      },
    };
  }

  // Drivers.
  let drivers;
  if (report.empty) drivers = { reason: noSpend, items: [] };
  else if (!report.drivers) drivers = { reason: short(DRIVERS_MIN_DAYS), items: [] };
  else if (report.drivers.items.length === 0) drivers = { reason: 'No changes between the two periods.', items: [] };
  else {
    drivers = {
      reason: null,
      intro: `${report.drivers.current.start} to ${report.drivers.current.end} against ${report.drivers.previous.start} to ${report.drivers.previous.end}, by service. Open a row for its usage types.`,
      items: report.drivers.items.slice(0, LIMIT).map((d) => ({
        name: name(d.provider, d.service),
        kind: d.kind === 'ai' ? 'AI' : d.kind === 'commitment' ? 'Commitment' : 'Cloud',
        current: money(d.current),
        previous: money(d.previous),
        change: signed(d.change),
        share: `${d.sharePct.toFixed(1)}%`,
        dir: dir(d.change),
        usage: usageTable(d.usageTypes, d.current),
      })),
    };
  }

  // Anomalies.
  let anomalies;
  if (report.empty) anomalies = { reason: noSpend, items: [] };
  else if (w.days < ANOMALY_MIN_DAYS) anomalies = { reason: short(ANOMALY_MIN_DAYS), items: [] };
  else if (report.anomalies.length === 0) anomalies = { reason: 'No anomalies found in this window.', items: [] };
  else {
    const days = report.daily.map((d) => d.date);
    const at = new Map(days.map((d, i) => [d, i]));
    anomalies = {
      reason: null,
      items: report.anomalies.slice(0, LIMIT).map((a) => {
        const start = a.start ?? a.date;
        const end = a.end ?? a.date;
        const flagged = a.flaggedDays ?? [a];
        const series = report.serviceDaily[`${a.provider}|${a.service}`] ?? null;
        const from = Math.max(0, (at.get(start) ?? 0) - SPARK_BEFORE_DAYS);
        const to = Math.min(days.length - 1, (at.get(end) ?? days.length - 1) + SPARK_AFTER_DAYS);
        const flaggedSet = new Set(flagged.map((f) => f.date));
        const sharePct = a.dayTotal > 0 ? Math.round((a.delta / a.dayTotal) * 100) : null;
        return {
          date: a.date,
          day: shortDate(a.date),
          index: at.get(a.date) ?? null,
          span: flagged.length > 1 ? `${flagged.length} days flagged, ${dateRange(start, end)}` : null,
          name: name(a.provider, a.service),
          cost: money(a.cost),
          baseline: money(a.baseline),
          delta: signed(a.delta),
          pct: `+${Math.round(a.deltaPct)}%`,
          excess: flagged.length > 1 ? `${signed(a.excess)} over the run` : null,
          share: sharePct === null ? '-' : `${sharePct}%`,
          shareOf: a.dayTotal > 0 ? `of ${money(a.dayTotal)}` : null,
          severity: a.severity,
          release: releaseContext(a, sanitize),
          spark: series ? { values: series.slice(from, to + 1), flagged: days.slice(from, to + 1).map((d) => flaggedSet.has(d)) } : null,
        };
      }),
    };
  }

  // Candidates.
  const candidates = {
    intro: 'Places worth a look, strongest signals first and then by spend over the last 30 days. These are not proven savings. Open a row for its usage types.',
    reason: report.empty ? noSpend
      : report.candidates.length === 0 ? 'No candidates found. These need AWS usage types (from Cost Explorer or a FOCUS x_UsageType column) or Azure or Google Cloud charge descriptions from a FOCUS export.' : null,
    items: report.candidates.map((c) => ({
      title: sanitize(c.title),
      why: sanitize(c.why),
      strength: STRENGTH_LABEL[c.strength],
      cost: money(c.cost30d),
      fix: c.plutusFix === 'pull_request' ? { url: plutusFixUrl('report', c.id), text: PR_LINE, compact: PR_LINE_COMPACT } : null,
      usage: usageTable(c.usageTypes.map((u) => ({ usageType: u.usageType, current: u.cost })), c.cost30d),
    })),
  };

  // AI by project.
  const aiProjects = {
    reason: report.empty ? noSpend : report.aiProjects.length === 0 ? 'No AI spend in this window.' : null,
    items: report.aiProjects.slice(0, LIMIT).map((p) => ({
      name: `${providerName(sanitize(p.provider))} ${sanitize(p.project)}`,
      cost: money(p.cost),
      share: `${p.sharePct.toFixed(1)}%`,
      pct: p.sharePct,
    })),
  };

  // Untagged share.
  const untagged = {
    reason: report.empty ? noSpend : report.untagged.length === 0 ? 'No tag data in this window.' : null,
    items: [...report.untagged].sort((a, b) => b.untaggedCost - a.untaggedCost).map((u) => ({
      name: `${providerName(sanitize(u.provider))} tag ${sanitize(u.key)}`,
      label: u.label,
      untagged: money(u.untaggedCost),
      total: money(u.untaggedCost + u.taggedCost),
      share: u.untaggedPct === null ? '-' : `${u.untaggedPct.toFixed(1)}%`,
      pct: u.untaggedPct ?? 0,
    })),
  };

  // Basis and notes.
  const lines = [...report.notes, ...report.basis].map(sanitize);
  lines.push(sanitize(freshnessLine({ ...report, currency: cur })));
  if (report.aws) lines.push(awsRequestLine(report.aws));
  const basis = { lines, generated: `Generated ${sanitize(report.generatedAt)} by plutus-scan ${sanitize(report.tool.version)}.` };

  return { empty: report.empty, headline, daily, drivers, anomalies, candidates, aiProjects, untagged, basis };
}

/**
 * @param {import('./data.js').ReportData} report
 * @returns {string} the complete HTML document
 */
export function renderHtml(report) {
  const parts = {
    '/*CLIENT_JS*/': inlineable(read('./client.js'), 'client.js'),
    __REPORT_JSON__: embedJson({ report, view: buildView(report) }),
  };
  // One pass, so text inserted for one placeholder is never scanned for another.
  return read('./template.html').replace(/\/\*CLIENT_JS\*\/|__REPORT_JSON__/g,
    (m) => parts[/** @type {keyof typeof parts} */ (m)]);
}

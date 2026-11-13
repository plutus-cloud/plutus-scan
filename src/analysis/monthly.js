/**
 * Charges billed once a month, spread over the month they cover, for the daily views only. Tax and a
 * monthly Reserved Instance fee land on the 1st and can be several ordinary days of spend; drawn as
 * billed they read as spikes. Totals, drivers and tables keep them as billed.
 *
 * A row is spread when it falls on the 1st, is a positive charge, and either:
 * - its source marked it monthly (`row.monthly`) and it is at least half of what its series (provider,
 *   kind, service) billed that month, so a Reserved Instance fee is spread even when an instance bought
 *   mid-month adds a prorated fee on another day, while a fee billed every day is not; or
 * - its series bills only on the 1st, in at least two months of the window (a Support plan fee).
 * Only the charge on the 1st moves; the series' other days stay as billed.
 *
 * Each charge is spread evenly over every day of its calendar month. For the month the window ends in,
 * the share of the days still to come is not drawn as actual spend: the forecast, fitted to the spread
 * series, carries that daily rate forward instead.
 */

import { eachDay } from '../model.js';

/** @typedef {import('../model.js').Row} Row */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {{ cloud: number, commitment: number, ai: number }} Split */

const MIN_MONTHS = 2;
// A marked charge on the 1st is spread when it is at least this share of its series' month.
const MIN_MONTH_SHARE = 0.5;

/** @param {string} date YYYY-MM-DD @returns {number} days in its month */
export function daysInMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const seriesKey = (/** @type {Row} */ r) => `${r.provider}\0${r.kind}\0${r.service}`;
const zero = () => ({ cloud: 0, commitment: 0, ai: 0 });

/**
 * @param {Row[]} rows rows inside the window
 * @param {Window} window
 * @returns {{ spread: Set<Row>, billed: Map<string, Split>, portions: Map<string, Split> }}
 *   `spread` holds the rows that are spread; `billed` is what they add to their day as billed and
 *   `portions` what each window day gets once they are spread, both by kind and keyed by date.
 */
export function spreadMonthly(rows, window) {
  /** @type {Map<string, { firsts: Set<string>, others: Set<string>, months: Map<string, number> }>}
   * per series: the months it bills on the 1st, the months it bills on other days, and its spend per month */
  const seen = new Map();
  for (const r of rows) {
    if (r.cost <= 0) continue;
    const k = seriesKey(r);
    let s = seen.get(k);
    if (!s) seen.set(k, (s = { firsts: new Set(), others: new Set(), months: new Map() }));
    const month = r.date.slice(0, 7);
    (r.date.endsWith('-01') ? s.firsts : s.others).add(month);
    s.months.set(month, (s.months.get(month) ?? 0) + r.cost);
  }

  /** @type {Set<Row>} */
  const spread = new Set();
  for (const r of rows) {
    if (r.cost <= 0 || !r.date.endsWith('-01')) continue;
    const s = /** @type {NonNullable<ReturnType<typeof seen.get>>} */ (seen.get(seriesKey(r)));
    const month = r.date.slice(0, 7);
    const dominant = r.cost >= MIN_MONTH_SHARE * (s.months.get(month) ?? 0);
    const firstOnly = s.others.size === 0 && s.firsts.size >= MIN_MONTHS;
    if ((r.monthly && dominant) || firstOnly) spread.add(r);
  }

  /** @type {Map<string, Split>} */
  const billed = new Map();
  /** @type {Map<string, Split>} */
  const portions = new Map();
  const days = new Set(eachDay(window));
  for (const r of spread) {
    const b = billed.get(r.date) ?? zero();
    b[r.kind] += r.cost;
    billed.set(r.date, b);
    const n = daysInMonth(r.date);
    const share = r.cost / n;
    for (let d = 1; d <= n; d += 1) {
      const date = `${r.date.slice(0, 8)}${String(d).padStart(2, '0')}`;
      if (!days.has(date)) continue;
      const p = portions.get(date) ?? zero();
      p[r.kind] += share;
      portions.set(date, p);
    }
  }
  return { spread, billed, portions };
}

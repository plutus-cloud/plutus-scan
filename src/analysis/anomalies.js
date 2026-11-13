/**
 * Daily spend anomalies: each day of the window is judged against its own series history.
 * Adapted from Plutus's private backend (plutus-backend/lib/anomaly-detection.js, commit
 * 8f3e0d23): pickBaseline, floorCentsFor, severityFor, compareSeries and isSpike. The sliding
 * evaluation over the window, the median floor base and the grouping of flagged days into
 * episodes are new.
 */
import { addDays, eachDay } from '../model.js';

/** @typedef {import('../model.js').Row} Row */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {import('../model.js').Release} Release */
/** @typedef {{ date: string, cost: number, baseline: number, delta: number }} FlaggedDay */
/**
 * One episode: a run of flagged days for one series. `date`, `cost`, `baseline`, `delta`,
 * `deltaPct` and `severity` describe the peak day; `excess` is the sum of `delta` over every
 * flagged day; `dayTotal` is the non-commitment spend of every series on the peak day. `release` is
 * the nearest release before the run; `releases` is every release on that day (an org can ship
 * several at once), so a report can name them all.
 * @typedef {{ date: string, start: string, end: string, provider: string, service: string,
 *   cost: number, baseline: number, delta: number, deltaPct: number, severity: 'low'|'medium'|'high',
 *   excess: number, dayTotal: number, flaggedDays: FlaggedDay[], release: Release|null,
 *   releases: Release[] }} Anomaly
 */

export const ANOMALY_MIN_DAYS = 8;
export const ANOMALY_LIMIT = 10;

const SPIKE_THRESHOLD_PCT = 50;
const RELATIVE_FLOOR_PCT = 2;
const MAX_FLOOR_CENTS = 50000;
const SMALL_ABSOLUTE_FLOOR_CENTS = 1000;
const MIN_BASELINE_DAYS = 3;
const WINDOW_DAYS = 8;
const SAME_WEEKDAY_OCCURRENCES = 4;
export const WEEKDAY_WINDOW_DAYS = 29;
const SEVERITY_HIGH_FLOOR_MULTIPLE = 10;
const SEVERITY_MEDIUM_FLOOR_MULTIPLE = 3;
// Flagged days of one series separated by at most this many unflagged days are one episode.
// The 4-week baseline lags a level shift, so a service that runs high for a week is flagged on
// most of its days; counting each day would fill the list with one cause.
const EPISODE_MAX_GAP_DAYS = 1;
const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };

/** @param {string} day YYYY-MM-DD @returns {number} 0 (Sunday) to 6 */
function dayOfWeek(day) {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * Judge the current day against the mean of the last 4 same-weekday days, else the prior 7 days.
 * @param {{ day: string }} current
 * @param {{ day: string, daily_cost: number }[]} priorDays
 */
function pickBaseline(current, priorDays) {
  const weekday = dayOfWeek(current.day);
  const sameWeekdayDays = priorDays
    .filter((d) => dayOfWeek(d.day) === weekday)
    .slice(-SAME_WEEKDAY_OCCURRENCES);
  if (sameWeekdayDays.length >= SAME_WEEKDAY_OCCURRENCES) {
    return { baselineDays: sameWeekdayDays };
  }
  const flatBaselineDays = priorDays.slice(-(WINDOW_DAYS - 1));
  if (flatBaselineDays.length >= MIN_BASELINE_DAYS) {
    return { baselineDays: flatBaselineDays };
  }
  return null;
}

/** @param {number[]} values @returns {number} */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The absolute floor in cents: 2% of the mean daily total (in dollars), clamped to $10..$500.
 * @param {number} meanDailyTotalDollars
 */
function floorCentsFor(meanDailyTotalDollars) {
  const relativeFloorCents = Math.round(meanDailyTotalDollars * 100 * (RELATIVE_FLOOR_PCT / 100));
  return Math.max(SMALL_ABSOLUTE_FLOOR_CENTS, Math.min(MAX_FLOOR_CENTS, relativeFloorCents));
}

/** @param {number} deltaCents @param {number} floorCents @returns {'low'|'medium'|'high'} */
function severityFor(deltaCents, floorCents) {
  if (deltaCents >= floorCents * SEVERITY_HIGH_FLOOR_MULTIPLE) return 'high';
  if (deltaCents >= floorCents * SEVERITY_MEDIUM_FLOOR_MULTIPLE) return 'medium';
  return 'low';
}

/**
 * @param {{ day: string, daily_cost: number }[]} days one series in ascending order, last is current
 */
function compareSeries(days) {
  if (days.length < MIN_BASELINE_DAYS + 1) return null;
  const current = days[days.length - 1];
  const baseline = pickBaseline(current, days.slice(0, -1));
  if (!baseline) return null;

  const { baselineDays } = baseline;
  const baselineMeanDollars = baselineDays.reduce((sum, d) => sum + d.daily_cost, 0) / baselineDays.length;
  const currentCents = Math.round(current.daily_cost * 100);
  const baselineCents = Math.round(baselineMeanDollars * 100);
  if (baselineCents <= 0) return null;
  const deltaCents = currentCents - baselineCents;
  return {
    day: current.day,
    currentCents,
    baselineCents,
    deltaCents,
    pctChange: Math.round((deltaCents / baselineCents) * 100),
  };
}

/** Applied to the unrounded percentage, as in Plutus. */
function isSpike(comparison, floorCents) {
  const pctChange = (comparison.deltaCents / comparison.baselineCents) * 100;
  return pctChange >= SPIKE_THRESHOLD_PCT && comparison.deltaCents >= floorCents;
}

/**
 * The latest release dated from 2 days before the date (or from `from`) up to the date itself.
 * @param {string} date @param {Release[]} releases @param {string} [from] @returns {Release|null}
 */
export function nearestRelease(date, releases, from = addDays(date, -2)) {
  let best = null;
  for (const r of releases) {
    if (r.date >= from && r.date <= date && (!best || r.date > best.date)) best = r;
  }
  return best;
}

/**
 * Commitment rows (Savings Plan and Reserved Instance fees) are ignored: they post on a schedule,
 * often on the 1st of the month, and are not usage. So are negative rows (credits and refunds): a
 * credit booked under a service would lower that weekday's baseline for four weeks and make an
 * ordinary day look like a spike. Days are judged on charges before credits.
 * @param {Row[]} rows @param {Window} window @param {Release[]} [releases]
 * @returns {Anomaly[]}
 */
export function detectAnomalies(rows, window, releases = []) {
  if (window.days < ANOMALY_MIN_DAYS) return [];
  const days = eachDay(window);
  const index = new Map(days.map((d, i) => [d, i]));

  /** @type {Map<string, { provider: string, service: string, values: number[] }>} */
  const series = new Map();
  const totals = new Array(days.length).fill(0);
  for (const r of rows) {
    const i = index.get(r.date);
    if (i === undefined || r.kind === 'commitment' || r.cost < 0) continue;
    const key = `${r.provider}\u0000${r.service}`;
    let s = series.get(key);
    if (!s) {
      s = { provider: r.provider, service: r.service, values: new Array(days.length).fill(0) };
      series.set(key, s);
    }
    s.values[i] += r.cost;
    totals[i] += r.cost;
  }

  /** @type {Map<{ provider: string, service: string, values: number[] }, (FlaggedDay & { i: number, deltaPct: number, severity: Anomaly["severity"] })[]>} */
  const flagged = new Map();
  for (let i = 1; i < days.length; i += 1) {
    // The median, not the mean: a fee on the 1st of the month would otherwise lift the floor
    // for the following week and change the severity of the same rise by its date.
    const floorCents = floorCentsFor(median(totals.slice(Math.max(0, i - WINDOW_DAYS), i)));
    for (const s of series.values()) {
      // pickBaseline looks back at most 28 days, so older history cannot change the result.
      const history = [];
      for (let j = Math.max(0, i - (WEEKDAY_WINDOW_DAYS - 1)); j <= i; j += 1) history.push({ day: days[j], daily_cost: s.values[j] });
      const c = compareSeries(history);
      if (!c || !isSpike(c, floorCents)) continue;
      if (!flagged.has(s)) flagged.set(s, []);
      flagged.get(s).push({
        i,
        date: days[i],
        cost: c.currentCents / 100,
        baseline: c.baselineCents / 100,
        delta: c.deltaCents / 100,
        deltaPct: c.pctChange,
        severity: severityFor(c.deltaCents, floorCents),
      });
    }
  }

  /** @type {Anomaly[]} */
  const found = [];
  for (const [s, hits] of flagged) {
    let run = [];
    const close = () => {
      const peak = run.reduce((best, d) => (d.delta > best.delta ? d : best), run[0]);
      found.push({
        date: peak.date,
        start: run[0].date,
        end: run[run.length - 1].date,
        provider: s.provider,
        service: s.service,
        cost: peak.cost,
        baseline: peak.baseline,
        delta: peak.delta,
        deltaPct: peak.deltaPct,
        severity: run.reduce((top, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[top] ? d.severity : top), peak.severity),
        excess: Math.round(run.reduce((sum, d) => sum + d.delta * 100, 0)) / 100,
        dayTotal: Math.round(totals[peak.i] * 100) / 100,
        flaggedDays: run.map((d) => ({ date: d.date, cost: d.cost, baseline: d.baseline, delta: d.delta })),
        release: null,
        releases: [],
      });
      run = [];
    };
    for (const hit of hits) {
      if (run.length && hit.i - run[run.length - 1].i > EPISODE_MAX_GAP_DAYS + 1) close();
      run.push(hit);
    }
    close();
  }

  found.sort((a, b) => b.delta - a.delta || a.date.localeCompare(b.date) || a.service.localeCompare(b.service));
  return found.slice(0, ANOMALY_LIMIT)
    .map((a) => {
      const release = nearestRelease(a.date, releases, addDays(a.start, -2));
      return { ...a, release, releases: release ? releases.filter((r) => r.date === release.date) : [] };
    });
}

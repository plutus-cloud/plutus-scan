/** Assemble the one ReportData object that every renderer reads. */

import { addDays, clampToWindow, eachDay, lastNDays, pickCurrency } from '../model.js';
import { rankDrivers } from '../analysis/drivers.js';
import { detectAnomalies } from '../analysis/anomalies.js';
import { forecast } from '../analysis/forecast.js';
import { findCandidates } from '../analysis/candidates.js';
import { spreadMonthly } from '../analysis/monthly.js';
import { untaggedShare, aiByProject } from '../analysis/breakdowns.js';
import { headlineSentence, possibleSavings } from './headline.js';

/** @typedef {import('../model.js').Row} Row */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {import('../model.js').SourceResult} SourceResult */
/** @typedef {import('./headline.js').Headline} Headline */

/**
 * One day as billed, by kind. `monthly` is the part of it that is charges billed once for the month
 * (see analysis/monthly.js), and `spread` what this day gets once those charges are spread over their
 * month. The daily views draw `spreadDay`; every total uses the day as billed.
 * @typedef {{ date: string, cloud: number, commitment: number, ai: number,
 *   monthly: { cloud: number, commitment: number, ai: number }, spread: { cloud: number, commitment: number, ai: number } }} Day
 */

/**
 * @typedef {{ schemaVersion: 1, tool: { name: 'plutus-scan', version: string }, generatedAt: string,
 *   window: Window, currency: string, excludedCurrencies: Record<string, number>,
 *   sources: { name: string, rowCount: number }[], notes: string[], basis: string[],
 *   lastCompleteDay: string,
 *   headline: Headline & { largestAnomaly: import('../analysis/anomalies.js').Anomaly|null, sentence: string },
 *   totals: { total: number, cloud: number, commitment: number, ai: number },
 *   daily: Day[],
 *   forecastExtension: { date: string, value: number }[],
 *   serviceDaily: Record<string, number[]>,
 *   drivers: import('../analysis/drivers.js').Drivers|null,
 *   anomalies: import('../analysis/anomalies.js').Anomaly[],
 *   candidates: import('../analysis/candidates.js').Candidate[],
 *   possibleSavings: { count: number, cost30d: number }|null,
 *   aiProjects: ReturnType<typeof aiByProject>,
 *   untagged: ReturnType<typeof untaggedShare>,
 *   releases: import('../model.js').Release[],
 *   aws: { billedRequests: number, cost: number }|null,
 *   empty: boolean }} ReportData
 */

const AWS_REQUEST_COST = 0.01;
const COMPARE_MIN_DAYS = 60;

/**
 * One day's spend across every kind.
 * @param {{ cloud: number, commitment: number, ai: number }} d @returns {number}
 */
export const dayTotal = (d) => d.cloud + d.commitment + d.ai;

const NONE = Object.freeze({ cloud: 0, commitment: 0, ai: 0 });
/** @param {{ cloud: number, commitment: number, ai: number }} x */
const sum = (x) => x.cloud + x.commitment + x.ai;

/**
 * One day as the daily views draw it: its own spend by kind without the monthly charges billed on it,
 * and `monthly`, its share of every monthly charge spread over the month.
 * @param {{ cloud: number, commitment: number, ai: number, monthly?: Day['monthly'], spread?: Day['spread'] }} d
 * @returns {{ cloud: number, commitment: number, ai: number, monthly: number }}
 */
export function spreadDay(d) {
  const m = d.monthly ?? NONE;
  return { cloud: d.cloud - m.cloud, commitment: d.commitment - m.commitment, ai: d.ai - m.ai, monthly: sum(d.spread ?? NONE) };
}

/** @param {Parameters<typeof spreadDay>[0]} d @returns {number} the day's total with monthly charges spread */
export const spreadTotal = (d) => dayTotal(d) - sum(d.monthly ?? NONE) + sum(d.spread ?? NONE);

/** @param {number} n @returns {string} plain amount with 2 decimals and thousands separators */
const plainAmount = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** @param {Row[]} rows @param {string} start @param {string} end */
function sumSplit(rows, start, end) {
  let cloud = 0;
  let commitment = 0;
  let ai = 0;
  for (const r of rows) {
    if (r.date < start || r.date > end) continue;
    if (r.kind === 'ai') ai += r.cost;
    else if (r.kind === 'commitment') commitment += r.cost;
    else cloud += r.cost;
  }
  return { total: cloud + commitment + ai, cloud, commitment, ai };
}

/**
 * Daily cost per '<provider>|<service>' over every window day, for the given keys.
 * @param {Row[]} rows @param {string[]} days @param {Set<string>} keys
 * @returns {Record<string, number[]>}
 */
function serviceSeries(rows, days, keys) {
  /** @type {Record<string, number[]>} */
  const out = {};
  for (const k of keys) out[k] = days.map(() => 0);
  const index = new Map(days.map((d, i) => [d, i]));
  for (const r of rows) {
    const series = out[`${r.provider}|${r.service}`];
    const i = index.get(r.date);
    if (series && i !== undefined) series[i] += r.cost;
  }
  return out;
}

/**
 * @param {{ window: Window, results: { name: string, result: SourceResult }[],
 *   awsBilledRequests?: number, version: string, generatedAt: string }} input
 * @returns {ReportData}
 */
export function buildReport({ window, results, awsBilledRequests, version, generatedAt }) {
  const all = results.map((r) => r.result);
  const notes = all.flatMap((r) => r.notes);
  const basis = all.flatMap((r) => r.basis);
  const tagCoverage = all.flatMap((r) => r.tagCoverage);
  const releases = all.flatMap((r) => r.releases)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));

  // 1. Currency.
  const picked = pickCurrency(all.flatMap((r) => r.rows));
  for (const [cur, amount] of Object.entries(picked.excluded)) {
    notes.push(`Excluded ${plainAmount(amount)} ${cur} in other currencies (no conversion).`);
  }
  const currency = picked.currency ?? 'USD';

  // 2. Window.
  const rows = clampToWindow(picked.rows, window);
  /** @param {Row[]} list */
  const inScope = (list) => clampToWindow(list.filter((r) => r.currency === picked.currency), window);
  const detailRows = inScope(all.flatMap((r) => r.detailRows));
  const candidateRows = inScope(all.flatMap((r) => r.candidateRows ?? r.detailRows));
  const empty = rows.length === 0;

  // 3. Analyses.
  const days = eachDay(window);
  const monthly = spreadMonthly(rows, window);
  /** @type {Map<string, Day>} */
  const byDay = new Map(days.map((date) => [date, {
    date, cloud: 0, commitment: 0, ai: 0,
    monthly: monthly.billed.get(date) ?? { ...NONE }, spread: monthly.portions.get(date) ?? { ...NONE },
  }]));
  for (const r of rows) {
    const d = /** @type {Day} */ (byDay.get(r.date));
    if (r.kind === 'ai') d.ai += r.cost;
    else if (r.kind === 'commitment') d.commitment += r.cost;
    else d.cloud += r.cost;
  }
  const daily = [...byDay.values()];
  const totals = sumSplit(rows, window.start, window.end);

  const drivers = empty ? null : rankDrivers(rows, window, { detailRows });
  // Monthly charges are not usage and would read as a spike on the 1st, so anomalies leave them out.
  const anomalies = empty ? [] : detectAnomalies(rows.filter((r) => !monthly.spread.has(r)), window, releases);
  // The forecast is fitted to the spread series, so it carries a monthly charge's daily rate into the
  // days ahead instead of a spike. The month so far stays as billed.
  const projection = empty ? null : forecast(daily.map((d) => ({ date: d.date, cost: spreadTotal(d) })));
  if (projection) {
    const billedMtd = daily.filter((d) => d.date.startsWith(projection.monthEnd.month)).reduce((a, d) => a + dayTotal(d), 0);
    projection.monthEnd.monthToDate = billedMtd;
    projection.monthEnd.projected = Math.max(projection.monthEnd.projected, billedMtd);
  }
  const candidates = empty ? [] : findCandidates(candidateRows, window);

  const keys = new Set([
    ...(drivers?.items ?? []).map((i) => `${i.provider}|${i.service}`),
    ...anomalies.map((a) => `${a.provider}|${a.service}`),
  ]);

  // 4. Headline.
  const recent = lastNDays(window, 30);
  const last30 = sumSplit(rows, recent.start, recent.end);
  let previous30Total = null;
  let change = null;
  let changePct = null;
  if (window.days >= COMPARE_MIN_DAYS) {
    previous30Total = sumSplit(rows, addDays(recent.start, -30), addDays(recent.start, -1)).total;
    change = last30.total - previous30Total;
    changePct = previous30Total === 0 ? null : (change / previous30Total) * 100;
  }
  const movers = (drivers?.items ?? []).slice(0, 3).map((i) => ({
    provider: i.provider, service: i.service, usageType: i.usageTypes[0]?.usageType || null, change: i.change,
  }));
  const headline = {
    last30, previous30Total, change, changePct, movers,
    largestAnomaly: anomalies[0] ?? null,
    monthEnd: projection?.monthEnd ?? null,
  };
  const sentence = empty ? 'No spend found in this window.' : headlineSentence(headline, currency);

  const aws = results.some((r) => r.name === 'aws')
    ? { billedRequests: awsBilledRequests ?? 0, cost: Math.round((awsBilledRequests ?? 0) * AWS_REQUEST_COST * 100) / 100 }
    : null;

  return {
    schemaVersion: 1,
    tool: { name: 'plutus-scan', version },
    generatedAt,
    window,
    currency,
    excludedCurrencies: picked.excluded,
    sources: results.map((r) => ({ name: r.name, rowCount: r.result.rows.length })),
    notes,
    basis,
    lastCompleteDay: window.end,
    headline: { ...headline, sentence },
    totals,
    daily,
    forecastExtension: projection?.extension ?? [],
    serviceDaily: serviceSeries(rows, days, keys),
    drivers,
    anomalies,
    candidates,
    possibleSavings: possibleSavings(candidates),
    aiProjects: aiByProject(rows),
    untagged: untaggedShare(tagCoverage),
    releases,
    aws,
    empty,
  };
}

/**
 * Cost drivers: which services moved the bill most, 30 days against the 30 before.
 * Adapted from Plutus's private backend (plutus-backend/lib/cost-drivers.js, rankDrivers,
 * commit 8f3e0d23).
 */
import { addDays, lastNDays } from '../model.js';

/** @typedef {import('../model.js').Row} Row */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {{ usageType: string, current: number, previous: number, change: number }} UsageTypeItem */
/** @typedef {{ provider: string, kind: import('../model.js').Kind, service: string, current: number, previous: number,
 *   change: number, sharePct: number, usageTypes: UsageTypeItem[] }} DriverItem */
/** @typedef {{ current: { start: string, end: string }, previous: { start: string, end: string },
 *   totalCurrent: number, totalPrevious: number, items: DriverItem[] }} Drivers */

export const DRIVERS_MIN_DAYS = 60;
const PERIOD_DAYS = 30;
const USAGE_TYPE_LIMIT = 3;

/**
 * Sum rows into groups keyed by `keyOf`, split by period.
 * @param {Row[]} rows
 * @param {{ start: string, end: string }} current
 * @param {{ start: string, end: string }} previous
 * @param {(r: Row) => string} keyOf
 */
function groupByPeriod(rows, current, previous, keyOf) {
  /** @type {Map<string, { current: number, previous: number, first: Row }>} */
  const groups = new Map();
  for (const r of rows) {
    const inCur = r.date >= current.start && r.date <= current.end;
    const inPrev = r.date >= previous.start && r.date <= previous.end;
    if (!inCur && !inPrev) continue;
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { current: 0, previous: 0, first: r }));
    if (inCur) g.current += r.cost;
    else g.previous += r.cost;
  }
  return groups;
}

/** @param {{ change: number }} a @param {{ change: number }} b */
const byMagnitude = (a, b) => Math.abs(b.change) - Math.abs(a.change);

/**
 * @param {Row[]} rows
 * @param {Window} window
 * @returns {{ current: {start:string,end:string}, previous: {start:string,end:string}, items: DriverItem[] }}
 */
function rankAll(rows, window) {
  const current = lastNDays(window, PERIOD_DAYS);
  const previous = { start: addDays(current.start, -PERIOD_DAYS), end: addDays(current.start, -1) };
  // Kind is part of the key, so commitment spend never merges with usage of the same service.
  const groups = groupByPeriod(rows, current, previous, (r) => `${r.provider}\0${r.kind}\0${r.service}`);
  /** @type {DriverItem[]} */
  const items = [];
  for (const g of groups.values()) {
    const change = g.current - g.previous;
    if (change === 0) continue;
    items.push({
      provider: g.first.provider, kind: g.first.kind, service: g.first.service,
      current: g.current, previous: g.previous, change, sharePct: 0, usageTypes: [],
    });
  }
  items.sort((a, b) => byMagnitude(a, b)
    || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0)
    || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0)
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return { current, previous, items };
}

/**
 * Rank services by absolute change between the last 30 days and the 30 before.
 * @param {Row[]} rows
 * @param {Window} window
 * @param {{ detailRows?: Row[], limit?: number }} [opts]
 * @returns {Drivers|null} null when the window is shorter than DRIVERS_MIN_DAYS
 */
export function rankDrivers(rows, window, { detailRows = [], limit = 10 } = {}) {
  if (window.days < DRIVERS_MIN_DAYS) return null;
  const { current, previous, items } = rankAll(rows, window);
  const totalAbs = items.reduce((s, i) => s + Math.abs(i.change), 0);
  for (const i of items) {
    i.sharePct = totalAbs > 0 ? Math.round((Math.abs(i.change) / totalAbs) * 1000) / 10 : 0;
  }
  const top = items.slice(0, limit);
  const usage = groupByPeriod(detailRows, current, previous,
    (r) => `${r.provider}\0${r.kind}\0${r.service}\0${r.usageType ?? ''}`);
  for (const item of top) {
    const prefix = `${item.provider}\0${item.kind}\0${item.service}\0`;
    /** @type {UsageTypeItem[]} */
    const types = [];
    for (const [key, g] of usage) {
      if (!key.startsWith(prefix)) continue;
      const change = g.current - g.previous;
      if (change === 0) continue;
      types.push({ usageType: key.slice(prefix.length), current: g.current, previous: g.previous, change });
    }
    types.sort((a, b) => byMagnitude(a, b) || (a.usageType < b.usageType ? -1 : 1));
    item.usageTypes = types.slice(0, USAGE_TYPE_LIMIT);
  }
  let totalCurrent = 0;
  let totalPrevious = 0;
  for (const r of rows) {
    if (r.date >= current.start && r.date <= current.end) totalCurrent += r.cost;
    else if (r.date >= previous.start && r.date <= previous.end) totalPrevious += r.cost;
  }
  return { current, previous, totalCurrent, totalPrevious, items: top };
}

/**
 * The first n (provider, service) pairs of the change ranking. Works with whatever history exists.
 * @param {Row[]} rows @param {Window} window @param {number} n
 * @returns {{ provider: string, service: string }[]}
 */
export function topServicesByChange(rows, window, n) {
  return rankAll(rows, window).items.slice(0, n).map((i) => ({ provider: i.provider, service: i.service }));
}

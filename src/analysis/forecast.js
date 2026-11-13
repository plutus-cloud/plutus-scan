// Adapted from Plutus's private backend (plutus-backend/lib/forecast.js, commit 8f3e0d23).
// fitModel and projectPeriodTotal are copied unchanged apart from the module format (ESM exports instead of module.exports).
// Dropped as server-only: PROJECTION_METHOD (budget-alert versioning) and the header comment on
// the golden fixture. The forecast() wrapper at the bottom is new.

import { addDays } from '../model.js';

// The projection model: a damped linear trend with weekly seasonality once there are three full
// weeks of data. Only the daily grain is exercised, but the cycle table is kept whole so the port
// stays diffable against the original. The original comment block describing the Plutus golden
// fixture and budget alerts is omitted because those parts do not exist here.

const CYCLE_LENGTH = { hour: 24, day: 7, month: 12, quarter: 4 };
const MIN_SEASONAL_CYCLES = 3;
const TREND_WINDOW = 12;

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function fitLinear(values) {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fitted = intercept + slope * i;
    ssRes += (values[i] - fitted) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

function dampingFactor(r2) {
  return 0.75 + 0.23 * r2;
}

function dampedTrendSum(phi, h) {
  if (phi >= 1) return h;
  return (phi * (1 - phi ** h)) / (1 - phi);
}

function centeredMovingAverage(values, period) {
  const result = new Array(values.length).fill(undefined);
  if (period % 2 === 1) {
    const half = (period - 1) / 2;
    for (let i = half; i < values.length - half; i++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) sum += values[i + k];
      result[i] = sum / period;
    }
    return result;
  }
  const half = period / 2;
  for (let i = half; i < values.length - half; i++) {
    let sum1 = 0;
    let sum2 = 0;
    for (let k = -half; k < half; k++) sum1 += values[i + k];
    for (let k = -half + 1; k <= half; k++) sum2 += values[i + k];
    result[i] = (sum1 + sum2) / (2 * period);
  }
  return result;
}

function computeSeasonalIndices(values, cycleLength) {
  if (values.length < cycleLength * MIN_SEASONAL_CYCLES) return null;
  const trend = centeredMovingAverage(values, cycleLength);
  const sums = new Array(cycleLength).fill(0);
  const counts = new Array(cycleLength).fill(0);
  for (let i = 0; i < values.length; i++) {
    const t = trend[i];
    if (t === undefined) continue;
    const phase = i % cycleLength;
    sums[phase] += values[i] - t;
    counts[phase]++;
  }
  if (counts.some((c) => c === 0)) return null;
  const indices = sums.map((s, i) => s / counts[i]);
  const meanIndex = mean(indices);
  return indices.map((v) => v - meanIndex);
}

export function fitModel(values, groupBy) {
  const n = values.length;
  if (n < 2) {
    const v = values[0] ?? 0;
    return { method: 'naive', forecast: () => v };
  }

  const cycleLength = CYCLE_LENGTH[groupBy];
  const seasonalIndices = cycleLength ? computeSeasonalIndices(values, cycleLength) : null;
  const deseasonalized = seasonalIndices
    ? values.map((v, i) => v - seasonalIndices[i % cycleLength])
    : values;

  const trendWindow = deseasonalized.slice(-TREND_WINDOW);
  const { slope, intercept, r2 } = fitLinear(trendWindow);
  const level = intercept + slope * (trendWindow.length - 1);
  const phi = dampingFactor(r2);

  return {
    method: seasonalIndices ? 'seasonal-damped-trend' : 'damped-trend',
    forecast(h) {
      const trended = level + slope * dampedTrendSum(phi, h);
      const seasonal = seasonalIndices ? seasonalIndices[(n - 1 + h) % cycleLength] : 0;
      return Math.max(0, trended + seasonal);
    },
  };
}

// ── Period-total projection (port of forecast.ts's projectPeriodTotal) ─────────────────────

const PROJECTION_HISTORY_DAYS = 56;
const DAY_MS = 86_400_000;

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDayStart(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// `input` is { daily: { 'YYYY-MM-DD': number }, periodStart: Date, periodEnd: Date, now: Date }.
// See the doc comment on forecast.ts's projectPeriodTotal for the semantics of every step.
export function projectPeriodTotal(input) {
  const periodStartMs = utcDayStart(input.periodStart);
  const periodEndMs = utcDayStart(input.periodEnd);
  const totalDays = Math.max(0, Math.round((periodEndMs - periodStartMs) / DAY_MS));
  const historyStartKey = dayKey(periodStartMs - PROJECTION_HISTORY_DAYS * DAY_MS);
  const periodEndKey = dayKey(periodEndMs);

  const keys = Object.keys(input.daily)
    .filter((k) => k >= historyStartKey && k < periodEndKey)
    .sort();
  if (keys.length === 0) {
    return { projectedTotal: 0, actualToDate: 0, method: 'none', daysRemaining: totalDays };
  }

  const firstMs = Date.parse(`${keys[0]}T00:00:00Z`);
  const lastMs = Date.parse(`${keys[keys.length - 1]}T00:00:00Z`);
  const completeEndMs = Math.max(
    periodStartMs,
    Math.min(utcDayStart(input.now), lastMs + DAY_MS, periodEndMs),
  );

  const series = [];
  let actualToDate = 0;
  for (let ms = firstMs; ms < completeEndMs; ms += DAY_MS) {
    const v = input.daily[dayKey(ms)] ?? 0;
    series.push(v);
    if (ms >= periodStartMs) actualToDate += v;
  }

  const daysRemaining = Math.max(0, Math.round((periodEndMs - completeEndMs) / DAY_MS));
  if (daysRemaining === 0) {
    return { projectedTotal: Math.max(0, actualToDate), actualToDate, method: 'complete', daysRemaining };
  }

  const model = fitModel(series, 'day');
  let forecast = 0;
  for (let h = 1; h <= daysRemaining; h++) forecast += model.forecast(h);
  return {
    projectedTotal: Math.max(0, actualToDate + forecast),
    actualToDate,
    method: model.method,
    daysRemaining,
  };
}


export const FORECAST_MIN_DAYS = 14;

/**
 * Month-end projection and a short forecast extension for a daily cost series.
 * @param {{ date: string, cost: number }[]} dailyTotals sorted ascending, one entry per day
 * @param {{ extensionDays?: number }} [opts]
 * @returns {{ method: string, monthEnd: { month: string, monthToDate: number, projected: number },
 *   extension: { date: string, value: number }[] } | null}
 */
export function forecast(dailyTotals, { extensionDays = 14 } = {}) {
  if (dailyTotals.length < FORECAST_MIN_DAYS) return null;
  const lastDay = dailyTotals[dailyTotals.length - 1].date;
  const month = lastDay.slice(0, 7);
  const [y, m] = month.split('-').map(Number);

  /** @type {Record<string, number>} */
  const daily = {};
  let monthToDate = 0;
  for (const d of dailyTotals) {
    daily[d.date] = d.cost;
    if (d.date.startsWith(month)) monthToDate += d.cost;
  }

  // Period is [first of month, first of next month); "now" is the day after the last day with data.
  const periodStart = new Date(Date.UTC(y, m - 1, 1));
  const periodEnd = new Date(Date.UTC(y, m, 1));
  const now = new Date(`${addDays(lastDay, 1)}T00:00:00Z`);
  const { projectedTotal } = projectPeriodTotal({ daily, periodStart, periodEnd, now });

  const model = fitModel(dailyTotals.map((d) => d.cost), 'day');
  const extension = [];
  for (let h = 1; h <= extensionDays; h++) {
    extension.push({ date: addDays(lastDay, h), value: Math.max(0, model.forecast(h)) });
  }
  return { method: model.method, monthEnd: { month, monthToDate, projected: projectedTotal }, extension };
}

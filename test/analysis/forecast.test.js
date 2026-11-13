import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast, FORECAST_MIN_DAYS } from '../../src/analysis/forecast.js';
import { addDays } from '../../src/model.js';

/** @param {string} start @param {number} n @param {(i: number) => number} fn */
const series = (start, n, fn) =>
  Array.from({ length: n }, (_, i) => ({ date: addDays(start, i), cost: fn(i) }));

test('flat series projects flat', () => {
  const daily = series('2026-10-01', 20, () => 10); // through 2026-10-20
  const f = forecast(daily);
  assert.ok(f);
  assert.equal(f.monthEnd.monthToDate, 200);
  assert.ok(Math.abs(f.monthEnd.projected - 310) < 1e-6);
  for (const e of f.extension) assert.ok(Math.abs(e.value - 10) < 1e-6);
});

test('monthEnd covers the month containing the last day', () => {
  const daily = series('2026-09-20', 20, () => 5); // 2026-09-20 .. 2026-10-09
  const f = forecast(daily);
  assert.ok(f);
  assert.equal(f.monthEnd.month, '2026-10');
  assert.equal(f.monthEnd.monthToDate, 45); // 9 October days
  assert.ok(Math.abs(f.monthEnd.projected - 155) < 1e-6); // 31 days * 5
});

test('extension has 14 days after the last day', () => {
  const daily = series('2026-10-01', 20, (i) => i); // rising
  const f = forecast(daily);
  assert.ok(f);
  assert.equal(f.extension.length, 14);
  assert.equal(f.extension[0].date, '2026-10-21');
  assert.equal(f.extension[13].date, '2026-11-03');
  assert.ok(f.extension.every((e) => e.value >= 0));
  assert.equal(typeof f.method, 'string');
  assert.equal(forecast(daily, { extensionDays: 3 })?.extension.length, 3);
});

test('null under 14 days', () => {
  assert.equal(FORECAST_MIN_DAYS, 14);
  assert.equal(forecast(series('2026-10-01', 13, () => 1)), null);
  assert.ok(forecast(series('2026-10-01', 14, () => 1)));
});

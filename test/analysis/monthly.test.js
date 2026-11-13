import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadMonthly, daysInMonth } from '../../src/analysis/monthly.js';
import { computeWindow, eachDay, emptyResult } from '../../src/model.js';
import { buildReport } from '../../src/report/data.js';

/** @returns {import('../../src/model.js').Row} */
const row = (date, service, cost, extra = {}) => ({
  date, provider: 'aws', kind: 'cloud', service, account: null, project: null, usageType: null, cost, currency: 'USD', ...extra,
});
const sumOf = (portions, kind) => [...portions.values()].reduce((a, p) => a + p[kind], 0);

test('daysInMonth', () => {
  assert.deepEqual(['2026-02-01', '2028-02-01', '2026-09-01', '2026-10-01'].map(daysInMonth), [28, 29, 30, 31]);
});

test('a monthly charge is spread evenly over its month and adds back to what was billed', () => {
  const window = computeWindow({ days: 60, end: '2026-10-30' });
  const tax = row('2026-09-01', 'Tax', 13500, { monthly: true });
  const { spread, billed, portions } = spreadMonthly([tax], window);
  assert.ok(spread.has(tax));
  assert.deepEqual(billed.get('2026-09-01'), { cloud: 13500, commitment: 0, ai: 0 });
  const sept = eachDay({ start: '2026-09-01', end: '2026-09-30', days: 30 });
  assert.ok(sept.every((d) => Math.abs(portions.get(d).cloud - 450) < 1e-9));
  assert.ok(Math.abs(sumOf(portions, 'cloud') - 13500) < 1e-6);
});

test('in the month the window ends in, only the days so far get their share', () => {
  const window = computeWindow({ days: 30, end: '2026-10-10' });
  const fee = row('2026-10-01', 'EC2 reservations', 3100, { kind: 'commitment', monthly: true });
  const { portions } = spreadMonthly([fee], window);
  assert.equal(portions.size, 10);
  assert.ok(Math.abs(sumOf(portions, 'commitment') - 1000) < 1e-6, 'ten 31sts of the fee; the rest goes to the forecast');
});

test('a series billed only on the 1st in two or more months is spread without a mark', () => {
  const window = computeWindow({ days: 90, end: '2026-10-28' });
  const support = ['2026-09-01', '2026-10-01'].map((d) => row(d, 'AWS Support (Business)', 900));
  assert.equal(spreadMonthly(support, window).spread.size, 2);
  // Once, in one month, is not enough to tell a monthly charge from a one-off.
  assert.equal(spreadMonthly([row('2026-10-01', 'Amazon EC2 purchases', 2400, { kind: 'commitment' })], window).spread.size, 0);
});

test('a marked RI fee is spread even when a mid-month purchase adds a prorated fee on another day', () => {
  // The shape Cost Explorer gives: the month's recurring fee on the 1st, a small prorated fee when an
  // instance is bought mid-month, both under the same "reservations" service, with no usage type.
  const window = computeWindow({ days: 60, end: '2026-10-30' });
  const ri = { kind: 'commitment', monthly: true };
  const fee = row('2026-10-01', 'Amazon Elastic Compute Cloud - Compute reservations', 10200, ri);
  const prorated = row('2026-10-14', 'Amazon Elastic Compute Cloud - Compute reservations', 190, { kind: 'commitment' });
  const { spread, portions } = spreadMonthly([fee, prorated], window);
  assert.ok(spread.has(fee));
  assert.ok(!spread.has(prorated), 'the prorated fee stays on its day');
  assert.ok(Math.abs(sumOf(portions, 'commitment') - 10200 * 30 / 31) < 1e-6);
});

test('a charge that also bills on other days of the month, and a credit, stay as billed', () => {
  const window = computeWindow({ days: 60, end: '2026-10-28' });
  const daily = eachDay(window).map((d) => row(d, 'Savings Plans', 140, { kind: 'commitment', monthly: d.endsWith('-01') ? true : undefined }));
  assert.equal(spreadMonthly(daily, window).spread.size, 0);
  assert.equal(spreadMonthly([row('2026-10-01', 'Tax', -50, { monthly: true })], window).spread.size, 0);
});

test('tax and RI fees on the 1st are no anomaly, and a real spike right after is still found', () => {
  const window = computeWindow({ days: 90, end: '2026-10-28' });
  const result = emptyResult();
  for (const d of eachDay(window)) {
    result.rows.push(row(d, 'EC2', d === '2026-10-02' ? 4200 : 2800));
    if (d.endsWith('-01')) {
      result.rows.push(row(d, 'Tax', 13500, { monthly: true }));
      result.rows.push(row(d, 'EC2 reservations', 9000, { kind: 'commitment', monthly: true }));
    }
  }
  const report = buildReport({ window, results: [{ name: 'aws', result }], version: '0.1.0', generatedAt: 'x' });
  assert.deepEqual(report.anomalies.map((a) => [a.date, a.service]), [['2026-10-02', 'EC2']]);
  // Totals stay as billed.
  assert.equal(report.totals.total, 2800 * 90 + 1400 + 3 * (13500 + 9000));
});

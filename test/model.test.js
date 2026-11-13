import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  computeWindow, addDays, eachDay, lastNDays, clampToWindow, pickCurrency,
  emptyResult, formatMoney, UsageError,
} from '../src/model.js';

const modelUrl = new URL('../src/model.js', import.meta.url).href;

test('computeWindow defaults end to today minus 2 days', () => {
  const w = computeWindow({ today: new Date('2026-10-30T10:00:00Z') });
  assert.deepEqual(w, { start: '2026-07-31', end: '2026-10-28', days: 90 });
});

test('computeWindow honours an explicit end', () => {
  const w = computeWindow({ days: 3, end: '2026-03-01' });
  assert.deepEqual(w, { start: '2026-02-27', end: '2026-03-01', days: 3 });
});

test('computeWindow rejects days over 395', () => {
  assert.throws(() => computeWindow({ days: 396 }), UsageError);
  assert.throws(() => computeWindow({ days: 0 }), UsageError);
  assert.throws(() => computeWindow({ days: 1.5 }), UsageError);
  assert.doesNotThrow(() => computeWindow({ days: 395 }));
});

test('computeWindow is TZ independent', () => {
  const code = `import(${JSON.stringify(modelUrl)}).then(m => console.log(JSON.stringify(
    m.computeWindow({ today: new Date('2026-10-30T23:30:00Z') }))))`;
  const r = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8', env: { ...process.env, TZ: 'Pacific/Auckland' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).end, '2026-10-28');
});

test('date helpers', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  const w = { start: '2026-01-30', end: '2026-02-02', days: 4 };
  assert.deepEqual(eachDay(w), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  assert.deepEqual(lastNDays(w, 2), { start: '2026-02-01', end: '2026-02-02' });
});

test('clampToWindow keeps rows inside the window inclusive', () => {
  const w = { start: '2026-01-02', end: '2026-01-04', days: 3 };
  const rows = ['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05'].map((date) => ({ date }));
  assert.deepEqual(clampToWindow(rows, w).map((r) => r.date), ['2026-01-02', '2026-01-04']);
});

test('pickCurrency keeps the dominant currency', () => {
  const rows = [{ cost: 100, currency: 'USD' }, { cost: 5, currency: 'EUR' }];
  const r = pickCurrency(rows);
  assert.equal(r.currency, 'USD');
  assert.deepEqual(r.rows, [rows[0]]);
  assert.deepEqual(r.excluded, { EUR: 5 });
});

test('pickCurrency uses absolute totals and handles empty input', () => {
  const r = pickCurrency([{ cost: 10, currency: 'USD' }, { cost: -50, currency: 'EUR' }]);
  assert.equal(r.currency, 'EUR');
  assert.deepEqual(pickCurrency([]), { currency: null, rows: [], excluded: {} });
});

test('emptyResult returns empty arrays', () => {
  assert.deepEqual(emptyResult(), {
    rows: [], detailRows: [], tagCoverage: [], releases: [], notes: [], basis: [],
  });
  assert.notEqual(emptyResult().rows, emptyResult().rows);
});

test('formatMoney rounds by size', () => {
  assert.equal(formatMoney(12340.4, 'USD'), '$12,340');
  assert.equal(formatMoney(12.345, 'USD'), '$12.35');
  assert.equal(formatMoney(-1610, 'USD'), '-$1,610');
  assert.equal(formatMoney(100, 'USD'), '$100');
  assert.equal(formatMoney(99.99, 'USD'), '$99.99');
  assert.equal(formatMoney(-0.001, 'USD'), '$0.00');
  assert.equal(formatMoney(-50.5, 'EUR'), '-€50.50');
  assert.equal(formatMoney(2000, 'GBP'), '£2,000');
  assert.equal(formatMoney(2000, 'JPY'), 'JPY 2,000');
});

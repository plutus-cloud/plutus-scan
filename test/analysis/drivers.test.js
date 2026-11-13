import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankDrivers, topServicesByChange, DRIVERS_MIN_DAYS } from '../../src/analysis/drivers.js';
import { computeWindow } from '../../src/model.js';

const window = computeWindow({ days: 60, end: '2026-10-28' });
// current: 2026-09-29..2026-10-28, previous: 2026-08-30..2026-09-28
const CUR = '2026-10-10';
const PREV = '2026-09-10';

/** @returns {import('../../src/model.js').Row} */
const row = (date, service, cost, extra = {}) => ({
  date, provider: 'aws', kind: 'cloud', service, account: null, project: null,
  usageType: null, cost, currency: 'USD', ...extra,
});

test('ranks services by absolute 30-day change', () => {
  const rows = [
    row(PREV, 'EC2', 100), row(CUR, 'EC2', 400),
    row(PREV, 'S3', 50), row(CUR, 'S3', 60),
    row(PREV, 'RDS', 200), row(CUR, 'RDS', 150),
    row(PREV, 'Flat', 10), row(CUR, 'Flat', 10),
  ];
  const d = rankDrivers(rows, window);
  assert.deepEqual(d.current, { start: '2026-09-29', end: '2026-10-28' });
  assert.deepEqual(d.previous, { start: '2026-08-30', end: '2026-09-28' });
  assert.equal(d.totalCurrent, 620);
  assert.equal(d.totalPrevious, 360);
  assert.deepEqual(d.items.map((i) => i.service), ['EC2', 'RDS', 'S3']);
  assert.equal(d.items[0].change, 300);
  assert.equal(d.items[0].sharePct, 83.3);
  assert.equal(d.items[1].change, -50);
  assert.equal(d.items[1].sharePct, 13.9);
  assert.equal(d.items[0].kind, 'cloud');
  assert.deepEqual(d.items[0].usageTypes, []);
});

test('drivers rank by absolute change with negative rows', () => {
  const rows = [
    row(PREV, 'EC2', 100), row(CUR, 'EC2', 130),
    row(PREV, 'Credits', 0), row(CUR, 'Credits', -500),
    row(CUR, 'Credits', 100),
  ];
  const d = rankDrivers(rows, window);
  assert.equal(d.items[0].service, 'Credits');
  assert.equal(d.items[0].current, -400);
  assert.equal(d.items[0].change, -400);
  assert.equal(d.totalCurrent, -270);
  assert.deepEqual(topServicesByChange(rows, window, 1), [{ provider: 'aws', service: 'Credits' }]);
});

test('attaches top usage types from detail rows', () => {
  const rows = [row(PREV, 'EC2', 100), row(CUR, 'EC2', 400), row(CUR, 'S3', 10)];
  const detailRows = [
    row(PREV, 'EC2', 10, { usageType: 'BoxUsage' }), row(CUR, 'EC2', 200, { usageType: 'BoxUsage' }),
    row(CUR, 'EC2', 100, { usageType: 'DataTransfer' }),
    row(PREV, 'EC2', 50, { usageType: 'EBS' }), row(CUR, 'EC2', 40, { usageType: 'EBS' }),
    row(CUR, 'EC2', 5, { usageType: 'Tiny' }),
    row(PREV, 'EC2', 7, { usageType: 'Same' }), row(CUR, 'EC2', 7, { usageType: 'Same' }),
    row(CUR, 'S3', 99, { usageType: 'Other' }),
    row(CUR, 'EC2', 99, { usageType: 'Other', provider: 'gcp' }),
  ];
  const d = rankDrivers(rows, window, { detailRows });
  const ec2 = d.items.find((i) => i.service === 'EC2');
  assert.deepEqual(ec2.usageTypes, [
    { usageType: 'BoxUsage', current: 200, previous: 10, change: 190 },
    { usageType: 'DataTransfer', current: 100, previous: 0, change: 100 },
    { usageType: 'EBS', current: 40, previous: 50, change: -10 },
  ]);
});

test('null under 60 days', () => {
  assert.equal(DRIVERS_MIN_DAYS, 60);
  assert.equal(rankDrivers([row(CUR, 'EC2', 1)], computeWindow({ days: 59, end: '2026-10-28' })), null);
});

test('limit and zero-sum behaviour', () => {
  const rows = [row(PREV, 'A', 5), row(CUR, 'A', 5)];
  assert.deepEqual(rankDrivers(rows, window).items, []);
  const many = ['A', 'B', 'C'].flatMap((s, i) => [row(CUR, s, 10 * (i + 1))]);
  assert.equal(rankDrivers(many, window, { limit: 2 }).items.length, 2);
  assert.deepEqual(topServicesByChange(many, computeWindow({ days: 30, end: '2026-10-28' }), 2).map((s) => s.service), ['C', 'B']);
});

test('a commitment row never merges with usage of the same service', () => {
  const rows = [
    row(PREV, 'EC2', 100), row(CUR, 'EC2', 150),
    row(CUR, 'EC2', 300, { kind: 'commitment' }),
  ];
  const detailRows = [
    row(PREV, 'EC2', 100, { usageType: 'BoxUsage' }), row(CUR, 'EC2', 150, { usageType: 'BoxUsage' }),
    row(CUR, 'EC2', 300, { kind: 'commitment', usageType: 'RIFee' }),
  ];
  const d = rankDrivers(rows, window, { detailRows });
  assert.deepEqual(d.items.map((i) => [i.kind, i.service, i.current, i.previous, i.change]), [
    ['commitment', 'EC2', 300, 0, 300],
    ['cloud', 'EC2', 150, 100, 50],
  ]);
  assert.deepEqual(d.items[0].usageTypes.map((u) => u.usageType), ['RIFee']);
  assert.deepEqual(d.items[1].usageTypes.map((u) => u.usageType), ['BoxUsage']);
});

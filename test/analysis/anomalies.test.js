import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomalies, nearestRelease, ANOMALY_MIN_DAYS, ANOMALY_LIMIT } from '../../src/analysis/anomalies.js';
import { computeWindow, addDays, eachDay } from '../../src/model.js';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';

const WIN = computeWindow({ days: 30, end: '2026-10-28' });

/** @returns {import('../../src/model.js').Row} */
const row = (date, service, cost, provider = 'aws') => ({
  date, provider, kind: 'cloud', service, account: null, project: null, usageType: null, cost, currency: 'USD',
});

/** A flat series over every day of the window. */
const flat = (service, cost, window = WIN, provider = 'aws') => eachDay(window).map((d) => row(d, service, cost, provider));

test('flags the seeded spike in the synthetic fixture and nothing else', async () => {
  const window = { start: '2026-07-31', end: '2026-10-28', days: 90 };
  const transport = createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
  const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
  const { rows } = await fetchFocus(transport, { paths: [fixture], window });

  const found = detectAnomalies(rows, window);
  assert.equal(found.length, 1);
  const [a] = found;
  assert.equal(a.date, '2026-10-13');
  assert.equal(a.provider, 'aws');
  assert.equal(a.service, 'Amazon Elastic Compute Cloud');
  assert.equal(a.cost, 777.6);

  // Baseline: mean of the four prior Tuesdays (2026-10-13 is day i=74, so i = 67, 60, 53, 46),
  // each round2(200 * (1 + 0.004 * i)): 253.60, 248.00, 242.40, 236.80.
  // (253.60 + 248.00 + 242.40 + 236.80) / 4 = 980.80 / 4 = 245.20.
  assert.equal(a.baseline, 245.2);
  // Delta: 777.60 - 245.20 = 532.40. Percent: 532.40 / 245.20 = 217.1%, rounded 217.
  assert.equal(a.delta, 532.4);
  assert.equal(a.deltaPct, 217);
  // Floor: the 8 days before (i = 66..73) have a median daily total of about 485 * 1.278 = 619.8,
  // and 2% of that is about 12.40, inside the $10..$500 clamp. High needs 10 x 12.40 = 124,
  // medium needs 3 x 12.40 = 37.20. A delta of 532.40 is above 124, so the severity is high.
  assert.equal(a.severity, 'high');
  assert.equal(a.release, null);
});

test('ignores a 60% rise below the absolute floor', () => {
  // Daily total 10 + 1000 = 1010, so the relative floor is 2% = 20.20 dollars.
  // Small service goes 10 -> 16: up 60% but only 6 dollars.
  const rows = [...flat('Big', 1000), ...flat('Small', 10).filter((r) => r.date !== '2026-10-20'), row('2026-10-20', 'Small', 16)];
  assert.deepEqual(detectAnomalies(rows, WIN), []);
  // Same rise at a size that clears the floor is flagged: 100 -> 160 is +60 over a 20.20 floor.
  const rows2 = [...flat('Big', 1000), ...flat('Med', 100).filter((r) => r.date !== '2026-10-20'), row('2026-10-20', 'Med', 160)];
  const found = detectAnomalies(rows2, WIN);
  assert.equal(found.length, 1);
  assert.equal(found[0].service, 'Med');
  assert.equal(found[0].deltaPct, 60);
});

test('uses the same-weekday baseline when 4 occurrences exist', () => {
  // 2026-10-27 is a Tuesday. Prior four Tuesdays (10-20, 10-13, 10-06, 09-29) cost 200 each,
  // every other day 50. A flat baseline would be about 50 and make 210 a huge spike;
  // the same-weekday baseline of 200 makes it +5%.
  const rows = [row('2026-10-28', 'Svc', 50)];
  for (const d of eachDay(WIN)) {
    if (d === '2026-10-28') continue;
    const tuesday = new Date(`${d}T00:00:00Z`).getUTCDay() === 2;
    rows.push(row(d, 'Svc', d === '2026-10-27' ? 210 : tuesday ? 200 : 50));
  }
  assert.deepEqual(detectAnomalies(rows, WIN).filter((a) => a.date === '2026-10-27'), []);

  // With a spike on top of the Tuesday level it is measured against 200.
  const spiked = rows.map((r) => (r.date === '2026-10-27' ? { ...r, cost: 400 } : r));
  const found = detectAnomalies(spiked, WIN).filter((a) => a.date === '2026-10-27');
  assert.equal(found.length, 1);
  assert.equal(found[0].baseline, 200);
  assert.equal(found[0].delta, 200);
  assert.equal(found[0].deltaPct, 100);
});

test('caps at 10 ranked by dollars', () => {
  // 12 services flat at 100, each spiking to 100 + 10*k on the last day (k = 1..12) would be
  // under 50%, so use 100 -> 200 + 10*k.
  const rows = [];
  for (let k = 1; k <= 12; k += 1) {
    for (const d of eachDay(WIN)) {
      rows.push(row(d, `S${String(k).padStart(2, '0')}`, d === '2026-10-28' ? 200 + 10 * k : 100));
    }
  }
  const found = detectAnomalies(rows, WIN);
  assert.equal(found.length, ANOMALY_LIMIT);
  assert.equal(found.length, 10);
  assert.deepEqual(found.map((a) => a.service), ['S12', 'S11', 'S10', 'S09', 'S08', 'S07', 'S06', 'S05', 'S04', 'S03']);
  for (let i = 1; i < found.length; i += 1) assert.ok(found[i - 1].delta >= found[i].delta);
});

test('nearestRelease picks the latest within 2 days before', () => {
  const rel = (date, name) => ({ date, repo: 'o/r', name, url: `https://github.com/o/r/releases/${name}` });
  const releases = [rel('2026-10-10', 'a'), rel('2026-10-11', 'b'), rel('2026-10-13', 'c'), rel('2026-10-14', 'd')];
  assert.equal(nearestRelease('2026-10-13', releases).name, 'c');
  assert.equal(nearestRelease('2026-10-12', releases).name, 'b');
  assert.equal(nearestRelease('2026-10-13', [rel('2026-10-11', 'b'), rel('2026-10-12', 'x')]).name, 'x');
  assert.equal(nearestRelease('2026-10-13', [rel('2026-10-10', 'a'), rel('2026-10-14', 'd')]), null);
  assert.equal(nearestRelease('2026-10-13', []), null);

  const rows = flat('Svc', 100).map((r) => (r.date === '2026-10-20' ? { ...r, cost: 400 } : r));
  const found = detectAnomalies(rows, WIN, [rel('2026-10-19', 'v1'), rel('2026-10-25', 'later')]);
  assert.equal(found[0].release.name, 'v1');
});

test('returns nothing under 8 days', () => {
  assert.equal(ANOMALY_MIN_DAYS, 8);
  const win = computeWindow({ days: 7, end: '2026-10-28' });
  const rows = flat('Svc', 100, win).map((r) => (r.date === win.end ? { ...r, cost: 900 } : r));
  assert.deepEqual(detectAnomalies(rows, win), []);
  // At exactly 8 days the same shape is judged (7 prior days, flat baseline).
  const win8 = computeWindow({ days: 8, end: '2026-10-28' });
  const rows8 = flat('Svc', 100, win8).map((r) => (r.date === win8.end ? { ...r, cost: 900 } : r));
  assert.equal(detectAnomalies(rows8, win8).length, 1);
  assert.equal(addDays(win8.start, 7), win8.end);
});

test('a reserved instance fee on the 1st of each month is not an anomaly', () => {
  const window = computeWindow({ days: 90, end: '2026-10-28' });
  const usage = flat('Amazon Elastic Compute Cloud - Compute', 100, window);
  // Same service name as the usage, as Cost Explorer reported it before record types were split out.
  const fee = (kind) => ['2026-08-01', '2026-09-01', '2026-10-01'].map((d) => ({
    ...row(d, 'Amazon Elastic Compute Cloud - Compute', 3000), kind }));
  assert.deepEqual(detectAnomalies([...usage, ...fee('commitment')], window), []);
  // The same fee counted as usage is flagged high, so the test above is not vacuous
  // (2026-08-01 is the window's second day, too early to have a baseline).
  const asUsage = detectAnomalies([...usage, ...fee('cloud')], window);
  assert.deepEqual(asUsage.map((a) => [a.date, a.severity]), [['2026-09-01', 'high'], ['2026-10-01', 'high']]);
});

/**
 * A synthetic account shaped like a real one: steady usage of about $2,800 a day, a commitment
 * and a usage-classified fee of about $20k on the 1st of each month, and one service that runs
 * high for most of a week. Returns the rows and the days the elevated service runs high.
 */
function monthStartAccount() {
  const window = computeWindow({ days: 90, end: '2026-10-29' });
  const high = new Map([['2026-10-12', 690], ['2026-10-13', 580], ['2026-10-14', 330], ['2026-10-15', 460]]);
  const rows = [];
  for (const d of eachDay(window)) {
    const first = d.endsWith('-01');
    rows.push(row(d, 'Compute', high.get(d) ?? 300));
    rows.push(row(d, 'Database', 900));
    rows.push(row(d, 'Storage', 500));
    rows.push(row(d, 'Upfront fees', first ? 15000 : 0));
    rows.push({ ...row(d, 'Savings Plans', first ? 10000 : 1000), kind: 'commitment' });
  }
  return { window, rows };
}

test('consecutive flagged days of one service are one episode', () => {
  const { window, rows } = monthStartAccount();
  const found = detectAnomalies(rows, window);
  const compute = found.filter((a) => a.service === 'Compute');
  // 10-12, 10-13 and 10-15 each clear 50% over the 300 baseline, 10-14 (+10%) does not.
  // A single unflagged day does not split the run, so this is one anomaly, not three.
  assert.equal(compute.length, 1);
  const [a] = compute;
  assert.equal(a.start, '2026-10-12');
  assert.equal(a.end, '2026-10-15');
  // The peak day carries the headline numbers.
  assert.equal(a.date, '2026-10-12');
  assert.equal(a.cost, 690);
  assert.equal(a.baseline, 300);
  assert.equal(a.delta, 390);
  assert.deepEqual(a.flaggedDays.map((f) => f.date), ['2026-10-12', '2026-10-13', '2026-10-15']);
  // Excess over the episode: 390 + 280 + 160.
  assert.equal(a.excess, 830);
  // The day's non-commitment spend on the peak day: 690 + 900 + 500.
  assert.equal(a.dayTotal, 2090);
});

test('a gap of two unflagged days starts a new episode', () => {
  const rows = flat('Svc', 100).map((r) => (['2026-10-20', '2026-10-23'].includes(r.date) ? { ...r, cost: 300 } : r));
  const found = detectAnomalies(rows, WIN);
  assert.deepEqual(found.map((a) => [a.start, a.end]), [['2026-10-20', '2026-10-20'], ['2026-10-23', '2026-10-23']]);
});

test('a fee on the 1st does not raise the floor for the following week', () => {
  // The floor is 2% of the typical daily usage total over the previous 8 days, about $1,760
  // here. A mean over a window holding the $15k fee on 10-01 reads about $3,635 instead, so
  // for a week after each 1st the floor doubles and the same rise drops a severity. The median
  // ignores the fee: +$150 is medium (3 x $35.20 = $105.60) on 10-06 and on 10-20 alike.
  const { window, rows } = monthStartAccount();
  const withCache = (day) => [...rows, ...eachDay(window).map((d) => row(d, 'Cache', d === day ? 210 : 60))];
  const early = detectAnomalies(withCache('2026-10-06'), window).find((a) => a.service === 'Cache');
  const late = detectAnomalies(withCache('2026-10-20'), window).find((a) => a.service === 'Cache');
  assert.equal(early.delta, 150);
  assert.equal(late.delta, 150);
  assert.equal(early.severity, 'medium');
  assert.equal(late.severity, 'medium');
});

test('a credit booked under a service does not lower its baseline and cause a false spike', () => {
  const window = computeWindow({ days: 60, end: '2026-10-28' });
  const usage = flat('Amazon Elastic Compute Cloud - Compute', 400, window);
  // A credit on the same weekday as the last day, two and three weeks before it.
  const credits = ['2026-10-07', '2026-10-14'].map((d) => row(d, 'Amazon Elastic Compute Cloud - Compute', -380));
  assert.deepEqual(detectAnomalies([...usage, ...credits], window), []);
  // Netted into the usage, the same credits make the ordinary 2026-10-21 and 2026-10-28 look like spikes,
  // so the test above is not vacuous.
  const netted = usage.map((r) => (['2026-10-07', '2026-10-14'].includes(r.date) ? { ...r, cost: r.cost - 380 } : r));
  assert.ok(detectAnomalies(netted, window).some((a) => a.date >= '2026-10-21'));
});

test('a real spike is still flagged on the day a credit posts', () => {
  const window = computeWindow({ days: 60, end: '2026-10-28' });
  const usage = flat('Compute', 400, window).map((r) => (r.date === '2026-10-28' ? { ...r, cost: 2400 } : r));
  const found = detectAnomalies([...usage, row('2026-10-28', 'Compute', -1500)], window);
  assert.deepEqual(found.map((a) => [a.date, a.cost, a.baseline]), [['2026-10-28', 2400, 400]]);
});

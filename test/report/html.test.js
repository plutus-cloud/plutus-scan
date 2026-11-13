import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { emptyResult } from '../../src/model.js';
import { buildReport } from '../../src/report/data.js';
import { buildView, renderHtml, usageRegion } from '../../src/report/html.js';
import { fetchDemo } from '../../src/sources/demo.js';
import { computeWindow } from '../../src/model.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const GENERATED = '2026-10-30T12:00:00Z';
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">`;
const FOOTER_URL = 'https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=report';
const JSON_OPEN = '<script type="application/json" id="report">';
const RELEASE_URL = 'https://github.com/acme/shop/releases/tag/v2.4.0';

async function fixtureReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  result.releases.push({ date: '2026-10-12', repo: 'acme/shop', name: 'v2.4.0', url: RELEASE_URL });
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
}

const emptyReport = () => buildReport({ window: WIN, results: [{ name: 'focus', result: emptyResult() }], version: '0.1.0', generatedAt: GENERATED });

/** Split a rendered page into the JSON block's text and everything else. */
function splitJson(html) {
  const open = html.indexOf(JSON_OPEN);
  assert.ok(open > 0, 'JSON block present');
  const start = open + JSON_OPEN.length;
  const end = html.indexOf('</script>', start);
  return { json: html.slice(start, end), outside: html.slice(0, open) + html.slice(end) };
}

const count = (text, needle) => text.split(needle).length - 1;

/** The synthetic fixture plus a $1,500 Reserved Instance purchase on the 1st of each month. */
async function commitmentReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  // Mid-month, so they are drawn on their day; charges billed on every 1st are spread (see the monthly tests).
  for (const date of ['2026-08-14', '2026-09-14', '2026-10-14']) {
    result.rows.push({ date, provider: 'aws', kind: 'commitment', service: 'Amazon Elastic Compute Cloud purchases',
      account: null, project: null, usageType: null, cost: 1500, currency: 'USD' });
  }
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

test('contains the exact CSP meta tag', async () => {
  const html = renderHtml(await fixtureReport());
  assert.equal(count(html, CSP), 1);
  assert.ok(html.indexOf(CSP) < html.indexOf('<script'), 'CSP comes before any script');
});

test('makes no remote references', async () => {
  const html = renderHtml(await fixtureReport());
  const { json, outside } = splitJson(html);
  const remote = [...outside.matchAll(/(?:\bsrc\s*=|\bhref\s*=|url\()\s*["']?\s*(https?:[^"'\s)>]*)/gi)].map((m) => m[1]);
  assert.deepEqual(remote, [FOOTER_URL]);
  assert.ok(!/<(?:link|img|iframe|object|embed)\b/i.test(outside), 'no external resource elements');
  assert.ok(!/@import/i.test(outside), 'no css imports');
  assert.ok(!outside.includes(RELEASE_URL), 'release URL only in the JSON block');
  assert.ok(json.includes(RELEASE_URL), 'release URL inside the JSON block');
});

test('html escapes script-closing sequences', async () => {
  const report = await fixtureReport();
  const evil = '</script><img src=x onerror=alert(1)>';
  report.drivers.items[0].service = evil;
  report.notes.push('line\u2028separator\u2029paragraph <!-- comment');
  const html = renderHtml(report);
  const after = html.slice(html.indexOf(JSON_OPEN));
  assert.equal(count(after, '</script>'), 1);
  assert.ok(!html.includes('<img'));
  assert.ok(!/[\u2028\u2029]/.test(splitJson(html).json), 'no raw line separators');
  const parsed = JSON.parse(splitJson(html).json);
  assert.equal(parsed.report.drivers.items[0].service, evil);
  assert.ok(parsed.report.notes.includes('line\u2028separator\u2029paragraph <!-- comment'));
  assert.deepEqual(parsed.report, JSON.parse(JSON.stringify(report)));
});

test('sections appear in the design order', async () => {
  const html = renderHtml(await fixtureReport());
  const order = [...html.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['headline', 'daily', 'drivers', 'anomalies', 'candidates', 'ai-projects', 'untagged', 'basis']);
  const footer = html.indexOf('<footer');
  assert.ok(footer > html.indexOf('data-section="basis"'), 'footer after the basis section');
  assert.equal(count(html, 'This is a snapshot. Plutus tracks it daily, per team and per customer, with alerts.'), 1);
  assert.ok(html.includes(`href="${FOOTER_URL}"`));
});

test('embeds a view with money formatted like formatMoney', async () => {
  const html = renderHtml(await fixtureReport());
  const { view } = JSON.parse(splitJson(html).json);
  assert.equal(view.headline.sentence, 'Last 30 days: $19,404 ($19,404 cloud, $0.00 AI), +13% vs the previous 30. Biggest mover: AWS Amazon Elastic Compute Cloud / BoxUsage:m7g.large +$1,238. Projected October total: $20,143.');
  assert.equal(view.daily.chart.labels.length, 90 + 14);
  assert.equal(view.daily.chart.labels[74], 'Oct 13');
  assert.equal(view.daily.chart.longDates[74], 'Tue Oct 13, 2026');
  assert.equal(view.daily.chart.anomaly[74], view.daily.chart.stacked[74]);
  assert.equal(view.daily.chart.text.anomaly[74], '+$532 AWS Amazon Elastic Compute Cloud');
  assert.equal(view.daily.chart.anomaly.filter((v) => v !== null).length, 1);
  assert.deepEqual(view.daily.chart.marks, [{ index: 74, severity: 'high', items: [
    { name: 'AWS Amazon Elastic Compute Cloud', delta: '+$532', actual: '$778', expected: '$245', row: 0 }] }]);
  // The forecast is its own bars after the last day, not joined to it.
  assert.equal(view.daily.chart.forecast[89], null);
  assert.ok(view.daily.chart.forecast[90] > 0);
  assert.equal(view.daily.chart.stacked[90], null);
  assert.deepEqual(view.daily.chart.clipped, []);
  assert.deepEqual(view.daily.chart.releases, [{ index: 73, label: 'acme/shop v2.4.0', items: [] }]);
  assert.equal(view.drivers.items.length, 6);
  assert.equal(view.drivers.items[0].change, '+$1,238');
  assert.equal(view.anomalies.items[0].delta, '+$532');
  assert.equal(view.anomalies.items[0].release, 'acme/shop v2.4.0 on 2026-10-12');
  assert.equal(view.anomalies.items[0].day, 'Oct 13');
  assert.equal(view.anomalies.items[0].index, 74);
  assert.equal(view.anomalies.items[0].baseline, '$245');
  assert.equal(view.anomalies.items[0].span, null);
  assert.equal(view.anomalies.items[0].spark.values.length, view.anomalies.items[0].spark.flagged.length);
  assert.equal(view.anomalies.items[0].spark.flagged.filter(Boolean).length, 1);
  assert.deepEqual(view.candidates.items.map((c) => c.cost), ['$584', '$1,558', '$779']);
  assert.match(view.candidates.intro, /not proven savings/);
  assert.equal(view.untagged.items[0].untagged, '$1,363');
  assert.ok(view.basis.lines.includes('Last complete day: 2026-10-28. Currency: USD.'));
  for (const t of view.daily.chart.yLabels) assert.match(t, /^\$[\d,]+(\.\d\d)?$/);
});

test('html renders an empty report', () => {
  const html = renderHtml(emptyReport());
  assert.ok(html.includes(CSP));
  const { view } = JSON.parse(splitJson(html).json);
  assert.equal(view.headline.sentence, 'No spend found in this window.');
  assert.equal(view.daily.chart, null);
  for (const key of ['daily', 'drivers', 'anomalies', 'candidates', 'aiProjects', 'untagged']) {
    assert.equal(typeof view[key].reason, 'string', key);
    assert.ok(view[key].reason.length > 0, key);
  }
  assert.doesNotMatch(JSON.stringify(view), /NaN|Infinity|undefined/);
});

test('short history states the reason per section', async () => {
  const win = { start: '2026-10-22', end: '2026-10-28', days: 7 };
  const result = await fetchFocus(noAws(), { paths: [fixture], window: win });
  const report = buildReport({ window: win, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
  const { view } = JSON.parse(splitJson(renderHtml(report)).json);
  assert.match(view.drivers.reason, /^Not enough history \(7 days\)/);
  assert.match(view.anomalies.reason, /^Not enough history \(7 days\)/);
  assert.match(view.daily.note, /^Forecast: not enough history \(7 days\)/);
  assert.equal(view.daily.chart.labels.length, 7);
});

test('headline view carries the top three movers and the AWS cost in US dollars', async () => {
  const report = await fixtureReport();
  const { view } = JSON.parse(splitJson(renderHtml(report)).json);
  assert.deepEqual(view.headline.movers, [
    { name: 'AWS Amazon Elastic Compute Cloud / BoxUsage:m7g.large', change: '+$1,238', dir: 'up' },
    { name: 'Azure Virtual Machines / D4s v5 usage', change: '+$432', dir: 'up' },
    { name: 'Azure Azure SQL Database / Gen Purpose compute', change: '+$216', dir: 'up' },
  ]);
  const eur = JSON.parse(splitJson(renderHtml({ ...report, currency: 'EUR', aws: { billedRequests: 6, cost: 0.06 } })).json).view;
  assert.ok(eur.basis.lines.includes('AWS Cost Explorer: 6 requests, $0.06.'));
});

test('chart y range reaches below zero when a day is net negative', async () => {
  const report = await fixtureReport();
  report.daily[10] = { ...report.daily[10], cloud: -2500, ai: 0 };
  const { chart } = JSON.parse(splitJson(renderHtml(report)).json).view.daily;
  assert.ok(chart.yTicks[0] < 0 && chart.yTicks[0] <= -2500, String(chart.yTicks));
  assert.ok(chart.yTicks.at(-1) >= Math.max(...chart.stacked.filter((v) => v !== null)));
  assert.ok(chart.yTicks.includes(0));
  assert.equal(chart.yLabels.length, chart.yTicks.length);
  assert.ok(chart.yTicks.length <= 12);
  // A report with no negative day still starts at zero.
  const plain = JSON.parse(splitJson(renderHtml(await fixtureReport())).json).view.daily.chart;
  assert.equal(plain.yTicks[0], 0);
});

test('commitments are a third stacked series between cloud and AI', async () => {
  const { view } = JSON.parse(splitJson(renderHtml(await commitmentReport())).json);
  assert.equal(view.headline.stats[0].detail, '$19,404 cloud, $1,500 commitments, $0.00 AI');
  const c = view.daily.chart;
  assert.equal(c.hasCommitment, true);
  const i = c.dates.indexOf('2026-10-14');
  assert.equal(c.cloudCommitment[i], c.cloud[i] + 1500);
  assert.equal(c.stacked[i], c.cloudCommitment[i]);
  assert.equal(c.text.commitment[i], '$1,500');
  assert.equal(c.cloudCommitment.length, c.labels.length);
  assert.equal(c.cloudCommitment.at(-1), null);

  const plain = JSON.parse(splitJson(renderHtml(await fixtureReport())).json).view;
  assert.equal(plain.headline.stats[0].detail, '$19,404 cloud, $0.00 AI');
  assert.equal(plain.daily.chart.hasCommitment, false);
});

test('the chart draws commitments as their own bar layer in every theme', async () => {
  const html = renderHtml(await commitmentReport());
  const { view } = JSON.parse(splitJson(html).json);
  assert.ok(view.daily.chart.commitment.some((v) => v > 0));
  assert.ok(html.includes("['commitment', c.commitment]"));
  assert.ok(html.includes("keyItem('s-commitment', 'Commitments')"));
  // Light, dark (media query and toggle) and print each define the series colours.
  assert.equal(count(html, '--series-2:'), 4);
  assert.ok(html.includes('.b-commitment { fill: var(--series-2); }'));
});

test('a fee far above an ordinary day is cut so the rest of the chart stays readable', async () => {
  const report = await fixtureReport();
  const i = report.daily.findIndex((d) => d.date === '2026-10-01');
  report.daily[i] = { ...report.daily[i], commitment: 20000 };
  const { chart, caption } = JSON.parse(splitJson(renderHtml(report)).json).view.daily;
  const ordinary = Math.max(...chart.stacked.filter((v, k) => v !== null && k !== i));
  const top = chart.yTicks.at(-1);
  assert.ok(top < 20000 && top >= ordinary, String(chart.yTicks));
  assert.deepEqual(chart.clipped.map((c) => c.index), [i]);
  assert.match(chart.clipped[0].label, /^\$2\d,\d{3}$/);
  assert.match(caption, /one taller bar is cut and labelled/);
});

test('an anomaly episode lists every flagged day on the chart and its run in the table', async () => {
  const report = await fixtureReport();
  const a = report.anomalies[0];
  report.anomalies[0] = {
    ...a, start: '2026-10-12', end: '2026-10-14', excess: 900, dayTotal: 4000,
    flaggedDays: [{ date: '2026-10-12', cost: 600, baseline: 245, delta: 355 }, { date: a.date, cost: a.cost, baseline: a.baseline, delta: a.delta },
      { date: '2026-10-14', cost: 258, baseline: 245, delta: 13 }],
  };
  const { view } = JSON.parse(splitJson(renderHtml(report)).json);
  assert.deepEqual(view.daily.chart.marks.map((m) => m.index), [73, 74, 75]);
  assert.equal(view.daily.chart.marks[0].items[0].delta, '+$355');
  const item = view.anomalies.items[0];
  assert.equal(item.span, '3 days flagged, Oct 12 to 14');
  assert.equal(item.excess, '+$900 over the run');
  assert.equal(item.share, '13%');
  assert.equal(item.shareOf, 'of $4,000');
});

test('a commitment driver is labelled as one', async () => {
  const report = await fixtureReport();
  report.drivers.items[0].kind = 'commitment';
  const { view } = JSON.parse(splitJson(renderHtml(report)).json);
  assert.equal(view.drivers.items[0].kind, 'Commitment');
  assert.equal(view.drivers.items[1].kind, 'Cloud');
});

test('the chart shows commitments by the same half-cent rule as the headline', async () => {
  const report = await fixtureReport();
  report.daily[5] = { ...report.daily[5], commitment: 0.001 };
  report.totals = { ...report.totals, commitment: 0.001 };
  assert.equal(JSON.parse(splitJson(renderHtml(report)).json).view.daily.chart.hasCommitment, false);
});

async function demoView() {
  const window = computeWindow({ days: 90, end: '2026-10-30' });
  const result = await fetchDemo(noAws(), { window });
  return buildView(buildReport({ window, results: [{ name: 'demo', result }], version: '0.1.0', generatedAt: GENERATED }));
}

test('usageRegion reads a known region prefix and leaves anything else alone', () => {
  assert.deepEqual(usageRegion('USE1-EBS:SnapshotUsage'), { region: 'us-east-1', rest: 'EBS:SnapshotUsage' });
  assert.deepEqual(usageRegion('EUW2-NatGateway-Bytes'), { region: 'eu-west-2', rest: 'NatGateway-Bytes' });
  assert.deepEqual(usageRegion('APN1-BoxUsage:m7g.large'), { region: 'ap-northeast-1', rest: 'BoxUsage:m7g.large' });
  // CloudFront edge codes, no prefix (us-east-1 in AWS's own naming, but not stated) and unknown codes get no region.
  for (const u of ['US-DataTransfer-Out-Bytes', 'BoxUsage:t3.micro', 'XYZ9-Thing', 'gpt-4.1-mini']) {
    assert.deepEqual(usageRegion(u), { region: '', rest: u });
  }
});

test('a candidate opens to a usage type sub-table: by cost, with regions, shares and the rest behind a more row', async () => {
  const view = await demoView();
  const snapshots = view.candidates.items.find((c) => c.title === 'EBS snapshots');
  assert.ok(snapshots, view.candidates.items.map((c) => c.title).join(', '));
  assert.equal('usageTypes' in snapshots, false, 'no inline usage type list');
  const u = snapshots.usage;
  assert.equal(u.compare, false);
  assert.equal(u.rows.length, 12);
  assert.equal(u.shown, 8);
  assert.equal(u.more, '4 more, $98.52');
  assert.deepEqual(u.rows.slice(0, 3).map((r) => [r.name, r.region, r.share]),
    [['EBS:SnapshotUsage', 'us-east-1', '30.0%'], ['EBS:SnapshotUsage', 'eu-west-2', '16.0%'], ['EBS:SnapshotUsage', 'us-west-2', '12.0%']]);
  const pcts = u.rows.map((r) => r.pct);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a), 'sorted by cost, largest first');
  assert.ok(u.rows.every((r) => !('previous' in r)), 'candidates have no previous period');
  // A short list has no more row.
  const nat = view.candidates.items.find((c) => c.title === 'NAT gateway');
  assert.deepEqual([nat?.usage.rows.length, nat?.usage.shown, nat?.usage.more], [1, 1, null]);
});

test('a driver opens to the same sub-table, with the previous 30 days and the change', async () => {
  const view = await demoView();
  const rds = view.drivers.items[0];
  assert.equal(rds.usage.compare, true);
  assert.deepEqual(rds.usage.rows.map((r) => [r.name, r.region, r.current, r.previous, r.change, r.dir, r.share]),
    [['InstanceUsage:db.r6g.xlarge', 'us-east-1', '$6,095', '$4,619', '+$1,476', 'up', '100.0%']]);
  assert.deepEqual(Object.keys(rds.usage).sort(), Object.keys(view.candidates.items[0].usage).sort());
});

test('with monthly charges the chart is drawn spread, with the as-billed view beside it', async () => {
  const view = await demoView();
  const c = view.daily.chart;
  assert.equal(c.hasMonthly, true);
  assert.ok(c.billed, 'an as-billed view is there for the toggle');
  const i = c.dates.indexOf('2026-10-01');
  // As billed, the 1st carries October's tax and RI fee; spread, it carries one day's share like any other day.
  assert.ok(c.billed.stacked[i] > c.stacked[i] + 2000, `${c.billed.stacked[i]} against ${c.stacked[i]}`);
  assert.ok(c.monthly[i] > 0 && c.monthly[i] < 300, String(c.monthly[i]));
  assert.ok(c.billed.monthly.slice(0, c.actualDays).every((v) => v === 0));
  // A complete month's spread portions add up to what was billed for it.
  const sept = c.dates.map((d, k) => [d, k]).filter(([d]) => d.startsWith('2026-09')).map(([, k]) => k);
  const spreadSept = sept.reduce((a, k) => a + c.stacked[k], 0);
  const billedSept = sept.reduce((a, k) => a + c.billed.stacked[k], 0);
  assert.ok(Math.abs(spreadSept - billedSept) < 1e-6);
  // The cut axis is for genuine outliers: as billed it cuts the 1sts, spread it does not.
  assert.ok(c.billed.clipped.some((x) => x.index === i));
  assert.ok(!c.clipped.some((x) => x.index === i));
  assert.match(c.caption, /spread over the month they cover; every total is as billed/);
  // Without monthly charges there is one view and no toggle.
  const plain = JSON.parse(splitJson(renderHtml(await fixtureReport())).json).view.daily.chart;
  assert.deepEqual([plain.hasMonthly, plain.billed], [false, null]);
});

test('releases on the same day are one marker, named in its tooltip and in the anomaly context', async () => {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  for (const [repo, name] of [['acme/web', 'v3.1.0'], ['acme/api', 'v1.9.2'], ['acme/shop', 'v2.4.0'], ['acme/jobs', 'v0.8.0']]) {
    result.releases.push({ date: '2026-10-12', repo, name, url: `https://github.com/${repo}/releases/tag/${name}` });
  }
  result.releases.push({ date: '2026-09-01', repo: 'acme/web', name: 'v3.0.0', url: 'https://github.com/acme/web/releases/tag/v3.0.0' });
  const report = buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
  const view = buildView(report);
  assert.deepEqual(view.daily.chart.releases, [
    { index: 32, label: 'acme/web v3.0.0', items: [] },
    { index: 73, label: '4 releases', items: ['acme/api v1.9.2', 'acme/jobs v0.8.0', 'acme/shop v2.4.0', 'acme/web v3.1.0'] },
  ]);
  assert.equal(view.anomalies.items[0].release, '4 releases on 2026-10-12: acme/api v1.9.2, acme/jobs v0.8.0, acme/shop v2.4.0 and 1 more');
  assert.ok(!view.daily.caption.includes('Release markers'));
});

test('release markers are capped, keeping the day an anomaly points at', async () => {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  // 45 release days: one a day for 44 days from Aug 1 (three on Aug 20), and the anomaly's Oct 12.
  for (let i = 0; i < 44; i++) {
    const date = new Date(Date.parse('2026-08-01T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    result.releases.push({ date, repo: 'acme/web', name: `v${i}`, url: 'https://example.com' });
  }
  result.releases.push({ date: '2026-08-20', repo: 'acme/api', name: 'a', url: 'https://example.com' });
  result.releases.push({ date: '2026-08-20', repo: 'acme/jobs', name: 'b', url: 'https://example.com' });
  result.releases.push({ date: '2026-10-12', repo: 'acme/shop', name: 'v2.4.0', url: 'https://example.com' });
  const report = buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
  const { releases } = buildView(report).daily.chart;
  assert.equal(releases.length, 30);
  assert.ok(releases.some((r) => r.index === 73), 'the anomaly\'s release day stays');
  assert.ok(releases.some((r) => r.label === '3 releases'), 'the busiest day stays');
  assert.deepEqual(releases.map((r) => r.index), [...releases.map((r) => r.index)].sort((a, b) => a - b));
  assert.match(buildView(report).daily.caption, /Release markers show 30 of 45 release days: any an anomaly points at, then the busiest\./);
});

test('a release tooltip lists at most eight names', async () => {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  for (let i = 0; i < 12; i++) result.releases.push({ date: '2026-09-01', repo: `acme/svc-${String(i).padStart(2, '0')}`, name: 'v1', url: 'https://example.com' });
  const report = buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
  const [marker] = buildView(report).daily.chart.releases;
  assert.equal(marker.label, '12 releases');
  assert.equal(marker.items.length, 8);
  assert.equal(marker.items.at(-1), 'and 5 more');
});

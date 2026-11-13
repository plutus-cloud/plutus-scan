import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { buildReport } from '../../src/report/data.js';
import { releaseContext } from '../../src/report/releases.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { renderMarkdown } from '../../src/report/markdown.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const r = (date, repo, name) => ({ date, repo, name, url: `https://github.com/${repo}/releases/tag/${name}` });

/** The synthetic fixture, whose one anomaly is on Oct 13, with three releases the day before. */
async function report() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  result.releases.push(r('2026-10-12', 'acme/web', 'v3.1.0'), r('2026-10-12', 'acme/api', 'v1.9.2'), r('2026-10-12', 'acme/jobs', 'v0.8.0'));
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: '2026-10-30T12:00:00Z' });
}

test('an anomaly names every release of its nearest release day, with the repo', async () => {
  const id = (s) => s;
  assert.equal(releaseContext({ release: null }, id), null);
  assert.equal(releaseContext({ release: r('2026-10-12', 'acme/web', 'v1'), releases: [] }, id), 'acme/web v1 on 2026-10-12');
  const rep = await report();
  const [a] = rep.anomalies;
  assert.equal(a.release.date, '2026-10-12');
  assert.deepEqual(a.releases.map((x) => x.repo), ['acme/api', 'acme/jobs', 'acme/web']);
  const four = { release: a.release, releases: [...a.releases, r('2026-10-12', 'acme/shop', 'v2')] };
  assert.equal(releaseContext(four, id), '4 releases on 2026-10-12: acme/api v1.9.2, acme/jobs v0.8.0, acme/web v3.1.0 and 1 more');
});

test('the terminal and Markdown reports carry the grouped release context', async () => {
  const rep = await report();
  const line = '3 releases on 2026-10-12: acme/api v1.9.2, acme/jobs v0.8.0, acme/web v3.1.0';
  const plain = renderTerminal(rep, { color: false, columns: 160, braille: false, layout: 'plain' });
  assert.ok(plain.includes(`  Nearby release (context, not a cause): ${line}`), plain);
  const dashboard = renderTerminal(rep, { color: false, columns: 200, braille: false, layout: 'dashboard', env: {} });
  // The dashboard's half-width panel cuts the note; the plain summary and the TUI detail carry it whole.
  assert.ok(dashboard.includes('↳ nearby release (context, not a cause): 3 '), dashboard);
  assert.ok(renderMarkdown(rep).includes(`(+$532, high). Nearby release (context, not a cause): ${line}.`));
});

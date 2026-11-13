import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CANDIDATE_RULES, findCandidates } from '../../src/analysis/candidates.js';
import { plutusFixUrl, plutusSectionUrl, PR_LINE, PR_LINE_COMPACT } from '../../src/report/plutus-link.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { buildView } from '../../src/report/html.js';
import { fetchDemo } from '../../src/sources/demo.js';
import { buildReport } from '../../src/report/data.js';

const WIN = { start: '2026-08-02', end: '2026-10-30', days: 90 };
const FIXABLE = ['gp2'];
const offline = () => ({ fetch: async () => { throw new Error('no network'); }, log: () => {}, requests: [] });

async function demoReport() {
  const result = await fetchDemo(offline(), { window: WIN });
  return buildReport({ window: WIN, results: [{ name: 'demo', result }], version: 'test', generatedAt: 'test' });
}

test('only gp2 is marked as something Plutus can open a pull request for', () => {
  const marked = CANDIDATE_RULES.filter((r) => r.plutusFix).map((r) => r.id).sort();
  assert.deepEqual(marked, [...FIXABLE].sort());
  assert.ok(CANDIDATE_RULES.every((r) => !r.plutusFix || r.plutusFix === 'pull_request'));
});

test('findCandidates carries plutusFix on every candidate, null when there is none', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/candidates/usage-types.json', import.meta.url), 'utf8')).rules;
  const rows = CANDIDATE_RULES.map((r, i) => ({
    date: '2026-10-20', provider: 'aws', kind: 'cloud', service: fixture[r.id].service, account: null, project: null, currency: 'USD', cost: 20 + i,
    usageType: fixture[r.id].match[0],
  }));
  const found = findCandidates(rows, { start: '2026-07-31', end: '2026-10-28', days: 90 });
  assert.equal(found.length, CANDIDATE_RULES.length);
  for (const c of found) assert.equal(c.plutusFix, FIXABLE.includes(c.id) ? 'pull_request' : null, c.id);
});

test('the link carries only the surface and a fixed candidate id, for every candidate', () => {
  for (const medium of ['report', 'md']) {
    for (const { id } of CANDIDATE_RULES) {
      assert.equal(plutusFixUrl(medium, id), `https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=${medium}&utm_content=${id}`);
    }
  }
  assert.equal(plutusSectionUrl(), 'https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=cli');
  assert.equal(plutusSectionUrl().length, 63);
  assert.throws(() => plutusFixUrl('md', 'USE1-EBS:VolumeUsage.gp2'));
  assert.throws(() => plutusFixUrl('md', '$584'));
});

test('the demo has a gp2 candidate and an idle-ip one, and the outputs point only gp2 at Plutus', async () => {
  const report = await demoReport();
  const ids = report.candidates.map((c) => c.id);
  for (const id of [...FIXABLE, 'idle-ip']) assert.ok(ids.includes(id), `${id} in ${ids.join(', ')}`);

  const md = renderMarkdown(report);
  const links = [...md.matchAll(/\]\((https:\/\/plutus-cloud\.com\/[^)]*utm_content=[^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(links, ['gp2'].map((id) => plutusFixUrl('md', id)), 'Markdown links only gp2');
  assert.equal(md.split(PR_LINE).length - 1, links.length);

  const view = buildView(report);
  for (const c of view.candidates.items) {
    const id = report.candidates.find((r) => r.title === c.title).id;
    if (FIXABLE.includes(id)) assert.deepEqual(c.fix, { url: plutusFixUrl('report', id), text: PR_LINE, compact: PR_LINE_COMPACT });
    else assert.equal(c.fix, null, id);
  }
  assert.equal(view.candidates.items.filter((c) => c.fix).length, 1);

  // Nothing from the data reaches a URL: no figure, usage type or account in any link.
  const urls = [...md.matchAll(/https:\/\/plutus-cloud\.com\/\S*?(?=\))/g)].map((m) => m[0])
    .concat(view.candidates.items.filter((c) => c.fix).map((c) => c.fix.url));
  for (const u of urls) assert.match(u, /^https:\/\/plutus-cloud\.com\/\?utm_source=plutus-scan&utm_medium=[a-z]+(&utm_content=[a-z0-9-]+)?$/);
});

test('plain terminal output adds the line under a fixable candidate only, within 80 columns', async () => {
  const report = await demoReport();
  const text = renderTerminal(report, { layout: 'plain', columns: 80 });
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('gp2 volumes'));
  assert.ok(at > 0);
  assert.equal(lines[at + 2], `  ${PR_LINE}`);
  const idle = lines.findIndex((l) => l.startsWith('Idle public IPs'));
  assert.ok(idle > at + 2, 'gp2, the fixable one, comes first');
  assert.equal(lines[idle + 1].includes('Plutus'), false, 'idle public IPs carry no pull-request line');
  assert.equal(text.split(PR_LINE).length - 1, 1);
  assert.ok(lines.every((l) => Array.from(l).length <= 80));
  assert.equal(text.split(plutusSectionUrl()).length - 1, 1);
  assert.equal(text.split('plutus-cloud.com').length - 1, 1);
  // The address ends the five shown candidates, and the line for the rest follows it.
  const url = lines.indexOf(`  ${plutusSectionUrl()}`);
  assert.ok(url > idle + 1);
  assert.match(lines[url + 1], /^ {2}and \d+ more, listed in --json and the HTML report$/);
  assert.ok(lines.slice(at + 3, url).every((l) => !l.includes('Plutus')), 'no pointer on any other candidate');
  const plain = { ...report, candidates: report.candidates.filter((c) => ['nat', 'egress'].includes(c.id)) };
  assert.equal(plain.candidates.length, 2);
  assert.doesNotMatch(renderTerminal(plain, { layout: 'plain', columns: 80 }), /plutus-cloud\.com/);
  assert.doesNotMatch(renderTerminal(plain, { layout: 'dashboard', columns: 80, color: false }), /plutus-cloud\.com/);
});

test('the dashboard adds the compact line under a fixable candidate, within 80 columns', async () => {
  const report = await demoReport();
  const text = renderTerminal(report, { layout: 'dashboard', columns: 80, color: false });
  assert.equal(text.split(PR_LINE_COMPACT).length - 1, 1);
  assert.equal(text.split(plutusSectionUrl()).length - 1, 1);
  assert.ok(text.split('\n').every((l) => Array.from(l).length <= 80));
});

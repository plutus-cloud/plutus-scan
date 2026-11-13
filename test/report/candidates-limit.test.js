import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/report/markdown.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { buildView } from '../../src/report/html.js';
import { fetchDemo } from '../../src/sources/demo.js';
import { buildReport } from '../../src/report/data.js';
import { computeWindow } from '../../src/model.js';
import { createTransport } from '../../src/transport.js';

const window = computeWindow({ days: 90, end: '2026-10-30' });
const SHOWN = 5;
const MORE = /and (\d+) more, listed in --json and the HTML report/;
const ANSI = /\x1b\[[0-9;]*m/g;

async function demoReport() {
  const t = createTransport({ fetchImpl: async () => { throw new Error('no http'); }, execImpl: async () => { throw new Error('no aws'); } });
  const result = await fetchDemo(t, { window });
  return buildReport({ window, results: [{ name: 'demo', result }], version: 'test', generatedAt: 'test' });
}

test('the demo lists a spread of candidates, and every one is kept in the report data', async () => {
  const report = await demoReport();
  assert.equal(report.candidates.length, 20);
  // Fixable first, then strong, then look, each by cost.
  const rank = (c) => (c.plutusFix ? 0 : c.strength === 'strong' ? 1 : 2);
  const sorted = [...report.candidates].sort((a, b) => rank(a) - rank(b) || b.cost30d - a.cost30d);
  assert.deepEqual(report.candidates.map((c) => c.id), sorted.map((c) => c.id));
  assert.ok(report.candidates.some((c) => c.strength === 'strong') && report.candidates.some((c) => c.strength === 'look'));
});

test('the plain summary shows the top five and says how many more, within 80 columns', async () => {
  const report = await demoReport();
  const text = renderTerminal(report, { layout: 'plain', columns: 80 });
  const lines = text.split('\n');
  const start = lines.indexOf('Candidates to review');
  const end = lines.indexOf('', start);
  const section = lines.slice(start + 1, end);
  assert.equal(section.filter((l) => /in 30 days$/.test(l)).length, SHOWN);
  assert.equal(section.at(-1), `  and ${report.candidates.length - SHOWN} more, listed in --json and the HTML report`);
  assert.ok(lines.every((l) => Array.from(l).length <= 80));
});

test('the dashboard says how many more at every width, within the width', async () => {
  const report = await demoReport();
  for (const columns of [80, 99, 120, 160]) {
    const text = renderTerminal(report, { layout: 'dashboard', columns, color: false }).replace(ANSI, '');
    const m = text.match(MORE);
    assert.ok(m, `${columns} columns`);
    assert.equal(Number(m[1]), report.candidates.length - SHOWN);
    assert.ok(text.split('\n').every((l) => Array.from(l).length <= columns), `${columns} columns`);
  }
});

test('Markdown ends the list with the same line', async () => {
  const report = await demoReport();
  const md = renderMarkdown(report);
  const items = md.split('\n').filter((l) => l.startsWith('- ') && /in 30 days\./.test(l));
  assert.equal(items.length, SHOWN);
  assert.match(md, new RegExp(`^- and ${report.candidates.length - SHOWN} more, listed in --json and the HTML report$`, 'm'));
});

test('five candidates or fewer print no line about more', async () => {
  const report = await demoReport();
  const few = { ...report, candidates: report.candidates.slice(0, SHOWN) };
  assert.doesNotMatch(renderTerminal(few, { layout: 'plain', columns: 80 }), MORE);
  assert.doesNotMatch(renderTerminal(few, { layout: 'dashboard', columns: 120, color: false }), MORE);
  assert.doesNotMatch(renderMarkdown(few), MORE);
});

test('the HTML report lists every candidate', async () => {
  const report = await demoReport();
  assert.equal(buildView(report).candidates.items.length, report.candidates.length);
});

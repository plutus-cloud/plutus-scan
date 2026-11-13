// Opens the HTML report in a real browser. Runs only where Playwright is already
// resolvable; everywhere else each test is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';
import { emptyResult } from '../../src/model.js';
import { buildReport } from '../../src/report/data.js';
import { renderHtml } from '../../src/report/html.js';
import { fetchDemo } from '../../src/sources/demo.js';
import { computeWindow } from '../../src/model.js';

const playwright = await import('playwright').catch(() => null);
const skip = playwright ? false : 'Playwright is not installed';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const GENERATED = '2026-10-30T12:00:00Z';
const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
const SECTIONS = ['headline', 'daily', 'drivers', 'anomalies', 'candidates', 'ai-projects', 'untagged', 'basis'];

async function fixtureReport() {
  const result = await fetchFocus(noAws(), { paths: [fixture], window: WIN });
  return buildReport({ window: WIN, results: [{ name: 'focus', result }], version: '0.1.0', generatedAt: GENERATED });
}

/**
 * Load a report in a fresh page with every request aborted.
 * @param {object} report
 * @param {(page: any, seen: { nonDocument: string[], errors: string[] }) => Promise<void>} fn
 */
async function withPage(report, fn, viewport = { width: 1280, height: 900 }) {
  const dir = mkdtempSync(join(tmpdir(), 'plutus-scan-html-'));
  const file = join(dir, 'report.html');
  writeFileSync(file, renderHtml(report));
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport });
    const seen = { nonDocument: [], errors: [] };
    page.on('request', (r) => { if (r.resourceType() !== 'document') seen.nonDocument.push(r.url()); });
    page.on('console', (m) => { if (m.type() === 'error') seen.errors.push(m.text()); });
    page.on('pageerror', (e) => seen.errors.push(String(e)));
    // Let the report itself load and abort everything else. Newer Playwright routes the
    // file:// document too, so aborting every request would abort the page.
    await page.route('**/*', (route) => (route.request().resourceType() === 'document' && route.request().url().startsWith('file:')
      ? route.continue() : route.abort()));
    await page.goto(pathToFileURL(file).href);
    await page.waitForSelector('[data-section="headline"] [data-role="sentence"]:not(:empty)');
    await fn(page, seen);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('browser: no requests beyond the document', { skip }, async () => {
  await withPage(await fixtureReport(), async (page, seen) => {
    assert.deepEqual(seen.nonDocument, []);
  });
});

test('browser: no console errors', { skip }, async () => {
  await withPage(await fixtureReport(), async (page, seen) => {
    assert.deepEqual(seen.errors, []);
  });
  await withPage(buildReport({ window: WIN, results: [{ name: 'focus', result: emptyResult() }], version: '0.1.0', generatedAt: GENERATED }),
    async (page, seen) => { assert.deepEqual(seen.errors, []); });
});

test('browser: the headline and 7 sections render', { skip }, async () => {
  await withPage(await fixtureReport(), async (page) => {
    const order = await page.$$eval('[data-section]', (els) => els.map((e) => e.getAttribute('data-section')));
    assert.deepEqual(order, SECTIONS);
    for (const name of SECTIONS) {
      const text = await page.textContent(`[data-section="${name}"] [data-role="body"]`);
      assert.ok(text && text.trim().length > 0, `${name} has content`);
    }
    assert.equal(await page.locator('[data-section="daily"] svg.chart-svg').count(), 1);
    // The seeded spike is marked on the chart, and its table row points at its day.
    assert.equal(await page.locator('[data-section="daily"] .mark').count(), 1);
    await page.locator('[data-section="anomalies"] tr.clickable').first().click();
    assert.match(await page.textContent('[data-section="daily"] .tooltip'), /Tue Oct 13, 2026.*\+\$532/);
  });
});

test('browser: print media hides the toggle', { skip }, async () => {
  await withPage(await fixtureReport(), async (page) => {
    assert.equal(await page.isVisible('#theme-toggle'), true);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.isVisible('#theme-toggle'), false);
    assert.equal(await page.isVisible('#copy-sentence'), false);
  });
});

async function demoReport() {
  const window = computeWindow({ days: 90, end: '2026-10-30' });
  const result = await fetchDemo(noAws(), { window });
  return buildReport({ window, results: [{ name: 'demo', result }], version: '0.1.0', generatedAt: GENERATED });
}

test('browser: a candidate row opens to its usage types from the mouse or the keyboard', { skip }, async () => {
  await withPage(await demoReport(), async (page) => {
    const group = page.locator('[data-section="candidates"] tbody.group', { hasText: 'EBS snapshots' });
    const button = group.locator('button.disclose');
    const reveal = group.locator('.reveal');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await reveal.evaluate((e) => getComputedStyle(e).visibility), 'hidden', 'collapsed by default');
    assert.equal(await page.locator('[data-section="candidates"] th', { hasText: 'Usage types' }).count(), 0);
    // A click anywhere on the row opens it.
    await group.locator('tr.parent td.num').click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.equal(await button.getAttribute('aria-controls'), await group.locator('tr.detail').getAttribute('id'));
    const rows = group.locator('.subtable tbody tr:visible');
    assert.equal(await rows.count(), 9, 'eight usage types and the more row');
    assert.deepEqual(await group.locator('.subtable th').allTextContents(), ['Usage type', 'Region', 'Last 30 days', 'Share']);
    await group.locator('button.more').click();
    assert.equal(await rows.count(), 12);
    // The keyboard closes it again.
    await button.focus();
    await page.keyboard.press('Enter');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    await page.keyboard.press(' ');
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
  });
});

test('browser: drivers and candidates use the same sub-table', { skip }, async () => {
  await withPage(await demoReport(), async (page) => {
    await page.locator('[data-section="drivers"] button.disclose').first().click();
    const heads = await page.locator('[data-section="drivers"] tbody.open .subtable th').allTextContents();
    assert.deepEqual(heads, ['Usage type', 'Region', 'Last 30 days', 'Previous 30', 'Change', 'Share']);
  });
});

test('browser: at phone width the sub-table scrolls inside its card, never the page', { skip }, async () => {
  await withPage(await demoReport(), async (page) => {
    await page.locator('[data-section="candidates"] tr.parent', { hasText: 'EBS snapshots' }).click();
    const sizes = await page.evaluate(() => {
      const box = document.querySelector('[data-section="candidates"] tbody.open .subtable-scroll');
      return { page: document.documentElement.scrollWidth, window: window.innerWidth, inner: box.scrollWidth, outer: box.clientWidth };
    });
    assert.equal(sizes.page, sizes.window);
    assert.ok(sizes.inner > sizes.outer, `the sub-table scrolls: ${JSON.stringify(sizes)}`);
  }, { width: 390, height: 844 });
});

test('browser: print shows every usage type, opened', { skip }, async () => {
  await withPage(await demoReport(), async (page) => {
    await page.emulateMedia({ media: 'print' });
    const group = page.locator('[data-section="candidates"] tbody.group', { hasText: 'EBS snapshots' });
    assert.equal(await group.locator('.subtable tbody tr:visible').count(), 12);
    assert.equal(await group.locator('button.more').isVisible(), false);
  });
});

test('browser: the daily chart switches between spread monthly charges and as billed', { skip }, async () => {
  await withPage(await demoReport(), async (page, seen) => {
    const spread = page.getByRole('button', { name: 'Spread monthly charges' });
    const billed = page.getByRole('button', { name: 'As billed' });
    assert.equal(await spread.getAttribute('aria-pressed'), 'true');
    assert.equal(await billed.getAttribute('aria-pressed'), 'false');
    const legend = () => page.locator('[data-section="daily"] .legend').textContent();
    assert.match(await legend(), /Monthly charges, spread/);
    assert.ok(await page.locator('[data-section="daily"] .b-monthly').count() > 0);
    await billed.click();
    assert.equal(await billed.getAttribute('aria-pressed'), 'true');
    assert.doesNotMatch(await legend(), /Monthly charges, spread/);
    assert.equal(await page.locator('[data-section="daily"] .b-monthly').count(), 0);
    assert.ok(await page.locator('[data-section="daily"] .cut-label').count() > 0, 'as billed, the 1sts are cut');
    await spread.click();
    assert.equal(await page.locator('[data-section="daily"] .cut-label').count(), 0);
    assert.deepEqual(seen.errors, []);
  });
});

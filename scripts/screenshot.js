// Captures docs/screenshot.png: the headline and the whole daily chart of the demo report
// (scripts/make-sample-report.js) at 1200px wide in the light theme. Run by hand, it is not part of the tests or the package.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node scripts/screenshot.js <report.html> [docs/screenshot.png]
//
// <report.html> is any report written by `plutus-scan --html`. Playwright is not a
// dependency of this project.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , input, output = 'docs/screenshot.png'] = process.argv;
if (!input) {
  console.error('Usage: node scripts/screenshot.js <report.html> [out.png]');
  process.exit(2);
}

const { chromium } = await import('playwright');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, colorScheme: 'light' });
  await page.goto(pathToFileURL(resolve(input)).href);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  // Down to the end of the daily chart card, so the chart is never cut off.
  const box = await page.locator('[data-section="daily"]').boundingBox();
  const height = box ? Math.ceil(box.y + box.height + 24) : 780;
  await page.screenshot({ path: output, fullPage: true, clip: { x: 0, y: 0, width: 1200, height } });
  console.log(`wrote ${output}`);
} finally {
  await browser.close();
}

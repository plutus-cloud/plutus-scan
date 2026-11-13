// The report the sample scripts draw: the --demo generator's 90 days ending DEMO_END, read through the
// same source as `plutus-scan --demo`, with a fixed generation time so the output is the same on every
// run. Every name and figure is synthetic.
import { computeWindow } from '../src/model.js';
import { createTransport } from '../src/transport.js';
import { fetchDemo } from '../src/sources/demo.js';
import { buildReport } from '../src/report/data.js';
import { VERSION } from '../src/version.js';

export const DEMO_END = '2026-10-30';

/** @returns {Promise<import('../src/report/data.js').ReportData>} */
export async function demoReport() {
  const window = computeWindow({ days: 90, end: DEMO_END });
  const offline = createTransport({
    fetchImpl: async () => { throw new Error('the demo must not make HTTP requests'); },
    execImpl: async () => { throw new Error('the demo must not run the aws CLI'); },
  });
  const result = await fetchDemo(offline, { window });
  return buildReport({ window, results: [{ name: 'demo', result }], version: VERSION, generatedAt: `${DEMO_END}T12:00:00Z` });
}

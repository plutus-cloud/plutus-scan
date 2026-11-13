// Writes a sample HTML report from the --demo generator (scripts/demo-report.js), for looking at the
// page and for docs/screenshot.png. Run by hand, it is not part of the tests or the package.
//
//   node scripts/make-sample-report.js [out.html]
import { writeFileSync } from 'node:fs';
import { renderHtml } from '../src/report/html.js';
import { demoReport } from './demo-report.js';

const [, , output = 'plutus-scan-report.html'] = process.argv;
const report = await demoReport();
writeFileSync(output, renderHtml(report));
console.log(`wrote ${output}: ${report.anomalies.length} anomalies`);

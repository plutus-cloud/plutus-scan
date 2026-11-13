#!/usr/bin/env node
/**
 * Write the terminal samples in docs/terminal-samples/ from the --demo generator (scripts/demo-report.js):
 * the dashboard at 80 and 120 columns at each colour depth and without colour, the full-screen tabs, and
 * the plain summary that piped output gets. View a coloured one with `cat`. Run: node scripts/terminal-samples.js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { renderTerminal } from '../src/report/terminal.js';
import { createApp } from '../src/tui/app.js';
import { demoReport } from './demo-report.js';

const out = new URL('../docs/terminal-samples/', import.meta.url);
const report = await demoReport();

mkdirSync(out, { recursive: true });
const write = (name, text) => writeFileSync(new URL(name, out), text);
for (const columns of [80, 120]) {
  write(`dashboard-${columns}-truecolor.ansi`, renderTerminal(report, { layout: 'dashboard', color: 24, columns }));
  write(`dashboard-${columns}-256.ansi`, renderTerminal(report, { layout: 'dashboard', color: 8, columns }));
  write(`dashboard-${columns}-16.ansi`, renderTerminal(report, { layout: 'dashboard', color: 4, columns }));
  write(`dashboard-${columns}-no-color.txt`, renderTerminal(report, { layout: 'dashboard', color: 0, columns }));
  write(`piped-${columns}.txt`, renderTerminal(report, { layout: 'plain', color: false, columns }));
}

const key = (name) => ({ name, sequence: name, ctrl: false });
for (const [columns, rows] of [[80, 24], [120, 40]]) {
  for (const color of [24, 0]) {
    const app = createApp(report, { columns, rows, color });
    const tag = `${columns}x${rows}-${color ? 'truecolor.ansi' : 'no-color.txt'}`;
    const shot = (name) => write(`tui-${name}-${tag}`, `${app.render().join('\n')}\n`);
    shot('overview');
    app.handleKey(key('2')); shot('drivers');
    app.handleKey(key('return')); shot('driver-detail');
    app.handleKey(key('3')); shot('anomalies');
    app.handleKey(key('return')); shot('anomaly-detail');
  }
}

/**
 * The default output. On a terminal it is a dashboard (see dashboard.js); piped or in CI it is the plain
 * summary below, which stays stable and easy to parse.
 */

import { formatMoney } from '../model.js';
import { colorDepth, createTheme } from '../ui/theme.js';
import { renderDashboard } from './dashboard.js';
import { providerName, freshnessLine, moverName, awsRequestLine, hasCommitment, moreCandidatesLine, possibleSavingsCaveat, STRENGTH_LABEL } from './headline.js';
import { spreadTotal } from './data.js';
import { sparkline } from './sparkline.js';
import { releaseContext } from './releases.js';
import { PR_LINE, plutusSectionUrl } from './plutus-link.js';

const COMPACT_BELOW = 100;
const LABEL_WIDE = 52;
const DRIVER_LIMIT = 5;
const ANOMALY_LIMIT = 3;
const CANDIDATE_LIMIT = 5;
const AI_LIMIT = 5;
const ANOMALY_MIN_DAYS = 8;
const DRIVERS_MIN_DAYS = 60;
const FORECAST_MIN_DAYS = 14;

/**
 * Remove escape sequences and control characters from data before printing.
 * Controls (including tab and newline) become a space; escape sequences vanish.
 * @param {unknown} text @returns {string}
 */
export function sanitize(text) {
  return String(text ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\x1b/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

/** @param {string} s @param {number} n @returns {string} at most n characters, ending in … when cut */
function truncate(s, n) {
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  return n <= 1 ? chars.slice(0, Math.max(n, 0)).join('') : `${chars.slice(0, n - 1).join('')}…`;
}

/** @param {string} s @param {number} n @returns {string[]} lines of at most n characters */
function wrap(s, n) {
  const lines = [];
  let line = '';
  for (const word of s.split(' ')) {
    const w = truncate(word, n);
    if (line && Array.from(`${line} ${w}`).length > n) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - Array.from(s).length));
const padStart = (s, n) => ' '.repeat(Math.max(0, n - Array.from(s).length)) + s;

/**
 * @param {import('./data.js').ReportData} report
 * @param {{ color?: boolean|import('../ui/theme.js').Depth, columns?: number, braille?: boolean,
 *   layout?: 'dashboard'|'plain', env?: NodeJS.ProcessEnv }} [opts]
 *   `color` true picks the depth from `env`; a number forces it. `layout` defaults to the dashboard when
 *   standard output is a terminal and the plain summary when it is not.
 * @returns {string}
 */
export function renderTerminal(report, { color = false, columns = 80, braille = false, layout, env = process.env } = {}) {
  if ((layout ?? (process.stdout.isTTY ? 'dashboard' : 'plain')) === 'dashboard') {
    const depth = color === true ? Math.max(4, colorDepth({ ...env, NO_COLOR: '' })) : color || 0;
    return renderDashboard(report, { theme: createTheme(/** @type {import('../ui/theme.js').Depth} */ (depth)), columns, braille });
  }
  return renderPlain(report, { color: Boolean(color), columns, braille });
}

/**
 * The plain summary: headings and aligned lines, no borders.
 * @param {import('./data.js').ReportData} report
 * @param {{ color: boolean, columns: number, braille: boolean }} opts
 * @returns {string}
 */
function renderPlain(report, { color, columns, braille }) {
  const compact = columns < COMPACT_BELOW;
  const cur = sanitize(report.currency);
  const money = (n) => formatMoney(n, cur);
  const signed = (n) => {
    const body = money(Math.abs(n));
    if (!/[1-9]/.test(body)) return body;
    return `${n > 0 ? '+' : '-'}${body}`;
  };
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  /** Colour a change: increases red, decreases green. */
  const tint = (n, text) => (n > 0 ? paint('31', text) : n < 0 ? paint('32', text) : text);
  const name = (provider, service) => `${providerName(sanitize(provider))} ${sanitize(service)}`;

  /** @type {string[]} */
  const out = [];
  const heading = (text) => { out.push('', paint('1', text)); };
  const fit = (s) => truncate(s, columns);

  /**
   * One table row: a left label cut to fit, then right-aligned value cells.
   * @param {string} label @param {{ text: string, width: number, change?: number }[]} cells
   * @param {number} indent
   */
  const tableRow = (label, cells, indent = 0) => {
    const valuesWidth = cells.reduce((a, c) => a + c.width + 2, 0);
    const labelWidth = Math.max(1, Math.min(columns - indent - valuesWidth, compact ? columns : LABEL_WIDE - indent));
    let line = ' '.repeat(indent) + padEnd(truncate(label, labelWidth), labelWidth);
    for (const c of cells) {
      const cell = padStart(c.text, c.width);
      line += `  ${c.change === undefined ? cell : tint(c.change, cell)}`;
    }
    out.push(line.trimEnd());
  };

  /** Sections 7 and 8: notes and basis, then the AWS request line. */
  const notesAndBasis = () => {
    heading('Notes and basis');
    for (const n of report.notes) for (const l of wrap(sanitize(n), columns)) out.push(l);
    for (const b of report.basis) for (const l of wrap(sanitize(b), columns)) out.push(l);
    out.push(fit(sanitize(freshnessLine({ ...report, currency: cur }))));
    if (report.aws) {
      out.push('', fit(awsRequestLine(report.aws)));
    }
  };

  // Header.
  {
    const title = `plutus-scan ${sanitize(report.tool.version)}`;
    const rest = `  ${report.window.start} to ${report.window.end} (${report.window.days} days)`;
    const cut = truncate(title + rest, columns);
    out.push(cut.length >= title.length ? paint('1', title) + cut.slice(title.length) : cut);
  }

  if (report.empty) {
    out.push('', ...wrap(sanitize(report.headline.sentence), columns));
    notesAndBasis();
    return `${out.join('\n')}\n`;
  }

  // 1. Headline.
  heading('Headline');
  for (const l of wrap(sanitize(report.headline.sentence), columns)) out.push(l);
  const h = report.headline;
  /** Truncate the plain text first; `mark` is a substring to colour afterwards. */
  const labelled = (label, text, mark) => {
    const plain = fit(`${padEnd(label, 16)}${text}`);
    out.push(mark && plain.includes(mark.text) ? plain.replace(mark.text, tint(mark.n, mark.text)) : plain);
  };
  const commitments = hasCommitment(h.last30.commitment) ? `, commitments ${money(h.last30.commitment)}` : '';
  labelled('Last 30 days', `${money(h.last30.total)} (cloud ${money(h.last30.cloud)}${commitments}, AI ${money(h.last30.ai)})`);
  if (h.previous30Total !== null) {
    const pct = h.changePct === null ? '' : ` (${h.changePct >= 0 ? '+' : '-'}${Math.abs(Math.round(h.changePct))}%)`;
    const change = signed(h.change ?? 0);
    labelled('Previous 30', `${money(h.previous30Total)}, change ${change}${pct}`, { text: change, n: h.change ?? 0 });
  }
  h.movers.forEach((m, i) => {
    const change = signed(m.change);
    labelled(i === 0 ? 'Top movers' : '', `${sanitize(moverName(m))} ${change}`, { text: change, n: m.change });
  });
  if (h.largestAnomaly) {
    labelled('Largest anomaly', `${signed(h.largestAnomaly.delta)} on ${h.largestAnomaly.date}, ${name(h.largestAnomaly.provider, h.largestAnomaly.service)}`);
  }
  if (h.monthEnd) labelled('Month-end', `${money(h.monthEnd.projected)} projected for ${h.monthEnd.month}`);
  else labelled('Month-end', `not enough history (${report.window.days} days, needs ${FORECAST_MIN_DAYS})`);

  // 2. Sparkline.
  heading('Daily spend');
  const width = Math.min(report.daily.length, columns - 2);
  // Monthly charges spread over their month, so a fee on the 1st is not a spike.
  const values = report.daily.map(spreadTotal);
  out.push(sparkline(values, { width: Math.max(1, braille ? Math.min(width, Math.ceil(values.length / 2)) : width), braille }));
  const peak = Math.max(0, ...values);
  out.push(fit(`${report.window.start} to ${report.window.end}, peak ${money(peak)} a day`));

  // 3. Drivers.
  heading('Top drivers (last 30 days against the previous 30)');
  if (!report.drivers) {
    out.push(`Drivers: not enough history (${report.window.days} days, needs ${DRIVERS_MIN_DAYS}).`);
  } else if (report.drivers.items.length === 0) {
    out.push('No drivers.');
  } else {
    if (!compact) tableRow('', [{ text: 'last 30', width: 9 }, { text: 'previous', width: 9 }, { text: 'change', width: 9 }, { text: 'share', width: 6 }]);
    for (const d of report.drivers.items.slice(0, DRIVER_LIMIT)) {
      const cells = compact
        ? [{ text: signed(d.change), width: 9, change: d.change }]
        : [
          { text: money(d.current), width: 9 }, { text: money(d.previous), width: 9 },
          { text: signed(d.change), width: 9, change: d.change }, { text: `${d.sharePct.toFixed(1)}%`, width: 6 },
        ];
      tableRow(name(d.provider, d.service), cells);
      for (const u of d.usageTypes) {
        tableRow(sanitize(u.usageType), compact
          ? [{ text: signed(u.change), width: 9, change: u.change }]
          : [{ text: money(u.current), width: 9 }, { text: money(u.previous), width: 9 },
            { text: signed(u.change), width: 9, change: u.change }, { text: '', width: 6 }], 2);
      }
    }
  }

  // 4. Anomalies.
  heading('Anomalies');
  if (report.window.days < ANOMALY_MIN_DAYS) {
    out.push(`Anomalies: not enough history (${report.window.days} days, needs ${ANOMALY_MIN_DAYS}).`);
  } else if (report.anomalies.length === 0) {
    out.push('No anomalies.');
  } else {
    if (!compact) tableRow('', [{ text: 'cost', width: 9 }, { text: 'baseline', width: 13 }, { text: 'change', width: 9 }, { text: 'severity', width: 8 }]);
    for (const a of report.anomalies.slice(0, ANOMALY_LIMIT)) {
      tableRow(`${a.date} ${name(a.provider, a.service)}`, compact
        ? [{ text: signed(a.delta), width: 9, change: a.delta }]
        : [{ text: money(a.cost), width: 9 }, { text: money(a.baseline), width: 13 },
          { text: signed(a.delta), width: 9, change: a.delta }, { text: a.severity, width: 8 }]);
      const context = releaseContext(a, sanitize);
      if (context) out.push(fit(`  Nearby release (context, not a cause): ${context}`));
    }
  }

  // 5. Candidates.
  heading('Candidates to review');
  if (report.candidates.length === 0) {
    out.push('No candidates.');
  } else {
    if (report.possibleSavings) out.push(fit(`Possible savings: up to ${money(report.possibleSavings.cost30d)} ${possibleSavingsCaveat(report.possibleSavings)}`));
    let group = null;
    for (const c of report.candidates.slice(0, CANDIDATE_LIMIT)) {
      if (c.strength !== group) out.push(paint('2', fit(STRENGTH_LABEL[c.strength])));
      group = c.strength;
      tableRow(sanitize(c.title), [{ text: `${money(c.cost30d)} in 30 days`, width: 17 }]);
      out.push(fit(`  ${sanitize(c.why)}`));
      if (c.plutusFix === 'pull_request') out.push(fit(`  ${PR_LINE}`));
    }
    if (report.candidates.slice(0, CANDIDATE_LIMIT).some((c) => c.plutusFix === 'pull_request')) out.push(`  ${plutusSectionUrl()}`);
    if (report.candidates.length > CANDIDATE_LIMIT) out.push(fit(`  ${moreCandidatesLine(report.candidates.length - CANDIDATE_LIMIT)}`));
  }

  // 6. AI by project (omitted when there is no AI spend).
  if (report.aiProjects.length > 0) {
    heading('AI by project');
    for (const p of report.aiProjects.slice(0, AI_LIMIT)) {
      tableRow(`${providerName(sanitize(p.provider))} ${sanitize(p.project)}`, compact
        ? [{ text: money(p.cost), width: 9 }]
        : [{ text: money(p.cost), width: 9 }, { text: `${p.sharePct.toFixed(1)}%`, width: 6 }]);
    }
  }

  notesAndBasis();
  return `${out.join('\n')}\n`;
}

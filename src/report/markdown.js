/** A short GitHub-flavoured Markdown summary sized for pull requests and issues (tables and <sub> do not render in Slack). */

import { formatMoney } from '../model.js';
import { providerName, freshnessLine, awsRequestLine, moreCandidatesLine, possibleSavingsCaveat, STRENGTH_LABEL } from './headline.js';
import { sanitize } from './terminal.js';
import { releaseContext } from './releases.js';
import { PR_LINE, plutusFixUrl } from './plutus-link.js';

const DRIVER_LIMIT = 5;
const ANOMALY_LIMIT = 3;
const CANDIDATE_LIMIT = 5;
const DRIVERS_MIN_DAYS = 60;
const FOOTER = '[This is a snapshot. Plutus tracks it daily, per team and per customer, with alerts.]'
  + '(https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=report)';

/**
 * Make data safe to place in Markdown: strip control characters first, then
 * backslash-escape `\ | * _ ` [ ]` and turn `&`, `<` and `>` into entities
 * (so data can neither open a tag or link nor break a table cell).
 * @param {unknown} text @returns {string}
 */
export function escapeMd(text) {
  return sanitize(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\|*_`[\]]/g, '\\$&');
}

/**
 * @param {import('./data.js').ReportData} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const cur = report.currency;
  const money = (n) => formatMoney(n, cur);
  const signed = (n) => {
    const body = money(Math.abs(n));
    if (!/[1-9]/.test(body)) return body;
    return `${n > 0 ? '+' : '-'}${body}`;
  };
  const name = (provider, service) => `${providerName(sanitize(provider))} ${sanitize(service)}`;
  const w = report.window;

  /** @type {string[]} */
  const blocks = [`**plutus-scan** · ${w.start} to ${w.end} (${w.days} days)`];

  if (report.empty) {
    blocks.push('No spend found in this window.');
  } else {
    blocks.push(escapeMd(report.headline.sentence));

    if (!report.drivers) {
      blocks.push(`Drivers: not enough history (${w.days} days, needs ${DRIVERS_MIN_DAYS}).`);
    } else if (report.drivers.items.length > 0) {
      const rows = report.drivers.items.slice(0, DRIVER_LIMIT).map((d) => {
        const usage = d.usageTypes[0]?.usageType;
        return `| ${escapeMd(name(d.provider, d.service))} | ${usage ? escapeMd(usage) : '-'} `
          + `| ${money(d.previous)} | ${money(d.current)} | ${signed(d.change)} |`;
      });
      blocks.push(['**Top drivers** (last 30 days against the previous 30)', '',
        '| Service | Usage type | Previous | Current | Change |',
        '| --- | --- | ---: | ---: | ---: |', ...rows].join('\n'));
    }

    if (report.anomalies.length > 0) {
      const items = report.anomalies.slice(0, ANOMALY_LIMIT).map((a) => {
        const context = releaseContext(a, escapeMd);
        const release = context ? ` Nearby release (context, not a cause): ${context}.` : '';
        return `- ${a.date} ${escapeMd(name(a.provider, a.service))}: ${money(a.cost)} against a baseline of `
          + `${money(a.baseline)} (${signed(a.delta)}, ${a.severity}).${release}`;
      });
      blocks.push(['**Anomalies**', '', ...items].join('\n'));
    }

    if (report.candidates.length > 0) {
      // One list per group, each under its label, so the strong candidates and the ones worth a look read apart.
      /** @type {string[]} */
      const items = [];
      if (report.possibleSavings) items.push(`Possible savings: up to ${money(report.possibleSavings.cost30d)} ${possibleSavingsCaveat(report.possibleSavings)}`, '');
      let group = null;
      for (const c of report.candidates.slice(0, CANDIDATE_LIMIT)) {
        if (c.strength !== group) items.push(...(group ? [''] : []), `*${STRENGTH_LABEL[c.strength]}*`, '');
        group = c.strength;
        const fix = c.plutusFix === 'pull_request' ? `. [${PR_LINE}](${plutusFixUrl('md', c.id)})` : '';
        items.push(`- ${escapeMd(c.title)}: ${money(c.cost30d)} in 30 days. ${escapeMd(c.why)}${fix}`);
      }
      if (report.candidates.length > CANDIDATE_LIMIT) items.push(`- ${moreCandidatesLine(report.candidates.length - CANDIDATE_LIMIT)}`);
      blocks.push(['**Candidates to review** (places to look, not proven findings)', '', ...items].join('\n'));
    }
  }

  const basis = [...report.notes, ...report.basis].map(escapeMd);
  basis.push(escapeMd(freshnessLine(report)));
  if (report.aws) basis.push(awsRequestLine(report.aws));
  blocks.push(`<sub>${basis.join('<br>')}</sub>`);
  blocks.push(FOOTER);
  return `${blocks.join('\n\n')}\n`;
}

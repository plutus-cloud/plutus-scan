/** The copyable headline sentence and the freshness line shared by every renderer. */

import { formatMoney } from '../model.js';

const PROVIDER_NAMES = {
  aws: 'AWS', azure: 'Azure', gcp: 'GCP', oci: 'OCI', openai: 'OpenAI', anthropic: 'Anthropic',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/** @param {string} slug @returns {string} display name, or the slug as-is when unknown */
export function providerName(slug) {
  return PROVIDER_NAMES[/** @type {keyof typeof PROVIDER_NAMES} */ (slug)] ?? slug;
}

/**
 * Money with an explicit sign: `+$1,610`, `-$1,610`, no sign when it rounds to zero.
 * @param {number} n @param {string} currency @returns {string}
 */
export function signedMoney(n, currency) {
  const body = formatMoney(Math.abs(n), currency);
  if (!/[1-9]/.test(body)) return body;
  return `${n > 0 ? '+' : '-'}${body}`;
}

/** @param {number} pct @returns {string} rounded whole percent with a sign, none at zero */
function signedPct(pct) {
  const r = Math.round(pct);
  if (r === 0) return '0%';
  return `${r > 0 ? '+' : '-'}${Math.abs(r)}%`;
}

/**
 * @typedef {{ provider: string, service: string, usageType: string|null, change: number }} Mover
 * @typedef {{ last30: { total: number, cloud: number, commitment: number, ai: number }, previous30Total: number|null,
 *   change: number|null, changePct: number|null, movers: Mover[],
 *   largestAnomaly: object|null, monthEnd: { month: string, monthToDate: number, projected: number }|null }} Headline
 */

/**
 * Whether there is commitment spend worth showing: at least half a cent either way, so it rounds to a cent.
 * @param {number|undefined} amount @returns {boolean}
 */
export const hasCommitment = (amount) => Math.abs(amount ?? 0) >= 0.005;

/**
 * The cloud, commitment and AI split as `$9,870 cloud, $3,200 commitments, $2,470 AI`; the commitments
 * part only when there is commitment spend.
 * @param {{ cloud: number, commitment?: number, ai: number }} split @param {string} currency @returns {string}
 */
export function splitText(split, currency) {
  const m = (n) => formatMoney(n, currency);
  const commitments = hasCommitment(split.commitment) ? `${m(/** @type {number} */ (split.commitment))} commitments, ` : '';
  return `${m(split.cloud)} cloud, ${commitments}${m(split.ai)} AI`;
}

/**
 * The one-line summary, in the exact shape of the design.
 * @param {Headline} headline @param {string} currency @returns {string}
 */
export function headlineSentence(headline, currency) {
  const m = (n) => formatMoney(n, currency);
  const { last30, previous30Total, changePct, movers, monthEnd } = headline;
  const parts = [];

  const compare = previous30Total === null
    ? 'no previous 30 days to compare'
    : changePct === null ? null : `${signedPct(changePct)} vs the previous 30`;
  parts.push(`Last 30 days: ${m(last30.total)} (${splitText(last30, currency)})`
    + `${compare ? `, ${compare}` : ''}.`);

  const mover = movers[0];
  if (mover) parts.push(`Biggest mover: ${moverName(mover)} ${signedMoney(mover.change, currency)}.`);

  if (monthEnd) {
    const name = MONTHS[Number(monthEnd.month.slice(5, 7)) - 1];
    parts.push(`Projected ${name} total: ${m(monthEnd.projected)}.`);
  }
  return parts.join(' ');
}

/**
 * A mover as `<Provider> <service>[ / <usage type without its region prefix>]`.
 * @param {Mover} mover @returns {string}
 */
export function moverName(mover) {
  const usage = mover.usageType ? ` / ${mover.usageType.replace(/^[A-Z0-9]+-/, '')}` : '';
  return `${providerName(mover.provider)} ${mover.service}${usage}`;
}

/**
 * The Cost Explorer request line. Cost Explorer bills in US dollars whatever the report currency.
 * @param {{ billedRequests: number, cost: number }} aws @returns {string}
 */
export function awsRequestLine(aws) {
  return `AWS Cost Explorer: ${aws.billedRequests} requests, ${formatMoney(aws.cost, 'USD')}.`;
}

/**
 * @param {{ lastCompleteDay: string, currency: string|null }} report
 * @returns {string}
 */
export function freshnessLine(report) {
  return `Last complete day: ${report.lastCompleteDay}. Currency: ${report.currency ?? 'USD'}.`;
}

/**
 * The two groups candidates are shown in, named for the reader. `strong` is a billing line that is itself
 * evidence of something usually worth changing; `look` is a legitimate cost that is only sometimes waste.
 * Plain text, shared by every output.
 * @type {Record<import('../analysis/candidates.js').Strength, string>}
 */
export const STRENGTH_LABEL = { strong: 'Often worth changing', look: 'Worth a look' };

/**
 * A ceiling on what the strongest candidates could save: their last 30 days of spend, since a line
 * cannot save more than it costs. Only the "Often worth changing" group counts; the ones worth a look
 * are legitimate costs and would swamp the figure. Null when there is nothing in that group.
 * @param {{ strength: string, cost30d: number }[]} candidates
 * @returns {{ count: number, cost30d: number }|null}
 */
export function possibleSavings(candidates) {
  const strong = candidates.filter((c) => c.strength === 'strong');
  if (strong.length === 0) return null;
  return { count: strong.length, cost30d: strong.reduce((s, c) => s + c.cost30d, 0) };
}

/** @param {{ count: number }} ps @returns {string} the one-line caveat under the figure */
export const possibleSavingsCaveat = (ps) => `in 30 days if ${ps.count === 1 ? 'it is' : `all ${ps.count} are`} waste. The bill cannot say.`;

/**
 * The line that ends a candidates list cut to its top few: how many more there are and where they are
 * listed in full. Plain text, so every output (terminal, dashboard, Markdown) uses it as is.
 * @param {number} more @returns {string}
 */
export const moreCandidatesLine = (more) => `and ${more} more, listed in --json and the HTML report`;

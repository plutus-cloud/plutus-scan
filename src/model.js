/**
 * Row model, report window and money formatting shared by every source and renderer.
 */

/** @typedef {'cloud'|'ai'|'commitment'} Kind  commitment: Savings Plans and Reserved Instance charges */
/** @typedef {{ date: string, provider: string, kind: Kind, service: string,
 *   account: string|null, project: string|null, usageType: string|null,
 *   cost: number, currency: string, monthly?: true }} Row
 * `monthly` marks a charge billed once on the 1st for the calendar month it opens (tax, a monthly
 * Reserved Instance fee); the daily views spread it over that month. Absent on every other row. */
/** @typedef {{ provider: string, key: string, taggedCost: number, untaggedCost: number }} TagCoverage */
/** @typedef {{ date: string, repo: string, name: string, url: string }} Release */
/** @typedef {{ source: string, kind: 'http'|'aws-cli', target: string,
 *   credential: string|null, billed: boolean }} RequestDescriptor */
/** @typedef {{ login: string, kind: 'organization'|'user', repos: number, excluded: number,
 *   withReleases: number, releases: number, visiblePrivate: number }} GithubOwner
 * One org or user read by `--github <owner>`: repos scanned (not archived, not forks, not excluded),
 * how many had releases in the window, and how many of the scanned repos were private. */
/** @typedef {{ rows: Row[], detailRows: Row[], candidateRows?: Row[], tagCoverage: TagCoverage[],
 *   releases: Release[], notes: string[], basis: string[],
 *   github?: { owners: GithubOwner[], repos: { repo: string, releases: number }[], tokenSource?: string|null } }} SourceResult
 * `detailRows` feed the usage-type drill-down. `candidateRows`, when present, feed the candidates
 * instead of `detailRows` (live AWS queries them separately); other sources leave it unset. `github`
 * is set by the GitHub source only, for its status line; `tokenSource` names where its token came from
 * ("gh login", "GITHUB_TOKEN"), never the token. */
/** @typedef {{ start: string, end: string, days: number }} Window   // inclusive */

const MS_PER_DAY = 86400000;
const MAX_DAYS = 395;

/** Raised for invalid user input (flags, options). */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** @param {number} ms @returns {string} */
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {string} date YYYY-MM-DD @returns {number} UTC midnight in ms */
const dayMs = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/**
 * Add n days (may be negative) to a YYYY-MM-DD date.
 * @param {string} date @param {number} n @returns {string}
 */
export function addDays(date, n) {
  return isoDay(dayMs(date) + n * MS_PER_DAY);
}

/**
 * Compute the inclusive report window. `end` defaults to today (UTC) minus 2 days.
 * @param {{ days?: number, end?: string, today?: Date }} [opts]
 * @returns {Window}
 */
export function computeWindow({ days = 90, end, today = new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new UsageError(`--days must be a whole number between 1 and ${MAX_DAYS}.`);
  }
  const last = end ?? addDays(today.toISOString().slice(0, 10), -2);
  return { start: addDays(last, -(days - 1)), end: last, days };
}

/** @param {Window} window @returns {string[]} every date in the window, inclusive */
export function eachDay(window) {
  const out = [];
  for (let d = window.start; d <= window.end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The last n days ending at window.end.
 * @param {Window} window @param {number} n @returns {{ start: string, end: string }}
 */
export function lastNDays(window, n) {
  return { start: addDays(window.end, -(n - 1)), end: window.end };
}

/**
 * Keep rows whose date falls inside the window, inclusive.
 * @param {Row[]} rows @param {{ start: string, end: string }} window @returns {Row[]}
 */
export function clampToWindow(rows, window) {
  return rows.filter((r) => r.date >= window.start && r.date <= window.end);
}

/**
 * Keep only the dominant currency, chosen by absolute total.
 * @param {Row[]} rows
 * @returns {{ currency: string|null, rows: Row[], excluded: Record<string, number> }}
 */
export function pickCurrency(rows) {
  /** @type {Map<string, number>} */
  const abs = new Map();
  for (const r of rows) {
    abs.set(r.currency, (abs.get(r.currency) ?? 0) + Math.abs(r.cost));
  }
  let currency = null;
  for (const [cur, total] of abs) {
    if (currency === null || total > /** @type {number} */ (abs.get(currency))) currency = cur;
  }
  /** @type {Record<string, number>} */
  const excluded = {};
  for (const [cur, total] of abs) if (cur !== currency) excluded[cur] = total;
  return { currency, rows: rows.filter((r) => r.currency === currency), excluded };
}

/** @returns {SourceResult} */
export function emptyResult() {
  return { rows: [], detailRows: [], tagCoverage: [], releases: [], notes: [], basis: [] };
}

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

/**
 * A safe ISO-style currency code: three capital letters, else `XXX` (no currency).
 * @param {unknown} value @returns {string}
 */
export function currencyCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'XXX';
}

/**
 * Format an amount: whole units at 100 or more, cents below, thousands separators.
 * @param {number} n @param {string} currency @returns {string}
 */
export function formatMoney(n, currency) {
  const whole = Math.abs(n) >= 100;
  const digits = whole ? 0 : 2;
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const negative = n < 0 && /[1-9]/.test(body);
  const prefix = SYMBOLS[/** @type {keyof typeof SYMBOLS} */ (currency)] ?? `${currency} `;
  return `${negative ? '-' : ''}${prefix}${body}`;
}

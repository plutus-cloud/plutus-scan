// AWS source: Cost Explorer through the user's `aws` CLI. The command builders
// below feed both fetchAws and describeAws, so --dry-run prints what would run.
import { SourceError } from '../transport.js';
import { addDays, currencyCode, emptyResult, lastNDays } from '../model.js';
import { topServicesByChange } from '../analysis/drivers.js';

/** @typedef {ReturnType<typeof import('../transport.js').createTransport>} Transport */
/** @typedef {import('../model.js').Row} Row */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {import('../model.js').SourceResult} SourceResult */
/** @typedef {import('../model.js').RequestDescriptor} RequestDescriptor */

const SOURCE = 'aws';
const BASIS = 'AWS: UnblendedCost from Cost Explorer, including credits, refunds and tax as billed.';
const DRILL_DAYS = 60;
const CANDIDATE_DAYS = 30;
const TOP_SERVICES = 3;
const TYPICAL_MIN = 5;
/** The steps of a run in order, as a cap note names them. */
const STEPS = ['the daily spend', 'the usage type drill-down', 'candidates', 'tag coverage'];
/** The same steps as a progress view shows them while they run. */
const STEP_PROGRESS = ['fetching daily spend', 'fetching usage types', 'finding candidates', 'reading tag coverage'];

const NOTE_DENIED = 'AWS: access denied. The caller needs ce:GetCostAndUsage; with AWS Organizations the call must run in the management account (a member account sees only its own spend).';
const NOTE_NOT_ENABLED = 'AWS: Cost Explorer is not enabled for this account. Enable it at https://console.aws.amazon.com/cost-management/home.';
const NOTE_TAGS_DENIED = "AWS: cost allocation tags can't be listed from this account (a member account of an AWS Organization is denied them; the management account can read them), so untagged share can't be measured.";
const NOTE_NO_TAGS = "AWS: no cost allocation tags are activated, so untagged share can't be measured.";

/**
 * Record types that are commitment spend (Savings Plans and Reserved Instances), not usage. Cost
 * Explorer has named the reservation fees more than one way (`Upfront` for the fee charged on
 * purchase, `Recurring` or `RIFee` for the monthly one), so each spelling is listed.
 */
export const COMMITMENT_RECORD_TYPES = ['SavingsPlanRecurringFee', 'SavingsPlanUpfrontFee', 'RIFee', 'Recurring',
  'Recurring reservation fee', 'Fee', 'Upfront', 'Upfront reservation fee'];
/** Credits and refunds stay in their own rows so they never net into a day's usage. */
const CREDIT_RECORD_TYPES = new Set(['credit', 'refund']);
/** Record types compared without case, spaces or underscores. @param {string} t */
const norm = (t) => t.toLowerCase().replace(/[\s_-]+/g, '');
const SAVINGS_PLAN_TYPES = new Set(['savingsplanrecurringfee', 'savingsplanupfrontfee']);
const RESERVATION_TYPES = new Set(['rifee', 'recurring', 'recurringreservationfee']);
const COMMITMENT_TYPES = new Set(COMMITMENT_RECORD_TYPES.map(norm));
/** Usage types of Reserved Instance fees, which are commitment spend whatever their record type. */
const RESERVATION_USAGE = /(^|[-:])HeavyUsage|ReservedHostUsage/;
/** Cost Explorer expression that leaves out the commitment record types. */
const NOT_COMMITMENT = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: COMMITMENT_RECORD_TYPES } } };
/** The commitment fees plus the record types that never carry a tag. */
const NOT_TAGGABLE = { Not: { Dimensions: { Key: 'RECORD_TYPE',
  Values: [...COMMITMENT_RECORD_TYPES, 'SavingsPlanNegation', 'Tax', 'Credit', 'Refund'] } } };

/**
 * Kind and readable service label for one daily SERVICE x RECORD_TYPE group. Savings Plan fees keep
 * the Cost Explorer service name; monthly reservation fees become `<service> reservations`, and
 * upfront fees `<service> upfront fees`.
 * @param {string} service @param {string} recordType
 * @returns {{ kind: 'cloud'|'commitment', service: string }}
 */
export function classifyRecord(service, recordType) {
  const t = norm(recordType);
  if (!COMMITMENT_TYPES.has(t)) return { kind: 'cloud', service };
  if (SAVINGS_PLAN_TYPES.has(t)) return { kind: 'commitment', service };
  return { kind: 'commitment', service: RESERVATION_TYPES.has(t) ? `${service} reservations` : `${service} upfront fees` };
}

/**
 * Record types that can be billed once a month, on the 1st, for the month: tax, the monthly reservation
 * fee and the Savings Plan recurring fee. Marked on the 1st only; the daily views spread one only when
 * it is most of its month, so a fee that Cost Explorer shows every day stays as billed.
 */
const MONTHLY_TYPES = new Set(['tax', ...RESERVATION_TYPES, 'savingsplanrecurringfee']);

/** @param {string} recordType @returns {boolean} a credit or refund */
export const isCreditRecord = (recordType) => CREDIT_RECORD_TYPES.has(norm(recordType));

/**
 * Quote one argument for a POSIX shell when it holds anything beyond plain word characters,
 * so a printed command line can be pasted as is.
 * @param {string} arg @returns {string}
 */
export function shellQuote(arg) {
  return /^[A-Za-z0-9_\-.,:/=@%+]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Cost Explorer time period; End is exclusive. */
const period = (p) => `Start=${p.start},End=${addDays(p.end, 1)}`;
const dim = (key) => `Type=DIMENSION,Key=${key}`;

/** @param {{start:string,end:string}} p @param {'DAILY'|'MONTHLY'} granularity @param {string[]} groupBy @param {string|null} [filter] @param {string|null} [token] @param {'UnblendedCost'|'AmortizedCost'} [metric] */
function costArgs(p, granularity, groupBy, filter = null, token = null, metric = 'UnblendedCost') {
  return [
    'ce', 'get-cost-and-usage',
    '--time-period', period(p),
    '--granularity', granularity,
    '--metrics', metric,
    ...(filter ? ['--filter', filter] : []),
    '--group-by', ...groupBy,
    ...(token ? ['--next-page-token', token] : []),
  ];
}

export const dailyArgs = (/** @type {Window} */ w, token = null) =>
  costArgs(w, 'DAILY', [dim('SERVICE'), dim('RECORD_TYPE')], null, token);

/** @param {string[]|string} services a list, or a placeholder written into the JSON as is */
const drillFilter = (services) => {
  const values = Array.isArray(services) ? JSON.stringify(services) : services;
  return `{"And":[{"Dimensions":{"Key":"SERVICE","Values":${values}}},${JSON.stringify(NOT_COMMITMENT)}]}`;
};

/** @param {Window} w @param {string[]} services @param {string|null} [token] */
export const drillArgs = (w, services, token = null) =>
  costArgs(drillPeriod(w), 'DAILY', [dim('SERVICE'), dim('USAGE_TYPE')], drillFilter(services), token);

export const candidateArgs = (/** @type {Window} */ w, token = null) =>
  costArgs(candidatePeriod(w), 'MONTHLY', [dim('SERVICE'), dim('USAGE_TYPE')], JSON.stringify(NOT_COMMITMENT), token);

export const tagListArgs = () => ['ce', 'list-cost-allocation-tags', '--status', 'Active', '--type', 'UserDefined'];

/** Usage only, and AmortizedCost unlike every other query: see docs/design.md, step 5. */
export const tagArgs = (/** @type {Window} */ w, /** @type {string} */ key, token = null) =>
  costArgs(candidatePeriod(w), 'MONTHLY', [`Type=TAG,Key=${key}`], JSON.stringify(NOT_TAGGABLE), token, 'AmortizedCost');

/** @param {Window} w */
const clampStart = (w, n) => {
  const p = lastNDays(w, n);
  return { start: p.start < w.start ? w.start : p.start, end: p.end };
};
const drillPeriod = (/** @type {Window} */ w) => clampStart(w, DRILL_DAYS);
const candidatePeriod = (/** @type {Window} */ w) => clampStart(w, CANDIDATE_DAYS);

/**
 * Whether the aws CLI is usable with working credentials. Unbilled.
 * @param {Transport} transport
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function awsAvailable(transport) {
  try {
    await transport.aws(SOURCE, ['sts', 'get-caller-identity']);
    return { ok: true };
  } catch (e) {
    if (e instanceof SourceError && e.code === 'ENOENT') {
      return { ok: false, reason: 'aws CLI v2 not found on PATH, so AWS was skipped.' };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `aws sts get-caller-identity failed (${msg}), so AWS was skipped.` };
  }
}

/**
 * The requests fetchAws would make, without calling anything. The drill-down filter
 * and tag key depend on live data, so they are shown as placeholders.
 * @param {{ window: Window, maxTagKeys?: number, maxRequests?: number|null, profile?: string|null }} opts
 * @returns {{ requests: RequestDescriptor[], estimate: { min: number, max: number|null } }}
 * `estimate.max` is null with no cap: every page of results is one more request.
 */
export function describeAws({ window, maxRequests = null, profile = null }) {
  const calls = [
    dailyArgs(window),
    costArgs(drillPeriod(window), 'DAILY', [dim('SERVICE'), dim('USAGE_TYPE')],
      drillFilter('[<top 3 services by 30-day change>]')),
    candidateArgs(window),
    tagListArgs(),
    tagArgs(window, '<active tag key>'),
  ];
  const requests = calls.map((args) => ({
    source: SOURCE,
    kind: /** @type {'aws-cli'} */ ('aws-cli'),
    target: `aws ${[...args, '--output', 'json', '--no-cli-pager', ...(profile ? ['--profile', profile] : [])].map(shellQuote).join(' ')}`,
    credential: null,
    billed: true,
  }));
  const min = maxRequests === null ? TYPICAL_MIN : Math.min(TYPICAL_MIN, maxRequests);
  return { requests, estimate: { min, max: maxRequests } };
}

/** @param {unknown} e @returns {string} */
function noteFor(e) {
  const code = e instanceof SourceError ? e.code : null;
  const msg = e instanceof Error ? e.message : String(e);
  if (code === 'AccessDeniedException' || /AccessDeniedException/.test(msg)) return NOTE_DENIED;
  if (code === 'DataUnavailableException' || /DataUnavailableException|not enabled/i.test(msg)) return NOTE_NOT_ENABLED;
  return `AWS: ${msg}`;
}

/** @param {string[]} items @returns {string} `a`, `a and b`, `a, b and c` */
const listing = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The note for a run cut short by --max-aws-requests, naming what was skipped.
 * @param {number} cap @param {number} step index into STEPS where the cap was hit
 * @param {boolean} partial whether that step had already made a request
 */
function capNote(cap, step, partial) {
  const skipped = STEPS.slice(step).map((s, i) => (i === 0 && partial ? `part of ${s}` : s));
  return `AWS: stopped at ${cap} Cost Explorer requests (--max-aws-requests); skipped ${listing(skipped)}. `
    + `Totals are ${step === 0 ? 'incomplete' : 'complete'}.`;
}

/**
 * @param {Transport} transport
 * @param {{ window: Window, maxTagKeys?: number, maxRequests?: number|null, onStep?: (step: string) => void }} opts
 *   maxRequests null (the default) means no cap. `onStep` hears each step as it starts.
 * @returns {Promise<SourceResult>}
 */
export async function fetchAws(transport, { window, maxTagKeys = 5, maxRequests = null, onStep = () => {} }) {
  /** @type {SourceResult & { candidateRows: Row[] }} */
  const result = { ...emptyResult(), candidateRows: [] };
  result.basis.push(BASIS);
  let used = 0;
  let stopped = false;
  let step = 0;
  let usedInStep = 0;
  /** @param {number} i */
  const enter = (i) => { step = i; usedInStep = 0; onStep(STEP_PROGRESS[i]); };
  onStep(STEP_PROGRESS[0]);

  /** Reserve one billed call; false once the cap is reached. */
  const take = () => {
    if (maxRequests !== null && used >= maxRequests) {
      if (!stopped) {
        stopped = true;
        result.notes.push(capNote(maxRequests, step, usedInStep > 0));
      }
      return false;
    }
    used += 1;
    usedInStep += 1;
    return true;
  };

  /**
   * Run a paged Cost Explorer query; returns every ResultsByTime entry fetched.
   * @param {(token: string|null) => string[]} build
   */
  async function paged(build) {
    /** @type {any[]} */
    const out = [];
    let token = null;
    do {
      if (!take()) break;
      const res = await transport.aws(SOURCE, build(token), { billed: true });
      out.push(...(res?.ResultsByTime ?? []));
      token = res?.NextPageToken ?? null;
    } while (token);
    return out;
  }

  /** @param {any} g @returns {{ cost: number, currency: string }|null} null for a zero or missing amount */
  const amount = (g) => {
    const m = g.Metrics?.UnblendedCost ?? g.Metrics?.AmortizedCost;
    const cost = Number(m?.Amount);
    return !Number.isFinite(cost) || cost === 0 ? null : { cost, currency: currencyCode(m.Unit || 'USD') };
  };

  /**
   * Daily SERVICE x RECORD_TYPE groups, summed to one row per (date, service, kind), so record types
   * don't multiply rows. Credits and refunds get a row of their own, so the anomaly baselines can
   * leave them out. A row whose record types net to zero is dropped.
   * @param {any[]} results @returns {Row[]}
   */
  const dailyRows = (results) => {
    /** @type {Map<string, Row>} */
    const rows = new Map();
    for (const r of results) {
      for (const g of r.Groups ?? []) {
        const a = amount(g);
        if (!a) continue;
        const { kind, service } = classifyRecord(g.Keys[0], g.Keys[1] ?? '');
        const key = [r.TimePeriod.Start, service, kind, a.currency, isCreditRecord(g.Keys[1] ?? '')].join('\0');
        const monthly = r.TimePeriod.Start.endsWith('-01') && MONTHLY_TYPES.has(norm(g.Keys[1] ?? ''));
        const held = rows.get(key);
        if (held) {
          held.cost += a.cost;
          if (monthly) held.monthly = true;
        } else {
          rows.set(key, {
            date: r.TimePeriod.Start, provider: 'aws', kind, service, account: null, project: null,
            usageType: null, cost: a.cost, currency: a.currency,
            ...(monthly ? { monthly: /** @type {true} */ (true) } : {}),
          });
        }
      }
    }
    return [...rows.values()].filter((row) => Math.abs(row.cost) >= 1e-9);
  };

  /** SERVICE x USAGE_TYPE groups (commitment record types already filtered out, reservation usage types skipped). @param {any[]} results @returns {Row[]} */
  const usageRows = (results) => {
    /** @type {Row[]} */
    const rows = [];
    for (const r of results) {
      for (const g of r.Groups ?? []) {
        const a = amount(g);
        if (!a || RESERVATION_USAGE.test(g.Keys[1] ?? '')) continue;
        rows.push({
          date: r.TimePeriod.Start, provider: 'aws', kind: 'cloud', service: g.Keys[0], account: null, project: null,
          usageType: g.Keys[1] ?? null, cost: a.cost, currency: a.currency,
        });
      }
    }
    return rows;
  };

  // 1. Daily spend. A failure here fails the source: there is nothing to report without it.
  try {
    result.rows = dailyRows(await paged((t) => dailyArgs(window, t)));
  } catch (e) {
    throw new SourceError(SOURCE, e instanceof SourceError ? e.status : null, noteFor(e),
      e instanceof SourceError ? e.code : null);
  }
  if (stopped) return result;

  // Later steps degrade to a note and keep the daily rows.
  const attempt = async (fn) => {
    try {
      await fn();
    } catch (e) {
      result.notes.push(noteFor(e));
    }
  };

  // 2. Drill-down for the top services by change. Commitment rows carry labels, not Cost Explorer
  // service names, and their record types are filtered out of the drill-down, so they are not ranked.
  enter(1);
  const usage = result.rows.filter((r) => r.kind !== 'commitment');
  const top = topServicesByChange(usage, window, TOP_SERVICES).map((s) => s.service);
  if (top.length > 0) {
    await attempt(async () => {
      result.detailRows.push(...usageRows(await paged((t) => drillArgs(window, top, t))));
    });
  }
  if (stopped) return result;

  // 3. Candidates: usage types over the last 30 days, kept apart from rows and from the drill-down,
  // whose last 30 days they overlap.
  enter(2);
  await attempt(async () => {
    result.candidateRows.push(...usageRows(await paged((t) => candidateArgs(window, t))));
  });
  if (stopped) return result;

  // 4 and 5. Tag coverage.
  enter(3);
  await attempt(async () => {
    if (!take()) return;
    let listed;
    try {
      listed = await transport.aws(SOURCE, tagListArgs(), { billed: true });
    } catch (e) {
      // Spend was read fine; only the tag list is off limits. Say that, not that Cost Explorer is.
      if (noteFor(e) !== NOTE_DENIED) throw e;
      result.notes.push(NOTE_TAGS_DENIED);
      return;
    }
    const keys = (listed?.CostAllocationTags ?? []).map((t) => t.TagKey).filter(Boolean).slice(0, maxTagKeys);
    if (keys.length === 0) {
      result.notes.push(NOTE_NO_TAGS);
      return;
    }
    for (const key of keys) {
      if (stopped) break;
      let tagged = 0;
      let untagged = 0;
      let calls = 0;
      try {
        const results = await paged((t) => tagArgs(window, key, t));
        calls = results.length;
        for (const r of results) {
          for (const g of r.Groups ?? []) {
            const a = amount(g);
            if (!a) continue;
            if (g.Keys[0] === `${key}$`) untagged += a.cost;
            else tagged += a.cost;
          }
        }
      } catch (e) {
        result.notes.push(noteFor(e));
        continue;
      }
      if (calls > 0) result.tagCoverage.push({ provider: 'aws', key, taggedCost: tagged, untaggedCost: untagged });
    }
  });
  return result;
}

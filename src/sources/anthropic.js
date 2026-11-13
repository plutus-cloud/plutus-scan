// Anthropic source: the organization cost report with an admin key. Amounts are
// decimal strings in cents. Priority Tier spend is not in this API.
import { SourceError } from '../transport.js';
import { addDays, currencyCode, emptyResult } from '../model.js';

/** @typedef {ReturnType<typeof import('../transport.js').createTransport>} Transport */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {import('../model.js').SourceResult} SourceResult */
/** @typedef {import('../model.js').RequestDescriptor} RequestDescriptor */

const SOURCE = 'anthropic';
const CREDENTIAL = 'ANTHROPIC_ADMIN_KEY';
const BASE = 'https://api.anthropic.com/v1/organizations';
const BASIS = 'Anthropic: as reported by the cost report API; Priority Tier not included.';
const NOTE_NO_NAMES = 'Anthropic: workspace names unavailable, showing workspace ids.';
const NOTE_AUTH = 'Anthropic: the cost report API rejected the key. Check the admin key (ANTHROPIC_ADMIN_KEY) is an organization admin key (sk-ant-admin...).';
const DEFAULT_WORKSPACE = 'Default workspace';
const OTHER = 'Anthropic (other)';

/** @param {Window} w @param {string|null} [page] */
function costUrl(w, page = null) {
  return `${BASE}/cost_report?starting_at=${w.start}T00:00:00Z&ending_at=${addDays(w.end, 1)}T00:00:00Z`
    + '&bucket_width=1d&group_by[]=description&group_by[]=workspace_id&limit=31'
    + `${page ? `&page=${encodeURIComponent(page)}` : ''}`;
}

/** @param {string|null} [after] */
const workspacesUrl = (after = null) => `${BASE}/workspaces?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;

const headers = (/** @type {string} */ key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' });

/**
 * The requests fetchAnthropic would make for the first page, without calling anything.
 * @param {{ window: Window }} opts
 * @returns {RequestDescriptor[]}
 */
export function describeAnthropic({ window }) {
  return [costUrl(window), workspacesUrl()].map((target) => ({
    source: SOURCE, kind: /** @type {'http'} */ ('http'), target, credential: CREDENTIAL, billed: false,
  }));
}

/** @returns {Promise<Map<string,string>>} */
async function workspaceNames(transport, key) {
  const names = new Map();
  let after = null;
  do {
    const res = await transport.http(SOURCE, workspacesUrl(after), { headers: headers(key), credential: CREDENTIAL });
    for (const w of res?.data ?? []) if (w?.id) names.set(w.id, w.name || w.id);
    const last = res?.last_id ?? res?.data?.at(-1)?.id ?? null;
    after = res?.has_more && last && last !== after ? last : null;
  } while (after);
  return names;
}

/**
 * @param {Transport} transport
 * @param {{ window: Window, key: string }} opts
 * @returns {Promise<SourceResult>}
 */
export async function fetchAnthropic(transport, { window, key }) {
  const result = emptyResult();
  result.basis.push(BASIS);

  /** @type {any[]} */
  const buckets = [];
  try {
    let page = null;
    do {
      const res = await transport.http(SOURCE, costUrl(window, page), { headers: headers(key), credential: CREDENTIAL });
      buckets.push(...(res?.data ?? []));
      page = res?.has_more && res?.next_page ? res.next_page : null;
    } while (page);
  } catch (e) {
    if (e instanceof SourceError && (e.status === 401 || e.status === 403)) throw new SourceError(SOURCE, e.status, NOTE_AUTH);
    throw e;
  }

  /** @type {Map<string,string>} */
  let names = new Map();
  if (buckets.some((b) => (b.results ?? []).some((r) => r.workspace_id))) {
    try {
      names = await workspaceNames(transport, key);
    } catch {
      result.notes.push(NOTE_NO_NAMES);
    }
  }

  for (const b of buckets) {
    const date = String(b.starting_at).slice(0, 10);
    for (const r of b.results ?? []) {
      const cost = Number(r.amount) / 100;
      if (!Number.isFinite(cost) || cost === 0) continue;
      result.rows.push({
        date, provider: 'anthropic', kind: 'ai', service: r.model || r.description || r.cost_type || OTHER,
        account: null, project: r.workspace_id ? (names.get(r.workspace_id) ?? r.workspace_id) : DEFAULT_WORKSPACE,
        usageType: null, cost, currency: currencyCode(r.currency || 'usd'),
      });
    }
  }
  return result;
}

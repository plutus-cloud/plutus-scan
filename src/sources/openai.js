// OpenAI source: the organization costs API with an admin key. Amounts are dollars.
import { SourceError } from '../transport.js';
import { addDays, currencyCode, emptyResult } from '../model.js';

/** @typedef {ReturnType<typeof import('../transport.js').createTransport>} Transport */
/** @typedef {import('../model.js').Row} Row */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {import('../model.js').SourceResult} SourceResult */
/** @typedef {import('../model.js').RequestDescriptor} RequestDescriptor */

const SOURCE = 'openai';
const CREDENTIAL = 'OPENAI_ADMIN_KEY';
const BASE = 'https://api.openai.com/v1/organization';
const BASIS = 'OpenAI: as reported by the organization costs API.';
const NOTE_NO_PROJECTS = 'OpenAI: project breakdown unavailable for this organization.';
const NOTE_NO_PROJECT_NAMES = 'OpenAI: project names unavailable, showing project ids.';
const NOTE_404 = 'OpenAI: the costs API returned 404. Check this is an organization admin key (sk-admin-...).';
const NOTE_AUTH = 'OpenAI: the costs API rejected the key. Check the admin key (OPENAI_ADMIN_KEY) is an organization admin key (sk-admin-...).';
const OTHER = 'OpenAI (other)';

const unix = (/** @type {string} */ date) => Date.parse(`${date}T00:00:00Z`) / 1000;
const GROUP_BOTH = ['line_item', 'project_id'];
const GROUP_LINE = ['line_item'];

/** @param {Window} w @param {string[]} groups @param {string|null} [page] */
function costsUrl(w, groups, page = null) {
  return `${BASE}/costs?start_time=${unix(w.start)}&end_time=${unix(addDays(w.end, 1))}&bucket_width=1d`
    + `${groups.map((g) => `&group_by[]=${g}`).join('')}&limit=180${page ? `&page=${encodeURIComponent(page)}` : ''}`;
}

/** @param {string|null} [after] */
const projectsUrl = (after = null) => `${BASE}/projects?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;

const headers = (/** @type {string} */ key) => ({ Authorization: `Bearer ${key}` });

/**
 * The requests fetchOpenAI would make for the first page, without calling anything.
 * @param {{ window: Window }} opts
 * @returns {RequestDescriptor[]}
 */
export function describeOpenAI({ window }) {
  return [costsUrl(window, GROUP_BOTH), projectsUrl()].map((target) => ({
    source: SOURCE, kind: /** @type {'http'} */ ('http'), target, credential: CREDENTIAL, billed: false,
  }));
}

/** Follow next_page while has_more; returns every bucket. */
async function pagedCosts(transport, key, window, groups) {
  const buckets = [];
  let page = null;
  do {
    const res = await transport.http(SOURCE, costsUrl(window, groups, page), { headers: headers(key), credential: CREDENTIAL });
    buckets.push(...(res?.data ?? []));
    page = res?.has_more && res?.next_page ? res.next_page : null;
  } while (page);
  return buckets;
}

/** @returns {Promise<Map<string,string>>} */
async function projectNames(transport, key) {
  const names = new Map();
  let after = null;
  do {
    const res = await transport.http(SOURCE, projectsUrl(after), { headers: headers(key), credential: CREDENTIAL });
    for (const p of res?.data ?? []) if (p?.id) names.set(p.id, p.name || p.id);
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
export async function fetchOpenAI(transport, { window, key }) {
  const result = emptyResult();
  result.basis.push(BASIS);

  /** @type {any[]} */
  let buckets;
  try {
    try {
      buckets = await pagedCosts(transport, key, window, GROUP_BOTH);
    } catch (e) {
      if (!(e instanceof SourceError && e.status === 400)) throw e;
      buckets = await pagedCosts(transport, key, window, GROUP_LINE);
      result.notes.push(NOTE_NO_PROJECTS);
    }
  } catch (e) {
    if (e instanceof SourceError && e.status === 404) throw new SourceError(SOURCE, 404, NOTE_404);
    if (e instanceof SourceError && (e.status === 401 || e.status === 403)) throw new SourceError(SOURCE, e.status, NOTE_AUTH);
    throw e;
  }

  /** @type {Map<string,string>} */
  let names = new Map();
  if (buckets.some((b) => (b.results ?? []).some((r) => r.project_id))) {
    try {
      names = await projectNames(transport, key);
    } catch {
      result.notes.push(NOTE_NO_PROJECT_NAMES);
    }
  }

  for (const b of buckets) {
    const date = new Date(b.start_time * 1000).toISOString().slice(0, 10);
    for (const r of b.results ?? []) {
      const cost = Number(r.amount?.value);
      if (!Number.isFinite(cost) || cost === 0) continue;
      const model = String(r.line_item ?? '').split(',')[0].trim();
      result.rows.push({
        date, provider: 'openai', kind: 'ai', service: model || OTHER, account: null,
        project: r.project_id ? (names.get(r.project_id) ?? r.project_id) : null,
        usageType: null, cost, currency: currencyCode(r.amount?.currency || 'usd'),
      });
    }
  }
  return result;
}

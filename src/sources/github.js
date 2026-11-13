// GitHub source: published releases, used as chart markers. No cost data.
//
// `--github owner/repo` reads one repo's releases through REST, with or without a token.
// `--github owner` reads every repo of an org (or a user) through GraphQL, which needs a token: one
// query walks 100 repos at a time with each repo's newest releases inline, so a 200-repo org takes a
// handful of calls. A repo's releases are paged further only while its newest page is still inside
// the window. Drafts are skipped; prereleases are kept, as in repo mode, since they are often what a
// staging stack deploys.
import { UsageError, emptyResult } from '../model.js';
import { SourceError } from '../transport.js';

/** @typedef {ReturnType<typeof import('../transport.js').createTransport>} Transport */
/** @typedef {import('../model.js').Release} Release */
/** @typedef {import('../model.js').Window} Window */
/** @typedef {import('../model.js').SourceResult} SourceResult */
/** @typedef {import('../model.js').RequestDescriptor} RequestDescriptor */
/** @typedef {import('../model.js').GithubOwner} GithubOwner */
/** @typedef {{ orgs: string[], repos: string[], exclude: string[] }} GithubTargets */
/** @typedef {import('./github-auth.js').TokenSource} TokenSource */

const SOURCE = 'github';
const PER_PAGE = 100;
// Releases fetched inline per repo. Most repos ship fewer than this in a 90-day window, so the
// first query is usually all an org needs.
const INLINE_RELEASES = 20;
const GRAPHQL_URL = 'https://api.github.com/graphql';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** @param {string} s */
const lower = (s) => s.toLowerCase();

/** @param {string} repo */
function checkRepo(repo) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new UsageError(`Invalid GitHub repo "${repo}". Use the form owner/name.`);
  }
  return repo;
}

/**
 * Split `--github` values into orgs (no slash) and repos, and check `--github-exclude` against them.
 * Names compare without case, as on GitHub; each one is kept once.
 * @param {string[]} args @param {string[]} [exclude] @returns {GithubTargets}
 */
export function githubTargets(args, exclude = []) {
  const orgs = [];
  const repos = [];
  const seen = new Set();
  for (const arg of args) {
    if (typeof arg === 'string' && !arg.includes('/')) {
      if (!OWNER_RE.test(arg)) throw new UsageError(`Invalid GitHub org or user "${arg}". Use an org or user name, or owner/name for one repo.`);
    } else checkRepo(arg);
    if (seen.has(lower(arg))) continue;
    seen.add(lower(arg));
    (arg.includes('/') ? repos : orgs).push(arg);
  }
  const ex = [];
  for (const e of exclude) {
    if (typeof e !== 'string' || !REPO_RE.test(e)) throw new UsageError(`Invalid --github-exclude "${e}". Use the form owner/name.`);
    if (seen.has(lower(e))) throw new UsageError(`--github-exclude ${e} is also passed to --github.`);
    if (!orgs.some((o) => lower(o) === lower(e.split('/')[0]))) {
      throw new UsageError(`--github-exclude ${e} is not in any org passed to --github.`);
    }
    if (!ex.includes(lower(e))) ex.push(lower(e));
  }
  return { orgs, repos, exclude: ex };
}

/**
 * Refuse org mode without a token, before any request: GitHub's GraphQL API needs one, and
 * without one GitHub allows only 60 requests an hour.
 * @param {GithubTargets} targets @param {string|null} token @param {{ ghAuth?: boolean }} [opts] whether a gh login was looked for
 */
export function checkGithub(targets, token, { ghAuth = true } = {}) {
  if (targets.orgs.length && !token) {
    const org = targets.orgs[0];
    const fix = ghAuth
      ? 'Set GITHUB_TOKEN, pass --github-token, or sign in with gh auth login.'
      : 'Set GITHUB_TOKEN or pass --github-token (--no-gh-auth leaves the gh login unused).';
    throw new UsageError(`--github ${org} reads every repo in ${org}, which needs a GitHub token: the GraphQL API it uses `
      + `requires one, and without one GitHub allows only 60 requests an hour. ${fix}`);
  }
}

/** @param {string} repo @param {number} page */
const releasesUrl = (repo, page) => `https://api.github.com/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;

/**
 * The requests fetchGithub would make, without calling anything. A repo is one request per page of
 * releases; an org cannot be counted before it is read, so its entry is an estimate. The credential
 * is named by where the token came from, never by its value.
 * @param {{ targets: GithubTargets, tokenSource?: TokenSource|null }} opts
 * @returns {{ requests: RequestDescriptor[], estimates: string[] }}
 */
export function describeGithub({ targets, tokenSource = null }) {
  const credential = tokenSource;
  const http = /** @type {'http'} */ ('http');
  const requests = targets.repos.map((repo) => ({ source: SOURCE, kind: http, target: releasesUrl(repo, 1), credential, billed: false }));
  const estimates = [];
  for (const org of targets.orgs) {
    requests.push({ source: SOURCE, kind: http, target: GRAPHQL_URL, credential, billed: false });
    estimates.push(`GitHub ${org}: about 1 request per ${PER_PAGE} repos (one more if ${org} is a user, not an org), `
      + `plus 1 per repo with more than ${INLINE_RELEASES} releases in the window; free`);
  }
  return { requests, estimates };
}

const RELEASE_FIELDS = 'nodes { name tagName url isDraft isPrerelease createdAt publishedAt }';

/** @param {'organization'|'user'} kind */
const ownerQuery = (kind) => `query($login: String!, $after: String) {
  owner: ${kind}(login: $login) {
    login
    repositories(first: ${PER_PAGE}, after: $after, isArchived: false, isFork: false${kind === 'user' ? ', ownerAffiliations: [OWNER]' : ''}, orderBy: { field: NAME, direction: ASC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner isPrivate isArchived isFork
        releases(first: ${INLINE_RELEASES}, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          ${RELEASE_FIELDS}
        }
      }
    }
  }
}`;

const REPO_RELEASES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    releases(first: ${PER_PAGE}, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      ${RELEASE_FIELDS}
    }
  }
}`;

/** @param {string|null|undefined} iso @returns {string|null} the UTC day */
const day = (iso) => (typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : null);

/**
 * Keep a page's published releases inside the window, and say whether older ones could still be
 * inside it: pages run newest first by creation, so a page that starts before the window ends paging.
 * @param {any} connection @param {string} repo @param {Window} window @param {Release[]} out
 * @returns {string|null} the cursor of the next page worth reading
 */
function takeReleases(connection, repo, window, out) {
  let oldest = null;
  for (const r of Array.isArray(connection?.nodes) ? connection.nodes : []) {
    const created = day(r?.createdAt);
    if (created && (oldest === null || created < oldest)) oldest = created;
    if (r?.isDraft) continue;
    const date = day(r?.publishedAt) ?? created;
    if (!date || date < window.start || date > window.end) continue;
    out.push({ date, repo, name: String(r.name || r.tagName || ''), url: String(r.url ?? '') });
  }
  const more = connection?.pageInfo?.hasNextPage && typeof connection.pageInfo.endCursor === 'string';
  return more && oldest !== null && oldest >= window.start ? connection.pageInfo.endCursor : null;
}

/**
 * One GraphQL call. A NOT_FOUND error with no data is returned as null data, so the caller can try
 * the next kind of owner; any other error fails the source.
 * @param {Transport} transport @param {string} query @param {Record<string, unknown>} variables
 * @param {{ headers: Record<string,string>, credential: string|null }} auth
 */
async function graphql(transport, query, variables, { headers, credential }) {
  const res = await transport.http(SOURCE, GRAPHQL_URL, { method: 'POST', body: { query, variables }, headers, credential });
  const errors = Array.isArray(res?.errors) ? res.errors : [];
  const missing = errors.length > 0 && errors.every((e) => e?.type === 'NOT_FOUND');
  if (errors.length && !missing) {
    const msg = String(errors[0]?.message ?? 'GraphQL error').split('\n')[0].slice(0, 200);
    throw new SourceError(SOURCE, 200, msg, typeof errors[0]?.type === 'string' ? errors[0].type : null);
  }
  return res?.data ?? null;
}

/**
 * Every repo of one org, or of a user when no org has that name.
 * @param {Transport} transport @param {string} login
 * @param {{ window: Window, exclude: string[], auth: { headers: Record<string,string>, credential: string|null } }} opts
 * @returns {Promise<{ owner: GithubOwner, releases: Release[], names: Set<string> }|null>} null when no org or user has the name
 */
async function readOwner(transport, login, { window, exclude, auth }) {
  /** @type {'organization'|'user'} */
  let kind = 'organization';
  let data = await graphql(transport, ownerQuery(kind), { login, after: null }, auth);
  if (!data?.owner) {
    kind = 'user';
    data = await graphql(transport, ownerQuery(kind), { login, after: null }, auth);
    if (!data?.owner) return null;
  }
  const name = String(data.owner.login ?? login);
  /** @type {Release[]} */
  const releases = [];
  const names = new Set();
  const withReleases = new Set();
  let repos = 0;
  let excluded = 0;
  let visiblePrivate = 0;
  /** @type {{ repo: string, cursor: string }[]} */
  const deeper = [];
  for (;;) {
    const conn = data.owner.repositories;
    for (const node of Array.isArray(conn?.nodes) ? conn.nodes : []) {
      const repo = typeof node?.nameWithOwner === 'string' ? node.nameWithOwner : null;
      // The query already leaves these out; checking again keeps a user's collaborations out too.
      if (!repo || node.isArchived || node.isFork || lower(repo.split('/')[0]) !== lower(name)) continue;
      names.add(lower(repo));
      if (exclude.includes(lower(repo))) {
        excluded += 1;
        continue;
      }
      repos += 1;
      if (node.isPrivate) visiblePrivate += 1;
      const before = releases.length;
      const cursor = takeReleases(node.releases, repo, window, releases);
      if (releases.length > before) withReleases.add(repo);
      if (cursor) deeper.push({ repo, cursor });
    }
    const page = conn?.pageInfo;
    if (!page?.hasNextPage || typeof page.endCursor !== 'string') break;
    data = await graphql(transport, ownerQuery(kind), { login, after: page.endCursor }, auth);
    if (!data?.owner) break;
  }
  for (const { repo, cursor: first } of deeper) {
    const [owner, repoName] = repo.split('/');
    for (let cursor = first; cursor;) {
      const res = await graphql(transport, REPO_RELEASES_QUERY, { owner, name: repoName, after: cursor }, auth);
      const before = releases.length;
      cursor = takeReleases(res?.repository?.releases, repo, window, releases);
      if (releases.length > before) withReleases.add(repo);
    }
  }
  return {
    owner: { login: name, kind, repos, excluded, withReleases: withReleases.size, releases: releases.length, visiblePrivate },
    releases,
    names,
  };
}

/**
 * One repo through REST, page by page until the releases predate the window.
 * @param {Transport} transport @param {string} repo @param {Window} window @param {Record<string,string>} headers @param {string|null} credential
 * @returns {Promise<Release[]>}
 */
async function readRepo(transport, repo, window, headers, credential) {
  const out = [];
  for (let page = 1; ; page++) {
    const items = await transport.http(SOURCE, releasesUrl(repo, page), { headers, credential });
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) break;
    let oldest = null;
    for (const r of list) {
      const date = day(r?.published_at);
      if (!date) continue;
      if (oldest === null || date < oldest) oldest = date;
      if (r.draft || date < window.start || date > window.end) continue;
      out.push({ date, repo, name: r.name || r.tag_name, url: r.html_url });
    }
    if (list.length < PER_PAGE || (oldest !== null && oldest < window.start)) break;
  }
  return out;
}

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {Transport} transport
 * @param {{ targets: GithubTargets, window: Window, token?: string|null, tokenSource?: TokenSource|null }} opts
 * `tokenSource` says where the token came from; it names the credential in the transport log and the notes.
 * @returns {Promise<SourceResult>}
 */
export async function fetchGithub(transport, { targets, window, token = null, tokenSource = null }) {
  checkGithub(targets, token);
  const result = emptyResult();
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const credential = token ? tokenSource ?? 'GITHUB_TOKEN' : null;
  const auth = { headers, credential };
  /** @type {GithubOwner[]} */
  const owners = [];
  const covered = new Set();

  for (const login of targets.orgs) {
    const read = await readOwner(transport, login, { window, exclude: targets.exclude, auth });
    if (!read) {
      result.notes.push(`GitHub: no org or user named ${login} is visible to this token.`);
      continue;
    }
    const o = read.owner;
    owners.push(o);
    result.releases.push(...read.releases);
    for (const n of read.names) covered.add(n);
    const skipped = o.excluded ? ` (${o.excluded} excluded)` : '';
    result.notes.push(`GitHub: ${count(o.repos, 'repo')} in ${o.login}${skipped}, ${o.withReleases} with releases in this window.`);
    if (o.repos > 0 && o.visiblePrivate === 0) {
      result.notes.push(`GitHub: this token could see only public repos in ${o.login}. If ${o.login} has private repos, the token needs read access to them.`);
    }
  }
  // A repo its org scan already read is not read twice; an archived or forked one still is, since it was asked for.
  const repos = [];
  for (const repo of targets.repos) {
    if (covered.has(lower(repo))) continue;
    const list = await readRepo(transport, repo, window, headers, credential);
    repos.push({ repo, releases: list.length });
    result.releases.push(...list);
  }
  if (credential) result.notes.push(`GitHub: read with a token via ${credential}.`);
  result.releases.sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo));
  result.github = { owners, repos, tokenSource: credential };
  return result;
}

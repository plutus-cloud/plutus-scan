import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/transport.js';
import { UsageError } from '../../src/model.js';
import { checkGithub, describeGithub, fetchGithub, githubTargets } from '../../src/sources/github.js';
import { sourceSummary } from '../../src/ui/progress.js';
import { fakeFetch } from '../helpers/http-fake.js';

const window = { start: '2026-07-31', end: '2026-10-28', days: 90 };
const TOKEN = 'ghp_secret';
const rel = (tag, published_at, extra = {}) => ({
  tag_name: tag, name: null, published_at, draft: false, html_url: `https://github.com/acme/app/releases/tag/${tag}`, ...extra,
});
const repoOnly = (repos) => githubTargets(repos);

test('stops paging once releases predate the window', async () => {
  const calls = [];
  const full = (n, iso) => Array.from({ length: 100 }, (_, i) => rel(`v${n}.${i}`, iso));
  const pages = {
    1: [rel('v3.0', '2026-10-29T10:00:00Z'), rel('v2.0', '2026-10-20T23:30:00Z', { name: 'Two' }), rel('d', '2026-10-10T00:00:00Z', { draft: true }),
      ...full(9, '2026-10-05T00:00:00Z').slice(3)],
    2: [rel('v1.5', '2026-08-01T00:00:00Z'), ...full(8, '2026-07-31T00:00:00Z').slice(2), rel('v1.0', '2026-07-30T23:59:59Z')],
    3: [rel('old', '2026-01-01T00:00:00Z')],
  };
  const transport = createTransport({ fetchImpl: fakeFetch((u) => ({ body: pages[u.searchParams.get('page')] ?? [] }), calls) });
  const res = await fetchGithub(transport, { targets: repoOnly(['acme/app']), window, token: TOKEN });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/repos/acme/app/releases');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.searchParams.get('per_page'), '100');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  const names = res.releases.map((r) => r.name);
  assert.ok(names.includes('Two'));
  assert.ok(!names.includes('d'));
  assert.ok(!names.includes('v3.0'), 'after window end');
  assert.ok(!names.includes('v1.0'), 'before window start');
  assert.equal(res.releases.find((r) => r.name === 'Two').date, '2026-10-20');
  assert.equal(res.releases.find((r) => r.name === 'Two').repo, 'acme/app');
  assert.match(res.releases[0].url, /^https:\/\/github\.com\//);
  const dates = res.releases.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort());
  assert.deepEqual(res.rows, []);
  assert.deepEqual(res.notes, ['GitHub: read with a token via GITHUB_TOKEN.']);
  assert.deepEqual(res.basis, []);
});

test('works without a token', async () => {
  const calls = [];
  const transport = createTransport({ fetchImpl: fakeFetch(() => ({ body: [rel('v1', '2026-09-01T12:00:00Z')] }), calls) });
  const res = await fetchGithub(transport, { targets: repoOnly(['acme/app']), window });
  assert.equal('Authorization' in calls[0].headers, false);
  assert.equal(res.releases.length, 1);
  assert.equal(res.releases[0].name, 'v1');
  assert.equal(transport.log[0].credential, null);
  assert.equal(transport.log[0].source, 'github');
  assert.equal(sourceSummary('github', res, { requests: 1 }), 'acme/app: 1 release; 1 request');
});

test('rejects invalid repo strings and describes first pages', () => {
  assert.throws(() => githubTargets(['a/b/c']), UsageError);
  assert.throws(() => githubTargets(['-bad']), UsageError);
  assert.throws(() => githubTargets(['acme/']), UsageError);
  const d = describeGithub({ targets: repoOnly(['acme/app', 'x/y']), tokenSource: 'GITHUB_TOKEN' });
  assert.equal(d.requests.length, 2);
  assert.deepEqual(d.estimates, []);
  assert.equal(d.requests[0].target, 'https://api.github.com/repos/acme/app/releases?per_page=100&page=1');
  assert.equal(d.requests[0].credential, 'GITHUB_TOKEN');
  assert.equal(d.requests[0].billed, false);
  assert.equal(describeGithub({ targets: repoOnly(['x/y']) }).requests[0].credential, null);
});

test('an org or user name sorts apart from repos, and excludes must name a repo of a scanned org', () => {
  assert.deepEqual(githubTargets(['acme', 'other/app', 'ACME', 'acme/app', 'Acme/App']), { orgs: ['acme'], repos: ['other/app', 'acme/app'], exclude: [] });
  assert.deepEqual(githubTargets(['acme'], ['acme/Noisy', 'acme/noisy']).exclude, ['acme/noisy']);
  assert.throws(() => githubTargets(['acme'], ['other/noisy']), /not in any org passed to --github/);
  assert.throws(() => githubTargets(['acme', 'acme/app'], ['acme/app']), /also passed to --github/);
  assert.throws(() => githubTargets(['acme'], ['noisy']), /Use the form owner\/name/);
  const d = describeGithub({ targets: githubTargets(['acme', 'x/y']), tokenSource: 'gh login' });
  assert.deepEqual(d.requests.map((r) => r.target), ['https://api.github.com/repos/x/y/releases?per_page=100&page=1', 'https://api.github.com/graphql']);
  assert.equal(d.estimates.length, 1);
  assert.match(d.estimates[0], /^GitHub acme: about 1 request per 100 repos/);
});

test('org mode without a token is refused, saying why', async () => {
  assert.throws(() => checkGithub(githubTargets(['acme']), null), (e) => e instanceof UsageError
    && /needs a GitHub token/.test(e.message) && /60 requests an hour/.test(e.message) && /GITHUB_TOKEN/.test(e.message));
  assert.doesNotThrow(() => checkGithub(githubTargets(['acme/app']), null));
  const calls = [];
  const transport = createTransport({ fetchImpl: fakeFetch(() => ({ body: {} }), calls) });
  await assert.rejects(fetchGithub(transport, { targets: githubTargets(['acme']), window }), UsageError);
  assert.equal(calls.length, 0);
});

// A fake GitHub GraphQL API. `owners` maps a login to { kind, repos }; each repo is
// { name, isPrivate?, isArchived?, isFork?, releases: [...] } with releases newest first.
function graphqlFake(owners, calls = []) {
  const page = (list, after, size) => {
    const from = after ? Number(after) : 0;
    const nodes = list.slice(from, from + size);
    return { nodes, pageInfo: { hasNextPage: from + size < list.length, endCursor: String(from + size) } };
  };
  const releaseNode = (r) => ({ isDraft: false, isPrerelease: false, url: `https://github.com/x/${r.tagName}`, name: null, ...r });
  return fakeFetch((u, headers, { method, body }) => {
    assert.equal(u.href, 'https://api.github.com/graphql');
    assert.equal(method, 'POST');
    const { query, variables } = body;
    if (query.includes('repository(owner')) {
      const owner = owners[variables.owner];
      const repo = owner.repos.find((r) => r.name === variables.name);
      const rels = page(repo.releases.map(releaseNode), variables.after, 100);
      return { body: { data: { repository: { releases: rels } } } };
    }
    const kind = query.includes('owner: organization(') ? 'organization' : 'user';
    const owner = owners[variables.login];
    if (!owner || owner.kind !== kind) {
      return { body: { data: { owner: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a ${kind} with the login of '${variables.login}'.` }] } };
    }
    const repos = page(owner.repos, variables.after, 100);
    repos.nodes = repos.nodes.map((r) => ({
      nameWithOwner: `${variables.login}/${r.name}`, isPrivate: Boolean(r.isPrivate), isArchived: Boolean(r.isArchived), isFork: Boolean(r.isFork),
      releases: page(r.releases.map(releaseNode), null, 20),
    }));
    return { body: { data: { owner: { login: variables.login, repositories: { totalCount: owner.repos.length, ...repos } } } } };
  }, calls);
}

const at = (date) => `${date}T12:00:00Z`;
const release = (tagName, date, extra = {}) => ({ tagName, createdAt: at(date), publishedAt: at(date), ...extra });

test('an org is read 100 repos a call, with each repo\'s releases in the same query', async () => {
  const repos = Array.from({ length: 230 }, (_, i) => ({
    name: `svc-${String(i).padStart(3, '0')}`,
    isPrivate: i % 2 === 0,
    // One repo in five released in the window; the rest only long before it.
    releases: i % 5 === 0 ? [release(`v${i}`, '2026-10-01')] : [release(`v${i}`, '2025-01-01')],
  }));
  const calls = [];
  const transport = createTransport({ fetchImpl: graphqlFake({ acme: { kind: 'organization', repos } }, calls) });
  const res = await fetchGithub(transport, { targets: githubTargets(['acme']), window, token: TOKEN });
  assert.equal(calls.length, 3, 'three pages of repos, no release paging');
  assert.deepEqual(calls.map((c) => c.body.variables.after), [null, '100', '200']);
  for (const c of calls) {
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.match(c.body.query, /repositories\(first: 100, after: \$after, isArchived: false, isFork: false/);
    assert.match(c.body.query, /releases\(first: 20, orderBy: \{ field: CREATED_AT, direction: DESC \}\)/);
  }
  assert.ok(transport.log.every((e) => e.source === 'github' && e.target === 'https://api.github.com/graphql' && e.credential === 'GITHUB_TOKEN' && !e.billed));
  assert.equal(transport.billedCount(), 0);
  assert.equal(res.releases.length, 46);
  assert.equal(res.releases[0].repo, 'acme/svc-000');
  assert.deepEqual(res.github.owners, [{ login: 'acme', kind: 'organization', repos: 230, excluded: 0, withReleases: 46, releases: 46, visiblePrivate: 115 }]);
  assert.deepEqual(res.notes, ['GitHub: 230 repos in acme, 46 with releases in this window.', 'GitHub: read with a token via GITHUB_TOKEN.']);
  assert.equal(sourceSummary('github', res, { requests: transport.log.length }), 'acme: 230 repos, 46 releases; 3 requests via GITHUB_TOKEN');
});

test('a login that is not an org is read as a user, and an unknown one is a note', async () => {
  const solo = { kind: 'user', repos: [{ name: 'tool', releases: [release('v1', '2026-09-09')] }] };
  const calls = [];
  const transport = createTransport({ fetchImpl: graphqlFake({ solo }, calls) });
  const res = await fetchGithub(transport, { targets: githubTargets(['solo', 'ghost']), window, token: TOKEN });
  assert.deepEqual(calls.map((c) => /owner: (\w+)\(/.exec(c.body.query)[1]), ['organization', 'user', 'organization', 'user']);
  assert.match(calls[1].body.query, /ownerAffiliations: \[OWNER\]/);
  assert.equal(res.github.owners[0].kind, 'user');
  assert.deepEqual(res.releases.map((r) => `${r.repo} ${r.name}`), ['solo/tool v1']);
  assert.ok(res.notes.includes('GitHub: no org or user named ghost is visible to this token.'));
  assert.ok(res.notes.includes('GitHub: this token could see only public repos in solo. If solo has private repos, the token needs read access to them.'));
});

test('archived and forked repos are left out, and so are excluded ones', async () => {
  const repos = [
    { name: 'app', releases: [release('v1', '2026-10-01')] },
    { name: 'old', isArchived: true, releases: [release('v9', '2026-10-01')] },
    { name: 'fork', isFork: true, releases: [release('v8', '2026-10-01')] },
    { name: 'noisy', releases: [release('nightly', '2026-10-01')] },
  ];
  const transport = createTransport({ fetchImpl: graphqlFake({ acme: { kind: 'organization', repos } }) });
  const res = await fetchGithub(transport, { targets: githubTargets(['acme'], ['acme/noisy']), window, token: TOKEN });
  assert.deepEqual(res.releases.map((r) => r.repo), ['acme/app']);
  assert.equal(res.github.owners[0].repos, 1);
  assert.equal(res.github.owners[0].excluded, 1);
  assert.equal(res.notes[0], 'GitHub: 1 repo in acme (1 excluded), 1 with releases in this window.');
});

test('a repo\'s releases are paged only while its newest page is inside the window', async () => {
  const days = (n, from) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(`${from}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
    return release(`r${i}`, d);
  });
  const repos = [
    // 45 releases, newest first from Oct 27: the inline 20 are all inside, so one more call reads the rest.
    { name: 'busy', isPrivate: true, releases: days(45, '2026-10-27') },
    // 30 releases a week apart: the inline 20 reach back before the window, so no more calls.
    { name: 'steady', releases: Array.from({ length: 30 }, (_, i) => release(`s${i}`, new Date(Date.parse('2026-10-20T00:00:00Z') - i * 7 * 86400000).toISOString().slice(0, 10))) },
    { name: 'edge', releases: [
      release('after', '2026-10-29'), release('draft', '2026-10-10', { isDraft: true, publishedAt: null }),
      release('rc', '2026-10-09', { isPrerelease: true }), release('created-only', '2026-10-08', { publishedAt: null }), release('before', '2026-07-30'),
    ] },
  ];
  const calls = [];
  const transport = createTransport({ fetchImpl: graphqlFake({ acme: { kind: 'organization', repos } }, calls) });
  const res = await fetchGithub(transport, { targets: githubTargets(['acme']), window, token: TOKEN });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.variables, { owner: 'acme', name: 'busy', after: '20' });
  assert.equal(res.releases.filter((r) => r.repo === 'acme/busy').length, 45);
  const steady = res.releases.filter((r) => r.repo === 'acme/steady');
  assert.ok(steady.every((r) => r.date >= window.start));
  assert.equal(steady.length, 12);
  assert.deepEqual(res.releases.filter((r) => r.repo === 'acme/edge').map((r) => r.name), ['created-only', 'rc']);
  assert.ok(!res.notes.some((n) => n.includes('only public')), 'a private repo was visible');
});

test('repos and orgs mix: a repo its org already read is not fetched again', async () => {
  const calls = [];
  const graph = graphqlFake({ acme: { kind: 'organization', repos: [{ name: 'app', releases: [release('v2', '2026-10-02')] }] } }, calls);
  const rest = fakeFetch(() => ({ body: [rel('v1', '2026-10-02T09:00:00Z')] }), calls);
  const transport = createTransport({ fetchImpl: (url, opts) => (url.includes('/graphql') ? graph(url, opts) : rest(url, opts)) });
  const res = await fetchGithub(transport, { targets: githubTargets(['acme/app', 'acme', 'other/lib']), window, token: TOKEN });
  assert.deepEqual(calls.map((c) => c.url.pathname), ['/graphql', '/repos/other/lib/releases']);
  assert.deepEqual(res.releases.map((r) => r.repo), ['acme/app', 'other/lib']);
  assert.equal(sourceSummary('github', res, { requests: 2 }), 'acme: 1 repo, 1 release; other/lib: 1 release; 2 requests via GITHUB_TOKEN');
});

test('a GraphQL error other than not found fails the source', async () => {
  const transport = createTransport({ fetchImpl: fakeFetch(() => ({ body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } })) });
  await assert.rejects(fetchGithub(transport, { targets: githubTargets(['acme']), window, token: TOKEN }), /API rate limit exceeded/);
});

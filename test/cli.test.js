import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, openCommand } from '../src/cli.js';
import { createTransport } from '../src/transport.js';
import { fakeAwsExec } from './helpers/aws-fake.js';
import { fetchFocus } from '../src/sources/focus/index.js';
import { fakeFetch, fixture } from './helpers/http-fake.js';

const bin = fileURLToPath(new URL('../bin/plutus-scan.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fakeBin = fileURLToPath(new URL('./fixtures/bin', import.meta.url));
const focusCsv = fileURLToPath(new URL('./fixtures/focus/synthetic.csv', import.meta.url));
const KEY = 'sk-test-secret';
const END = ['--end', '2026-10-28'];
const WARNING = (p) => `Warning: ${p} contains real spend figures. Share it only with people who should see them.`;
const NO_SOURCES = 'No sources found. Configure the aws CLI, or pass --focus, --openai-key or --anthropic-key. To see a report without an account, run plutus-scan --demo.';

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">`;

/** An env with only the fake aws and node on PATH (never the real aws) and no real keys. */
function testEnv(extra = {}) {
  const env = { ...process.env, PATH: `${fakeBin}:${dirname(process.execPath)}`, ...extra };
  for (const k of ['OPENAI_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'NO_COLOR', 'AWS_PROFILE', 'CI', 'DISPLAY', 'WAYLAND_DISPLAY']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function sink(isTTY = false) {
  return { text: '', isTTY, columns: 120, write(s) { this.text += s; return true; } };
}

/** Fake fetch answering OpenAI and Anthropic from fixtures; `fail` maps a host to a status. */
function aiFetch(calls, fail = {}) {
  return fakeFetch((u) => {
    if (fail[u.host]) return { status: fail[u.host], body: { error: { message: 'boom' } } };
    if (u.pathname === '/v1/organization/projects') return { body: fixture('openai/projects.json') };
    if (u.pathname === '/v1/organization/costs') return { body: fixture('openai/costs.json') };
    if (u.pathname === '/v1/organizations/workspaces') return { body: fixture('anthropic/workspaces.json') };
    if (u.pathname === '/v1/organizations/cost_report') return { body: fixture('anthropic/cost-report-page3.json') };
    throw new Error(`unexpected url ${u}`);
  }, calls);
}

// Stands in for the gh CLI in every test, so the real gh and its login are never used: no gh found.
const noGh = async () => ({ code: 127, stdout: '' });

async function run(argv, { env = testEnv(), transport, runGh = noGh } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { env, stdout, stderr, transport, runGh });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'plutus-scan-cli-'));

test('the fake aws is executable, so PATH lookup cannot fall through', () => {
  assert.ok(statSync(join(fakeBin, 'aws')).mode & 0o111);
  assert.ok(!testEnv().PATH.split(':').some((d) => { try { return statSync(join(d, 'aws')).isFile() && d !== fakeBin; } catch { return false; } }));
});

test('aws-only run prints the headline and writes html with the warning line', () => {
  const dir = tmp();
  const html = join(dir, 'report.html');
  const json = join(dir, 'report.json');
  const r = spawnSync(process.execPath, [bin, ...END, '--html', html, '--json', json], { encoding: 'utf8', env: testEnv() });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(json, 'utf8'));
  assert.deepEqual(report.sources.map((s) => s.name), ['aws']);
  assert.ok(report.sources[0].rowCount > 0);
  assert.ok(r.stdout.includes(report.headline.sentence.slice(0, 40)), r.stdout);
  assert.ok(readFileSync(html, 'utf8').includes(CSP));
  assert.ok(r.stderr.includes(WARNING(html)), r.stderr);
  assert.ok(!r.stdout.includes('Warning:'));
});

test('focus with aws rows skips live aws and says so', async () => {
  const calls = [];
  const transport = createTransport({ execImpl: fakeAwsExec({ calls }) });
  const dir = tmp();
  const json = join(dir, 'r.json');
  const r = await run([...END, '--focus', focusCsv, '--json', json], { transport });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls.length, 0);
  const report = JSON.parse(readFileSync(json, 'utf8'));
  assert.deepEqual(report.sources.map((s) => s.name), ['focus']);
  assert.ok(report.notes.includes(
    'AWS: skipped because the FOCUS input already holds AWS rows. Pass --aws to use Cost Explorer instead.'), report.notes.join('\n'));
  assert.ok(r.stdout.includes('AWS: skipped'));

  const forced = [];
  const t2 = createTransport({ execImpl: fakeAwsExec({ calls: forced }) });
  const r2 = await run([...END, '--focus', focusCsv, '--aws', '--json', json], { transport: t2 });
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(forced.length > 0);
  const both = JSON.parse(readFileSync(json, 'utf8'));
  assert.deepEqual(both.sources.map((s) => s.name), ['focus', 'aws']);
  // Live AWS replaces the FOCUS AWS rows rather than adding to them.
  const focusAws = (await fetchFocus(createTransport(), { paths: [focusCsv], window: both.window }))
    .rows.filter((row) => row.provider === 'aws').reduce((s, row) => s + row.cost, 0);
  const cents = (n) => Math.round(n * 100);
  assert.equal(cents(both.totals.cloud), cents(report.totals.cloud) - cents(focusAws) + 35150);
  assert.equal(cents(both.totals.commitment), 5500);
  assert.ok(both.notes.includes('AWS: used Cost Explorer (--aws) in place of the AWS rows in the FOCUS input.'), both.notes.join('\n'));
  assert.ok(!both.untagged.some((u) => u.provider === 'aws' && u.key === 'team'), 'FOCUS AWS tag coverage dropped');
});

test('partial source failure still writes every output', async () => {
  const fetches = [];
  const transport = createTransport({ fetchImpl: aiFetch(fetches, { 'api.openai.com': 500 }), env: testEnv() });
  const dir = tmp();
  const [html, json, md] = ['r.html', 'r.json', 'r.md'].map((f) => join(dir, f));
  const r = await run([...END, '--openai-key', KEY, '--anthropic-key', KEY, '--html', html, '--json', json, '--md', md], { transport });
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(readFileSync(json, 'utf8'));
  assert.deepEqual(report.sources.map((s) => s.name).sort(), ['anthropic', 'aws']);
  assert.ok(report.notes.some((n) => n.startsWith('OpenAI: HTTP 500')), report.notes.join('\n'));
  assert.ok(r.stderr.includes('OpenAI: HTTP 500'));
  assert.ok(readFileSync(html, 'utf8').length > 0);
  assert.ok(readFileSync(md, 'utf8').includes('Last 30 days'));
  assert.ok(r.stdout.includes('Last 30 days'));
});

test('a failed aws still states its request count and cost', async () => {
  const execImpl = fakeAwsExec({ overrides: { 'daily-page2.json': { code: 254, stderr: 'An error occurred (ThrottlingException) when calling the GetCostAndUsage operation: slow down' } } });
  const transport = createTransport({ execImpl, fetchImpl: aiFetch([]) });
  const json = join(tmp(), 'r.json');
  const r = await run([...END, '--openai-key', KEY, '--json', json], { transport });
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(readFileSync(json, 'utf8'));
  assert.deepEqual(report.aws, { billedRequests: 2, cost: 0.02 });
  assert.ok(report.notes.some((n) => n.includes('ThrottlingException')), report.notes.join('\n'));
  assert.ok(r.stdout.includes('AWS Cost Explorer: 2 requests, $0.02.'), r.stdout);
});

test('all sources failing exits 1', async () => {
  const calls = [];
  const execImpl = fakeAwsExec({ calls, overrides: { 'daily-page1.json': { code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the GetCostAndUsage operation: no' } } });
  const transport = createTransport({ execImpl, fetchImpl: aiFetch([], { 'api.openai.com': 500, 'api.anthropic.com': 401 }) });
  const dir = tmp();
  const json = join(dir, 'r.json');
  const r = await run([...END, '--openai-key', KEY, '--anthropic-key', KEY, '--json', json], { transport });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes('ce:GetCostAndUsage'), r.stderr);
  assert.ok(r.stderr.includes('OpenAI: HTTP 500'));
  assert.ok(r.stderr.includes('Anthropic: the cost report API rejected the key'));
  assert.ok(r.stderr.endsWith('AWS Cost Explorer: 1 requests, $0.01.\n'), r.stderr);
  assert.throws(() => readFileSync(json));
});

test('no sources exits 2 with guidance', async () => {
  const empty = tmp();
  const r = await run([...END], { env: testEnv({ PATH: empty }) });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes(NO_SOURCES), r.stderr);
  assert.ok(r.stderr.includes('AWS: skipped (aws CLI v2 not found on PATH).'), r.stderr);
  assert.equal(r.stdout, '');

  const r2 = await run([...END, '--no-aws']);
  assert.equal(r2.code, 2);
  assert.ok(r2.stderr.includes(NO_SOURCES));

  // --aws makes an unavailable AWS a failed source rather than a skipped one.
  const r3 = await run([...END, '--aws'], { env: testEnv({ PATH: empty }) });
  assert.equal(r3.code, 1);
  assert.ok(r3.stderr.includes('aws CLI v2 not found on PATH'));
});

test('dry-run makes no calls and names credentials only', async () => {
  const execCalls = [];
  const fetchCalls = [];
  const transport = createTransport({ execImpl: fakeAwsExec({ calls: execCalls }), fetchImpl: aiFetch(fetchCalls) });
  const env = testEnv({ ANTHROPIC_ADMIN_KEY: KEY, GITHUB_TOKEN: KEY });
  const r = await run([...END, '--dry-run', '--openai-key', KEY, '--github', 'nodejs/node', '--profile', 'dev'], { env, transport });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(transport.log.length, 0);
  assert.equal(execCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.at(-1), 'Estimated AWS cost: $0.05 or more (one request per page of results)');
  const requests = lines.slice(0, -1);
  for (const line of requests) {
    assert.match(line, /^(aws|openai|anthropic|github|focus) {2}\S.* {2}credential: \S+ {2}(billed|free)$/);
  }
  assert.equal(requests.filter((l) => l.startsWith('aws  aws ce ')).length, 5);
  assert.ok(requests.every((l) => !l.startsWith('aws  ') || (l.includes('--profile dev') && l.endsWith('credential: none  billed'))));
  assert.ok(requests.some((l) => l.startsWith('openai  https://api.openai.com/') && l.endsWith('credential: OPENAI_ADMIN_KEY  free')));
  assert.ok(requests.some((l) => l.startsWith('anthropic  https://api.anthropic.com/') && l.endsWith('credential: ANTHROPIC_ADMIN_KEY  free')));
  assert.ok(requests.some((l) => l.startsWith('github  https://api.github.com/repos/nodejs/node/') && l.endsWith('credential: GITHUB_TOKEN  free')));

  const r2 = await run([...END, '--dry-run', '--no-aws', '--focus', 's3://bucket/focus/'], { transport });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(transport.log.length, 0);
  assert.ok(r2.stdout.startsWith('focus  aws s3 ls s3://bucket/focus/ --recursive  credential: none  free\n'), r2.stdout);
  assert.ok(r2.stdout.endsWith('Estimated AWS cost: $0.00-$0.00\n'));

  const r3 = await run([...END, '--dry-run', '--max-aws-requests', '20'], { transport });
  assert.equal(r3.code, 0, r3.stderr);
  assert.ok(r3.stdout.endsWith('\nEstimated AWS cost: $0.05-$0.20\n'), r3.stdout);
});

test('only configured hosts are contacted', async () => {
  const transport = createTransport({ fetchImpl: aiFetch([]), env: testEnv() });
  const r = await run([...END, '--openai-key', KEY, '--anthropic-key', KEY], { transport });
  assert.equal(r.code, 0, r.stderr);
  const http = transport.log.filter((e) => e.kind === 'http');
  const cli = transport.log.filter((e) => e.kind === 'aws-cli');
  assert.ok(http.length > 0 && cli.length > 0);
  for (const e of http) assert.ok(['api.openai.com', 'api.anthropic.com'].includes(new URL(e.target).host), e.target);
  for (const e of cli) assert.ok(e.target.startsWith('aws ce ') || e.target.startsWith('aws sts '), e.target);
  assert.equal(transport.log.length, http.length + cli.length);
});

test('keys never appear in outputs', async () => {
  const transport = createTransport({ fetchImpl: aiFetch([]), env: testEnv() });
  const dir = tmp();
  const [html, json, md] = ['r.html', 'r.json', 'r.md'].map((f) => join(dir, f));
  const r = await run([...END, '--openai-key', KEY, '--anthropic-key', KEY, '--html', html, '--json', json, '--md', md], { transport });
  assert.equal(r.code, 0, r.stderr);
  for (const text of [r.stdout, r.stderr, readFileSync(html, 'utf8'), readFileSync(json, 'utf8'), readFileSync(md, 'utf8')]) {
    assert.ok(text.length > 0);
    assert.ok(!text.includes(KEY));
  }
  assert.ok(!JSON.stringify(transport.log).includes(KEY));
});

test('--github with an org and no token is a usage error that says why, before any request', async () => {
  for (const extra of [[], ['--dry-run'], ['--github', 'acme/app']]) {
    const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: aiFetch([]) });
    const r = await run([...END, '--github', 'acme', ...extra], { transport });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /--github acme reads every repo in acme, which needs a GitHub token/);
    assert.match(r.stderr, /without one GitHub allows only 60 requests an hour\. Set GITHUB_TOKEN, pass --github-token, or sign in with gh auth login\./);
    assert.equal(transport.log.length, 0);
  }
  const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: aiFetch([]) });
  const r = await run([...END, '--github', 'acme', '--github-exclude', 'other/app'], { env: testEnv({ GITHUB_TOKEN: KEY }), transport });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--github-exclude other\/app is not in any org passed to --github/);
});

test('dry-run shows an org as an estimate', async () => {
  const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: aiFetch([]) });
  const r = await run([...END, '--dry-run', '--no-aws', '--github', 'acme', '--github', 'acme/app', '--github', 'other/lib'], { env: testEnv({ GITHUB_TOKEN: KEY }), transport });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(transport.log.length, 0);
  const lines = r.stdout.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 3), [
    'github  https://api.github.com/repos/acme/app/releases?per_page=100&page=1  credential: GITHUB_TOKEN  free',
    'github  https://api.github.com/repos/other/lib/releases?per_page=100&page=1  credential: GITHUB_TOKEN  free',
    'github  https://api.github.com/graphql  credential: GITHUB_TOKEN  free',
  ]);
  assert.match(lines[3], /^Estimated GitHub acme: about 1 request per 100 repos .*; free$/);
  assert.ok(!r.stdout.includes(KEY));
});

test('--demo refuses the GitHub flags, so it stays offline', async () => {
  for (const flag of [['--github', 'acme'], ['--github-exclude', 'acme/app'], ['--github-token', KEY]]) {
    const r = await run([...END, '--demo', ...flag]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, new RegExp(`--demo reads no account, so it cannot be combined with ${flag[0]}\\.`));
  }
});

test('keys with line breaks are refused without echoing them', async () => {
  const bad = `${KEY}\nx`;
  const cases = [
    [['--openai-key', bad], {}, '--openai-key'],
    [['--anthropic-key', `${KEY}\r`], {}, '--anthropic-key'],
    [[], { OPENAI_ADMIN_KEY: bad }, 'OPENAI_ADMIN_KEY'],
    [[], { ANTHROPIC_ADMIN_KEY: `${KEY}\0` }, 'ANTHROPIC_ADMIN_KEY'],
    [['--github', 'nodejs/node'], { GITHUB_TOKEN: bad }, 'GITHUB_TOKEN'],
    [['--github', 'nodejs/node', '--github-token', bad], {}, '--github-token'],
  ];
  for (const [argv, extra, name] of cases) {
    const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: aiFetch([]) });
    const r = await run([...END, ...argv], { env: testEnv(extra), transport });
    assert.equal(r.code, 2, name);
    assert.ok(r.stderr.includes(name), r.stderr);
    assert.equal(transport.log.length, 0);
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  }
});

test('--json - prints schemaVersion 1 and no summary', async () => {
  const transport = createTransport({ env: testEnv() });
  const r = await run([...END, '--json', '-'], { transport });
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.tool.version, version);
  assert.ok(r.stdout.endsWith('}\n'));
});

test('--md - prints markdown', async () => {
  const transport = createTransport({ env: testEnv() });
  const r = await run([...END, '--md', '-'], { transport });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith('**plutus-scan**'), r.stdout);
  assert.ok(r.stdout.includes('| Service | Usage type |'));
  assert.ok(r.stdout.includes('plutus-cloud.com'));
});

test('usage errors exit 2 and help states the price and the trust line', async () => {
  for (const argv of [
    ['--end', '2026-02-30'], ['--end', 'yesterday'], ['--days', '0'], ['--days', '1.5'],
    ['--max-aws-requests', 'x'], ['--max-tag-keys', '-1'], ['--json', '-', '--md', '-'],
    ['--bogus'], ['stray'], ['--aws', '--no-aws'], ['--tui', '--json', '-'], ['--tui', '--md', '-'],
  ]) {
    const r = await run(argv, { transport: createTransport({ execImpl: fakeAwsExec() }) });
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('--help'), r.stderr);
  }
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.ok(h.stdout.includes('AWS Cost Explorer charges $0.01 per request. A typical run makes 4-10; --max-aws-requests caps it if you want a hard limit.\n'));
  assert.ok(h.stdout.includes('\n  --max-aws-requests <n>     Optional cap on billed Cost Explorer requests (no cap by default)\n'));
  assert.ok(h.stdout.includes('plutus-scan sends no telemetry and contacts only the providers you configure.\n'));
  const v = await run(['--version']);
  assert.equal(v.stdout, `${version}\n`);
});

test('--tui refuses without a terminal, before any request', async () => {
  const err = [];
  const code = await main(['--focus', 'test/fixtures/focus/synthetic.csv', '--no-aws', '--tui'], {
    env: {}, stdout: { write() {}, isTTY: false }, stderr: { write: (s) => err.push(s) },
  });
  assert.equal(code, 2);
  assert.match(err.join(''), /--tui needs an interactive terminal of at least 80x24\./);
  assert.doesNotMatch(err.join(''), /Reading FOCUS/);
});

test('--tui refuses a terminal below 80x24 before any request', async () => {
  for (const [columns, rows] of [[79, 24], [80, 23]]) {
    const calls = [];
    const transport = createTransport({ execImpl: fakeAwsExec({ calls }) });
    const err = [];
    const code = await main([...END, '--tui'], {
      env: testEnv(), transport, stdin: { isTTY: true },
      stdout: { write() {}, isTTY: true, columns, rows }, stderr: { write: (s) => err.push(s) },
    });
    assert.equal(code, 2);
    assert.match(err.join(''), /--tui needs an interactive terminal of at least 80x24\./);
    assert.equal(calls.length, 0);
  }
});

test('openCommand passes an empty title to start on Windows', () => {
  assert.deepEqual(openCommand('win32', 'C:\\r\\my report.html'),
    ['cmd', ['/c', 'start', '""', '"C:\\r\\my report.html"'], { windowsVerbatimArguments: true }]);
  assert.deepEqual(openCommand('darwin', '/r/a.html'), ['open', ['/r/a.html'], {}]);
  assert.deepEqual(openCommand('linux', '/r/a.html'), ['xdg-open', ['/r/a.html'], {}]);
});

/** A bare-run harness: a TTY stdout, a temp dir and an opener that records instead of launching. */
async function bareRun(argv, { env = testEnv({ DISPLAY: ':0' }), tty = true, transport = createTransport({ execImpl: fakeAwsExec() }) } = {}) {
  const tmpDir = tmp();
  const opened = [];
  const stdout = sink(tty);
  const stderr = sink();
  const code = await main([...END, ...argv], { env, stdout, stderr, transport, tmpDir, open: (p) => opened.push(p) });
  const report = join(tmpDir, 'plutus-scan', 'report-2026-10-28.html');
  return { code, stdout: stdout.text, stderr: stderr.text, opened, report, written: () => { try { return readFileSync(report, 'utf8'); } catch { return null; } } };
}

test('a bare run on a terminal writes the report to the temp folder and opens it', async () => {
  const r = await bareRun([]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.written().includes(CSP));
  assert.ok(r.stderr.includes(WARNING(r.report)), r.stderr);
  assert.deepEqual(r.opened, [r.report]);
  assert.ok(r.stdout.length > 0);
});

test('a bare run off a terminal, in CI, or with an output flag writes no html', async () => {
  const none = (r) => { assert.equal(r.code, 0, r.stderr); assert.equal(r.written(), null); assert.deepEqual(r.opened, []); };
  none(await bareRun([], { tty: false }));
  none(await bareRun([], { env: testEnv({ DISPLAY: ':0', CI: '1' }) }));
  none(await bareRun(['--md', '-']));
  none(await bareRun(['--json', join(tmp(), 'r.json')]));
});

test('--no-open writes the report without opening it, and --no-html writes nothing', async () => {
  const quiet = await bareRun(['--no-open']);
  assert.ok(quiet.written().includes(CSP));
  assert.deepEqual(quiet.opened, []);
  assert.ok(quiet.stderr.includes(WARNING(quiet.report)));
  const skipped = await bareRun(['--no-html']);
  assert.equal(skipped.written(), null);
  assert.deepEqual(skipped.opened, []);
});

test('a bare run on Linux with no display writes the report and leaves the path', async () => {
  if (process.platform !== 'linux') return;
  const r = await bareRun([], { env: testEnv() });
  assert.ok(r.written().includes(CSP));
  assert.deepEqual(r.opened, []);
  assert.ok(r.stderr.includes(WARNING(r.report)));
});

test('a bare run where every source failed writes nothing', async () => {
  const execImpl = fakeAwsExec({ overrides: { 'daily-page1.json': { code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the GetCostAndUsage operation: no' } } });
  const r = await bareRun([], { transport: createTransport({ execImpl }) });
  assert.equal(r.code, 1);
  assert.equal(r.written(), null);
  assert.deepEqual(r.opened, []);
});

test('the stdout the CLI is given picks the terminal layout, not the process stdout', async () => {
  const summary = async (tty) => {
    const stdout = sink(tty);
    const stderr = sink();
    const code = await main([...END, '--no-html'], { env: testEnv({ NO_COLOR: '1' }), stdout, stderr, transport: createTransport({ execImpl: fakeAwsExec() }) });
    assert.equal(code, 0, stderr.text);
    return stdout.text;
  };
  const dashboard = await summary(true);
  const plain = await summary(false);
  assert.ok(dashboard.startsWith('\u25c6 plutus-scan'), dashboard.slice(0, 80));
  assert.ok(plain.startsWith('plutus-scan'), plain.slice(0, 80));
  assert.ok(plain.includes('\nHeadline\n'));
  assert.ok(!/\x1b\[/.test(dashboard), 'NO_COLOR from the given env turns colour off');
});

test('a bare --demo run writes a demo report that says it is synthetic, apart from a real one', async () => {
  const tmpDir = tmp();
  const opened = [];
  const stderr = sink();
  const offline = createTransport({ execImpl: async () => { throw new Error('the demo must not run the aws CLI'); } });
  const code = await main([...END, '--demo'], { env: testEnv({ DISPLAY: ':0' }), stdout: sink(true), stderr, transport: offline, tmpDir, open: (p) => opened.push(p) });
  assert.equal(code, 0, stderr.text);
  const report = join(tmpDir, 'plutus-scan', 'demo-report-2026-10-28.html');
  const html = readFileSync(report, 'utf8');
  assert.ok(html.includes('synthetic spend for a fictional company'), 'the page carries the demo banner');
  assert.ok(stderr.text.includes(`${report} contains synthetic demo data, not real spend.`), stderr.text);
  assert.ok(!stderr.text.includes('real spend figures'), stderr.text);
  assert.deepEqual(opened, [report]);
  // A real report never carries the banner.
  const real = await bareRun([]);
  assert.ok(!real.written().includes('synthetic spend for a fictional company'));
});

test('the temp report folder is private, and a shared or foreign one is refused', async () => {
  if (process.platform === 'win32') return;
  const ok = await bareRun([]);
  assert.ok(ok.written());
  assert.equal(statSync(ok.report).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(ok.report)).mode & 0o777, 0o700);

  const tmpDir = tmp();
  mkdirSync(join(tmpDir, 'plutus-scan'), { mode: 0o755 });
  chmodSync(join(tmpDir, 'plutus-scan'), 0o755);
  const opened = [];
  const stderr = sink();
  const code = await main(END, { env: testEnv({ DISPLAY: ':0' }), stdout: sink(true), stderr, transport: createTransport({ execImpl: fakeAwsExec() }), tmpDir, open: (p) => opened.push(p) });
  assert.equal(code, 1);
  assert.match(stderr.text, /not a private folder/);
  assert.deepEqual(opened, []);
});

/** A run on a terminal with stderr a terminal too, so the live progress panel is drawn there. */
async function liveRun(argv, { env = testEnv({ DISPLAY: ':0' }), transport = createTransport({ execImpl: fakeAwsExec() }), runGh = noGh } = {}) {
  const tmpDir = tmp();
  const opened = [];
  const stdout = sink(true);
  const stderr = sink(true);
  const delays = [];
  const code = await main([...END, ...argv], { env, stdout, stderr, transport, tmpDir, runGh, open: (p) => opened.push(p), delay: async (ms) => { delays.push(ms); } });
  return { code, stdout: stdout.text, stderr: stderr.text, plain: stderr.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), opened, delays, tmpDir };
}

test('on a terminal the run is drawn as a live panel that collapses to one line', async () => {
  const r = await liveRun(['--no-open']);
  assert.equal(r.code, 0, r.plain);
  assert.ok(r.stderr.startsWith('\x1b[?25l'), 'the cursor is hidden while the panel runs');
  assert.equal(r.stderr.split('\x1b[?25l').length - 1, 1);
  assert.equal(r.stderr.split('\x1b[?25h').length - 1, 1, 'and given back once');
  assert.match(r.plain, /✓ AWS Cost Explorer +\d+ days, \d+ services, \d+ requests, \$0\.\d\d/);
  assert.match(r.plain, /– OpenAI +skipped, no key/);
  assert.match(r.plain, /Analysis +✓ drivers +✓ anomalies +✓ forecast +✓ candidates/);
  // The plain progress lines are not written on a live run.
  assert.ok(!r.plain.includes('Checking the aws CLI...'));
  assert.ok(!r.plain.includes('Reading AWS Cost Explorer...'));
  // After the panel: the summary line, then the report line and the warning, word for word.
  const report = join(r.tmpDir, 'plutus-scan', 'report-2026-10-28.html');
  const tail = r.plain.slice(r.plain.lastIndexOf('✓ Scanned'));
  assert.match(tail, /^✓ Scanned AWS Cost Explorer · \d+ requests · \d+ billed, \$0\.\d\d · \d+\.\ds\n/);
  assert.ok(tail.endsWith(`Wrote report: ${report}\n${WARNING(report)}\n`), tail);
  assert.ok(r.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').startsWith('◆ plutus-scan'), 'the dashboard follows on stdout');
});

test('a live --demo run paces its steps, says the report is synthetic and opens it', async () => {
  const r = await liveRun(['--demo']);
  assert.equal(r.code, 0, r.plain);
  assert.ok(r.delays.length >= 6 && r.delays.every((ms) => ms > 0 && ms <= 500), JSON.stringify(r.delays));
  assert.match(r.plain, /✓ Demo data +90 days, \d+ services/);
  assert.match(r.plain, /– AWS Cost Explorer +off, --demo reads no account/);
  const report = join(r.tmpDir, 'plutus-scan', 'demo-report-2026-10-28.html');
  assert.ok(r.plain.endsWith(`Wrote report: ${report}, opening in your browser\n${report} contains synthetic demo data, not real spend.\n`), r.plain.slice(-300));
  assert.deepEqual(r.opened, [report]);
});

test('without a terminal on stderr, in CI or with --json the plain lines stay and the demo does not pause', async () => {
  const delays = [];
  const stderr = sink(false);
  await main([...END, '--demo', '--no-html'], { env: testEnv(), stdout: sink(true), stderr, delay: async (ms) => { delays.push(ms); } });
  assert.deepEqual(delays, []);
  assert.ok(!stderr.text.includes('\x1b['));
  for (const argv of [['--json', join(tmp(), 'r.json')], []]) {
    const env = argv.length ? testEnv() : testEnv({ CI: '1' });
    const r = await liveRun(argv, { env });
    assert.ok(!r.stderr.includes('\x1b[?25l'), argv.join(' ') || 'CI');
    assert.ok(r.stderr.startsWith('Checking the aws CLI...\nReading AWS Cost Explorer...\n'), r.stderr.slice(0, 80));
  }
});

test('when every source fails on a live run the panel comes down and its notes are written out', async () => {
  const execImpl = fakeAwsExec({ overrides: { 'daily-page1.json': { code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the GetCostAndUsage operation: no' } } });
  const r = await liveRun([], { transport: createTransport({ execImpl }) });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.split('\x1b[?25h').length - 1, 1);
  const tail = r.plain.slice(r.plain.lastIndexOf('✗ No source could be read'));
  assert.match(tail, /^✗ No source could be read · \d+ requests · \d+ billed, \$0\.\d\d · \d+\.\ds\nAWS: access denied\. The caller needs ce:GetCostAndUsage/);
});

test('an org run marks its releases, notes what it read and counts its calls on the live panel', async () => {
  const repo = (name, releases, extra = {}) => ({ nameWithOwner: `acme/${name}`, isPrivate: true, isArchived: false, isFork: false, ...extra,
    releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: releases } });
  const rel = (tagName, iso) => ({ name: null, tagName, url: `https://github.com/acme/web/releases/tag/${tagName}`, isDraft: false, isPrerelease: false, createdAt: iso, publishedAt: iso });
  const calls = [];
  const fetchImpl = fakeFetch((u, headers, { body }) => {
    assert.equal(u.href, 'https://api.github.com/graphql');
    assert.equal(headers.Authorization, `Bearer ${KEY}`);
    return { body: { data: { owner: { login: body.variables.login, repositories: {
      totalCount: 3, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [repo('web', [rel('v2', '2026-10-12T10:00:00Z'), rel('v1', '2026-10-12T08:00:00Z')]), repo('api', [rel('v9', '2026-10-12T09:00:00Z')]), repo('idle', [])],
    } } } } };
  }, calls);
  const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl });
  const env = testEnv({ DISPLAY: ':0', GITHUB_TOKEN: KEY });
  const r = await liveRun(['--no-aws', '--focus', focusCsv, '--github', 'acme', '--no-open'], { env, transport });
  assert.equal(r.code, 0, r.plain);
  assert.equal(calls.length, 1);
  assert.match(r.plain, /✓ GitHub releases +acme: 3 repos, 3 releases; 1 request/);
  const json = JSON.parse(readFileSync(join(r.tmpDir, 'plutus-scan', 'report-2026-10-28.html'), 'utf8')
    .match(/<script type="application\/json" id="report">([^<]*)<\/script>/)[1]);
  assert.ok(json.report.notes.includes('GitHub: 3 repos in acme, 2 with releases in this window.'), JSON.stringify(json.report.notes));
  const marker = json.view.daily.chart.releases.find((m) => m.label === '3 releases');
  assert.deepEqual(marker.items, ['acme/api v9', 'acme/web v2', 'acme/web v1']);
  assert.ok(!r.plain.includes(KEY));
});

// gh CLI login as the last fallback for the GitHub token.

const GH_TOKEN_VALUE = 'gho_from-gh-login';
/** A fake gh runner that records its calls and answers with `res` (or throws it when it is an Error). */
function ghFake(res = { code: 0, stdout: `${GH_TOKEN_VALUE}\n` }) {
  const calls = [];
  const runGh = async (env) => {
    calls.push(env);
    if (res instanceof Error) throw res;
    return res;
  };
  return { runGh, calls };
}

/** A GitHub GraphQL fake for org `acme`: one repo with one release in the window. */
function orgFetch(calls, { status = 200 } = {}) {
  return fakeFetch((u, headers, { body }) => {
    if (u.href !== 'https://api.github.com/graphql') throw new Error(`unexpected url ${u}`);
    if (status !== 200) return { status, body: { message: 'Bad credentials' } };
    return { body: { data: { owner: { login: body.variables.login, repositories: {
      totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ nameWithOwner: 'acme/web', isPrivate: true, isArchived: false, isFork: false, releases: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ name: null, tagName: 'v1', url: 'https://github.com/acme/web/releases/tag/v1', isDraft: false, isPrerelease: false, createdAt: '2026-10-12T10:00:00Z', publishedAt: '2026-10-12T10:00:00Z' }],
      } }],
    } } } } };
  }, calls);
}

test('the GitHub token comes from --github-token, then GITHUB_TOKEN, then GH_TOKEN, then the gh login', async () => {
  const values = { flag: 'tok-flag', GITHUB_TOKEN: 'tok-github', GH_TOKEN: 'tok-gh-env' };
  const cases = [
    [['--github-token', values.flag], { GITHUB_TOKEN: values.GITHUB_TOKEN, GH_TOKEN: values.GH_TOKEN }, '--github-token', 0],
    [[], { GITHUB_TOKEN: values.GITHUB_TOKEN, GH_TOKEN: values.GH_TOKEN }, 'GITHUB_TOKEN', 0],
    [[], { GH_TOKEN: values.GH_TOKEN }, 'GH_TOKEN', 0],
    [[], {}, 'gh login', 1],
  ];
  for (const [argv, extra, credential, ghCalls] of cases) {
    const gh = ghFake();
    const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: aiFetch([]) });
    const r = await run([...END, '--dry-run', '--no-aws', '--github', 'acme', '--github', 'acme/app', ...argv], { env: testEnv(extra), transport, runGh: gh.runGh });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gh.calls.length, ghCalls, credential);
    assert.equal(transport.log.length, 0);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('github  '));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.endsWith(`credential: ${credential}  free`)), lines.join('\n'));
    for (const v of [...Object.values(values), GH_TOKEN_VALUE]) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), credential);
  }
});

test('the token each source gives is the one sent', async () => {
  const cases = [
    [['--github-token', 'tok-flag'], { GITHUB_TOKEN: 'tok-github' }, 'tok-flag', '--github-token'],
    [[], { GITHUB_TOKEN: 'tok-github', GH_TOKEN: 'tok-gh-env' }, 'tok-github', 'GITHUB_TOKEN'],
    [[], { GH_TOKEN: 'tok-gh-env' }, 'tok-gh-env', 'GH_TOKEN'],
    [[], {}, GH_TOKEN_VALUE, 'gh login'],
  ];
  for (const [argv, extra, token, source] of cases) {
    const calls = [];
    const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: orgFetch(calls) });
    const r = await run([...END, '--no-aws', '--focus', focusCsv, '--github', 'acme', '--json', '-', ...argv], { env: testEnv(extra), transport, runGh: ghFake().runGh });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(calls[0].headers.Authorization, `Bearer ${token}`);
    assert.ok(JSON.parse(r.stdout).notes.includes(`GitHub: read with a token via ${source}.`), source);
    assert.ok(transport.log.every((e) => e.source !== 'github' || e.credential === source));
  }
});

test('a missing, failing, hung or silent gh means no token, never a crash', async () => {
  const answers = [
    { code: 127, stdout: '' },
    { code: 1, stdout: '' },
    { code: 0, stdout: '' },
    { code: 0, stdout: '\n' },
    Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('Command failed: gh auth token'), { killed: true, signal: 'SIGKILL' }),
  ];
  for (const answer of answers) {
    // Org mode stops before any request, and now also points at gh auth login.
    const gh = ghFake(answer);
    const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: aiFetch([]) });
    const r = await run([...END, '--github', 'acme'], { transport, runGh: gh.runGh });
    assert.equal(r.code, 2, r.stderr);
    assert.equal(gh.calls.length, 1);
    assert.match(r.stderr, /Set GITHUB_TOKEN, pass --github-token, or sign in with gh auth login\./);
    assert.equal(transport.log.length, 0);
    // A single repo still reads, without a token.
    const calls = [];
    const repoTransport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: fakeFetch(() => ({ body: [] }), calls) });
    const r2 = await run([...END, '--no-aws', '--focus', focusCsv, '--github', 'acme/app', '--json', '-'], { transport: repoTransport, runGh: ghFake(answer).runGh });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal('Authorization' in calls[0].headers, false);
    assert.equal(repoTransport.log.find((e) => e.source === 'github').credential, null);
    assert.ok(!JSON.parse(r2.stdout).notes.some((n) => n.includes('read with a token')));
  }
});

test('--no-gh-auth never asks gh, and the org error says so', async () => {
  const gh = ghFake();
  const r = await run([...END, '--github', 'acme', '--no-gh-auth'], { runGh: gh.runGh });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Set GITHUB_TOKEN or pass --github-token \(--no-gh-auth leaves the gh login unused\)\./);
  const r2 = await run([...END, '--dry-run', '--no-aws', '--github', 'acme/app', '--no-gh-auth'], { runGh: gh.runGh });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /^github {2}https:\/\/api\.github\.com\/repos\/acme\/app\/.* {2}credential: none {2}free$/m);
  const r3 = await run([...END, '--dry-run', '--no-aws', '--github', 'acme', '--no-gh-auth'], { env: testEnv({ GH_TOKEN: 'tok-gh-env' }), runGh: gh.runGh });
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stdout, /credential: GH_TOKEN {2}free/);
  assert.equal(gh.calls.length, 0);
});

test('gh is only asked when GitHub is, and never by --demo', async () => {
  const gh = ghFake();
  for (const argv of [['--demo', '--json', '-'], ['--demo', '--no-gh-auth', '--json', '-'], ['--no-aws', '--focus', focusCsv, '--json', '-']]) {
    const r = await run([...END, ...argv], { runGh: gh.runGh });
    assert.equal(r.code, 0, r.stderr);
  }
  const live = await liveRun(['--demo', '--no-open'], { runGh: gh.runGh });
  assert.equal(live.code, 0, live.plain);
  assert.equal(gh.calls.length, 0);
  // The real runner is the default, and it never runs with --demo either: an empty PATH has no gh to find.
  const stdout = sink();
  assert.equal(await main([...END, '--demo', '--json', '-'], { env: { PATH: '' }, stdout, stderr: sink() }), 0);
});

test('a gh login token is never written to any output, error or log', async () => {
  const dir = tmp();
  const outs = { html: join(dir, 'r.html'), md: join(dir, 'r.md'), json: join(dir, 'r.json') };
  const calls = [];
  const transport = createTransport({ execImpl: fakeAwsExec(), fetchImpl: orgFetch(calls) });
  const r = await run([...END, '--no-aws', '--focus', focusCsv, '--github', 'acme', '--html', outs.html, '--md', outs.md, '--json', outs.json], { transport, runGh: ghFake().runGh });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls[0].headers.Authorization, `Bearer ${GH_TOKEN_VALUE}`, 'the token was used');
  const texts = [r.stdout, r.stderr, JSON.stringify(transport.log), ...Object.values(outs).map((p) => readFileSync(p, 'utf8'))];
  assert.ok(texts.every((t) => !t.includes(GH_TOKEN_VALUE)));
  assert.ok(JSON.parse(readFileSync(outs.json, 'utf8')).notes.includes('GitHub: read with a token via gh login.'));

  // --json -, --md -, --dry-run, and a GitHub error.
  for (const argv of [['--json', '-'], ['--md', '-'], ['--dry-run']]) {
    const t = createTransport({ execImpl: fakeAwsExec(), fetchImpl: orgFetch([]) });
    const out = await run([...END, '--no-aws', '--focus', focusCsv, '--github', 'acme', ...argv], { transport: t, runGh: ghFake().runGh });
    assert.equal(out.code, 0, out.stderr);
    assert.ok(!out.stdout.includes(GH_TOKEN_VALUE) && !out.stderr.includes(GH_TOKEN_VALUE), argv[0]);
  }
  const failing = createTransport({ execImpl: fakeAwsExec(), fetchImpl: orgFetch([], { status: 401 }) });
  const bad = await run([...END, '--no-aws', '--focus', focusCsv, '--github', 'acme', '--json', '-'], { transport: failing, runGh: ghFake().runGh });
  assert.equal(bad.code, 0, bad.stderr);
  assert.ok(JSON.parse(bad.stdout).notes.some((n) => n.startsWith('GitHub: HTTP 401')), bad.stdout);
  assert.ok(!bad.stdout.includes(GH_TOKEN_VALUE) && !bad.stderr.includes(GH_TOKEN_VALUE));

  // The live panel says where the token came from, and nothing more.
  const live = await liveRun(['--no-aws', '--focus', focusCsv, '--github', 'acme', '--no-open'], {
    transport: createTransport({ execImpl: fakeAwsExec(), fetchImpl: orgFetch([]) }), runGh: ghFake().runGh, env: testEnv({ DISPLAY: ':0' }),
  });
  assert.equal(live.code, 0, live.plain);
  assert.match(live.plain, /✓ GitHub releases +acme: 1 repo, 1 release; 1 request via gh login/);
  assert.ok(!live.stderr.includes(GH_TOKEN_VALUE) && !live.stdout.includes(GH_TOKEN_VALUE));
  const html = readFileSync(join(live.tmpDir, 'plutus-scan', 'report-2026-10-28.html'), 'utf8');
  assert.ok(!html.includes(GH_TOKEN_VALUE));
});

test('escape sequences in a note or error never reach the terminal', async () => {
  // A path is the easiest untrusted text to put into a source note: the same writes carry
  // provider error bodies and aws CLI stderr.
  const r = await run([...END, '--no-aws', '--focus', '\x1b]0;owned\x07\x1b[31mmissing.csv']);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes('missing.csv'), r.stderr);
  assert.ok(!/[\x1b\x07]/.test(r.stderr), JSON.stringify(r.stderr));
});

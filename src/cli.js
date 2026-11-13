// Command-line entry: parse flags, gather sources, build the report and write outputs.
import { parseArgs } from 'node:util';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { UsageError, computeWindow, emptyResult, formatMoney } from './model.js';
import { createTransport } from './transport.js';
import { awsAvailable, describeAws, fetchAws } from './sources/aws.js';
import { describeOpenAI, fetchOpenAI } from './sources/openai.js';
import { describeAnthropic, fetchAnthropic } from './sources/anthropic.js';
import { describeFocus, fetchFocus } from './sources/focus/index.js';
import { checkGithub, describeGithub, fetchGithub, githubTargets } from './sources/github.js';
import { ghRunner, ghToken } from './sources/github-auth.js';
import { fetchDemo } from './sources/demo.js';
import { buildReport } from './report/data.js';
import { awsRequestLine } from './report/headline.js';
import { renderTerminal } from './report/terminal.js';
import { renderMarkdown } from './report/markdown.js';
import { renderHtml } from './report/html.js';
import { VERSION } from './version.js';
import { createProgress, noProgress, sourceSummary } from './ui/progress.js';
import { colorDepth, createTheme } from './ui/theme.js';

/** @typedef {import('./model.js').SourceResult} SourceResult */
/** @typedef {import('./model.js').RequestDescriptor} RequestDescriptor */
/** @typedef {{ write(s: string): unknown, isTTY?: boolean, columns?: number, rows?: number }} Out */

const NO_SOURCES = 'No sources found. Configure the aws CLI, or pass --focus, --openai-key or --anthropic-key. To see a report without an account, run plutus-scan --demo.';
const AWS_REQUEST_COST = 0.01;
const TUI_MIN_COLUMNS = 80;
const TUI_MIN_ROWS = 24;
// How long --demo pauses per step on the live progress panel, so the run can be watched.
const DEMO_STEP_MS = 350;
const ANALYSIS = ['drivers', 'anomalies', 'forecast', 'candidates'];
const LABELS = { aws: 'AWS', openai: 'OpenAI', anthropic: 'Anthropic', focus: 'FOCUS', github: 'GitHub', demo: 'Demo' };

const HELP = `Usage: plutus-scan [options]

Reports what changed in your cloud and AI bill. Runs locally.
With no output option in a terminal, it prints the summary, then writes the HTML report to your temp folder and opens it.

Window
  --days <n>                 Days to report, ending at --end (default 90, max 395)
  --end <YYYY-MM-DD>         Last day of the window (default: two days ago, UTC)

AWS (through your aws CLI)
  --aws                      Query AWS even when a FOCUS input already holds AWS rows
  --no-aws                   Skip AWS
  --profile <name>           aws CLI profile
  --max-aws-requests <n>     Optional cap on billed Cost Explorer requests (no cap by default)
  --max-tag-keys <n>         Cost allocation tag keys to measure (default 5)

FOCUS
  --focus <path>             FOCUS export: file, directory or s3:// prefix (repeatable)

AI providers
  --openai-key <key>         OpenAI admin key (default: OPENAI_ADMIN_KEY)
  --anthropic-key <key>      Anthropic admin key (default: ANTHROPIC_ADMIN_KEY)

GitHub
  --github <owner/repo>      Mark releases of this repo on the chart (repeatable)
  --github <owner>           Mark releases of every repo in this org or user, not archived or
                             forked (repeatable, mixes with owner/repo; needs a token)
  --github-exclude <o/repo>  Leave this repo of an org out (repeatable)
  --github-token <token>     GitHub token (default: GITHUB_TOKEN, then GH_TOKEN, then your gh login)
  --no-gh-auth               Do not ask the gh CLI for its login's token

Outputs
  --html <file>              Write a self-contained HTML report to this path
  --open                     Open the HTML report when written
  --no-html                  Skip the automatic HTML report
  --no-open                  Write the automatic HTML report without opening it
  --json <file|->            Write the report data as JSON (- for stdout)
  --md <file|->              Write a Markdown summary (- for stdout)

Display
  --tui                      Full-screen keyboard view of the report
  --braille                  Braille sparkline
  --no-color                 No colour in the terminal summary

Other
  --demo                     Report on built-in synthetic data for a fictional company; reads no account
  --dry-run                  List every request without making any
  --help                     Show this help
  --version                  Show the version

AWS Cost Explorer charges $0.01 per request. A typical run makes 4-10; --max-aws-requests caps it if you want a hard limit.
plutus-scan sends no telemetry and contacts only the providers you configure.
`;

const OPTIONS = /** @type {const} */ ({
  days: { type: 'string' },
  end: { type: 'string' },
  aws: { type: 'boolean' },
  'no-aws': { type: 'boolean' },
  profile: { type: 'string' },
  'max-aws-requests': { type: 'string' },
  'max-tag-keys': { type: 'string' },
  focus: { type: 'string', multiple: true },
  'openai-key': { type: 'string' },
  'anthropic-key': { type: 'string' },
  github: { type: 'string', multiple: true },
  'github-exclude': { type: 'string', multiple: true },
  'github-token': { type: 'string' },
  'no-gh-auth': { type: 'boolean' },
  html: { type: 'string' },
  open: { type: 'boolean' },
  'no-html': { type: 'boolean' },
  'no-open': { type: 'boolean' },
  json: { type: 'string' },
  md: { type: 'string' },
  tui: { type: 'boolean' },
  braille: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  demo: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean' },
  version: { type: 'boolean' },
});

/**
 * @template {number|null} F
 * @param {string|undefined} value @param {string} flag @param {F} fallback @returns {number|F}
 */
function positiveInt(value, flag, fallback) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`${flag} must be a positive whole number.`);
  return Number(value);
}

/** @param {string|undefined} value @returns {string|undefined} */
function checkDate(value) {
  if (value === undefined) return undefined;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) throw new UsageError(`--end must be a real date in the form YYYY-MM-DD.`);
  return value;
}

const BAD_SECRET = /[\0\r\n]/;

/**
 * A key from its flag, else its env var; null when the key is not `used`. A value with a NUL, CR or LF would make
 * fetch echo it in an error, so it is refused, naming only the flag or variable.
 * @param {string|undefined} flagValue @param {string} flag @param {NodeJS.ProcessEnv} env
 * @param {string} envName @param {boolean} used @returns {string|null}
 */
function secret(flagValue, flag, env, envName, used) {
  if (flagValue) {
    if (BAD_SECRET.test(flagValue)) throw new UsageError(`${flag} contains a line break or NUL character.`);
    return used ? flagValue : null;
  }
  const value = used ? env[envName] : undefined;
  if (!value) return null;
  if (BAD_SECRET.test(value)) throw new UsageError(`${envName} contains a line break or NUL character.`);
  return value;
}

/**
 * The GitHub token from --github-token, else GITHUB_TOKEN, else GH_TOKEN, with where it came from.
 * The gh login, the last fallback, is asked for later, since it runs a command.
 * @param {string|undefined} flagValue @param {NodeJS.ProcessEnv} env @param {boolean} used
 * @returns {{ token: string|null, source: import('./sources/github-auth.js').TokenSource|null }}
 */
function githubSecret(flagValue, env, used) {
  if (flagValue) {
    const token = secret(flagValue, '--github-token', env, 'GITHUB_TOKEN', used);
    return { token, source: token ? '--github-token' : null };
  }
  for (const name of /** @type {const} */ (['GITHUB_TOKEN', 'GH_TOKEN'])) {
    const token = secret(undefined, name, env, name, used);
    if (token) return { token, source: name };
  }
  return { token: null, source: null };
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
function parseOptions(argv, env) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (e) {
    throw new UsageError(String(e instanceof Error ? e.message : e).split('\n')[0]);
  }
  if (values.aws && values['no-aws']) throw new UsageError('--aws and --no-aws cannot be used together.');
  if (values.json === '-' && values.md === '-') throw new UsageError('--json - and --md - cannot both write to stdout.');
  if (values.open && !values.html) throw new UsageError('--open needs --html <file>.');
  if (values.tui && (values.json === '-' || values.md === '-')) {
    throw new UsageError('--tui cannot be combined with --json - or --md -.');
  }
  const demo = Boolean(values.demo);
  if (demo) {
    const live = ['aws', 'profile', 'max-aws-requests', 'max-tag-keys', 'focus', 'openai-key', 'anthropic-key', 'github', 'github-exclude', 'github-token']
      .find((k) => values[/** @type {keyof typeof values} */ (k)] !== undefined);
    if (live) throw new UsageError(`--demo reads no account, so it cannot be combined with --${live}.`);
  }
  const github = githubTargets(values.github ?? [], values['github-exclude'] ?? []);
  const githubOn = github.orgs.length + github.repos.length > 0;
  const githubAuth = githubSecret(values['github-token'], env, githubOn);
  return {
    help: Boolean(values.help),
    version: Boolean(values.version),
    days: positiveInt(values.days, '--days', 90),
    end: checkDate(values.end),
    aws: Boolean(values.aws),
    noAws: demo || Boolean(values['no-aws']),
    profile: values.profile ?? null,
    maxAwsRequests: positiveInt(values['max-aws-requests'], '--max-aws-requests', null),
    maxTagKeys: positiveInt(values['max-tag-keys'], '--max-tag-keys', 5),
    focus: values.focus ?? [],
    openaiKey: secret(values['openai-key'], '--openai-key', env, 'OPENAI_ADMIN_KEY', !demo),
    anthropicKey: secret(values['anthropic-key'], '--anthropic-key', env, 'ANTHROPIC_ADMIN_KEY', !demo),
    github,
    githubOn,
    githubToken: githubAuth.token,
    /** @type {import('./sources/github-auth.js').TokenSource|null} */
    githubTokenSource: githubAuth.source,
    noGhAuth: Boolean(values['no-gh-auth']),
    html: values.html ?? null,
    open: Boolean(values.open),
    noHtml: Boolean(values['no-html']),
    noOpen: Boolean(values['no-open']),
    json: values.json ?? null,
    md: values.md ?? null,
    tui: Boolean(values.tui),
    braille: Boolean(values.braille),
    noColor: Boolean(values['no-color']),
    dryRun: Boolean(values['dry-run']),
    demo,
  };
}

/** A failed source's message as a note, labelled with the provider once. */
function failureNote(name, error) {
  const label = LABELS[/** @type {keyof typeof LABELS} */ (name)] ?? name;
  const msg = String(error instanceof Error ? error.message : error).split('\n')[0];
  return msg.startsWith(label) ? msg : `${label}: ${msg}`;
}

/** @param {ReturnType<typeof parseOptions>} o @param {import('./model.js').Window} window @param {Out} stdout */
function dryRun(o, window, stdout) {
  /** @type {RequestDescriptor[]} */
  const requests = [];
  if (o.focus.length) requests.push(...describeFocus({ paths: o.focus }));
  /** @type {{ min: number, max: number|null }} */
  let estimate = { min: 0, max: 0 };
  if (!o.noAws) {
    const aws = describeAws({ window, maxRequests: o.maxAwsRequests, profile: o.profile });
    requests.push(...aws.requests);
    estimate = aws.estimate;
  }
  if (o.openaiKey) requests.push(...describeOpenAI({ window }));
  if (o.anthropicKey) requests.push(...describeAnthropic({ window }));
  const github = o.githubOn ? describeGithub({ targets: o.github, tokenSource: o.githubTokenSource }) : { requests: [], estimates: [] };
  requests.push(...github.requests);
  for (const r of requests) {
    stdout.write(`${r.source}  ${r.target}  credential: ${r.credential ?? 'none'}  ${r.billed ? 'billed' : 'free'}\n`);
  }
  // An org's repos are not known until it is read, so its requests are an estimate.
  for (const line of github.estimates) stdout.write(`Estimated ${line}\n`);
  const money = (n) => formatMoney(n * AWS_REQUEST_COST, 'USD');
  stdout.write(estimate.max === null
    ? `Estimated AWS cost: ${money(estimate.min)} or more (one request per page of results)\n`
    : `Estimated AWS cost: ${money(estimate.min)}-${money(estimate.max)}\n`);
}

const NOTE_AWS_REPLACED = 'AWS: used Cost Explorer (--aws) in place of the AWS rows in the FOCUS input.';

/**
 * Remove AWS rows, detail rows and tag coverage from the FOCUS result, and say so.
 * @param {{ name: string, result: SourceResult }[]} results @param {string[]} notes @param {(line: string) => void} say
 */
function dropFocusAws(results, notes, say) {
  for (const { name, result } of results) {
    if (name !== 'focus') continue;
    const keep = (/** @type {{ provider: string }} */ r) => r.provider !== 'aws';
    result.rows = result.rows.filter(keep);
    result.detailRows = result.detailRows.filter(keep);
    if (result.candidateRows) result.candidateRows = result.candidateRows.filter(keep);
    result.tagCoverage = result.tagCoverage.filter(keep);
  }
  notes.push(NOTE_AWS_REPLACED);
  say(NOTE_AWS_REPLACED);
}

/**
 * The platform opener for a file. On Windows, `start` takes its first quoted argument as a window
 * title, so an empty title goes first, and the arguments are passed verbatim so Node does not escape it.
 * @param {string} platform @param {string} path
 * @returns {[string, string[], { windowsVerbatimArguments?: boolean }]}
 */
export function openCommand(platform, path) {
  if (platform === 'darwin') return ['open', [path], {}];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', `"${path}"`], { windowsVerbatimArguments: true }];
  return ['xdg-open', [path], {}];
}

/** Launch the platform opener without waiting for it. */
function openFile(path) {
  const [cmd, args, opts] = openCommand(process.platform, path);
  try {
    const child = spawn(cmd, args, { ...opts, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* opening is best effort */ }
}

/** Whether a window could show the report: Linux needs a display server, other platforms always have one. */
function hasDisplay(platform, env) {
  return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Refuse a report folder that is a link, or that another user owns or can open. */
async function checkPrivateDir(dir) {
  const st = await lstat(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && (st.uid !== uid || (st.mode & 0o077) !== 0))) {
    throw new Error(`${dir} is not a private folder owned by you, so the report was not written.`);
  }
}

/** No output option given, an interactive terminal, and not CI. */
function isBareRun(o, stdout, env) {
  return !(o.html || o.md || o.json || o.tui || o.dryRun) && Boolean(stdout.isTTY) && !env.CI;
}

/**
 * Whether to draw the live progress panel: both streams are terminals, not CI, and no JSON or
 * Markdown is asked for. Everything else keeps the plain progress lines on stderr.
 * @param {ReturnType<typeof parseOptions>} o @param {Out} stdout @param {Out} stderr @param {NodeJS.ProcessEnv} env
 */
function isLive(o, stdout, stderr, env) {
  return Boolean(stdout.isTTY && stderr.isTTY) && !env.CI && !o.tui && !o.json && !o.md && env.TERM !== 'dumb';
}

const warning = (path) => `Warning: ${path} contains real spend figures. Share it only with people who should see them.`;
const demoWarning = (path) => `${path} contains synthetic demo data, not real spend.`;

/**
 * Run plutus-scan.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: Out, stderr?: Out, stdin?: { isTTY?: boolean },
 *   transport?: ReturnType<typeof createTransport>, open?: (path: string) => unknown, tmpDir?: string }} [io]
 * `open`, `tmpDir`, `delay` and `runGh` default to the platform opener, the OS temp folder, a timer and
 * `gh auth token`; tests replace them.
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, transport, open = openFile, tmpDir = tmpdir(),
  delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), runGh = ghRunner() } = {}) {
  /** @type {{ view?: { stop: () => void } }} */
  const ctx = {};
  try {
    return await run(argv, { env, stdout, stderr, stdin, transport, open, tmpDir, delay, runGh, ctx });
  } catch (e) {
    ctx.view?.stop(); // the live panel comes down before the error is written
    if (e instanceof UsageError) {
      stderr.write(`plutus-scan: ${e.message}\nRun plutus-scan --help for usage.\n`);
      return 2;
    }
    stderr.write(`plutus-scan: ${String(e instanceof Error ? e.message : e).split('\n')[0]}\n`);
    return 1;
  }
}

/** @param {string[]} argv @param {{ env: NodeJS.ProcessEnv, stdout: Out, stderr: Out, stdin: { isTTY?: boolean },
 *   transport?: ReturnType<typeof createTransport>, open: (path: string) => unknown, tmpDir: string,
 *   delay: (ms: number) => Promise<void>, runGh: import('./sources/github-auth.js').GhRunner,
 *   ctx: { view?: { stop: () => void } } }} io */
async function run(argv, { env, stdout, stderr, stdin, transport, open, tmpDir, delay, runGh, ctx }) {
  const o = parseOptions(argv, env);
  if (o.help) {
    stdout.write(HELP);
    return 0;
  }
  if (o.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  // No token set: fall back to the gh CLI's login, only when GitHub is asked for (never with --demo).
  if (o.githubOn && !o.githubToken && !o.noGhAuth) {
    const token = await ghToken(runGh, env);
    if (token) {
      o.githubToken = token;
      o.githubTokenSource = 'gh login';
    }
  }
  if (o.githubOn) checkGithub(o.github, o.githubToken, { ghAuth: !o.noGhAuth }); // an org needs a token, refused before any request

  // 1. Window.
  const window = computeWindow({ days: o.days, end: o.end });
  if (o.dryRun) {
    dryRun(o, window, stdout);
    return 0;
  }
  // Refuse before any request when there is no terminal to draw on, so a billed run is not wasted.
  // runTui checks the size again, since the terminal can shrink while sources are read.
  if (o.tui && (!stdout.isTTY || !stdin.isTTY || (stdout.columns ?? 0) < TUI_MIN_COLUMNS || (stdout.rows ?? 0) < TUI_MIN_ROWS)) {
    throw new UsageError('--tui needs an interactive terminal of at least 80x24.');
  }
  const tui = o.tui ? await import('./tui/app.js') : null;
  const t = transport ?? createTransport({ profile: o.profile, env });

  /** @type {{ name: string, result: SourceResult }[]} */
  const results = [];
  /** @type {string[]} */
  const notes = [];
  let configured = 0;
  let failed = 0;

  // On an interactive run the sources and the analysis are drawn as a live panel; otherwise the plain
  // progress lines go to stderr as they always have.
  const live = isLive(o, stdout, stderr, env);
  const view = live ? createProgress({
    stream: stderr, theme: createTheme(o.noColor ? 0 : colorDepth(env)), version: VERSION, window,
    stats: () => ({ requests: t.log.length, billed: t.billedCount(), cost: t.billedCount() * AWS_REQUEST_COST }),
  }) : noProgress();
  ctx.view = view;
  const say = (/** @type {string} */ line) => { if (!live) stderr.write(`${line}\n`); };
  // The demo is instant, so on the live panel it pauses a little per step to be watchable.
  const pace = live && o.demo ? () => delay(DEMO_STEP_MS) : async () => {};
  const ok = (/** @type {string} */ name, /** @type {import('./ui/progress.js').SourceHandle} */ line, /** @type {SourceResult} */ result) => {
    const calls = t.log.filter((r) => r.source === name);
    line.ok(sourceSummary(name, result, { requests: calls.length, cost: calls.filter((r) => r.billed).length * AWS_REQUEST_COST }));
  };
  const fail = (name, e, line = view.source(name)) => {
    const note = failureNote(name, e);
    notes.push(note);
    say(note);
    line.fail(note.replace(/^[^:]+: /, ''));
  };
  const lines = {
    demo: o.demo ? view.source('Demo data') : null,
    focus: o.focus.length ? view.source('FOCUS') : null,
    aws: o.demo ? null : view.source('AWS Cost Explorer'),
    openai: o.demo ? null : view.source('OpenAI'),
    anthropic: o.demo ? null : view.source('Anthropic'),
    github: o.githubOn ? view.source('GitHub releases') : null,
  };
  if (o.demo) for (const label of ['AWS Cost Explorer', 'OpenAI', 'Anthropic']) view.source(label).skip('off, --demo reads no account');
  view.start();

  // Demo data, read through the FOCUS source; every other source is off.
  if (lines.demo) {
    configured += 1;
    lines.demo.step('generating 90 days of synthetic spend');
    await pace();
    const result = await fetchDemo(t, { window });
    results.push({ name: 'demo', result });
    lines.demo.step('reading it as a FOCUS export');
    await pace();
    ok('focus', lines.demo, result);
  }

  // 2. FOCUS.
  if (lines.focus) {
    configured += 1;
    say('Reading FOCUS files...');
    lines.focus.step('reading files');
    try {
      const result = await fetchFocus(t, { paths: o.focus, window });
      results.push({ name: 'focus', result });
      ok('focus', lines.focus, result);
    } catch (e) {
      failed += 1;
      fail('focus', e, lines.focus);
    }
  }

  // 3. AWS, with the skip and force rules.
  const focusHasAws = results.some((r) => r.name === 'focus' && r.result.rows.some((row) => row.provider === 'aws'));
  if (lines.aws && o.noAws) {
    lines.aws.skip('skipped, --no-aws');
  } else if (lines.aws && focusHasAws && !o.aws) {
    const note = 'AWS: skipped because the FOCUS input already holds AWS rows. Pass --aws to use Cost Explorer instead.';
    notes.push(note);
    say(note);
    lines.aws.skip('skipped, the FOCUS input holds AWS rows');
  } else if (lines.aws) {
    say('Checking the aws CLI...');
    lines.aws.step('checking the aws CLI');
    const avail = await awsAvailable(t);
    const reason = String(avail.reason ?? '').replace(/, so AWS was skipped\.$/, '');
    if (!avail.ok && !o.aws) {
      const note = `AWS: skipped (${reason}).`;
      notes.push(note);
      say(note);
      lines.aws.skip(`skipped, ${reason}`);
    } else if (!avail.ok) {
      configured += 1;
      failed += 1;
      fail('aws', `${reason}.`, lines.aws);
      results.push({ name: 'aws', result: emptyResult() }); // keeps the AWS request line; still a failure
    } else {
      configured += 1;
      say('Reading AWS Cost Explorer...');
      try {
        const result = await fetchAws(t, { window, maxTagKeys: o.maxTagKeys, maxRequests: o.maxAwsRequests, onStep: (step) => lines.aws?.step(step) });
        results.push({ name: 'aws', result });
        ok('aws', lines.aws, result);
        // Forced with --aws: live Cost Explorer wins, so the FOCUS AWS rows are dropped rather than counted twice.
        if (focusHasAws) dropFocusAws(results, notes, say);
      } catch (e) {
        failed += 1;
        fail('aws', e, lines.aws);
        // Billed calls may already have been made: keep the AWS request count and cost in every output.
        results.push({ name: 'aws', result: emptyResult() });
      }
    }
  }

  // 4. OpenAI, Anthropic and GitHub concurrently. GitHub is not a cost source.
  /** @type {{ name: string, cost: boolean, fetch: () => Promise<SourceResult> }[]} */
  const parallel = [];
  if (o.openaiKey) {
    const key = o.openaiKey;
    parallel.push({ name: 'openai', cost: true, fetch: () => fetchOpenAI(t, { window, key }) });
  } else lines.openai?.skip('skipped, no key');
  if (o.anthropicKey) {
    const key = o.anthropicKey;
    parallel.push({ name: 'anthropic', cost: true, fetch: () => fetchAnthropic(t, { window, key }) });
  } else lines.anthropic?.skip('skipped, no key');
  if (o.githubOn) {
    parallel.push({ name: 'github', cost: false, fetch: () => fetchGithub(t, { targets: o.github, window, token: o.githubToken, tokenSource: o.githubTokenSource }) });
  }
  if (parallel.length) say(`Reading ${parallel.map((p) => LABELS[/** @type {keyof typeof LABELS} */ (p.name)]).join(', ')}...`);
  const lineOf = (/** @type {string} */ name) => lines[/** @type {keyof typeof lines} */ (name)] ?? view.source(name);
  const settled = await Promise.allSettled(parallel.map((p) => {
    lineOf(p.name).step('fetching');
    return p.fetch().then((result) => { ok(p.name, lineOf(p.name), result); return result; });
  }));
  // 5. Failures become notes.
  settled.forEach((s, i) => {
    const p = parallel[i];
    if (p.cost) configured += 1;
    if (s.status === 'fulfilled') results.push({ name: p.name, result: s.value });
    else {
      if (p.cost) failed += 1;
      fail(p.name, s.reason, lineOf(p.name));
    }
  });

  // 6-7. Nothing to report. The panel comes down first, and its notes are written out, since no
  // report follows to carry them.
  if (configured === 0 || failed === configured) {
    view.finish();
    if (live) for (const note of notes) stderr.write(`${note}\n`);
  }
  if (configured === 0) {
    stderr.write(`${NO_SOURCES}\n`);
    return 2;
  }
  if (failed === configured) {
    // No report to carry it, so billed Cost Explorer calls are stated here.
    if (t.billedCount() > 0) {
      stderr.write(`${awsRequestLine({ billedRequests: t.billedCount(), cost: t.billedCount() * AWS_REQUEST_COST })}\n`);
    }
    return 1;
  }

  // 8. Report. buildReport holds the event loop, so the panel is drawn first and ticked after.
  const steps = view.analysis(ANALYSIS);
  view.render();
  const report = buildReport({
    window, results, awsBilledRequests: t.billedCount(), version: VERSION, generatedAt: new Date().toISOString(),
  });
  report.notes = [...notes, ...report.notes];
  for (const step of ANALYSIS) {
    await pace();
    steps.done(step);
  }
  view.render();
  await pace();
  view.finish();

  // 9-10. Outputs.
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (o.json === '-') stdout.write(json);
  else if (o.json) await writeFile(o.json, json);
  if (o.md === '-') stdout.write(renderMarkdown(report));
  else if (o.md) await writeFile(o.md, renderMarkdown(report));
  if (o.html) await writeFile(o.html, renderHtml(report));

  if (!o.tui && o.json !== '-' && o.md !== '-') {
    const color = Boolean(stdout.isTTY && !env.NO_COLOR && !o.noColor);
    // The stdout this run was given decides the layout, not the process's own.
    const layout = stdout.isTTY ? 'dashboard' : 'plain';
    stdout.write(renderTerminal(report, { color, columns: stdout.columns || 100, braille: o.braille, layout, env }));
  }
  const notice = o.demo ? demoWarning : warning;
  // On the live panel's runs the report gets a line of its own; the notice after it is word for word.
  const wrote = (/** @type {string} */ path, /** @type {boolean} */ opening) => {
    if (live) stderr.write(`Wrote report: ${path}${opening ? ', opening in your browser' : ''}\n`);
  };
  if (o.html) {
    wrote(o.html, o.open);
    stderr.write(`${notice(o.html)}\n`);
    if (o.open) open(o.html);
  } else if (!o.noHtml && isBareRun(o, stdout, env)) {
    // A bare interactive run also leaves the report in the temp folder, where real figures stay out of any repo.
    const dir = join(tmpDir, 'plutus-scan');
    // A demo report gets its own name, so it never replaces a real one for the same day.
    const path = join(dir, `${o.demo ? 'demo-' : ''}report-${window.end}.html`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await checkPrivateDir(dir);
    await rm(path, { force: true }); // replaces the file itself, never writing through a link left at the path
    await writeFile(path, renderHtml(report), { mode: 0o600, flag: 'wx' });
    const opening = !o.noOpen && hasDisplay(process.platform, env);
    wrote(path, opening);
    stderr.write(`${notice(path)}\n`);
    if (opening) open(path);
  }

  // 11. Full-screen view.
  if (tui) {
    const writeHtml = async (/** @type {string} */ path) => {
      await writeFile(path, renderHtml(report));
      return notice(path);
    };
    await tui.runTui(report, { input: /** @type {any} */ (stdin), output: stdout, env, writeHtml, noColor: o.noColor });
  }
  return 0;
}

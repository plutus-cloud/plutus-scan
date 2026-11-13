// Recording transport: every HTTP and aws CLI call goes through here, and the
// log of what was (or would be) requested drives --dry-run and the
// "only configured hosts" test. Header values are never recorded.
import { spawn } from 'node:child_process';

/** @typedef {import('./model.js').RequestDescriptor} RequestDescriptor */

export class SourceError extends Error {
  /**
   * @param {string} source
   * @param {number|null} status
   * @param {string} message
   * @param {string|null} [code]
   */
  constructor(source, status, message, code = null) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
    this.code = code;
  }
}

/**
 * Run a command without a shell.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
export function defaultExec(cmd, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/** Short, secret-free description of a failed HTTP response. */
async function describeHttpError(res) {
  let detail = '';
  try {
    const parsed = JSON.parse(await res.text());
    const m = parsed?.error?.message ?? parsed?.message;
    if (typeof m === 'string') detail = m.split('\n')[0].slice(0, 200);
  } catch { /* body is not JSON; fall back to the status text */ }
  if (!detail) detail = String(res.statusText || '').slice(0, 100);
  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

const TIMEOUT_MS = 60000;

/** @param {unknown} e @returns {boolean} whether the error is the request timeout firing */
const timedOut = (e) => /** @type {any} */ (e)?.name === 'TimeoutError';

/**
 * @param {{ fetchImpl?: typeof fetch, execImpl?: typeof defaultExec,
 *   profile?: string|null, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 */
export function createTransport({
  fetchImpl = globalThis.fetch,
  execImpl = defaultExec,
  profile = null,
  env = process.env,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  /** @type {RequestDescriptor[]} */
  const log = [];

  async function run(source, args, { billed, extra }) {
    const full = [...args, ...extra, ...(profile ? ['--profile', profile] : [])];
    log.push({ source, kind: 'aws-cli', target: `aws ${full.join(' ')}`, credential: null, billed });
    let res;
    try {
      res = await execImpl('aws', full, { env });
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new SourceError(source, null, 'aws CLI not found on PATH', 'ENOENT');
      throw new SourceError(source, null, `aws CLI failed to start: ${String(e?.message ?? e).split('\n')[0]}`);
    }
    if (res.code !== 0) {
      const first = String(res.stderr ?? '').split('\n').find((l) => l.trim()) ?? `aws exited with code ${res.code}`;
      const code = /An error occurred \(([A-Za-z0-9_.]+)\)/.exec(String(res.stderr ?? ''))?.[1] ?? null;
      throw new SourceError(source, res.code, first.trim(), code);
    }
    return res.stdout;
  }

  return {
    log,

    /**
     * @param {string} source
     * @param {string} url
     * @param {{ headers?: Record<string,string>, credential?: string|null, billed?: boolean,
     *   method?: 'GET'|'POST', body?: unknown }} [opts] a `body` is sent as JSON (GitHub GraphQL)
     */
    async http(source, url, { headers = {}, credential = null, billed = false, method = 'GET', body } = {}) {
      log.push({ source, kind: 'http', target: url, credential, billed });
      // One hung provider must not hang the run; the signal also covers reading the body.
      const signal = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, body === undefined
          ? { headers, signal }
          : { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      } catch (e) {
        if (timedOut(e)) throw new SourceError(source, null, 'request timed out');
        // Only a network cause code is echoed: a fetch error message can quote header values.
        const code = typeof e?.cause?.code === 'string' && /^[A-Z0-9_]+$/.test(e.cause.code) ? e.cause.code : null;
        throw new SourceError(source, null, code ? `request failed: ${code}` : 'request failed');
      }
      if (!res.ok) throw new SourceError(source, res.status, await describeHttpError(res));
      let text;
      try {
        text = await res.text();
      } catch (e) {
        throw new SourceError(source, res.status, timedOut(e) ? 'request timed out' : 'response could not be read');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new SourceError(source, res.status, 'response was not valid JSON');
      }
    },

    /**
     * @param {string} source
     * @param {string[]} args
     * @param {{ billed?: boolean }} [opts]
     */
    async aws(source, args, { billed = false } = {}) {
      const out = await run(source, args, { billed, extra: ['--output', 'json', '--no-cli-pager'] });
      try {
        return JSON.parse(out.toString('utf8'));
      } catch {
        throw new SourceError(source, null, 'aws CLI output was not valid JSON');
      }
    },

    /**
     * @param {string} source
     * @param {string[]} args
     * @returns {Promise<Buffer>}
     */
    awsRaw(source, args) {
      return run(source, args, { billed: false, extra: [] });
    },

    billedCount() {
      return log.filter((r) => r.billed).length;
    },
  };
}

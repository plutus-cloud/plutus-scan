// The last place the GitHub token can come from, after --github-token, GITHUB_TOKEN and GH_TOKEN:
// the gh CLI's own login (`gh auth token`), the way the AWS source reuses the aws CLI's. gh runs without a shell,
// with a short timeout, and anything other than one clean token on stdout means "no token": a
// missing gh, a non-zero exit, a timeout or empty output never fails the run. gh's stderr is
// dropped, and the token itself is never written anywhere; only where it came from is.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** @typedef {'--github-token'|'GITHUB_TOKEN'|'GH_TOKEN'|'gh login'} TokenSource */
/** @typedef {(env: NodeJS.ProcessEnv) => Promise<{ code: number, stdout: string }>} GhRunner */

const GH_ARGS = ['auth', 'token', '--hostname', 'github.com'];
const GH_TIMEOUT_MS = 5000;
// One printable, space-free line; anything else from gh is not a token.
const TOKEN_RE = /^[\x21-\x7e]{1,1024}$/;

// Other providers' keys, which gh has no use for.
const HIDDEN_FROM_GH = ['OPENAI_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY'];

/**
 * The absolute path of `cmd` in the PATH folders, or null. Empty and relative entries (such as ".")
 * are skipped, so a gh left in the current folder is never the one run.
 * @param {string} cmd @param {NodeJS.ProcessEnv} env @param {string} [platform] @returns {string|null}
 */
export function onPath(cmd, env, platform = process.platform) {
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = join(dir, cmd + ext);
      try {
        accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * Run `gh auth token --hostname github.com` without a shell, by the absolute path found on PATH.
 * Missing gh resolves as exit 127.
 * @param {{ timeoutMs?: number }} [opts] @returns {GhRunner}
 */
export function ghRunner({ timeoutMs = GH_TIMEOUT_MS } = {}) {
  return (env) => new Promise((resolve) => {
    const gh = onPath('gh', env);
    if (!gh) {
      resolve({ code: 127, stdout: '' });
      return;
    }
    const childEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
    for (const name of HIDDEN_FROM_GH) delete childEnv[name];
    execFile(gh, GH_ARGS, {
      shell: false, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8',
      env: childEnv,
    }, (error, stdout) => {
      if (error) resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout: '' });
      else resolve({ code: 0, stdout: String(stdout) });
    });
  });
}

/**
 * The gh CLI's token for github.com, or null for any failure.
 * @param {GhRunner} runGh @param {NodeJS.ProcessEnv} env @returns {Promise<string|null>}
 */
export async function ghToken(runGh, env) {
  try {
    const res = await runGh(env);
    if (res?.code !== 0) return null;
    const token = String(res.stdout ?? '').trim();
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}


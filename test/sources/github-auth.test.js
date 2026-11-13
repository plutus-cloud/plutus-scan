import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ghRunner, ghToken, onPath } from '../../src/sources/github-auth.js';

const TOKEN = 'gho_fake-test-token';

/** A folder holding a fake `gh` script with this body. PATH is that folder alone, so the real gh is never found. */
function fakeGh(body) {
  const dir = mkdtempSync(join(tmpdir(), 'plutus-scan-gh-'));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  return { PATH: dir, dir };
}

test('ghToken trims one clean token and treats every other answer as no token', async () => {
  const answer = (res) => async () => res;
  assert.equal(await ghToken(answer({ code: 0, stdout: `${TOKEN}\n` }), {}), TOKEN);
  assert.equal(await ghToken(answer({ code: 0, stdout: `  ${TOKEN}  \r\n` }), {}), TOKEN);
  assert.equal(await ghToken(answer({ code: 1, stdout: TOKEN }), {}), null, 'non-zero exit');
  assert.equal(await ghToken(answer({ code: 127, stdout: '' }), {}), null, 'gh missing');
  assert.equal(await ghToken(answer({ code: 0, stdout: '' }), {}), null, 'empty output');
  assert.equal(await ghToken(answer({ code: 0, stdout: ' \n' }), {}), null, 'blank output');
  assert.equal(await ghToken(answer({ code: 0, stdout: `${TOKEN}\nmore` }), {}), null, 'two lines');
  assert.equal(await ghToken(answer({ code: 0, stdout: 'a token' }), {}), null, 'a space');
  assert.equal(await ghToken(answer(null), {}), null);
  assert.equal(await ghToken(async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, {}), null);
  assert.equal(await ghToken(() => { throw new Error('sync throw'); }, {}), null);
});

test('onPath finds an executable gh only in absolute PATH folders, and returns its path', () => {
  const { dir } = fakeGh('exit 0');
  assert.equal(onPath('gh', { PATH: dir }), join(dir, 'gh'));
  assert.equal(onPath('gh', { PATH: '' }), null);
  assert.equal(onPath('gh', {}), null);
  const plain = mkdtempSync(join(tmpdir(), 'plutus-scan-gh-'));
  writeFileSync(join(plain, 'gh'), 'not executable');
  chmodSync(join(plain, 'gh'), 0o644);
  assert.equal(onPath('gh', { PATH: plain }), null);
  // A relative entry such as "." is skipped, even when it holds a gh.
  const rel = relative(process.cwd(), dir);
  assert.equal(onPath('gh', { PATH: `.:${rel}` }), null);
  assert.equal(onPath('gh', { PATH: `${rel}:${dir}` }), join(dir, 'gh'));
});

test('gh runs by the path found, without the other providers\' keys', async () => {
  const { PATH } = fakeGh('[ -z "$OPENAI_ADMIN_KEY$ANTHROPIC_ADMIN_KEY" ] && [ "$KEEP" = 1 ] && echo ok-token && exit 0; exit 4');
  assert.equal(await ghToken(ghRunner(), { PATH, KEEP: '1', OPENAI_ADMIN_KEY: 'sk-x', ANTHROPIC_ADMIN_KEY: 'sk-y' }), 'ok-token');
});

test('the runner asks gh for its github.com token, without a shell or a prompt', async () => {
  // The fake prints the token only for exactly these arguments, and only with prompts off.
  const { PATH } = fakeGh(`[ "$*" = "auth token --hostname github.com" ] && [ "$GH_PROMPT_DISABLED" = 1 ] && echo ${TOKEN} && exit 0; exit 3`);
  const res = await ghRunner()({ PATH });
  assert.deepEqual(res, { code: 0, stdout: `${TOKEN}\n` });
  assert.equal(await ghToken(ghRunner(), { PATH }), TOKEN);
});

test('the runner reports a missing gh, a failure and a hang as no token', async () => {
  assert.deepEqual(await ghRunner()({ PATH: mkdtempSync(join(tmpdir(), 'plutus-scan-empty-')) }), { code: 127, stdout: '' });
  const failing = fakeGh('echo "not logged in to any GitHub hosts" >&2; exit 1');
  assert.equal(await ghToken(ghRunner(), { PATH: failing.PATH }), null);
  const silent = fakeGh('exit 0');
  assert.equal(await ghToken(ghRunner(), { PATH: silent.PATH }), null);
  const hung = fakeGh(`echo ${TOKEN}; exec /bin/sleep 10`);
  const started = Date.now();
  assert.equal(await ghToken(ghRunner({ timeoutMs: 200 }), { PATH: hung.PATH }), null);
  assert.ok(Date.now() - started < 5000, 'the timeout ends a hung gh');
});

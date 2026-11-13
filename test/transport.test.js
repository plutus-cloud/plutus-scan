import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, SourceError } from '../src/transport.js';

function fakeFetch(status, body, statusText = '') {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test('http records the credential name, not its value', async () => {
  const t = createTransport({ fetchImpl: fakeFetch(200, { ok: 1 }) });
  const out = await t.http('openai', 'https://api.openai.com/v1/organization/costs?limit=1', {
    headers: { Authorization: 'Bearer sk-test-123' },
    credential: 'OPENAI_ADMIN_KEY',
  });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(t.log.length, 1);
  assert.equal(t.log[0].credential, 'OPENAI_ADMIN_KEY');
  assert.equal(t.log[0].kind, 'http');
  assert.equal(t.log[0].source, 'openai');
  assert.equal(t.log[0].billed, false);
  assert.ok(!JSON.stringify(t.log).includes('sk-test-123'));
});

test('http 401 throws SourceError without header values', async () => {
  const t = createTransport({
    fetchImpl: fakeFetch(401, { error: { message: 'Incorrect API key' } }, 'Unauthorized'),
  });
  await assert.rejects(
    () => t.http('openai', 'https://api.openai.com/v1/x', {
      headers: { Authorization: 'Bearer sk-test-123' },
      credential: 'OPENAI_ADMIN_KEY',
    }),
    (err) => {
      assert.ok(err instanceof SourceError);
      assert.equal(err.source, 'openai');
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes('sk-test-123'));
      assert.ok(err.message.includes('Incorrect API key'));
      return true;
    },
  );
  assert.equal(t.log.length, 1);
});

test('http non-JSON error body falls back to status text', async () => {
  const t = createTransport({ fetchImpl: fakeFetch(502, '<html>sk-test-123</html>', 'Bad Gateway') });
  await assert.rejects(
    () => t.http('github', 'https://api.github.com/x'),
    (err) => err.status === 502 && err.message.includes('Bad Gateway') && !err.message.includes('sk-test'),
  );
});

test('aws passes --profile and counts billed calls', async () => {
  const calls = [];
  const execImpl = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: Buffer.from('{"a":1}'), stderr: '' };
  };
  const env = { AWS_REGION: 'us-east-1' };
  const t = createTransport({ execImpl, profile: 'work', env });
  const out = await t.aws('aws', ['ce', 'get-cost-and-usage'], { billed: true });
  assert.deepEqual(out, { a: 1 });
  assert.equal(calls[0].cmd, 'aws');
  assert.deepEqual(calls[0].args, ['ce', 'get-cost-and-usage', '--output', 'json', '--no-cli-pager', '--profile', 'work']);
  assert.equal(calls[0].opts.env, env);
  await t.aws('aws', ['sts', 'get-caller-identity'], { billed: false });
  assert.equal(t.billedCount(), 1);
  assert.equal(t.log.length, 2);
  assert.equal(t.log[0].kind, 'aws-cli');
  assert.equal(t.log[0].target, 'aws ce get-cost-and-usage --output json --no-cli-pager --profile work');
  assert.equal(t.log[0].credential, null);
  assert.equal(t.log[0].billed, true);
});

test('aws extracts the AWS error code from stderr', async () => {
  const execImpl = async () => ({
    code: 254,
    stdout: Buffer.alloc(0),
    stderr: 'An error occurred (AccessDeniedException) when calling the GetCostAndUsage operation: nope\nmore',
  });
  const t = createTransport({ execImpl });
  await assert.rejects(
    () => t.aws('aws', ['ce', 'get-cost-and-usage'], { billed: true }),
    (err) => {
      assert.ok(err instanceof SourceError);
      assert.equal(err.code, 'AccessDeniedException');
      assert.ok(!err.message.includes('\n'));
      assert.ok(err.message.startsWith('An error occurred'));
      return true;
    },
  );
});

test('missing aws binary gives code ENOENT', async () => {
  const execImpl = async () => { throw Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }); };
  const t = createTransport({ execImpl });
  await assert.rejects(
    () => t.aws('aws', ['sts', 'get-caller-identity'], { billed: false }),
    (err) => err instanceof SourceError && err.code === 'ENOENT' && /aws CLI not found on PATH/.test(err.message),
  );
});

test('awsRaw returns the stdout buffer, logs unbilled, uses the profile', async () => {
  const calls = [];
  const execImpl = async (cmd, args) => {
    calls.push(args);
    return { code: 0, stdout: Buffer.from([1, 2, 3]), stderr: '' };
  };
  const t = createTransport({ execImpl, profile: 'p' });
  const out = await t.awsRaw('focus', ['s3', 'cp', 's3://b/k', '-']);
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual([...out], [1, 2, 3]);
  assert.deepEqual(calls[0], ['s3', 'cp', 's3://b/k', '-', '--profile', 'p']);
  assert.equal(t.log[0].billed, false);
  assert.equal(t.log[0].target, 'aws s3 cp s3://b/k - --profile p');
  assert.equal(t.billedCount(), 0);
});

test('a fetch error that quotes a header value is not echoed', async () => {
  const secret = 'sk-test-secret\nx';
  // Builds Headers the way fetch does, which throws on the line break; no network is touched.
  const fetchImpl = async (_url, { headers }) => { new Headers(headers); throw new Error('unreachable'); };
  const t = createTransport({ fetchImpl });
  await assert.rejects(
    t.http('openai', 'https://api.openai.com/v1/organization/costs', { headers: { Authorization: `Bearer ${secret}` } }),
    (e) => e instanceof SourceError && e.message === 'request failed' && !e.message.includes('sk-test-secret'),
  );
  const quoting = async () => { throw new TypeError(`invalid header value "${secret}"`); };
  await assert.rejects(createTransport({ fetchImpl: quoting }).http('openai', 'https://api.openai.com/x'),
    (e) => e.message === 'request failed');
  const network = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(createTransport({ fetchImpl: network }).http('openai', 'https://api.openai.com/x'),
    (e) => e.message === 'request failed: ECONNREFUSED');
});

test('a hung request times out as a SourceError', async () => {
  /** Never answers; rejects only when the signal aborts. */
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const t = createTransport({ fetchImpl, timeoutMs: 20 });
  await assert.rejects(t.http('openai', 'https://api.openai.com/v1/x'),
    (e) => e instanceof SourceError && e.source === 'openai' && e.message === 'request timed out');
  // A body that stalls after the headers times out the same way.
  const slowBody = (_url, { signal }) => Promise.resolve({ ok: true, status: 200, statusText: '',
    text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  await assert.rejects(createTransport({ fetchImpl: slowBody, timeoutMs: 20 }).http('openai', 'https://api.openai.com/v1/x'),
    (e) => e instanceof SourceError && e.message === 'request timed out');
});

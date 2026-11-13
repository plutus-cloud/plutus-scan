import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/plutus-scan.js', import.meta.url));

test('--version prints the package version', () => {
  const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(r.stdout, '0.1.0\n');
  assert.equal(r.status, 0);
});

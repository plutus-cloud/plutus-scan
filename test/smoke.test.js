import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/plutus-scan.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('--version prints the package version', () => {
  const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(r.stdout, `${version}\n`);
  assert.equal(r.status, 0);
});

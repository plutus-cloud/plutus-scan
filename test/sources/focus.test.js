import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTransport } from '../../src/transport.js';
import { describeFocus, fetchFocus } from '../../src/sources/focus/index.js';
import { readParquetRecords } from '../../src/sources/focus/parquet.js';
import { FocusInputError } from '../../src/sources/focus/rows.js';

const FIX = new URL('../fixtures/focus/', import.meta.url);
const fixturePath = (name) => new URL(name, FIX).pathname;
const window = { start: '2026-10-01', end: '2026-10-05', days: 5 };

const HEAD = 'BilledCost,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName,Tags,x_UsageType';
const csv = (...lines) => [HEAD, ...lines].join('\n') + '\n';
// A transport whose aws CLI must never be reached.
const noAws = () => createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'focus-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Runs fn with os.tmpdir() pointed at a private empty folder, so a test can assert that the
// code under test leaves nothing behind without seeing temp dirs other test files create at
// the same time. Test files run in separate processes, so the env change reaches only this one.
async function withPrivateTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'focus-private-tmp-'));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
    await rm(root, { recursive: true, force: true });
  }
}

const total = (rows) => Math.round(rows.reduce((s, r) => s + r.cost * 100, 0)) / 100;

test('reads a directory of csv and csv.gz', async () => {
  await scratch(async (dir) => {
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'a.csv'), csv('10,USD,2026-10-01T00:00:00Z,AWS,S3,,TimedStorage'));
    await writeFile(join(dir, 'nested', 'b.csv.gz'), gzipSync(csv('5.5,USD,2026-10-02T00:00:00Z,Microsoft,Virtual Machines,,')));
    await writeFile(join(dir, 'ignore.txt'), 'nope');
    const res = await fetchFocus(noAws(), { paths: [dir], window });
    assert.equal(res.rows.length, 2);
    assert.equal(total(res.rows), 15.5);
    assert.deepEqual(res.rows.map((r) => r.provider).sort(), ['aws', 'azure']);
    assert.deepEqual(res.detailRows.map((r) => r.usageType), ['TimedStorage']);
    assert.deepEqual(res.basis, ['FOCUS: BilledCost, including credit and tax rows when present.']);
    assert.deepEqual(res.notes, []);
  });
});

test('part files in one directory are one export and are summed', async () => {
  await scratch(async (dir) => {
    const a = join(dir, 'export-00001.csv');
    const b = join(dir, 'export-00002.csv');
    await writeFile(a, csv('100,USD,2026-10-01T00:00:00Z,AWS,S3,,', '100,USD,2026-10-02T00:00:00Z,AWS,S3,,'));
    await writeFile(b, csv('150,USD,2026-10-01T00:00:00Z,AWS,EC2,,', '150,USD,2026-10-02T00:00:00Z,AWS,EC2,,'));
    await utimes(a, new Date('2026-10-10T00:00:00Z'), new Date('2026-10-10T00:00:00Z'));
    await utimes(b, new Date('2026-10-10T00:00:05Z'), new Date('2026-10-10T00:00:05Z'));
    const res = await fetchFocus(noAws(), { paths: [dir], window });
    assert.equal(total(res.rows), 500);
    assert.deepEqual(res.notes, []);
  });
});

test('two export directories covering the same days keep the newer directory', async () => {
  await scratch(async (dir) => {
    const older = join(dir, 'export-old');
    const newer = join(dir, 'export-new');
    await mkdir(older);
    await mkdir(newer);
    await writeFile(join(older, 'part-1.csv'), csv(
      '100,USD,2026-10-01T00:00:00Z,AWS,S3,,',
      '100,USD,2026-10-02T00:00:00Z,AWS,S3,,',
      '7,USD,2026-10-01T00:00:00Z,Microsoft,Storage,,',
    ));
    await writeFile(join(older, 'part-2.csv'), csv('1,USD,2026-10-03T00:00:00Z,AWS,S3,,'));
    await writeFile(join(newer, 'part-1.csv'), csv('150,USD,2026-10-01T00:00:00Z,AWS,S3,,'));
    await writeFile(join(newer, 'part-2.csv'), csv('150,USD,2026-10-02T00:00:00Z,AWS,S3,,'));
    const at = (f, iso) => utimes(f, new Date(iso), new Date(iso));
    await at(join(older, 'part-1.csv'), '2026-10-10T00:00:00Z');
    await at(join(older, 'part-2.csv'), '2026-10-25T00:00:00Z'); // the newest file decides the directory
    await at(join(newer, 'part-1.csv'), '2026-10-20T00:00:00Z');
    await at(join(newer, 'part-2.csv'), '2026-10-20T00:00:00Z');
    let res = await fetchFocus(noAws(), { paths: [dir], window });
    assert.equal(total(res.rows.filter((r) => r.provider === 'aws')), 201);
    assert.deepEqual(res.notes, [`FOCUS: ${newer} and ${older} both cover aws on 2 days; used the newer export.`]);

    await at(join(older, 'part-2.csv'), '2026-10-10T00:00:00Z');
    res = await fetchFocus(noAws(), { paths: [dir], window });
    assert.equal(total(res.rows.filter((r) => r.provider === 'aws')), 301);
    assert.equal(total(res.rows.filter((r) => r.provider === 'azure')), 7);
    assert.deepEqual(res.notes, [`FOCUS: ${older} and ${newer} both cover aws on 2 days; used the newer export.`]);
  });
});

test('rows with the same key are collapsed while reading', async () => {
  await scratch(async (dir) => {
    await writeFile(join(dir, 'a.csv'), csv(
      '1.25,USD,2026-10-01T00:00:00Z,AWS,S3,"{""team"":""web""}",TimedStorage',
      '2.50,USD,2026-10-01T06:00:00Z,AWS,S3,,TimedStorage',
      '4,USD,2026-10-02T00:00:00Z,AWS,S3,,TimedStorage',
    ));
    const res = await fetchFocus(noAws(), { paths: [dir], window });
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows.find((r) => r.date === '2026-10-01').cost, 3.75);
    assert.deepEqual(res.tagCoverage, [{ provider: 'aws', key: 'team', taggedCost: 1.25, untaggedCost: 6.5 }]);
  });
});

test('a credit with the same key as usage keeps its own row', async () => {
  await scratch(async (dir) => {
    await writeFile(join(dir, 'a.csv'), csv(
      '400,USD,2026-10-03T00:00:00Z,AWS,EC2,,BoxUsage',
      '-300,USD,2026-10-03T00:00:00Z,AWS,EC2,,BoxUsage',
    ));
    const res = await fetchFocus(noAws(), { paths: [dir], window });
    assert.deepEqual(res.rows.map((r) => r.cost).sort((a, b) => a - b), [-300, 400]);
  });
});

test('a ChargePeriodStart without a zone is read as UTC', async () => {
  const saved = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  try {
    await scratch(async (dir) => {
      await writeFile(join(dir, 'a.csv'), csv(
        '1,USD,2026-10-02T00:00:00,AWS,S3,,',
        '2,USD,2026-10-03 00:00:00,AWS,S3,,',
        '4,USD,2026-10-04,AWS,S3,,',
        '8,USD,2026-10-05T00:00:00+00:00,AWS,S3,,',
      ));
      const res = await fetchFocus(noAws(), { paths: [dir], window });
      assert.deepEqual(res.rows.map((r) => [r.date, r.cost]).sort(),
        [['2026-10-02', 1], ['2026-10-03', 2], ['2026-10-04', 4], ['2026-10-05', 8]]);
    });
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

// How the Parquet fixtures were made (outside this repo, so no dev dependency was added): in a
// scratch directory, `npm install hyparquet-writer`, then one script wrote the same 3 rows
// (columns BilledCost, BillingCurrency, ChargePeriodStart, ServiceProviderName, ServiceName,
// Tags, x_UsageType) with parquetWriteFile({ codec: 'SNAPPY' }) to small.parquet, and with
// codec 'ZSTD' plus compressors { ZSTD: zlib.zstdCompressSync } to zstd.parquet.
test('reads snappy parquet', async () => {
  const recs = [];
  for await (const r of readParquetRecords(fixturePath('small.parquet'))) recs.push(r);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].BilledCost, '12.5');
  assert.equal(recs[1].Tags, '');
  const res = await fetchFocus(noAws(), { paths: [fixturePath('small.parquet')], window });
  assert.equal(total(res.rows), 22.75);
  assert.deepEqual(res.rows.map((r) => r.provider), ['aws', 'aws', 'azure']);
  assert.equal(res.detailRows.length, 2);
  assert.deepEqual(res.tagCoverage, [{ provider: 'aws', key: 'team', taggedCost: 12.5, untaggedCost: 3.25 }]);
});

test('rejects zstd parquet with the re-export message', async () => {
  await assert.rejects(
    async () => { for await (const _ of readParquetRecords(fixturePath('zstd.parquet'))) { /* drain */ } },
    (e) => e instanceof FocusInputError
      && e.message === 'zstd.parquet uses ZSTD compression, which plutus-scan cannot read. Re-export as CSV or Snappy Parquet.',
  );
});

test('s3 path lists and fetches through the aws CLI', () => withPrivateTmp(async (tmp) => {
  const calls = [];
  const parquet = await readFile(fixturePath('small.parquet'));
  const objects = {
    's3://bkt/exports/a.csv': Buffer.from(csv('10,USD,2026-10-04T00:00:00Z,AWS,S3,,')),
    's3://bkt/exports/b.csv.gz': gzipSync(csv('4,USD,2026-10-05T00:00:00Z,AWS,EC2,,')),
    's3://bkt/exports/c.parquet': parquet,
  };
  const execImpl = async (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, 'aws');
    if (args[1] === 'ls') {
      return {
        code: 0,
        stderr: '',
        stdout: Buffer.from([
          '2026-10-06 09:00:00        100 exports/a.csv',
          '2026-10-06 09:00:00        100 exports/b.csv.gz',
          '2026-10-06 09:00:00        100 exports/c.parquet',
          '2026-10-06 09:00:00        100 exports/readme.txt',
          '',
        ].join('\n')),
      };
    }
    assert.deepEqual(args.slice(0, 2), ['s3', 'cp']);
    assert.equal(args[3], '-');
    return { code: 0, stderr: '', stdout: objects[args[2]] };
  };
  const transport = createTransport({ execImpl });
  const res = await fetchFocus(transport, { paths: ['s3://bkt/exports/'], window });
  assert.deepEqual(calls[0].slice(0, 5), ['aws', 's3', 'ls', 's3://bkt/exports/', '--recursive']);
  assert.equal(calls.length, 4);
  assert.equal(res.rows.length, 5);
  assert.equal(total(res.rows), 36.75);
  assert.ok(transport.log.every((r) => r.source === 'focus' && r.billed === false));
  assert.deepEqual(await readdir(tmp), [], 'temp dirs are removed');
  const d = describeFocus({ paths: ['/local/x.csv', 's3://bkt/exports/'] });
  assert.equal(d.length, 2);
  assert.equal(d[0].target, 'aws s3 ls s3://bkt/exports/ --recursive');
  assert.ok(d.every((r) => r.billed === false && r.kind === 'aws-cli' && r.source === 'focus'));
  assert.deepEqual(describeFocus({ paths: ['/local/x.csv'] }), []);
}));

test('tag coverage over the synthetic fixture', async () => {
  const w = { start: '2026-07-31', end: '2026-10-28', days: 90 };
  const res = await fetchFocus(noAws(), { paths: [fixturePath('synthetic.csv')], window: w });
  assert.equal(res.rows.length, 631);
  assert.equal(Math.round(total(res.rows) * 100), 5193344);
  // Only the team key exists, and only AWS rows carry it. The last 30 days are
  // 2026-09-29..2026-10-28, so the credit row (2026-09-10) is outside.
  assert.deepEqual(res.tagCoverage, [{ provider: 'aws', key: 'team', taggedCost: 9864.0, untaggedCost: 1362.9 }]);
});

test('s3 zstd parquet error names the object and leaves no temp dir', () => withPrivateTmp(async (tmp) => {
  const zstd = await readFile(fixturePath('zstd.parquet'));
  const execImpl = async (_cmd, args) => ({
    code: 0,
    stderr: '',
    stdout: args[1] === 'ls' ? Buffer.from('2026-10-06 09:00:00        100 exports/z.parquet\n') : zstd,
  });
  await assert.rejects(
    fetchFocus(createTransport({ execImpl }), { paths: ['s3://bkt/exports/'], window }),
    (e) => e instanceof FocusInputError
      && e.message === 'z.parquet uses ZSTD compression, which plutus-scan cannot read. Re-export as CSV or Snappy Parquet.',
  );
  assert.deepEqual(await readdir(tmp), []);
}));

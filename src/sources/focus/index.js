// FOCUS source: local files, directories, csv.gz, Parquet and s3:// prefixes (through `aws s3`).
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, gunzipSync } from 'node:zlib';
import { emptyResult, lastNDays } from '../../model.js';
import { shellQuote } from '../aws.js';
import { parseCsvStream } from './csv.js';
import { readParquetRecords } from './parquet.js';
import { FocusInputError, focusRecordToRow, recordTags } from './rows.js';

/** @typedef {import('../../model.js').Row} Row */
/** @typedef {import('../../model.js').Window} Window */
/** @typedef {import('../../model.js').SourceResult} SourceResult */
/** @typedef {import('../../model.js').RequestDescriptor} RequestDescriptor */
/** @typedef {ReturnType<typeof import('../../transport.js').createTransport>} Transport */
/** @typedef {{ name: string, unit: string, mtime: number, records: () => AsyncIterable<Record<string,string>> }} FocusFile
 * `unit` names the export the file belongs to: its local directory, or its s3 prefix up to the last '/'. */

const SOURCE = 'focus';
const BASIS = 'FOCUS: BilledCost, including credit and tax rows when present.';
const COVERAGE_DAYS = 30;
const COVERAGE_KEYS = 5;
const EXT = /\.(csv|csv\.gz|parquet)$/i;

const isS3 = (/** @type {string} */ p) => p.startsWith('s3://');
const round2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * Network requests this source would make. Local paths make none.
 * @param {{ paths: string[] }} opts
 * @returns {RequestDescriptor[]}
 */
export function describeFocus({ paths }) {
  /** @type {RequestDescriptor[]} */
  const out = [];
  for (const p of paths.filter(isS3)) {
    out.push({ source: SOURCE, kind: 'aws-cli', target: `aws s3 ls ${shellQuote(p)} --recursive`, credential: null, billed: false });
    out.push({ source: SOURCE, kind: 'aws-cli', target: `aws s3 cp ${p}<each file> -`, credential: null, billed: false });
  }
  return out;
}

/**
 * Records of an in-memory object. Parquet goes through a temp file named after the object, so
 * errors name it; the temp dir is removed when iteration ends.
 * @param {string} key @param {Buffer} buf @returns {AsyncIterable<Record<string,string>>}
 */
async function* recordsFromBuffer(key, buf) {
  const lower = key.toLowerCase();
  if (lower.endsWith('.parquet')) {
    const dir = await mkdtemp(join(tmpdir(), 'plutus-scan-'));
    try {
      const file = join(dir, basename(key));
      await writeFile(file, buf);
      yield* readParquetRecords(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return;
  }
  yield* parseCsvStream(Readable.from([lower.endsWith('.gz') ? gunzipSync(buf) : buf]));
}

/** @param {string} path @param {number} mtime @returns {FocusFile} */
function localFile(path, mtime) {
  const lower = path.toLowerCase();
  const records = lower.endsWith('.parquet')
    ? () => readParquetRecords(path)
    : lower.endsWith('.gz')
      ? () => parseCsvStream(createReadStream(path).pipe(createGunzip()))
      : () => parseCsvStream(createReadStream(path));
  return { name: basename(path), unit: dirname(path), mtime, records };
}

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (EXT.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/** @param {string} p @param {string[]} notes @returns {Promise<FocusFile[]>} */
async function localFiles(p, notes) {
  let info;
  try {
    info = await stat(p);
  } catch {
    throw new FocusInputError(`FOCUS path not found: ${p}`);
  }
  if (info.isDirectory()) {
    const paths = await walk(p);
    if (paths.length === 0) notes.push(`FOCUS: no .csv, .csv.gz or .parquet files found in ${p}.`);
    return Promise.all(paths.map(async (f) => localFile(f, (await stat(f)).mtimeMs)));
  }
  if (!EXT.test(p)) throw new FocusInputError(`FOCUS file ${basename(p)} is not a .csv, .csv.gz or .parquet file.`);
  return [localFile(p, info.mtimeMs)];
}

// `aws s3 ls --recursive` prints "2026-10-01 12:00:00       1234 some/key.csv".
const LS_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s+\d+\s+(.+?)\s*$/;

/** @param {Transport} transport @param {string} uri @param {string[]} notes @returns {Promise<FocusFile[]>} */
async function s3Files(transport, uri, notes) {
  const bucket = /^s3:\/\/[^/]+/.exec(uri)?.[0];
  if (!bucket) throw new FocusInputError(`FOCUS path ${uri} is not a valid s3:// URI.`);
  const listing = (await transport.awsRaw(SOURCE, ['s3', 'ls', uri, '--recursive'])).toString('utf8');
  /** @type {FocusFile[]} */
  const files = [];
  for (const line of listing.split('\n')) {
    const m = LS_LINE.exec(line);
    if (!m || !EXT.test(m[3])) continue;
    const objectUri = `${bucket}/${m[3]}`;
    const mtime = Date.parse(`${m[1]}T${m[2]}Z`);
    files.push({
      name: basename(m[3]),
      unit: `${bucket}/${m[3].slice(0, m[3].lastIndexOf('/') + 1)}`,
      mtime,
      records: async function* () {
        const buf = await transport.awsRaw(SOURCE, ['s3', 'cp', objectUri, '-']);
        yield* recordsFromBuffer(m[3], buf);
      },
    });
  }
  if (files.length === 0) notes.push(`FOCUS: no .csv, .csv.gz or .parquet files found under ${uri}.`);
  return files;
}

/**
 * @typedef {{ label: string, mtime: number, rows: Map<string, Row>,
 *   tags: Map<string, { total: number, keys: Map<string, number> }> }} Unit
 * One export: rows collapsed by key while reading, and per (provider, date) over the last 30 days the
 * cloud total and the tagged amount per tag key, in cents, so per-row tags are never kept.
 */

// A negative row (a credit or refund) is kept apart from usage, so the anomaly baselines can leave it out.
const rowKey = (/** @type {Row} */ r) =>
  [r.date, r.provider, r.kind, r.service, r.account ?? '', r.usageType ?? '', r.currency, r.cost < 0, Boolean(r.monthly)].join('\0');
const has = (/** @type {Record<string,string>} */ tags, /** @type {string} */ k) =>
  tags[k] !== undefined && tags[k] !== null && tags[k] !== '';

/**
 * Read one export's files into a Unit, keeping only rows inside the window.
 * @param {FocusFile[]} files @param {Window} window @returns {Promise<Unit>}
 */
async function readUnit(files, window) {
  const recent = lastNDays(window, COVERAGE_DAYS);
  /** @type {Unit} */
  const unit = { label: files[0].unit, mtime: Math.max(...files.map((f) => f.mtime)), rows: new Map(), tags: new Map() };
  for (const file of files) {
    for await (const record of file.records()) {
      const row = focusRecordToRow(record);
      if (!row || row.date < window.start || row.date > window.end) continue;
      const k = rowKey(row);
      const held = unit.rows.get(k);
      if (held) held.cost += row.cost;
      else unit.rows.set(k, row);
      if (row.kind !== 'cloud' || row.date < recent.start || row.date > recent.end) continue;
      const day = `${row.provider}|${row.date}`;
      let t = unit.tags.get(day);
      if (!t) unit.tags.set(day, (t = { total: 0, keys: new Map() }));
      const cents = Math.round(row.cost * 100);
      t.total += cents;
      const tags = recordTags(record);
      for (const key of Object.keys(tags)) if (has(tags, key)) t.keys.set(key, (t.keys.get(key) ?? 0) + cents);
    }
  }
  return unit;
}

/**
 * Per (provider, date) covered by more than one export, the export with the newest file wins.
 * @param {Unit[]} units @param {string[]} notes
 * @returns {(provider: string, date: string, unit: number) => boolean} whether a unit owns that day
 */
function resolveOverlaps(units, notes) {
  /** @type {Map<string, Set<number>>} */
  const owners = new Map();
  units.forEach((u, i) => {
    for (const r of u.rows.values()) {
      const k = `${r.provider}|${r.date}`;
      if (!owners.has(k)) owners.set(k, new Set());
      /** @type {Set<number>} */ (owners.get(k)).add(i);
    }
  });
  /** @type {Map<string, number>} */
  const winner = new Map();
  /** @type {Map<string, number>} */
  const overlapDays = new Map();
  for (const [k, set] of owners) {
    if (set.size < 2) continue;
    const ranked = [...set].sort((a, b) => units[b].mtime - units[a].mtime || b - a);
    winner.set(k, ranked[0]);
    const provider = k.split('|')[0];
    for (const loser of ranked.slice(1)) {
      const nk = `${provider}|${loser}|${ranked[0]}`;
      overlapDays.set(nk, (overlapDays.get(nk) ?? 0) + 1);
    }
  }
  for (const [nk, days] of overlapDays) {
    const [provider, loser, win] = nk.split('|');
    notes.push(`FOCUS: ${units[Number(loser)].label} and ${units[Number(win)].label} both cover ${provider} on ${days} days; used the newer export.`);
  }
  return (provider, date, unit) => {
    const w = winner.get(`${provider}|${date}`);
    return w === undefined || w === unit;
  };
}

/**
 * Top tag keys over the last 30 days, cloud rows only, from the owning exports' per-day sums.
 * @param {Unit[]} units @param {(provider: string, date: string, unit: number) => boolean} owns
 */
function tagCoverage(units, owns) {
  /** @type {Map<string, number>} */
  const keySpend = new Map();
  /** @type {Map<string, number>} */
  const providerTotal = new Map();
  /** @type {Map<string, Map<string, number>>} key -> provider -> tagged cents */
  const tagged = new Map();
  units.forEach((u, i) => {
    for (const [day, t] of u.tags) {
      const [provider, date] = day.split('|');
      if (!owns(provider, date, i)) continue;
      providerTotal.set(provider, (providerTotal.get(provider) ?? 0) + t.total);
      for (const [key, cents] of t.keys) {
        keySpend.set(key, (keySpend.get(key) ?? 0) + cents);
        if (!tagged.has(key)) tagged.set(key, new Map());
        const byProvider = /** @type {Map<string, number>} */ (tagged.get(key));
        byProvider.set(provider, (byProvider.get(provider) ?? 0) + cents);
      }
    }
  });
  const topKeys = [...keySpend].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, COVERAGE_KEYS);
  /** @type {import('../../model.js').TagCoverage[]} */
  const out = [];
  for (const [key] of topKeys) {
    // One entry per provider that has the key on at least one row.
    for (const [provider, cents] of [.../** @type {Map<string, number>} */ (tagged.get(key))].sort((a, b) => b[1] - a[1])) {
      out.push({
        provider,
        key,
        taggedCost: round2(cents / 100),
        untaggedCost: round2(((providerTotal.get(provider) ?? 0) - cents) / 100),
      });
    }
  }
  return out;
}

/**
 * Rows are collapsed while streaming, one export (directory or s3 prefix) at a time; part files of one
 * export are summed, and overlaps are resolved between exports.
 * `files` adds in-memory exports alongside `paths` (the demo source uses it).
 * @param {Transport} transport
 * @param {{ paths: string[], window: Window, files?: FocusFile[] }} opts
 * @returns {Promise<SourceResult>}
 */
export async function fetchFocus(transport, { paths, window, files: extra = [] }) {
  const result = emptyResult();
  /** @type {FocusFile[]} */
  const files = [...extra];
  for (const p of paths) files.push(...(isS3(p) ? await s3Files(transport, p, result.notes) : await localFiles(p, result.notes)));

  /** @type {Map<string, FocusFile[]>} */
  const groups = new Map();
  for (const f of files) {
    if (!groups.has(f.unit)) groups.set(f.unit, []);
    /** @type {FocusFile[]} */ (groups.get(f.unit)).push(f);
  }
  /** @type {Unit[]} */
  const units = [];
  for (const group of groups.values()) units.push(await readUnit(group, window));
  const owns = resolveOverlaps(units, result.notes);

  result.rows = units.flatMap((u, i) => [...u.rows.values()].filter((r) => owns(r.provider, r.date, i)));
  result.detailRows = result.rows.filter((r) => r.usageType);
  result.tagCoverage = tagCoverage(units, owns);
  result.basis.push(BASIS);
  return result;
}

// Parquet reader for FOCUS exports, through hyparquet (the one runtime dependency).
// Uncompressed and Snappy only; anything else is refused before any data page is decoded.
import { basename } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { FocusInputError } from './rows.js';

const SUPPORTED = new Set(['UNCOMPRESSED', 'SNAPPY']);
const REQUIRED = ['BilledCost', 'ChargePeriodStart', 'BillingCurrency'];
// Every column focusRecordToRow and recordTags read; others are never decoded.
const USED = ['BilledCost', 'BillingCurrency', 'ChargePeriodStart', 'ServiceProviderName', 'ProviderName',
  'ServiceName', 'SubAccountName', 'SubAccountId', 'x_UsageType', 'ChargeDescription', 'Tags'];

/** Flatten a decoded Parquet cell to the string a CSV cell would hold. */
function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return String(value);
}

/**
 * Index just past the schema element at i and all its descendants.
 * @param {{ num_children?: number }[]} schema @param {number} i @returns {number}
 */
function skipSubtree(schema, i) {
  let next = i + 1;
  for (let c = schema[i].num_children ?? 0; c > 0; c--) next = skipSubtree(schema, next);
  return next;
}

/**
 * Records of a Parquet file, read row group by row group and projected to the FOCUS columns used.
 * @param {string} filePath
 * @returns {AsyncIterable<Record<string,string>>}
 */
export async function* readParquetRecords(filePath) {
  const file = await asyncBufferFromFile(filePath);
  const metadata = await parquetMetadataAsync(file);
  for (const group of metadata.row_groups) {
    for (const column of group.columns) {
      const codec = column.meta_data?.codec ?? 'UNCOMPRESSED';
      if (!SUPPORTED.has(codec)) {
        throw new FocusInputError(
          `${basename(filePath)} uses ${codec} compression, which plutus-scan cannot read. Re-export as CSV or Snappy Parquet.`,
        );
      }
    }
  }
  // Top-level columns are the root's direct children.
  const topLevel = new Set();
  for (let i = 1, left = metadata.schema[0]?.num_children ?? 0; i < metadata.schema.length && left > 0; left--) {
    topLevel.add(metadata.schema[i].name);
    i = skipSubtree(metadata.schema, i);
  }
  for (const col of REQUIRED) {
    if (!topLevel.has(col)) throw new FocusInputError(`The FOCUS file has no ${col} column, which is required.`);
  }
  const columns = USED.filter((c) => topLevel.has(c));
  // One row group at a time, so memory holds a single group's projected columns.
  let rowStart = 0;
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    const objects = await parquetReadObjects({ file, metadata, columns, rowStart, rowEnd });
    for (const obj of objects) {
      /** @type {Record<string,string>} */
      const rec = {};
      for (const [k, v] of Object.entries(obj)) rec[k] = cellToString(v);
      yield rec;
    }
    rowStart = rowEnd;
  }
}

// Adapted from Plutus's private backend (parseCsv in plutus-backend/lib/sync/focus.js, commit
// 8f3e0d23). Reworked from a whole-string parser into a chunked state machine.
import { StringDecoder } from 'node:string_decoder';
import { FocusInputError } from './rows.js';

const REQUIRED = ['BilledCost', 'ChargePeriodStart', 'BillingCurrency'];

/**
 * Streaming RFC 4180 parser. The first record is the header; later records go to onRecord as
 * objects keyed by header name.
 * @param {(record: Record<string,string>) => void} onRecord
 */
export function createCsvParser(onRecord) {
  /** @type {string[]|null} */
  let header = null;
  let row = /** @type {string[]} */ ([]);
  let field = '';
  let inQuotes = false;
  let quoteSeen = false; // inside quotes, the previous char was a quote
  let sawContent = false;

  function endRow() {
    row.push(field);
    field = '';
    const done = row;
    row = [];
    sawContent = false;
    if (!header) {
      header = done.map((h) => h.replace(/^﻿/, '').trim());
      for (const col of REQUIRED) {
        if (!header.includes(col)) {
          throw new FocusInputError(`The FOCUS file has no ${col} column, which is required.`);
        }
      }
      return;
    }
    if (done.length === 1 && done[0] === '') return; // blank line
    const rec = /** @type {Record<string,string>} */ ({});
    for (let i = 0; i < header.length; i++) rec[header[i]] = done[i] ?? '';
    onRecord(rec);
  }

  /** @param {string} chunk */
  function push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inQuotes) {
        if (quoteSeen) {
          quoteSeen = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          inQuotes = false; // the quote closed the field; fall through to normal handling
        } else if (ch === '"') {
          quoteSeen = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"') {
        inQuotes = true;
        sawContent = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
        sawContent = true;
      } else if (ch === '\r') {
        // the paired \n ends the row
      } else if (ch === '\n') {
        endRow();
      } else {
        field += ch;
        sawContent = true;
      }
    }
  }

  function end() {
    if (inQuotes && quoteSeen) {
      inQuotes = false;
      quoteSeen = false;
    }
    if (sawContent || field.length > 0 || row.length > 0) endRow();
    if (!header) throw new FocusInputError('The FOCUS file is empty.');
  }

  return { push, end };
}

/**
 * @param {AsyncIterable<string|Buffer>} readable
 * @returns {AsyncIterable<Record<string,string>>}
 */
export async function* parseCsvStream(readable) {
  /** @type {Record<string,string>[]} */
  let batch = [];
  const parser = createCsvParser((r) => batch.push(r));
  const decoder = new StringDecoder('utf8');
  for await (const chunk of readable) {
    parser.push(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    if (batch.length) {
      const out = batch;
      batch = [];
      yield* out;
    }
  }
  parser.push(decoder.end());
  parser.end();
  yield* batch;
}

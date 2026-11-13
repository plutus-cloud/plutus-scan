// Fake `aws` for tests: maps argv to a fixture in test/fixtures/aws.
// Task 17's test/fixtures/bin/aws can reuse fixtureFor(argv) to pick the file.
//
// Mapping (argv without the trailing --output/--profile flags):
//   sts get-caller-identity                              -> sts.json
//   ce list-cost-allocation-tags                         -> tags-list.json
//   ce get-cost-and-usage, group-by Type=TAG,Key=<K>     -> tag-<K>.json
//   ce get-cost-and-usage, DAILY, group-by USAGE_TYPE    -> drilldown.json
//   ce get-cost-and-usage, MONTHLY, group-by USAGE_TYPE  -> candidates.json
//   ce get-cost-and-usage, DAILY, group-by RECORD_TYPE   -> daily-page1.json,
//                                    or daily-page2.json when --next-page-token is given
// The daily fixtures group by SERVICE and RECORD_TYPE; page 2 holds Reserved Instance and
// Savings Plan fees, covered usage with its negation, and tax on 2026-10-01.
import { readFileSync } from 'node:fs';

const DIR = new URL('../fixtures/aws/', import.meta.url);

/** @param {string[]} args @returns {string} fixture file name */
export function fixtureFor(args) {
  const s = args.join(' ');
  if (args[0] === 'sts') return 'sts.json';
  if (args[1] === 'list-cost-allocation-tags') return 'tags-list.json';
  const tag = /Type=TAG,Key=([^\s,]+)/.exec(s);
  if (tag) return `tag-${tag[1]}.json`;
  if (s.includes('Key=USAGE_TYPE')) return args.includes('MONTHLY') ? 'candidates.json' : 'drilldown.json';
  return args.includes('--next-page-token') ? 'daily-page2.json' : 'daily-page1.json';
}

/**
 * execImpl for createTransport. `calls` collects argv; `overrides` maps a fixture
 * name to `{ code, stderr }` to simulate a failing call.
 * @param {{ calls?: string[][], overrides?: Record<string, { code: number, stderr: string }> }} [opts]
 */
export function fakeAwsExec({ calls = [], overrides = {} } = {}) {
  return async (_cmd, args) => {
    calls.push(args);
    const name = fixtureFor(args);
    if (overrides[name]) return { code: overrides[name].code, stdout: Buffer.alloc(0), stderr: overrides[name].stderr };
    return { code: 0, stdout: readFileSync(new URL(name, DIR)), stderr: '' };
  };
}

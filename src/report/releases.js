// How a nearby release reads in every report: with its repo, and as one group when several ship the same day.

/** @typedef {import('../model.js').Release} Release */

// Releases named in one line before the rest are counted.
const NAMED = 3;

/** @param {Release} r @param {(s: string) => string} clean */
export const releaseLabel = (r, clean) => `${clean(r.repo)} ${clean(r.name)}`;

/**
 * The releases an anomaly was near: every release on the nearest release's day, else that release alone.
 * @param {{ release: Release|null, releases?: Release[] }} a @returns {Release[]}
 */
export const nearbyReleases = (a) => (a.releases?.length ? a.releases : a.release ? [a.release] : []);

/**
 * "acme/shop v2.4.0 on 2026-10-12", or "3 releases on 2026-10-12: acme/a v1, acme/b v2, acme/c v3"
 * (past three, "and N more"). Null when there is none.
 * @param {{ release: Release|null, releases?: Release[] }} a @param {(s: string) => string} clean
 * @returns {string|null}
 */
export function releaseContext(a, clean) {
  const list = nearbyReleases(a);
  if (list.length === 0) return null;
  const date = clean(list[0].date);
  if (list.length === 1) return `${releaseLabel(list[0], clean)} on ${date}`;
  const named = list.slice(0, NAMED).map((r) => releaseLabel(r, clean)).join(', ');
  const more = list.length > NAMED ? ` and ${list.length - NAMED} more` : '';
  return `${list.length} releases on ${date}: ${named}${more}`;
}

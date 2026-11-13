/** Untagged share and AI spend by project. */

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {import('../model.js').TagCoverage[]} tagCoverage
 * @returns {{ provider: string, key: string, label: 'Untagged', untaggedCost: number,
 *   taggedCost: number, untaggedPct: number|null }[]}
 */
export function untaggedShare(tagCoverage) {
  return tagCoverage.map((t) => {
    const total = t.taggedCost + t.untaggedCost;
    return {
      provider: t.provider, key: t.key, label: 'Untagged',
      untaggedCost: t.untaggedCost, taggedCost: t.taggedCost,
      untaggedPct: total === 0 ? null : round1((t.untaggedCost / total) * 100),
    };
  });
}

/**
 * AI spend per (provider, project) with share of the AI total.
 * @param {import('../model.js').Row[]} rows
 * @returns {{ provider: string, project: string, cost: number, sharePct: number }[]}
 */
export function aiByProject(rows) {
  const groups = new Map();
  let total = 0;
  for (const r of rows) {
    if (r.kind !== 'ai') continue;
    const project = r.project ?? '(no project)';
    const key = `${r.provider}\u0000${project}`;
    const g = groups.get(key) ?? { provider: r.provider, project, cost: 0 };
    g.cost += r.cost;
    groups.set(key, g);
    total += r.cost;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, sharePct: total === 0 ? 0 : round1((g.cost / total) * 100) }))
    .sort((a, b) => b.cost - a.cost);
}

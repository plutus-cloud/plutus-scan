/**
 * The pull-request pointer on candidates Plutus can fix. Nothing here is fetched: the HTML and Markdown
 * outputs carry it as a plain link the reader may follow. The URL holds only the fixed surface name and
 * candidate id from the rule table, never anything from the user's data.
 */

export const PR_LINE = 'If this is waste, Plutus can open the pull request that fixes it.';
export const PR_LINE_COMPACT = 'Plutus can open the fix as a pull request';

/**
 * @param {'report'|'md'} medium where the link is shown
 * @param {string} candidateId a rule id from the candidate table
 * @returns {string}
 */
export function plutusFixUrl(medium, candidateId) {
  if (!/^[a-z0-9-]+$/.test(candidateId)) throw new Error(`Not a candidate id: ${candidateId}`);
  return `https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=${medium}&utm_content=${candidateId}`;
}

/**
 * The one URL the terminal summary prints, once at the end of the candidates section. It has no candidate
 * id: the terminal shows a bare URL a reader can follow, and a per-candidate URL would not fit 80 columns.
 * @returns {string}
 */
export const plutusSectionUrl = () => 'https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=cli';

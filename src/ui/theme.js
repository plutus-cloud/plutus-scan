/**
 * Colour for the terminal views: how many colours the terminal has, and the Plutus palette at that depth.
 * Roles, not colours, are what the widgets ask for, so a 16-colour terminal and a truecolor one draw the
 * same layout.
 */

/** @typedef {0|4|8|24} Depth no colour, 16 colours, 256 colours, truecolor */
/** @typedef {'brand'|'accent'|'up'|'down'|'warn'|'muted'|'border'|'cloud'|'commitment'|'ai'|'monthly'|'rank'|'forecast'|'bold'|'value'} Role */

// Hex values from the Plutus brand (fuchsia, violet), its status text colours and its categorical chart
// palette. `ansi` is the 16-colour fallback: an SGR foreground code.
/** @type {Record<Exclude<Role, 'bold'|'value'>, { hex: string, ansi: string }>} */
const PALETTE = {
  brand: { hex: '#E9368F', ansi: '95' },
  accent: { hex: '#7C3AED', ansi: '35' },
  up: { hex: '#F87171', ansi: '91' },
  down: { hex: '#2FBF8F', ansi: '92' },
  warn: { hex: '#F5A524', ansi: '93' },
  muted: { hex: '#948C9E', ansi: '90' },
  border: { hex: '#5E5668', ansi: '90' },
  cloud: { hex: '#1D9CE6', ansi: '94' },
  commitment: { hex: '#C08800', ansi: '33' },
  ai: { hex: '#9B7BE0', ansi: '35' },
  monthly: { hex: '#5FB3A9', ansi: '36' },
  rank: { hex: '#C04F9A', ansi: '35' },
  forecast: { hex: '#9A91AC', ansi: '37' },
};

/**
 * How many colours to use. The caller decides whether to colour at all (TTY, NO_COLOR, --no-color);
 * this only picks the depth.
 * @param {NodeJS.ProcessEnv} env @returns {Depth}
 */
export function colorDepth(env) {
  if (env.NO_COLOR) return 0;
  const colorterm = String(env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 24;
  const term = String(env.TERM ?? '').toLowerCase();
  if (term === 'dumb') return 0;
  if (/-truecolor|-direct/.test(term)) return 24;
  if (/256/.test(term)) return 8;
  return 4;
}

/** @param {string} hex @returns {[number, number, number]} */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** @param {[number, number, number]} c @returns {number} the nearest xterm-256 colour */
function xterm256([r, g, b]) {
  const near = (v) => CUBE.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(CUBE[best] - v) ? i : best), 0);
  const [ri, gi, bi] = [near(r), near(g), near(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (CUBE[ri] - r) ** 2 + (CUBE[gi] - g) ** 2 + (CUBE[bi] - b) ** 2;
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const greyDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return greyDist < cubeDist ? 232 + grey : cube;
}

/**
 * @typedef {{ depth: Depth, color: boolean,
 *   fg: (role: Role, text: string) => string,
 *   bg: (role: Role, text: string) => string,
 *   code: (role: Role) => string,
 *   bold: (text: string) => string, dim: (text: string) => string,
 *   inverse: (text: string) => string }} Theme
 */

/**
 * @param {Depth|boolean} depth true picks 16 colours
 * @returns {Theme}
 */
export function createTheme(depth) {
  const d = /** @type {Depth} */ (depth === true ? 4 : depth === false ? 0 : depth);
  /** @param {Role} role @param {boolean} [back] @returns {string} SGR parameters, '' for none */
  const sgr = (role, back = false) => {
    if (d === 0) return '';
    if (role === 'bold' || role === 'value') return '1';
    const p = PALETTE[role];
    if (d === 4) return back ? String(Number(p.ansi) + 10) : p.ansi;
    if (d === 8) return `${back ? 48 : 38};5;${xterm256(rgb(p.hex))}`;
    return `${back ? 48 : 38};2;${rgb(p.hex).join(';')}`;
  };
  const wrapIn = (code, text) => (code && text ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    depth: d,
    color: d > 0,
    fg: (role, text) => wrapIn(sgr(role), text),
    bg: (role, text) => wrapIn(sgr(role, true) && `${sgr(role, true)};97`, text),
    code: (role) => sgr(role),
    bold: (text) => wrapIn(d ? '1' : '', text),
    dim: (text) => wrapIn(d ? '2' : '', text),
    inverse: (text) => wrapIn(d ? '7' : '', text),
  };
}

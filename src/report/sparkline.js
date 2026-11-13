/** Block and braille sparklines. */

const BLOCKS = '▁▂▃▄▅▆▇█';
// Braille dot bits, bottom to top, for the left and right column of a cell.
const LEFT = [0x40, 0x04, 0x02, 0x01];
const RIGHT = [0x80, 0x20, 0x10, 0x08];

/**
 * Resample to `n` points by averaging the values that fall in each bucket.
 * @param {number[]} values @param {number} n @returns {number[]}
 */
function resample(values, n) {
  if (values.length === 0 || n <= 0) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * values.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / n));
    const slice = values.slice(from, Math.min(to, values.length));
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

/**
 * @param {number[]} values negatives are drawn as 0
 * @param {{ width: number, braille?: boolean }} opts width is in characters
 * @returns {string}
 */
export function sparkline(values, { width, braille = false }) {
  const points = resample(values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)), braille ? width * 2 : width);
  if (points.length === 0) return '';
  const max = Math.max(...points);
  const min = Math.min(...points);
  const level = (v, steps) => (max === min ? 0 : Math.round(((v - min) / (max - min)) * (steps - 1)));

  if (!braille) return points.map((v) => BLOCKS[level(v, BLOCKS.length)]).join('');

  let out = '';
  for (let i = 0; i < points.length; i += 2) {
    let bits = 0;
    for (let h = 0; h <= level(points[i], 4); h++) bits |= LEFT[h];
    if (i + 1 < points.length) for (let h = 0; h <= level(points[i + 1], 4); h++) bits |= RIGHT[h];
    out += String.fromCharCode(0x2800 + bits);
  }
  return out;
}

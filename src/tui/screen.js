/** Terminal I/O for the full-screen view: alternate screen, raw keys, diff repaint, restore. */

import readline from 'node:readline';

const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[0m\x1b[?25h\x1b[?1049l';
const SIGNALS = /** @type {const} */ ([['SIGINT', 130], ['SIGTERM', 143]]);

/**
 * @param {{ input: any, output: any, proc?: any,
 *   onKey: (str: string|undefined, key: { name?: string, sequence?: string, ctrl?: boolean }) => void,
 *   onResize: () => void, onEnd?: () => void, onRestore?: () => void }} io
 */
export function createScreen({ input, output, proc = process, onKey, onResize, stderr = process.stderr, onEnd = () => {}, onRestore = () => {} }) {
  let started = false;
  let restored = false;
  /** @type {string[]} */
  let previous = [];
  /** @type {(() => void)[]} */
  const undo = [];

  const restore = () => {
    if (!started || restored) return;
    restored = true;
    for (const f of undo.splice(0).reverse()) {
      try { f(); } catch { /* keep restoring */ }
    }
    try { input.setRawMode?.(false); } catch { /* not a TTY any more */ }
    try { input.pause?.(); } catch { /* ignore */ }
    output.write(LEAVE);
    try { onRestore(); } catch { /* nothing more to do */ }
  };

  const on = (emitter, event, fn) => {
    emitter.on(event, fn);
    undo.push(() => emitter.removeListener(event, fn));
  };

  const start = () => {
    if (started) return;
    started = true;
    try {
      output.write(ENTER);
      readline.emitKeypressEvents(input);
      input.setRawMode?.(true);
      input.resume?.();
      on(input, 'keypress', onKey);
      on(input, 'end', onEnd);
      on(output, 'resize', () => { previous = []; onResize(); });
      for (const [sig, code] of SIGNALS) {
        on(proc, sig, () => { restore(); proc.exit(code); });
      }
      on(proc, 'exit', restore);
      on(proc, 'uncaughtException', (/** @type {unknown} */ e) => {
        restore();
        stderr.write(`plutus-scan: ${String(e instanceof Error ? e.message : e).split('\n')[0]}\n`);
        proc.exit(1);
      });
    } catch (e) {
      restore();
      throw e;
    }
  };

  /** Write only the rows that changed since the last paint. @param {string[]} lines */
  const paint = (lines) => {
    if (!started || restored) return;
    let buf = '';
    if (previous.length === 0) buf += '\x1b[2J';
    lines.forEach((line, i) => {
      if (previous[i] !== line) buf += `\x1b[${i + 1};1H\x1b[2K${line}`;
    });
    previous = lines.slice();
    if (buf) output.write(buf);
  };

  return { start, paint, restore };
}

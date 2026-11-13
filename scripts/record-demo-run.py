#!/usr/bin/env python3
"""Record `plutus-scan --demo` in a pseudo-terminal as an asciicast (v2), so the live progress panel
and the dashboard can be replayed with `asciinema play`. Python 3 standard library only; run by hand,
it is not part of the tests or the package.

    python3 scripts/record-demo-run.py [out.cast] [columns] [rows]

Next to the cast it writes three frames of the live panel as ANSI files (progress-<n>-<what>.ansi): while
the demo data is generated, while the analysis runs, and the summary line it collapses to.
"""

import fcntl
import json
import os
import pty
import re
import struct
import sys
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', 'terminal-samples', 'demo-run.cast')
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 120
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 40

env = {k: v for k, v in os.environ.items() if k not in ('NO_COLOR', 'CI', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY', 'GITHUB_TOKEN')}
env.update({'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'})
argv = ['node', os.path.join(ROOT, 'bin', 'plutus-scan.js'), '--demo', '--end', '2026-10-30', '--no-html']

pid, fd = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execvpe('node', argv, env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
start = time.monotonic()
events = []
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    events.append([round(time.monotonic() - start, 3), 'o', data.decode('utf-8', 'replace')])
os.waitpid(pid, 0)

with open(out, 'w', encoding='utf-8') as f:
    f.write(json.dumps({'version': 2, 'width': cols, 'height': rows, 'title': 'plutus-scan --demo',
                        'env': {'TERM': env['TERM'], 'SHELL': '/bin/sh'}}) + '\n')
    for e in events:
        f.write(json.dumps(e, ensure_ascii=False) + '\n')
print(f'wrote {out}: {len(events)} events over {events[-1][0] if events else 0}s')

# Frames of the live panel: each redraw starts with the synchronised-output mark. Cursor movement is
# dropped and colour kept, so `cat` shows the frame as it looked.
data = ''.join(e[2] for e in events)
panel = data.split('\x1b[?25h')[0]
frames = [re.sub(r'\x1b\[(\d+F|2K|J|\?2026[hl]|\?25l)', '', f).replace('\r\n', '\n') for f in panel.split('\x1b[?2026h')]
frames = [f for f in frames if f.strip()]
plain = lambda f: re.sub(r'\x1b\[[0-9;]*m', '', f)
picks = [
    ('1-generating', next(f for f in frames if 'generating' in plain(f))),
    ('2-analysis', next(f for f in frames if 'Analysis' in plain(f) and '✓ drivers' in plain(f) and '✓ candidates' not in plain(f))),
]
tail = data[data.rindex('\x1b[?2026h'):] if '\x1b[?2026h' in data else ''
done = re.sub(r'\x1b\[(\d+F|J|\?2026[hl]|\?25[hl])', '', tail).replace('\r\n', '\n').split('\n')[0] + '\n'
picks.append(('3-summary', done))
for name, frame in picks:
    path = os.path.join(os.path.dirname(out), f'progress-{name}.ansi')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(frame)
    print(f'wrote {path}')

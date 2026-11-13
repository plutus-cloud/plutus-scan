# Terminal samples

Captures of the terminal output, rendered from the same synthetic data as `plutus-scan --demo`
(`src/sources/demo.js`, 90 days ending 2026-10-30, through `scripts/demo-report.js`). None of it is real
spend. The one anomaly is the demo's injected NAT gateway spike on 2026-10-17. Regenerate them with
`node scripts/terminal-samples.js`, and the recorded run with `python3 scripts/record-demo-run.py`.

View an `.ansi` file in a terminal with `cat` (or `less -R`). The `.txt` files are the same views with
no colour.

| File | What it is |
| --- | --- |
| `dashboard-{80,120}-truecolor.ansi` | Default output on a terminal with 24-bit colour |
| `dashboard-{80,120}-256.ansi` | The same on a 256-colour terminal |
| `dashboard-{80,120}-16.ansi` | The same on a 16-colour terminal |
| `dashboard-{80,120}-no-color.txt` | The dashboard with `NO_COLOR` or `--no-color` |
| `piped-{80,120}.txt` | Output when standard output is not a terminal (piped, CI) |
| `tui-<view>-80x24-*` / `tui-<view>-120x40-*` | `--tui` Overview, Drivers, a driver's detail, Anomalies and an anomaly's detail |
| `demo-run.cast` | A whole `--demo` run in a terminal, live progress panel then dashboard; replay with `asciinema play` |
| `progress-{1-generating,2-analysis,3-summary}.ansi` | Frames of the live progress panel, and the line it collapses to |
| `dashboard-120-truecolor.png`, `tui-truecolor.png`, `progress-truecolor.png` | Pictures of the coloured captures |

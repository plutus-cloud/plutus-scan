// Renders the plutus-scan HTML report from the embedded JSON. Inlined into the page by
// src/report/html.js. Every piece of data reaches the DOM through textContent; money arrives
// preformatted from the server so formatting rules live in one place. Colours come from CSS
// classes, so switching theme restyles the chart without redrawing it.
(function () {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';

  /**
   * @param {string} tag @param {string|null} [cls] @param {Array<Node|string|null>|string|null} [children]
   * @returns {HTMLElement}
   */
  function h(tag, cls, children) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (typeof children === 'string') node.textContent = children;
    else if (children) {
      for (const c of children) {
        if (c === null || c === undefined) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  /** @param {string} tag @param {Record<string, string|number>} [attrs] @returns {SVGElement} */
  function s(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, String(attrs[k]));
    return node;
  }

  /** @param {string} name @returns {HTMLElement} */
  const body = (name) => /** @type {HTMLElement} */ (document.querySelector(`[data-section="${name}"] [data-role="body"]`));
  const reason = (text) => h('p', 'reason', text);
  // Cost-semantic: spend going up is bad, going down is good.
  const tone = (dir) => (dir === 'up' ? 'bad' : dir === 'down' ? 'good' : 'neutral');
  const chip = (text, cls) => h('span', `chip ${cls}`, text);
  const sevLabel = { high: 'High', medium: 'Medium', low: 'Low' };
  const badge = (severity) => h('span', `badge sev-${severity}`, sevLabel[severity] || severity);

  /** A table with a header row; `cols` items are [label, className]. */
  function table(cols, cls) {
    const t = h('table', `data ${cls || ''}`);
    t.appendChild(h('thead', null, [h('tr', null, cols.map(([label, c]) => {
      const th = h('th', c || null, label);
      th.setAttribute('scope', 'col');
      return th;
    }))]));
    return t;
  }
  const td = (cls, children) => h('td', cls, children);
  const sub = (text) => (text ? h('span', 'sub', text) : null);

  /** @param {number} pct @param {string} text @returns {HTMLElement} a share with an inline meter */
  function meter(pct, text) {
    const fill = h('span', 'meter-fill');
    fill.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
    return h('span', 'meter', [h('span', 'meter-track', [fill]), h('span', 'meter-text', text)]);
  }

  // Headline.
  function renderHeadline(view) {
    const hv = view.headline;
    document.querySelector('[data-role="title"]').textContent = hv.title;
    document.querySelector('[data-role="window"]').textContent = hv.window;
    if (hv.demo) {
      const demo = /** @type {HTMLElement} */ (document.querySelector('[data-role="demo"]'));
      demo.textContent = hv.demo;
      demo.hidden = false;
    }
    const sentence = /** @type {HTMLElement} */ (document.querySelector('[data-role="sentence"]'));
    sentence.textContent = hv.sentence;
    const stats = document.querySelector('[data-role="stats"]');
    for (const st of hv.stats) {
      let extra = null;
      if (st.chip && sevLabel[st.chip]) extra = badge(st.chip);
      else if (st.chip) extra = chip(st.chip, tone(st.tone));
      stats.appendChild(h('div', 'tile', [
        h('div', 'tile-label', st.label),
        h('div', 'tile-value', st.value),
        h('div', 'tile-detail', [extra, extra ? ' ' : null, h('span', null, st.detail)]),
      ]));
    }
    if (hv.stats.length === 0) stats.remove();
    const movers = document.querySelector('[data-role="movers"]');
    if (hv.movers.length === 0) movers.remove();
    else {
      movers.appendChild(h('span', 'movers-label', 'Top movers'));
      for (const m of hv.movers) {
        movers.appendChild(h('span', 'mover', [h('span', 'mover-name', m.name), ' ', chip(m.change, tone(m.dir))]));
      }
    }

    const state = document.querySelector('[data-role="copy-state"]');
    const selectSentence = () => {
      const range = document.createRange();
      range.selectNodeContents(sentence);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      state.textContent = 'Selected. Press Ctrl+C or Cmd+C to copy.';
    };
    document.getElementById('copy-sentence').addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(hv.sentence)
          .then(() => { state.textContent = 'Copied.'; })
          .catch(selectSentence);
      } else {
        selectSentence();
      }
    });
  }

  // Daily chart: stacked bars per day, forecast as outlined bars, anomaly marks above flagged days.
  /** Path for a bar with rounded top corners, or rounded bottom corners when it hangs below zero. */
  function barPath(x, y, w, hgt, r, down) {
    const rr = Math.max(0, Math.min(r, w / 2, hgt));
    if (rr === 0) return `M${x},${y}h${w}v${hgt}h${-w}z`;
    if (down) {
      return `M${x},${y}h${w}v${hgt - rr}q0,${rr} ${-rr},${rr}h${-(w - 2 * rr)}q${-rr},0 ${-rr},${-rr}z`;
    }
    return `M${x},${y + hgt}v${-(hgt - rr)}q0,${-rr} ${rr},${-rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}v${hgt - rr}z`;
  }

  function renderDaily(view, bus) {
    const dv = view.daily;
    const root = body('daily');
    if (!dv.chart) {
      root.appendChild(reason(dv.reason));
      return null;
    }
    // With monthly charges the chart can be drawn spread (the default) or as billed; `c` is the one shown.
    const spreadView = dv.chart;
    const billedView = spreadView.billed ? { ...spreadView, ...spreadView.billed } : null;
    let c = spreadView;
    const n = c.labels.length;
    const hasForecast = c.forecast.some((v) => v !== null);
    // One marker per day; a day with several releases names each in the tooltip.
    const releasesAt = new Map(c.releases.map((r) => [r.index, r]));
    const marksAt = new Map(c.marks.map((m) => [m.index, m]));
    let clippedAt = new Map();
    const spreadShown = () => c.hasMonthly && c !== billedView;

    const key = h('div', 'legend');
    const keyItem = (cls, label) => h('span', 'legend-item', [h('span', `swatch ${cls}`), label]);
    const caption = h('p', 'caption');
    const frame = h('div', 'chart');
    frame.setAttribute('role', 'img');
    frame.tabIndex = 0;
    const setMode = () => {
      clippedAt = new Map(c.clipped.map((x) => [x.index, x.label]));
      key.textContent = '';
      key.appendChild(keyItem('s-cloud', 'Cloud'));
      if (c.hasCommitment) key.appendChild(keyItem('s-commitment', 'Commitments'));
      if (c.hasAi) key.appendChild(keyItem('s-ai', 'AI'));
      if (spreadShown()) key.appendChild(keyItem('s-monthly', 'Monthly charges, spread'));
      if (hasForecast) key.appendChild(keyItem('s-forecast', 'Forecast'));
      if (c.marks.length) key.appendChild(keyItem('s-mark', 'Anomaly'));
      if (c.releases.length) key.appendChild(keyItem('s-release', 'Release'));
      caption.textContent = c.caption;
      frame.setAttribute('aria-label', `Daily spend, ${view.headline.window}. ${c.caption}`);
    };
    setMode();

    const tip = h('div', 'tooltip');
    tip.hidden = true;
    const wrap = h('div', 'chart-wrap', [frame, tip]);
    if (billedView) {
      // Two pressed-or-not buttons choose how charges billed once a month are drawn.
      const toggle = h('div', 'seg');
      toggle.setAttribute('role', 'group');
      toggle.setAttribute('aria-label', 'Monthly charges');
      const choices = [[spreadView, 'Spread monthly charges'], [billedView, 'As billed']].map(([target, label]) => {
        const b = h('button', null, label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(target === c));
        b.addEventListener('click', () => {
          if (c === target) return;
          c = target;
          for (const [t, other] of choices) other.setAttribute('aria-pressed', String(t === c));
          setMode();
          draw();
        });
        return [target, b];
      });
      for (const [, b] of choices) toggle.appendChild(b);
      root.appendChild(toggle);
    }
    root.append(key, wrap, caption);
    if (dv.note) root.appendChild(h('p', 'caption', dv.note));

    let geo = null;
    let active = null;
    let pinned = false;

    const draw = (printWidth) => {
      const width = printWidth || Math.max(280, frame.clientWidth || root.clientWidth);
      const height = printWidth ? 260 : width < 560 ? 220 : 300;
      const yLo = c.yTicks[0];
      const yHi = c.yTicks[c.yTicks.length - 1];
      const font = 11;
      const left = Math.ceil(Math.max(...c.yLabels.map((l) => l.length)) * 6.6) + 10;
      const top = 18;
      const bottom = 22;
      const right = 4;
      const plotW = width - left - right;
      const plotH = height - top - bottom;
      const band = plotW / n;
      const barW = Math.max(1, Math.min(band * 0.72, 28));
      const y = (v) => top + (1 - (Math.min(Math.max(v, yLo), yHi) - yLo) / (yHi - yLo)) * plotH;
      const x = (i) => left + i * band + (band - barW) / 2;
      const radius = barW >= 6 ? 3 : barW >= 3 ? 1 : 0;

      const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg' });
      svg.setAttribute('aria-hidden', 'true');
      const grid = s('g', { class: 'grid' });
      c.yTicks.forEach((t, k) => {
        const ty = Math.round(y(t)) + 0.5;
        grid.appendChild(s('line', { x1: left, x2: width - right, y1: ty, y2: ty, class: t === 0 ? 'zero' : 'line' }));
        const label = s('text', { x: left - 8, y: ty + 4, 'text-anchor': 'end', class: 'tick', 'font-size': font });
        label.textContent = c.yLabels[k];
        grid.appendChild(label);
      });
      svg.appendChild(grid);

      const cursor = s('rect', { x: 0, y: top, width: band, height: plotH, class: 'cursor' });
      cursor.style.display = 'none';
      svg.appendChild(cursor);

      // Releases sit behind the bars.
      for (const r of c.releases) {
        const rx = Math.round(left + r.index * band + band / 2) + 0.5;
        svg.appendChild(s('line', { x1: rx, x2: rx, y1: top, y2: top + plotH, class: 'release' }));
      }

      // The hatch for monthly charges spread over their month; its colours come from the stylesheet.
      const defs = s('defs');
      const hatch = s('pattern', { id: 'hatch-monthly', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      hatch.appendChild(s('rect', { width: 6, height: 6, class: 'hatch-bg' }));
      hatch.appendChild(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-line' }));
      defs.appendChild(hatch);
      svg.appendChild(defs);

      const bars = s('g', { class: 'bars' });
      const layers = [['cloud', c.cloud], ['commitment', c.commitment], ['ai', c.ai], ...(spreadShown() ? [['monthly', c.monthly]] : [])];
      for (let i = 0; i < n; i += 1) {
        if (c.forecast[i] !== null) {
          const v = c.forecast[i];
          const y0 = y(0);
          const y1 = y(v);
          bars.appendChild(s('path', { d: barPath(x(i) + 0.5, Math.min(y0, y1), barW - 1, Math.abs(y0 - y1), radius, v < 0), class: 'b-forecast' }));
          continue;
        }
        if (c.stacked[i] === null) continue;
        // Positive parts stack up from zero, negative parts (credits, refunds) hang below it.
        let up = 0;
        let down = 0;
        const parts = [];
        for (const [layer, values] of layers) {
          const v = values[i] || 0;
          if (v > 0) { parts.push({ layer, from: up, to: up + v, down: false }); up += v; }
          else if (v < 0) { parts.push({ layer, from: down, to: down + v, down: true }); down += v; }
        }
        const topUp = parts.filter((p) => !p.down).pop();
        const topDown = parts.filter((p) => p.down).pop();
        for (const p of parts) {
          const ya = y(p.from);
          const yb = y(p.to);
          const hgt = Math.abs(ya - yb);
          if (hgt < 0.01) continue;
          const edge = p === topUp || p === topDown;
          bars.appendChild(s('path', { d: barPath(x(i), Math.min(ya, yb), barW, hgt, edge ? radius : 0, p.down), class: `b-${p.layer}` }));
        }
        if (clippedAt.has(i)) {
          // A break across the cut bar; its real total is labelled above.
          const by = top + 8;
          bars.appendChild(s('path', { d: `M${x(i) - 1.5},${by}l${barW + 3},-4M${x(i) - 1.5},${by + 4}l${barW + 3},-4`, class: 'cut' }));
        }
      }
      svg.appendChild(bars);

      const labels = s('g', { class: 'cut-labels' });
      for (const [i, label] of clippedAt) {
        const cx = left + i * band + band / 2;
        const t = s('text', { x: Math.min(width - right - 24, Math.max(left + 24, cx)), y: top - 5, 'text-anchor': 'middle', class: 'cut-label', 'font-size': font });
        t.textContent = label;
        labels.appendChild(t);
      }
      svg.appendChild(labels);

      const marks = s('g', { class: 'marks' });
      for (const m of c.marks) {
        const total = c.stacked[m.index];
        const size = Math.max(3.5, Math.min(5, barW / 2 + 1.5));
        const tipY = clippedAt.has(m.index) ? top + 14 : y(Math.max(0, total)) - 3;
        const mx = left + m.index * band + band / 2;
        marks.appendChild(s('path', { d: `M${mx},${tipY}l${-size},${-size * 1.5}h${size * 2}z`, class: `mark sev-${m.severity}` }));
      }
      svg.appendChild(marks);

      // X labels: an even step that fits.
      const room = Math.max(1, Math.floor(plotW / 64));
      let step = Math.ceil(n / room);
      for (const st of [1, 2, 7, 14, 28, 56, 91, 182, 364]) if (n / st <= room) { step = st; break; }
      const xl = s('g', { class: 'x-labels' });
      for (let i = 0; i < n; i += step) {
        const t = s('text', { x: left + i * band + band / 2, y: height - 6, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'tick', 'font-size': font });
        t.textContent = c.labels[i];
        xl.appendChild(t);
      }
      svg.appendChild(xl);

      frame.textContent = '';
      frame.appendChild(svg);
      geo = { left, band, top, width, cursor };
      if (active !== null) show(active);
    };

    const tipRow = (cls, label, value) => h('div', `tip-row ${cls}`, [h('span', 'tip-dot'), h('span', 'tip-name', label), h('span', 'tip-value', value)]);
    function show(i) {
      if (!geo || i === null || i < 0 || i >= n) return;
      active = i;
      geo.cursor.setAttribute('x', String(geo.left + i * geo.band));
      geo.cursor.setAttribute('width', String(geo.band));
      geo.cursor.style.display = '';
      tip.textContent = '';
      tip.appendChild(h('div', 'tip-title', c.longDates[i]));
      if (c.text.total[i] !== null) {
        tip.appendChild(h('div', 'tip-total', [h('span', null, 'Total'), h('span', 'tip-value', c.text.total[i])]));
        tip.appendChild(tipRow('t-cloud', 'Cloud', c.text.cloud[i]));
        if (c.hasCommitment) tip.appendChild(tipRow('t-commitment', 'Commitments', c.text.commitment[i]));
        if (c.hasAi) tip.appendChild(tipRow('t-ai', 'AI', c.text.ai[i]));
        if (spreadShown()) tip.appendChild(tipRow('t-monthly', 'Monthly charges, spread', c.text.monthly[i]));
      }
      if (c.text.forecast[i]) tip.appendChild(h('div', 'tip-total', [h('span', null, 'Forecast'), h('span', 'tip-value', c.text.forecast[i])]));
      const m = marksAt.get(i);
      if (m) {
        tip.appendChild(h('div', 'tip-head', 'Anomalies'));
        for (const it of m.items) {
          tip.appendChild(h('div', 'tip-anomaly', [
            h('span', 'tip-name', it.name),
            h('span', 'tip-value', it.delta),
            h('span', 'tip-sub', `${it.actual} against ${it.expected} expected`),
          ]));
        }
      }
      const rel = releasesAt.get(i);
      if (rel && rel.items.length) {
        tip.appendChild(h('div', 'tip-head', rel.label));
        for (const item of rel.items) tip.appendChild(h('div', 'tip-sub', item));
      } else if (rel) tip.appendChild(h('div', 'tip-sub', `Release ${rel.label}`));
      tip.hidden = false;
      const cx = geo.left + i * geo.band + geo.band / 2;
      const tw = tip.offsetWidth;
      tip.style.left = `${cx + 14 + tw > geo.width ? Math.max(0, cx - 14 - tw) : cx + 14}px`;
      tip.style.top = `${geo.top}px`;
    }
    function hide() {
      if (pinned) return;
      active = null;
      tip.hidden = true;
      if (geo) geo.cursor.style.display = 'none';
    }
    const indexAt = (clientX) => Math.floor((clientX - frame.getBoundingClientRect().left - geo.left) / geo.band);
    frame.addEventListener('pointermove', (e) => {
      if (!geo) return;
      pinned = false;
      const i = indexAt(e.clientX);
      if (i >= 0 && i < n) show(i); else hide();
    });
    frame.addEventListener('pointerleave', hide);
    frame.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      pinned = true;
      show(Math.max(0, Math.min(n - 1, (active === null ? c.actualDays - 1 : active) + (e.key === 'ArrowLeft' ? -1 : 1))));
    });
    frame.addEventListener('blur', () => { pinned = false; hide(); });

    draw();
    let pending = 0;
    let printing = false;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => { if (!printing && geo && frame.clientWidth !== geo.width) draw(); });
    });
    bus.focusDay = (i) => {
      frame.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      pinned = true;
      show(i);
    };
    return {
      setPrintWidth: (pw) => { printing = pw !== null; pinned = false; hide(); draw(pw || undefined); },
    };
  }

  /**
   * The usage types a driver or candidate opens to, scrolling sideways inside its card on a narrow
   * screen. Rows past the first few sit behind an "N more" row.
   */
  function usageSubTable(u) {
    const cols = [['Usage type'], ['Region'], ['Last 30 days', 'num'],
      ...(u.compare ? [['Previous 30', 'num'], ['Change', 'num']] : []), ['Share', 'num']];
    const t = table(cols, 'subtable');
    const tbody = h('tbody');
    const spanAll = (node) => { node.colSpan = cols.length; return node; };
    if (u.rows.length === 0) tbody.appendChild(h('tr', null, [spanAll(td('muted', 'No usage type detail for this row.'))]));
    const extra = [];
    u.rows.forEach((r, i) => {
      const tr = h('tr', null, [
        td('name', r.name),
        td('muted', r.region),
        td('num', r.current),
        ...(u.compare ? [td('num muted', r.previous), td(`num delta-${tone(r.dir)}`, r.change)] : []),
        td('num', [meter(r.pct, r.share)]),
      ]);
      if (i >= u.shown) {
        tr.hidden = true;
        tr.className = 'extra';
        extra.push(tr);
      }
      tbody.appendChild(tr);
    });
    if (u.more) {
      const button = h('button', 'more', u.more);
      button.type = 'button';
      const row = h('tr', 'more-row', [spanAll(td(null, [button]))]);
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        for (const tr of extra) tr.hidden = false;
        row.remove();
        extra[0].tabIndex = -1;
        extra[0].focus();
      });
      tbody.appendChild(row);
    }
    t.appendChild(tbody);
    return h('div', 'subtable-scroll', [t]);
  }

  /**
   * The pull-request pointer on a candidate Plutus can fix: a plain link, which is a navigation and not a
   * fetch, so the content security policy is untouched. Clicking it must not also toggle the row.
   */
  function fixLink(fix, text) {
    if (!fix) return null;
    const a = h('a', null, text);
    a.href = fix.url;
    a.rel = 'noopener';
    a.addEventListener('click', (e) => e.stopPropagation());
    return h('span', 'sub', [a]);
  }

  let detailCount = 0;
  /**
   * One row that opens to its usage types: the whole row is clickable, and its first cell holds the
   * chevron button that carries aria-expanded. Collapsed by default. Drivers and candidates share it.
   * @param {Array<Node|string|null>} label @param {HTMLElement[]} cells the cells after the first
   */
  function disclosure(label, cells, usage, note) {
    const group = h('tbody', 'group');
    const button = h('button', 'disclose', label);
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    const parent = h('tr', 'parent', [td(null, [button]), ...cells]);
    const cell = td(null, [h('div', 'reveal', [h('div', 'reveal-inner', [note, usageSubTable(usage)])])]);
    cell.colSpan = cells.length + 1;
    const detail = h('tr', 'detail', [cell]);
    detail.id = `usage-${++detailCount}`;
    button.setAttribute('aria-controls', detail.id);
    // A click on the button bubbles here too, so the row is the one place that toggles.
    parent.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      group.classList.toggle('open', open);
    });
    group.append(parent, detail);
    return group;
  }

  // Drivers: one row per service; a row opens to its usage types.
  function renderDrivers(view) {
    const dv = view.drivers;
    const root = body('drivers');
    if (dv.reason) { root.appendChild(reason(dv.reason)); return; }
    root.appendChild(h('p', 'intro', dv.intro));
    const t = table([['Service'], ['Last 30 days', 'num'], ['Previous 30', 'num wide'], ['Change', 'num'], ['Share of change', 'num wide']], 'drivers');
    for (const d of dv.items) {
      t.appendChild(disclosure([h('span', 'name', d.name), d.kind === 'Cloud' ? null : h('span', 'badge neutral', d.kind)], [
        td('num', d.current),
        td('num wide muted', d.previous),
        td('num', [chip(d.change, tone(d.dir))]),
        td('num wide muted', d.share),
      ], d.usage));
    }
    root.appendChild(t);
  }

  /** A small bar sparkline of one service, its flagged days in the severity colour. */
  function spark(sp, severity) {
    const w = 96;
    const hgt = 24;
    const max = Math.max(...sp.values, 0) || 1;
    const bw = w / sp.values.length;
    const svg = s('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: 'spark' });
    svg.setAttribute('aria-hidden', 'true');
    sp.values.forEach((v, i) => {
      const bh = Math.max(1, (Math.max(0, v) / max) * (hgt - 2));
      svg.appendChild(s('rect', {
        x: i * bw + bw * 0.12, y: hgt - bh, width: Math.max(0.8, bw * 0.76), height: bh,
        class: sp.flagged[i] ? `spark-hit sev-${severity}` : 'spark-bar',
      }));
    });
    return svg;
  }

  // Anomalies.
  function renderAnomalies(view, bus) {
    const av = view.anomalies;
    const root = body('anomalies');
    if (av.reason) { root.appendChild(reason(av.reason)); return; }
    const t = table([
      ['Service'], ['Peak day'], ['Expected', 'num wide'], ['Actual', 'num wide'], ['Change', 'num'],
      ['Share of day', 'num wide'], ['Last weeks', 'wide'], ['Severity', 'wide'],
    ], 'anomalies');
    const tbody = h('tbody');
    for (const a of av.items) {
      const tr = h('tr', a.index === null ? null : 'clickable', [
        td(null, [h('span', 'name', a.name), sub(a.span), sub(a.release ? `Nearby release, context only: ${a.release}` : null)]),
        td('nowrap', a.day),
        td('num wide muted', a.baseline),
        td('num wide', a.cost),
        td('num', [h('span', 'delta-bad', a.delta), sub(a.excess || a.pct)]),
        td('num wide', [a.share, sub(a.shareOf)]),
        td('wide', a.spark ? [spark(a.spark, a.severity)] : null),
        td('wide', [badge(a.severity)]),
      ]);
      if (a.index !== null) {
        tr.tabIndex = 0;
        tr.title = 'Show this day on the chart';
        const go = () => { if (bus.focusDay) bus.focusDay(a.index); };
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      }
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    root.appendChild(t);
  }

  // Candidates.
  function renderCandidates(view) {
    const cv = view.candidates;
    const root = body('candidates');
    root.appendChild(h('p', 'intro', cv.intro));
    if (cv.reason) { root.appendChild(reason(cv.reason)); return; }
    const t = table([['Candidate'], ['Last 30 days', 'num']], 'candidates');
    for (const c of cv.items) {
      t.appendChild(disclosure([h('span', 'name', c.title), sub(c.strength + '. ' + c.why)], [td('num', [c.cost, fixLink(c.fix, c.fix && c.fix.compact)])], c.usage, fixLink(c.fix, c.fix && c.fix.text)));
    }
    root.appendChild(t);
  }

  function renderAiProjects(view) {
    const pv = view.aiProjects;
    const root = body('ai-projects');
    if (pv.reason) { root.appendChild(reason(pv.reason)); return; }
    const t = table([['Project'], ['Cost', 'num'], ['Share of AI', 'num']], 'compact');
    const tbody = h('tbody');
    for (const p of pv.items) tbody.appendChild(h('tr', null, [td(null, [h('span', 'name', p.name)]), td('num', p.cost), td('num', [meter(p.pct, p.share)])]));
    t.appendChild(tbody);
    root.appendChild(t);
  }

  function renderUntagged(view) {
    const uv = view.untagged;
    const root = body('untagged');
    if (uv.reason) { root.appendChild(reason(uv.reason)); return; }
    const t = table([['Tag key'], ['Untagged', 'num'], ['Total', 'num wide'], ['Untagged share', 'num']], 'compact');
    const tbody = h('tbody');
    for (const u of uv.items) {
      tbody.appendChild(h('tr', null, [
        td(null, [h('span', 'name', u.name)]), td('num', u.untagged), td('num wide muted', u.total), td('num', [meter(u.pct, u.share)]),
      ]));
    }
    t.appendChild(tbody);
    root.appendChild(t);
  }

  function renderBasis(view) {
    const root = body('basis');
    for (const line of view.basis.lines) root.appendChild(h('p', null, line));
    root.appendChild(h('p', 'generated', view.basis.generated));
  }

  // Theme toggle and print.
  function setupTheme(chart) {
    const rootEl = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const current = () => rootEl.getAttribute('data-theme') || (media.matches ? 'dark' : 'light');
    const button = document.getElementById('theme-toggle');
    const label = () => { button.textContent = current() === 'dark' ? 'Light theme' : 'Dark theme'; };
    button.addEventListener('click', () => {
      rootEl.setAttribute('data-theme', current() === 'dark' ? 'light' : 'dark');
      label();
    });
    media.addEventListener('change', label);
    label();

    // Usage type sub-tables are opened for print by the stylesheet, not here.
    let saved = null;
    window.addEventListener('beforeprint', () => {
      saved = rootEl.getAttribute('data-theme');
      rootEl.setAttribute('data-theme', 'light');
      if (chart) chart.setPrintWidth(660);
    });
    window.addEventListener('afterprint', () => {
      if (saved === null) rootEl.removeAttribute('data-theme');
      else rootEl.setAttribute('data-theme', saved);
      if (chart) chart.setPrintWidth(null);
    });
  }

  function start() {
    const data = JSON.parse(document.getElementById('report').textContent);
    const view = data.view;
    const bus = { focusDay: null };
    renderHeadline(view);
    const chart = renderDaily(view, bus);
    renderDrivers(view);
    renderAnomalies(view, bus);
    renderCandidates(view);
    renderAiProjects(view);
    renderUntagged(view);
    renderBasis(view);
    setupTheme(chart);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());

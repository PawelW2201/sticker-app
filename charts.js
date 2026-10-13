// charts.js — small dependency-free SVG time-series charts.
// One y-axis per chart (never dual-axis); stacked charts share a crosshair group.

const NS = "http://www.w3.org/2000/svg";
const DAY = 86400000;

function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

export function toDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (d) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
const fmtMon = (d) => MON[d.getUTCMonth()];
const fmtMonYear = (d) => `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// "Nice" ticks (d3-style) for a numeric domain.
function niceTicks(lo, hi, count) {
  if (!(hi > lo)) { const p = Math.abs(lo) * 0.05 || 1; lo -= p; hi += p; }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const err = raw / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return { ticks, step };
}

// Date ticks: pick weekly / monthly / quarterly / yearly by span and width.
function dateTicks(d0, d1, maxTicks) {
  const span = (d1 - d0) / DAY;
  const out = [];
  if (span <= 50) {
    const step = span / maxTicks <= 7 ? 7 : 14;
    // anchor on Mondays
    let t = new Date(d0);
    while (t.getUTCDay() !== 1) t = new Date(+t + DAY);
    for (; t <= d1; t = new Date(+t + step * DAY)) out.push({ t, label: fmtDay(t) });
    return out;
  }
  const months = span / 30.4;
  const every = [1, 2, 3, 6, 12].find((m) => months / m <= maxTicks) || 12;
  let t = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1));
  while (t.getUTCMonth() % every !== 0) t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
  for (; t <= d1; t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + every, 1))) {
    const label = t.getUTCMonth() === 0 || every >= 12 ? fmtMonYear(t) : fmtMon(t);
    out.push({ t, label });
  }
  return out;
}

// A crosshair group keeps stacked charts on the same day.
export function crosshairGroup() {
  const charts = new Set();
  return {
    add(c) { charts.add(c); },
    remove(c) { charts.delete(c); },
    set(i, from) { for (const c of charts) c._setIndex(i, from); },
  };
}

let openTouchChart = null;
document.addEventListener("pointerdown", (e) => {
  if (openTouchChart && !openTouchChart.root.contains(e.target)) {
    openTouchChart.group.set(null);
    openTouchChart = null;
  }
}, { passive: true });

/**
 * timeChart(container, opts)
 *  opts.dates   ISO "YYYY-MM-DD" strings (ascending; daily or sparse)
 *  opts.series  [{ name, values, color, kind: "line"|"area", band: {lo, hi, name} }]
 *               values aligned to dates; null = missing
 *  opts.height  plot height in px (axis band is added on top of this)
 *  opts.fmt     value formatter for ticks + readout
 *  opts.tickFmt optional compact formatter for the y ticks
 *  opts.title   readout title when one series
 *  opts.connectGaps  draw through missing days (sparse logs)
 *  opts.group   crosshairGroup() to sync with siblings
 *  opts.label   accessible description
 */
export function timeChart(container, opts) {
  const group = opts.group || crosshairGroup();
  const root = document.createElement("div");
  root.className = "chart";
  const head = document.createElement("div");
  head.className = "chart-readout";
  const plotWrap = document.createElement("div");
  plotWrap.className = "chart-plot";
  root.append(head, plotWrap);
  container.appendChild(root);

  const dates = opts.dates.map(toDate);
  const n = dates.length;
  const series = opts.series;
  const fmt = opts.fmt || ((v) => String(v));
  const tickFmt = opts.tickFmt || fmt;
  const H = opts.height || 160;
  const AXIS = 22;
  let W = 0, idx = null, s = null, geo = null;

  const self = { root, group, _setIndex: setIndex, destroy, update: render };
  group.add(self);

  function lastValid(vals) {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i;
    return -1;
  }

  function readout(i) {
    head.textContent = "";
    const at = i == null ? lastValid(series[0].values) : i;
    const left = document.createElement("div");
    left.className = "ro-vals";
    for (const se of series) {
      const item = document.createElement("span");
      item.className = "ro-item";
      const key = document.createElement("i");
      key.className = "ro-key" + (se.kind === "area" ? " area" : "");
      key.style.setProperty("--k", se.color);
      const v = at >= 0 ? se.values[at] : null;
      const val = document.createElement("b");
      val.textContent = v == null ? "—" : fmt(v);
      const lab = document.createElement("span");
      lab.textContent = se.name;
      item.append(key, lab, val);
      left.appendChild(item);
      if (se.band) {
        const bi = document.createElement("span");
        bi.className = "ro-item";
        const bk = document.createElement("i");
        bk.className = "ro-key spread";
        bk.style.setProperty("--k", se.color);
        const lo = at >= 0 ? se.band.lo[at] : null, hi = at >= 0 ? se.band.hi[at] : null;
        const bl = document.createElement("span");
        bl.textContent = se.band.name;
        const bv = document.createElement("b");
        bv.textContent = lo == null ? "—" : fmt(lo);
        bi.append(bk, bl, bv);
        left.appendChild(bi);
      }
    }
    const right = document.createElement("time");
    right.className = "ro-date";
    if (at >= 0) {
      right.textContent = (i == null ? "Latest, " : "") + fmtDay(dates[at]);
      right.dateTime = opts.dates[at];
    }
    head.append(left, right);
  }

  function render() {
    W = Math.max(200, Math.round(plotWrap.clientWidth || container.clientWidth || 320));
    plotWrap.textContent = "";
    if (!n) { readout(null); return; }
    const m = { l: 6, r: 50, t: 8, b: AXIS };
    const pw = W - m.l - m.r, ph = H;
    // y domain from every drawn value
    let lo = Infinity, hi = -Infinity;
    for (const se of series) {
      for (const v of se.values) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (se.band) for (let i = 0; i < n; i++) {
        const a = se.band.lo[i], b = se.band.hi[i];
        if (a != null && b != null) { if (a < lo) lo = a; if (b > hi) hi = b; }
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (opts.zero) lo = Math.min(0, lo);
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    const yt = niceTicks(lo - (opts.zero && lo === 0 ? 0 : pad), hi + pad, Math.max(2, Math.round(ph / 48)));
    const y0 = Math.min(yt.ticks[0], lo - (opts.zero ? 0 : pad * 0.5));
    const y1 = Math.max(yt.ticks[yt.ticks.length - 1], hi + pad * 0.5);
    const t0 = +dates[0], t1 = +dates[n - 1] || t0 + DAY;
    const X = (i) => m.l + (n === 1 ? pw / 2 : ((+dates[i] - t0) / (t1 - t0)) * pw);
    const Y = (v) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
    geo = { X, Y, m, pw, ph };

    const el = svg("svg", {
      width: W, height: ph + m.t + m.b, viewBox: `0 0 ${W} ${ph + m.t + m.b}`,
      class: "chart-svg", role: "img", tabindex: 0,
      "aria-label": opts.label || series.map((x) => x.name).join(", "),
    });
    // grid + y ticks (right side)
    const g = svg("g", { class: "grid" }, el);
    for (const v of yt.ticks) {
      if (v < y0 || v > y1) continue;
      const yy = Math.round(Y(v)) + 0.5;
      svg("line", { x1: m.l, x2: m.l + pw, y1: yy, y2: yy }, g);
      const t = svg("text", { x: m.l + pw + 8, y: yy, class: "tick", "dominant-baseline": "middle" }, g);
      t.textContent = tickFmt(v);
    }
    // x ticks
    const xt = dateTicks(dates[0], dates[n - 1], Math.max(2, Math.floor(pw / 74)));
    const gx = svg("g", { class: "xaxis" }, el);
    svg("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph + 0.5, y2: m.t + ph + 0.5, class: "base" }, gx);
    for (const { t, label } of xt) {
      const xx = m.l + ((+t - t0) / (t1 - t0)) * pw;
      if (xx < m.l + 12 || xx > m.l + pw - 12) continue;
      svg("line", { x1: xx, x2: xx, y1: m.t + ph, y2: m.t + ph + 4, class: "base" }, gx);
      const tx = svg("text", { x: xx, y: m.t + ph + 16, class: "tick", "text-anchor": "middle" }, gx);
      tx.textContent = label;
    }
    // marks
    for (const se of series) {
      if (se.band) {
        let d = "", seg = [];
        const flush = () => {
          if (seg.length > 1) {
            d += "M" + seg.map((i) => `${X(i).toFixed(1)},${Y(se.band.hi[i]).toFixed(1)}`).join("L");
            d += "L" + seg.slice().reverse().map((i) => `${X(i).toFixed(1)},${Y(se.band.lo[i]).toFixed(1)}`).join("L") + "Z";
          }
          seg = [];
        };
        for (let i = 0; i < n; i++) {
          if (se.band.lo[i] != null && se.band.hi[i] != null) seg.push(i); else flush();
        }
        flush();
        if (d) svg("path", { d, class: "spread", style: `--c:${se.color}` }, el);
      }
      const pts = [];
      let path = "", pen = false;
      for (let i = 0; i < n; i++) {
        const v = se.values[i];
        if (v == null) { if (!opts.connectGaps) pen = false; continue; }
        path += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1);
        pen = true;
        pts.push(i);
      }
      if (se.kind === "area" && pts.length > 1) {
        const base = Y(y0).toFixed(1);
        const a = `M${X(pts[0]).toFixed(1)},${base}L` +
          pts.map((i) => `${X(i).toFixed(1)},${Y(se.values[i]).toFixed(1)}`).join("L") +
          `L${X(pts[pts.length - 1]).toFixed(1)},${base}Z`;
        svg("path", { d: a, class: "area", style: `--c:${se.color}` }, el);
      }
      if (path) svg("path", { d: path, class: "line", style: `--c:${se.color}` }, el);
      const li = lastValid(se.values);
      if (li >= 0) svg("circle", { cx: X(li), cy: Y(se.values[li]), r: 4, class: "dot end", style: `--c:${se.color}` }, el);
    }
    // crosshair layer
    const cross = svg("g", { class: "cross" }, el);
    const vline = svg("line", { y1: m.t, y2: m.t + ph, class: "vline" }, cross);
    const dots = series.map((se) => svg("circle", { r: 4, class: "dot", style: `--c:${se.color}` }, cross));
    const hit = svg("rect", { x: m.l, y: 0, width: pw, height: ph + m.t + m.b, class: "hit" }, el);
    s = { cross, vline, dots, el };

    const pick = (clientX) => {
      const r = el.getBoundingClientRect();
      const x = clientX - r.left;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const dd = Math.abs(X(i) - x);
        if (dd < bd) { bd = dd; best = i; }
      }
      return best;
    };
    hit.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // scrubbing shouldn't draw a keyboard focus ring
      if (e.pointerType !== "mouse") openTouchChart = self;
      group.set(pick(e.clientX), self);
    });
    hit.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" || e.buttons) group.set(pick(e.clientX), self);
    });
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") group.set(null); });
    el.addEventListener("keydown", (e) => {
      const cur = idx == null ? n - 1 : idx;
      const k = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: n - 1 }[e.key];
      if (k != null) { e.preventDefault(); group.set(Math.max(0, Math.min(n - 1, k)), self); }
      if (e.key === "Escape") group.set(null);
    });
    el.addEventListener("blur", () => group.set(null));
    plotWrap.appendChild(el);
    paint();
  }

  function paint() {
    readout(idx);
    if (!s || !geo) return;
    if (idx == null) { s.cross.style.display = "none"; return; }
    s.cross.style.display = "";
    const x = geo.X(idx);
    s.vline.setAttribute("x1", x);
    s.vline.setAttribute("x2", x);
    series.forEach((se, k) => {
      const v = se.values[idx];
      const dot = s.dots[k];
      if (v == null) { dot.style.display = "none"; return; }
      dot.style.display = "";
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", geo.Y(v));
    });
  }

  function setIndex(i) { idx = i; paint(); }

  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const w = Math.round(plotWrap.clientWidth);
      if (w && Math.abs(w - W) > 1) render();
    });
  });
  ro.observe(plotWrap);

  function destroy() { ro.disconnect(); group.remove(self); root.remove(); }

  render();
  return self;
}

// Tiny non-interactive sparkline (string of SVG markup is avoided: DOM nodes only).
export function sparkline(values, color, w = 76, h = 24) {
  const el = svg("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: "spark", "aria-hidden": "true" });
  const pts = [];
  values.forEach((v, i) => { if (v != null && isFinite(v)) pts.push([i, v]); });
  if (pts.length < 2) return el;
  let lo = Infinity, hi = -Infinity;
  for (const [, v] of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const n = values.length - 1 || 1;
  const X = (i) => 2 + (i / n) * (w - 6);
  const Y = (v) => 2 + (1 - (v - lo) / (hi - lo)) * (h - 4);
  svg("path", { d: "M" + pts.map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("L"), class: "spark-line", style: `--c:${color}` }, el);
  const [li, lv] = pts[pts.length - 1];
  svg("circle", { cx: X(li), cy: Y(lv), r: 2.2, class: "spark-dot", style: `--c:${color}` }, el);
  return el;
}

// Horizontal bars for a handful of categories (single series).
export function barList(container, rows, { fmt, color, label }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const list = document.createElement("div");
  list.className = "bars";
  list.setAttribute("role", "list");
  if (label) list.setAttribute("aria-label", label);
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.setAttribute("role", "listitem");
    const name = document.createElement("span");
    name.className = "bar-name";
    name.textContent = r.name;
    const track = document.createElement("span");
    track.className = "bar-track";
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.width = `${Math.max(0.5, (r.value / max) * 100)}%`;
    bar.style.setProperty("--c", color);
    track.appendChild(bar);
    const val = document.createElement("span");
    val.className = "bar-val";
    val.textContent = fmt(r.value);
    const sub = document.createElement("span");
    sub.className = "bar-sub";
    sub.textContent = r.sub || "";
    row.append(name, track, val, sub);
    if (r.onClick) { row.tabIndex = 0; row.classList.add("tappable"); row.addEventListener("click", r.onClick); row.addEventListener("keydown", (e) => { if (e.key === "Enter") r.onClick(); }); }
    list.appendChild(row);
  }
  container.appendChild(list);
  return list;
}

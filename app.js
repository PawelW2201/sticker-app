// app.js — StickerTracker app. Reads the nightly bundle (summary.json, series.json)
// from your private repo's dashboard-data branch with a read-only token.
import { timeChart, crosshairGroup, sparkline, barList, toDate, fmtDay } from "./charts.js";

const VERSION = "1.0.9";
const STORE = "stickertracker.v1";
const DATA_CACHE = "st-data-v1";
const DEFAULT_BRANCH = "dashboard-data";
const RAW = "application/vnd.github.raw+json";
const DAY = 86400000;
const TABS = ["today", "drift", "book", "agent", "watch"];
const VIEWS = [...TABS, "movers"];          // movers is a page under Today, not a tab
const RANGES = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, All: null };

// ------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);

const MINUS = "−";
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sign = (v) => (v < 0 ? MINUS : v > 0 ? "+" : "");
const money = (v) => (v == null ? "—" : (v < 0 ? MINUS : "") + "¥" + nf0.format(Math.abs(v)));
const smoney = (v) => (v == null ? "—" : sign(v) + "¥" + nf0.format(Math.abs(v)));
const price = (v) => (v == null ? "—" : "¥" + nf2.format(v));
const int = (v) => (v == null ? "—" : nf0.format(v));
const pct = (p, d = 1) => (p == null ? "—" : sign(Math.round(p * 10 ** (d + 2)) / 10 ** (d + 2)) + (Math.abs(p) * 100).toFixed(d) + "%");
function compact(v) {
  const a = Math.abs(v), s = v < 0 ? MINUS : "";
  if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e4) return s + Math.round(a / 1e3) + "K";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return s + nf0.format(a);
}
const numTick = (v) => {
  const a = Math.abs(v);
  if (a >= 1000) return compact(v);
  if (a >= 100) return nf0.format(v);
  return String(+v.toFixed(a >= 10 ? 1 : 2));
};
const dcls = (p) => (p == null || Math.abs(p) < 1e-9 ? "flat" : p > 0 ? "up" : "down");
const roundTo = (p, d) => (p == null ? null : Math.round(p * 10 ** (d + 2)) / 10 ** (d + 2));
const iso = (d) => d.toISOString().slice(0, 10);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const longDay = (s) => { const d = toDate(s); return `${WD[d.getUTCDay()]} ${fmtDay(d)}`; };
function ago(isoTs) {
  const ms = Date.now() - Date.parse(isoTs);
  if (!(ms >= 0)) return "";
  const m = Math.round(ms / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} days ago`;
}

function nameParts(mhn) {
  const parts = String(mhn).split(" | ");
  if (parts[0] === "Sticker" && parts.length >= 3) {
    let team = parts[1], variant = "";
    const m = team.match(/^(.*) \(([^)]+)\)$/);
    if (m) { team = m[1]; variant = m[2]; }
    return { team, variant, event: parts.slice(2).join(" | ") };
  }
  if (parts.length >= 2) return { team: parts[0], variant: "", event: parts.slice(1).join(" | ") };  // agent | faction
  return { team: String(mhn), variant: "", event: "" };
}
const shortName = (mhn) => { const p = nameParts(mhn); return `${p.team}${p.variant && p.variant !== "Holo" ? ` (${p.variant})` : ""}, ${p.event}`; };
function nameBlock(mhn, extra) {
  const p = nameParts(mhn);
  return h("span", { class: "nm" },
    h("span", { class: "nm-team" }, p.team + (p.variant && p.variant !== "Holo" ? ` (${p.variant})` : ""), extra || null),
    h("span", { class: "nm-event", text: p.event }));
}

// Drift-desk signature: three cells for week / month / quarter.
const BITS = { PRIORITY: [1, 1, 1], MQ: [0, 1, 1], WQ: [1, 0, 1], WM: [1, 1, 0], Q: [0, 0, 1], M: [0, 1, 0], W: [1, 0, 0] };
const HORIZ = ["week", "month", "quarter"];
function sig(cat, cls = "") {
  const bits = BITS[cat] || [0, 0, 0];
  const on = HORIZ.filter((_, i) => bits[i]);
  const el = h("span", { class: `sig ${cls}`.trim(), role: "img",
    "aria-label": cat ? `${cat}, listings drifting down over the ${on.join(", ")}` : "Not in a drift category" });
  bits.forEach((b) => el.appendChild(h("i", { class: b ? "on" : null })));
  return el;
}

// ------------------------------------------------------------------ storage
const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode */ } },
};
let cfg = store.get();
const saveCfg = (patch) => { cfg = { ...cfg, ...patch }; store.set(cfg); };

async function cacheGet(name) {
  try {
    const c = await caches.open(DATA_CACHE);
    const r = await c.match(new URL(`__data/${name}`, location.href).href);
    return r ? { text: await r.text(), at: r.headers.get("x-fetched") } : null;
  } catch { return null; }
}
async function cachePut(name, text) {
  try {
    const c = await caches.open(DATA_CACHE);
    await c.put(new URL(`__data/${name}`, location.href).href,
      new Response(text, { headers: { "content-type": "application/json", "x-fetched": new Date().toISOString() } }));
  } catch { /* no Cache Storage (non-secure context) */ }
}
async function cacheClear() { try { await caches.delete(DATA_CACHE); } catch { /* ignore */ } }

// ------------------------------------------------------------------ GitHub
class GhError extends Error {
  constructor(status, message) { super(message || `HTTP ${status}`); this.status = status; }
}
async function gh(path, accept = "application/vnd.github+json", token = cfg.token) {
  let res;
  try {
    res = await fetch("https://api.github.com" + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept }, cache: "no-cache",
    });
  } catch {
    throw new GhError(0, "Can't reach GitHub");
  }
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).message || ""; } catch { /* not json */ }
    const err = new GhError(res.status, msg);
    err.rateLimited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    throw err;
  }
  return accept === RAW ? res.text() : res.json();
}
const contentsPath = (file, c = cfg) =>
  `/repos/${c.repo}/contents/${file}?ref=${encodeURIComponent(c.branch || DEFAULT_BRANCH)}`;

// ------------------------------------------------------------------ state
const state = {
  summary: null, series: null, idx: null,
  source: null, fetchedAt: null, loading: false, error: null,
  tab: "today", ui: {}, // per-view UI state (filters, sorts, ranges)
};
const ui = (k, dflt) => (k in state.ui ? state.ui[k] : (cfg.ui && k in cfg.ui ? cfg.ui[k] : dflt));
function setUi(k, v, persist) {
  state.ui[k] = v;
  if (persist) saveCfg({ ui: { ...(cfg.ui || {}), [k]: v } });
}

function applySummary(s, source, at) {
  if (!s || s.v !== 1) throw new Error("Unexpected data format");
  state.summary = s;
  state.source = source;
  state.fetchedAt = at || new Date().toISOString();
}
function applySeries(r) {
  state.series = r;
  state.idx = new Map(r.items.map((it) => [it.mhn, it]));
}

let loadSeq = 0;
async function load({ force } = {}) {
  if (!cfg.token || !cfg.repo) return render();
  const seq = ++loadSeq;
  if (!state.summary) {
    const [cs, cr] = await Promise.all([cacheGet("summary.json"), cacheGet("series.json")]);
    try { if (cs) applySummary(JSON.parse(cs.text), "cache", cs.at); } catch { /* stale format */ }
    try { if (cr) applySeries(JSON.parse(cr.text)); } catch { /* stale format */ }
    if (state.summary) render();
  }
  state.loading = true;
  renderStatus();
  try {
    const text = await gh(contentsPath("summary.json"), RAW);
    if (seq !== loadSeq) return;
    const s = JSON.parse(text);
    const changed = !state.summary || state.summary.generated_at !== s.generated_at || state.source === "cache";
    applySummary(s, "network");
    state.error = null;
    cachePut("summary.json", text);
    if (changed || force) render();
    if (!state.series || state.series.as_of !== s.as_of) {
      const rt = await gh(contentsPath("series.json"), RAW);
      if (seq !== loadSeq) return;
      applySeries(JSON.parse(rt));
      cachePut("series.json", rt);
      render();
    }
  } catch (e) {
    if (seq !== loadSeq) return;
    state.error = e;
    render();
  } finally {
    if (seq === loadSeq) { state.loading = false; renderStatus(); }
  }
}

// ------------------------------------------------------------------ routing
function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const q = new URLSearchParams(query || "");
  if (parts[0] === "s" && parts[1]) return { sheet: { type: "sticker", mhn: decodeURIComponent(parts.slice(1).join("/")) }, q };
  if (parts[0] === "settings") return { sheet: { type: "settings" }, q };
  return { tab: VIEWS.includes(parts[0]) ? parts[0] : "today", q };
}
let sheetPushed = false;
function go(hash) { location.hash = hash; }
function openSticker(mhn) { sheetPushed = true; go(`#/s/${encodeURIComponent(mhn)}`); }
function openSettings() { sheetPushed = true; go("#/settings"); }
function closeSheet() {
  if (sheetPushed) { sheetPushed = false; history.back(); }
  else go(`#/${state.tab}`);
}

// ------------------------------------------------------------------ shell
const app = $("#app");
let lastFocus = null;
let renderedTab = null;

function render() {
  applyTheme();
  const r = route();
  if (r.tab) state.tab = r.tab;
  renderedTab = state.tab;
  if (!cfg.token || !cfg.repo) {
    app.replaceChildren(viewSetup());
    renderSheet(null);
    return;
  }
  const main = h("main", { id: "view", tabindex: "-1" });
  app.replaceChildren(rail(), h("div", { class: "main-col" }, topbar(), h("div", { id: "status" }), main), tabbar());
  renderStatus();
  if (!state.summary) {
    main.appendChild(state.error ? h("div") : h("div", { class: "loading-shell" }, h("p", { text: "Loading your tracker…" })));
  } else {
    const view = { today: viewToday, drift: viewDrift, book: viewBook, agent: viewAgent, watch: viewWatch, movers: viewMovers }[state.tab];
    try { main.appendChild(view()); }
    catch (e) { console.error(e); main.appendChild(h("p", { class: "empty", text: `This view couldn't be drawn: ${e.message}` })); }
  }
  const sy = state.ui[`scroll:${state.tab}`];
  if (sy != null && !r.sheet) requestAnimationFrame(() => window.scrollTo(0, sy));
  renderSheet(r.sheet);
}

function brand() {
  return h("span", { class: "brand" },
    h("img", { src: "icons/icon.svg", alt: "", width: 26, height: 26 }),
    h("span", { class: "brand-name", text: "StickerTracker" }));
}

const TAB_LABEL = { today: "Today", drift: "Drift desk", book: "Your book", agent: "Agent", watch: "Watching" };
const TAB_ICON = {
  today: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 7v5l3 2",
  drift: "M4 6h16M4 12h10M4 18h5",
  book: "M5 4h11l3 3v13H5zM9 10h6M9 14h6",
  agent: "M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8z",
  watch: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
};
function navIcon(d) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "nav-ico");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  s.appendChild(p);
  return s;
}
function navLinks(cls) {
  return TABS.map((t) => h("a", {
    href: `#/${t}`, class: cls, "aria-current": state.tab === t || (t === "today" && state.tab === "movers") ? "page" : null,
    onclick: () => { state.ui[`scroll:${state.tab}`] = window.scrollY; },
  }, navIcon(TAB_ICON[t]), h("span", { text: TAB_LABEL[t] })));
}
function rail() {
  return h("aside", { class: "rail" }, brand(), h("nav", { class: "rail-nav", "aria-label": "Sections" }, navLinks("rail-link")), railFoot());
}
function railFoot() {
  const s = state.summary;
  return h("div", { class: "rail-foot" },
    s ? h("p", { class: "muted" }, `Data for ${longDay(s.as_of)}`) : null,
    h("button", { class: "linkish", type: "button", onclick: openSettings }, "Settings"));
}
function tabbar() {
  return h("nav", { class: "tabbar", "aria-label": "Sections" }, navLinks("tab-link"));
}
function topbar() {
  const s = state.summary;
  return h("header", { class: "topbar" },
    h("div", { class: "topbar-brand" }, brand()),
    h("div", { class: "topbar-meta" },
      s ? h("span", { class: "asof" }, `Data for ${longDay(s.as_of)}`) : null,
      s ? h("span", { class: "updated", title: s.generated_at }, `exported ${ago(s.generated_at)}`) : null),
    h("div", { class: "topbar-actions" },
      h("button", { class: "icon-btn", type: "button", "aria-label": "Refresh", title: "Refresh", id: "refresh-btn",
        onclick: () => load({ force: true }) }, navIcon("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7")),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Settings", title: "Settings", onclick: openSettings },
        navIcon("M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M19.4 13.5l1.6 1.2-2 3.4-1.9-.6a7 7 0 0 1-1.7 1l-.4 2h-4l-.4-2a7 7 0 0 1-1.7-1l-1.9.6-2-3.4 1.6-1.2a7 7 0 0 1 0-3l-1.6-1.2 2-3.4 1.9.6a7 7 0 0 1 1.7-1l.4-2h4l.4 2a7 7 0 0 1 1.7 1l1.9-.6 2 3.4-1.6 1.2a7 7 0 0 1 0 3z"))));
}

function renderStatus() {
  const el = $("#status");
  const btn = $("#refresh-btn");
  if (btn) btn.classList.toggle("spinning", state.loading);
  if (!el) return;
  el.replaceChildren();
  const e = state.error;
  if (!e) {
    if (state.summary && state.source === "cache" && !state.loading)
      el.appendChild(h("p", { class: "banner" }, `Showing saved data from ${longDay(state.summary.as_of)}.`));
    return;
  }
  let msg, action = null;
  if (e.status === 0) msg = state.summary ? `Offline. Showing saved data from ${longDay(state.summary.as_of)}.` : "Can't reach GitHub. Check your connection, then refresh.";
  else if (e.status === 401) { msg = "GitHub rejected the token; it may have expired or been revoked. Add a new one in Settings."; action = ["Open settings", openSettings]; }
  else if (e.status === 404) {
    msg = isAppRepo(cfg.repo)
      ? `${cfg.repo} is this app's own repository, which has no tracker data. In Settings, change the repository to your tracker repository, and make sure the token can read it.`
      : `Can't find app data in ${cfg.repo}. Either the token can't read that repository (on GitHub, edit the token and add it under Repository access), or the nightly run hasn't published to the ${cfg.branch || DEFAULT_BRANCH} branch yet.`;
    action = ["Open settings", openSettings];
  }
  else if (e.rateLimited) msg = "GitHub's rate limit is used up for now. Try again in a few minutes.";
  else msg = `Loading failed: ${e.message}`;
  el.appendChild(h("div", { class: "banner warn", role: "status" }, h("span", { text: msg }),
    action ? h("button", { class: "linkish", type: "button", onclick: action[1] }, action[0]) : null));
}

// ------------------------------------------------------------------ shared bits
function delta(p, cls = "", d = 1) { // colour follows the value as displayed, so "0%" is never green
  return h("span", { class: `delta ${dcls(roundTo(p, d))} ${cls}`.trim() }, pct(p, d));
}
function ndelta(p, d = 0) { // neutral delta (listings: down isn't "bad")
  return h("span", { class: "delta nd" }, pct(p, d));
}
function rangeControl(key, dflt, onChange, options = Object.keys(RANGES)) {
  const cur = ui(key, dflt);
  const wrap = h("div", { class: "seg", role: "group", "aria-label": "Time range" });
  for (const r of options) {
    wrap.appendChild(h("button", {
      type: "button", class: "seg-btn", "aria-pressed": String(r === cur),
      onclick: (e) => {
        for (const b of wrap.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        setUi(key, r, true);
        onChange(r);
      },
    }, r));
  }
  return wrap;
}
function section(cls, ...kids) { return h("section", { class: `band ${cls || ""}`.trim() }, kids); }
function kicker(text) { return h("p", { class: "kicker", text }); }
function stat(label, value, extra) {
  return h("div", { class: "stat" }, h("span", { class: "stat-label", text: label }), h("span", { class: "stat-val" }, value), extra || null);
}
function emptyNote(text) { return h("p", { class: "empty", text }); }
function pair(label, node) { return h("span", { class: "pair" }, h("span", { class: "dl", text: label }), node); }
const HNAME = { W: "week", M: "month", Q: "quarter" };
function catDesc(label) {
  // "M+Q (steady, less aggressive)" -> "month and quarter, steady, less aggressive"
  const m = String(label || "").match(/^([WMQ+]+)(\s+only)?\s*(?:\((.*)\))?$/);
  if (!m) return label || "";
  const hs = m[1].split("+").map((x) => HNAME[x]).filter(Boolean);
  const list = hs.length > 1 ? hs.slice(0, -1).join(", ") + " and " + hs.at(-1) : hs[0];
  return list + (m[2] ? " only" : "") + (m[3] ? `, ${m[3]}` : "");
}

function seriesFor(mhn, days) {
  const it = state.idx && state.idx.get(mhn);
  if (!it) return null;
  const n = it.ask.length;
  const start = days ? Math.max(0, n - days) : 0;
  const d0 = +toDate(it.d0);
  const dates = [];
  for (let i = start; i < n; i++) dates.push(iso(new Date(d0 + i * DAY)));
  return { dates, ask: it.ask.slice(start), bid: it.bid.slice(start), stock: it.stock.slice(start) };
}
function spark(mhn, key, days, color) {
  const s = seriesFor(mhn, days);
  return s ? sparkline(s[key], color) : h("span", { class: "spark-ph" });
}

// Alerts come from the Discord ping text; make them readable.
function parseLD(op) {
  if (!op) return null;
  const out = [];
  const conf = op.match(/confirmed (\d{4}-\d{2}-\d{2}) ref=([\d.]+) ext=([+-]?[\d.]+) gate (OPEN|SHUT)/);
  const ds = op.match(/D\*=([+-]?[\d.]+)/);
  if (conf) {
    out.push(`Confirmed ${fmtDay(toDate(conf[1]))}${ds ? ` (D* ${ds[1].replace("-", MINUS)})` : ""}`);
    out.push(`Extension ${conf[3].replace("-", MINUS)} vs ref ¥${conf[2]}, gate ${conf[4].toLowerCase()}`);
  } else if (/no recent confirmation/.test(op)) {
    out.push(`No recent confirmation${ds ? ` (D* ${ds[1].replace("-", MINUS)})` : ""}`);
  }
  const cb = op.match(/cB (PASS|VETO) (\d+)(<=|>)(\d+)/);
  if (cb) out.push(`Clause B ${cb[1] === "PASS" ? "pass" : "veto"}, listings ${cb[2]} ${cb[3] === "<=" ? "≤" : ">"} ${cb[4]}`);
  else if (/cB sleeps/.test(op)) out.push("Clause B inactive");
  const tr = op.match(/trend (smooth|FLAT|CLIFFY)[^|]*/);
  if (tr) out.push("Trend " + tr[0].slice(6).replace(/-(\d)/g, MINUS + "$1").trim());
  return out.length ? out : [op];
}
function parseAlert(text) {
  let m = text.match(/^⚡ ENTRY (.+?) — (.*)$/u);
  if (m) return { kind: "entry", label: "Entry", mhn: "Sticker | " + m[1], details: parseLD(m[2]) };
  m = text.match(/^🔔 EXIT-WATCH (.+?) ext=([+-]?[\d.]+) — (.*)$/u);
  if (m) return { kind: "exit", label: "Exit watch", mhn: "Sticker | " + m[1], details: [`Extension ${m[2].replace("-", MINUS)}`, m[3]] };
  m = text.match(/^📈 (.+?) moved ([+-]?\d+)% today$/u);
  if (m) return { kind: "move", label: "Big move", mhn: "Sticker | " + m[1], details: [`Moved ${m[2].replace("-", MINUS)}% today`] };
  return { kind: "other", label: "Alert", mhn: null, details: [text] };
}
function alertRow(text) {
  const a = parseAlert(text);
  const body = h("div", { class: "alert-body" },
    a.mhn ? nameBlock(a.mhn) : null,
    h("ul", { class: "facts" }, a.details.map((d) => h("li", { text: d }))));
  const row = h(a.mhn ? "button" : "div", { class: `alert-row ${a.kind}`, type: a.mhn ? "button" : null,
    onclick: a.mhn ? () => openSticker(a.mhn) : null },
    h("span", { class: `badge ${a.kind}`, text: a.label }), body);
  return row;
}

// ------------------------------------------------------------------ Today
function viewToday() {
  const s = state.summary;
  // two stacks side by side on wide screens; one column in this order on phones
  return h("div", { class: "view today" },
    h("div", { class: "today-col a" }, bookBrief(s.book), marketBrief()),
    h("div", { class: "today-col b" }, agentBrief(s.agent), moversBrief()),
    driftBrief(s.drift), pipelineNote(s));
}

function bookBrief(b) {
  if (!b || !b.count) return section("brief book", kicker("Your book"),
    emptyNote("No holdings found. List them in live/mybook.csv (mhn,units[,basis]) and they'll show up after the next run."));
  const ch = b.change && b.change["1d"];
  let headline = "Your book";
  if (ch && ch.abs != null) {
    headline = Math.abs(ch.pct) < 0.0005 ? "Your book held steady overnight"
      : `Your book ${ch.abs < 0 ? "fell" : "rose"} ${money(Math.abs(ch.abs))} overnight`;
  }
  const mkt = marketGroup("All holos");
  const mch = (k) => (mkt && mkt.change ? mkt.change[k] : null);
  const periods = [["7 days", "7d"], ["30 days", "30d"], ["90 days", "90d"], ["1 year", "1y"]]
    .filter(([, k]) => b.change && b.change[k])
    .map(([lab, k]) => h("li", null, h("span", { class: "per-label", text: lab }), delta(b.change[k].pct),
      mch(k) != null ? h("span", { class: "per-mkt", text: `market ${pct(mch(k))}` }) : null));
  const chartBox = h("div", { class: "chart-box" });
  let range = ui("range:book", "3M");
  const draw = () => {
    chartBox.replaceChildren();
    const days = RANGES[range];
    const hist = days ? b.history.slice(-days) : b.history;
    const dates = hist.map((x) => x[0]);
    const span = range === "All" ? "all available history" : "the last " + range;
    if (mkt && ui("book:mode", "value") === "market") {
      // both lines as % change since the first day of the range that has both
      const m = dates.map((d) => indexOn(mkt, d));
      const i0 = m.findIndex((v) => v != null);
      if (i0 >= 0) {
        const rebase = (v, base, i) => (i < i0 || v == null ? null : (100 * v) / base);
        timeChart(chartBox, {
          dates, height: 170, fmt: (v) => pct(v / 100 - 1), tickFmt: (v) => pct(v / 100 - 1, 0),
          series: [
            { name: "Your book", values: hist.map((x, i) => rebase(x[1], hist[i0][1], i)), color: "var(--s-book)", kind: "line" },
            { name: "All holos", values: m.map((v, i) => rebase(v, m[i0], i)), color: "var(--s-market)", kind: "line" },
          ],
          label: `Your book and the holo market, change over ${span}`,
        });
        return;
      }
    }
    timeChart(chartBox, {
      dates, height: 170, fmt: money, tickFmt: (v) => "¥" + compact(v),
      series: [{ name: "Book value", values: hist.map((x) => x[1]), color: "var(--s-book)", kind: "area" }],
      label: `Book value over ${span}`,
    });
  };
  const seg = rangeControl("range:book", "3M", (r) => { range = r; draw(); });
  const modeSeg = mkt ? h("div", { class: "seg", role: "group", "aria-label": "Show" },
    [["value", "Value"], ["market", "vs market"]].map(([v, l]) => h("button", {
      type: "button", class: "seg-btn", "aria-pressed": String(ui("book:mode", "value") === v),
      onclick: (e) => {
        for (const x of e.currentTarget.parentNode.children) x.setAttribute("aria-pressed", String(x === e.currentTarget));
        setUi("book:mode", v, true); draw();
      },
    }, l))) : null;
  const sec = section("brief book",
    kicker(`Your book on ${longDay(state.summary.as_of)}`),
    h("h2", { class: "headline", text: headline }),
    h("div", { class: "hero" }, h("span", { class: "hero-val", text: money(b.value) }), ch ? delta(ch.pct, "chip") : null,
      mch("1d") != null ? h("span", { class: "hero-mkt", text: `market ${pct(mch("1d"))}` }) : null),
    periods.length ? h("ul", { class: "periods" }, periods) : null,
    b.pnl != null ? h("p", { class: "muted" }, `Unrealised P&L ${smoney(b.pnl)} on cost ${money(b.cost)}`) : null,
    h("div", { class: "filters" }, seg, modeSeg),
    chartBox,
    h("p", { class: "note" }, `${int(b.count)} holdings, ${int(b.units)} units, valued at today's quantities and each day's mid price, net of the 1% sell fee.`),
    movers(b),
  );
  queueMicrotask(draw);
  return sec;
}

// ------------------------------------------------------------------ market
function marketGroup(name) {
  const m = state.summary.market;
  return (m && (m.groups || []).find((g) => g.name === name)) || null;
}
function indexOn(g, iso) {
  const k = Math.round((toDate(iso) - toDate(g.d0)) / DAY);
  return k >= 0 && k < g.values.length ? g.values[k] : null;
}
function marketBrief() {
  const m = state.summary.market;
  if (!m || !m.groups || !m.groups.length) return null;
  const all = marketGroup("All holos") || m.groups[0];
  const c = all.change["1d"];
  const headline = c == null ? "Market" : Math.abs(c) < 0.0005 ? "Holo prices held steady overnight"
    : `Holo prices ${c < 0 ? "fell" : "rose"} ${(Math.abs(c) * 100).toFixed(1)}% overnight`;
  const row = (g) => h("div", { class: `mkt-row${g === all ? " all" : ""}`, role: "listitem" },
    h("span", { class: "mkt-name" }, h("b", { text: g.name }), h("span", { class: "muted", text: ` ${g.n}` })),
    h("span", { class: "mkt-c" }, delta(g.change["1d"])),
    h("span", { class: "mkt-c" }, delta(g.change["30d"], "", 0)),
    h("span", { class: "mkt-c" }, delta(g.change["90d"], "", 0)),
    h("span", { class: "mkt-spark", title: "Last 90 days" }, sparkline(g.values.slice(-90), "var(--s-market)")));
  const holos = state.series ? (moverRows(1) || []).filter((r) => inScope(r, "holos")) : [];
  const split = askBidLine(breadth(holos));
  return section("brief market",
    kicker("Market, equal-weight"),
    h("h2", { class: "headline", text: headline }),
    split ? h("p", { class: "mkt-split", text: split }) : null,
    h("div", { class: "mkt-rows", role: "list" },
      h("div", { class: "mkt-row head", "aria-hidden": "true" }, h("span"), h("span", { text: "1 day" }),
        h("span", { text: "30 days" }), h("span", { text: "90 days" }), h("span")),
      m.groups.map(row)),
    h("p", { class: "note", text: "Each index averages the daily change in mid price (halfway between ask and bid) of every tracked sticker in it, so cheap and expensive stickers count the same." }));
}

function movers(b) {
  const ps = b.positions.filter((p) => p.dmark1d != null && Math.abs(p.dmark1d) >= 0.5)
    .sort((x, y) => Math.abs(y.dmark1d) - Math.abs(x.dmark1d)).slice(0, 5);
  if (!ps.length) return null;
  return h("div", { class: "movers" },
    h("h3", { class: "h3", text: "Biggest moves overnight" }),
    h("div", { class: "rows" }, ps.map((p) => h("button", { type: "button", class: "row mover-row", onclick: () => openSticker(p.mhn) },
      h("span", { class: "c-name" }, nameBlock(p.mhn)),
      h("span", { class: "c-imp" }, h("b", { class: `delta ${dcls(p.dmark1d)}`, text: smoney(p.dmark1d) }),
        h("span", { class: "sub" }, `mid ${pct(p.dmid1d)}, ${int(p.units)} units`))))));
}

// ------------------------------------------------------------------ market movers
// Computed here from series.json, so every tracked item counts: the agent's set
// and the watch list. Price moves use the ask (lowest listing), like the rest of
// the app's per-sticker changes; the averages also report bids, because the
// market index and your book are valued halfway between the two.
const MV_METRICS = [["losers", "Losers"], ["gainers", "Gainers"], ["ldown", "Listings ↓"], ["lup", "Listings ↑"]];
const MV_PERIODS = [["1D", 1], ["7D", 7], ["30D", 30], ["90D", 90]];
const MV_SPARK = { 1: 30, 7: 30, 30: 90, 90: 180 };   // days of context in each row's sparkline
const MV_MIN_LISTINGS = 20;                         // listings moves need this many at the start
const MV_PAGE = 50;
let moversViaLink = false;                          // came from Today, so "Today" goes back
let mvCache = null;

const goodBid = (b, a) => (b > 0 && a > 0 && b <= a ? b : null);
const effBid = (b, a) => goodBid(b, a) ?? a * 0.96;   // export_dashboard's fallback for the mid price
const isPriceMetric = (m) => m === "losers" || m === "gainers";

function scopeOf(mhn) {
  const p = nameParts(mhn);
  if (String(mhn).startsWith("Sticker |")) return p.variant === "Holo" ? `holo:${p.event}` : "other";
  return /Capsule/.test(mhn) ? "other" : "agents";
}
const inScope = (r, scope) => (scope === "holos" ? r.scope.startsWith("holo:") : r.scope === scope);

// Every item with a price on the series' last day and `days` before it.
function moverRows(days) {
  const se = state.series;
  if (!se) return null;
  const key = `${se.as_of}|${state.summary && state.summary.generated_at}|${days}`;
  if (mvCache && mvCache.key === key) return mvCache.rows;
  const end = +toDate(se.as_of);
  const own = new Map(((state.summary && state.summary.book && state.summary.book.positions) || []).map((p) => [p.mhn, p.units]));
  const rows = [];
  for (const it of se.items) {
    const k = Math.round((end - +toDate(it.d0)) / DAY), j = k - days;
    if (k >= it.ask.length || j < 0) continue;
    const a1 = it.ask[k], a0 = it.ask[j], s1 = it.stock[k], s0 = it.stock[j];
    const priced = a1 > 0 && a0 > 0;
    const b1 = priced ? goodBid(it.bid[k], a1) : null, b0 = priced ? goodBid(it.bid[j], a0) : null;
    rows.push({
      mhn: it.mhn, scope: scopeOf(it.mhn), own: own.get(it.mhn) || null,
      a0, a1, da: priced ? a1 / a0 - 1 : null,
      b0, b1, db: b0 && b1 ? b1 / b0 - 1 : null,
      lask: priced ? Math.log(a1 / a0) : null,
      lbid: priced ? Math.log(effBid(it.bid[k], a1) / effBid(it.bid[j], a0)) : null,
      s0, s1, ds: s0 > 0 && s1 != null ? s1 / s0 - 1 : null, dsn: s0 != null && s1 != null ? s1 - s0 : null,
    });
  }
  mvCache = { key, rows };
  return rows;
}

// How many fell and rose, and the equal-weight average change of asks and bids.
function breadth(rows) {
  let n = 0, down = 0, up = 0, sa = 0, sb = 0, ls = 0, l0 = 0, l1 = 0, ldown = 0, lup = 0;
  for (const r of rows) {
    if (r.s0 > 0 && r.s1 != null) { ls++; l0 += r.s0; l1 += r.s1; if (r.s1 < r.s0) ldown++; else if (r.s1 > r.s0) lup++; }
    if (r.da == null) continue;
    n++;
    const shown = roundTo(r.da, 1);              // as displayed: "−0.0%" counts as unchanged
    if (shown < 0) down++; else if (shown > 0) up++;
    sa += r.lask; sb += r.lbid;
  }
  return { n, down, up, flat: n - down - up, ask: n ? Math.exp(sa / n) - 1 : null, bid: n ? Math.exp(sb / n) - 1 : null,
    listed: ls, ldown, lup, lchange: l0 > 0 ? l1 / l0 - 1 : null };
}
function moved(p) {   // "fell 1.8%", "rose 0.4%", "were flat"
  const r = roundTo(p, 1);
  if (r == null) return "—";
  return Math.abs(r) < 1e-9 ? "were flat" : `${r < 0 ? "fell" : "rose"} ${(Math.abs(p) * 100).toFixed(1)}%`;
}
const askBidLine = (b) => (b && b.n ? `On average, asks ${moved(b.ask)} and bids ${moved(b.bid)}.` : null);
// "124 of 193 holos fell, 11 rose and 58 didn't move" / "103 of your 125 holos fell, ..."
function countLine(b, noun, owned) {
  const parts = [`${int(b.down)} of ${owned ? "your " : ""}${int(b.n)} ${noun} fell`, `${int(b.up)} rose`];
  if (b.flat) parts.push(`${int(b.flat)} didn't move`);
  return parts.length === 3 ? `${parts[0]}, ${parts[1]} and ${parts[2]}` : `${parts[0]} and ${parts[1]}`;
}
function emptyMovers(metric, noun, owned) {
  const who = owned ? `your ${noun}` : noun;
  return {
    losers: owned ? `None of your ${noun} fell.` : `No ${noun} fell.`,
    gainers: owned ? `None of your ${noun} rose.` : `No ${noun} rose.`,
    ldown: `No drops in listings among ${who} with at least ${MV_MIN_LISTINGS} listings.`,
    lup: `No rises in listings among ${who} with at least ${MV_MIN_LISTINGS} listings.`,
  }[metric];
}

function rankMovers(rows, metric) {
  const val = isPriceMetric(metric) ? (r) => r.da : (r) => (r.s0 >= MV_MIN_LISTINGS ? r.ds : null);
  const down = metric === "losers" || metric === "ldown";
  return rows.filter((r) => { const v = roundTo(val(r), 1); return v != null && (down ? v < 0 : v > 0); })
    .sort((x, y) => (down ? val(x) - val(y) : val(y) - val(x)) || (x.mhn < y.mhn ? -1 : 1));
}

function ownMark(units) { return units ? h("span", { class: "own", title: `You own ${units}` }, ` ★ ${units}`) : null; }
function moverRow(r, metric, i, days, full) {
  const px = isPriceMetric(metric);
  const main = px
    ? h("span", { class: "c-main" }, h("b", { class: `delta ${dcls(roundTo(r.da, 1))}`, text: pct(r.da) }),
      h("span", { class: "sub", text: `${price(r.a0)} → ${price(r.a1)}` }))
    : h("span", { class: "c-main" }, h("b", { class: "delta nd", text: pct(r.ds) }),
      h("span", { class: "sub", text: `${int(r.s0)} → ${int(r.s1)}` }));
  // the other side of the move: bid and listings for a price move, ask and bid for a listings move
  const facts = !full ? null : h("span", { class: "c-facts" }, px
    ? [r.db != null ? pair("Bid", delta(r.db)) : null,
      pair("Listings", h("span", null, h("b", { text: int(r.s1) }), " ", r.ds != null ? ndelta(r.ds, 1) : null))]
    : [pair("Ask", h("span", null, h("b", { text: price(r.a1) }), " ", r.da != null ? delta(r.da) : null)),
      r.db != null ? pair("Bid", delta(r.db)) : null]);
  const sp = MV_SPARK[days] || 30;
  // reading order: rank, name, the move, the rest (the grid places them)
  return h("button", { type: "button", class: `row mv-row ${full ? "full" : "brief"}`, role: "listitem",
    onclick: () => openSticker(r.mhn) },
    full ? h("span", { class: "c-rank", text: String(i + 1) }) : null,
    h("span", { class: "c-name" }, nameBlock(r.mhn, ownMark(r.own))),
    main,
    facts,
    h("span", { class: "c-spark", title: `${px ? "Ask price" : "Listings"}, last ${sp} days` },
      spark(r.mhn, px ? "ask" : "stock", sp, px ? "var(--s-price)" : "var(--s-list)")));
}
function segControl(label, options, cur, onPick) {
  const wrap = h("div", { class: "seg", role: "group", "aria-label": label });
  for (const [v, l] of options) {
    wrap.appendChild(h("button", { type: "button", class: "seg-btn", "aria-pressed": String(v === cur),
      onclick: (e) => {
        for (const b of wrap.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        onPick(v);
      } }, l));
  }
  return wrap;
}

// Today: overnight movers across all holos.
function moversBrief() {
  const kick = kicker("Movers overnight, all holos");
  if (!state.series) return section("brief movers", kick, emptyNote("Loading prices…"));
  const rows = (moverRows(1) || []).filter((r) => inScope(r, "holos"));
  const b = breadth(rows);
  if (!b.n) return null;
  let metric = ui("mv:brief", "losers");
  if (!MV_METRICS.slice(0, 3).some(([v]) => v === metric)) metric = "losers";
  const list = h("div", { class: "rows mv-rows", role: "list" });
  const draw = (m) => {
    const top = rankMovers(rows, m).slice(0, 5);
    list.replaceChildren(...(top.length ? top.map((r, i) => moverRow(r, m, i, 1, false)) : [emptyNote(emptyMovers(m, "holos"))]));
  };
  draw(metric);
  const mk = state.summary.market;
  const noIndex = !mk || !mk.groups || !mk.groups.length;   // the market card shows this line when it's there
  return section("brief movers", kick,
    h("h2", { class: "headline", text: `${int(b.down)} of ${int(b.n)} holos fell, ${int(b.up)} rose` }),
    noIndex ? h("p", { class: "mkt-split", text: askBidLine(b) }) : null,
    h("div", { class: "filters" }, segControl("Show", MV_METRICS.slice(0, 3), metric, (v) => { metric = v; setUi("mv:brief", v, true); draw(v); })),
    list,
    h("a", { class: "more", href: "#/movers", onclick: () => {
      // open the full list on what this card shows: all holos, overnight, same ranking
      state.ui["scroll:today"] = window.scrollY;
      state.ui["scroll:movers"] = 0;
      Object.assign(state.ui, { "mv:metric": metric, "mv:period": "1D", "mv:scope": "holos", "mv:mine": false });
      moversViaLink = true;
    } }, "All movers"));
}

// The full page: any period, any group, only what you own.
function viewMovers() {
  const s = state.summary;
  const back = h("a", { class: "back-link", href: "#/today", onclick: (e) => {
    if (moversViaLink) { e.preventDefault(); history.back(); }
  } }, "← Today");
  const intro = (...kids) => section("intro", back, h("h1", { class: "title", text: "Movers" }), ...kids);
  if (!state.series) return h("div", { class: "view movers-view" }, intro(emptyNote("Loading prices…")));

  // groups in the data: all holos, each Major (in the market table's order), agents, the rest
  const all = moverRows(1) || [];
  const count = (sc) => all.filter((r) => inScope(r, sc)).length;
  const order = ((s.market && s.market.groups) || []).map((g) => g.name);
  const rank = (e) => { const i = order.indexOf(e); return i < 0 ? 99 : i; };
  const year = (e) => +((e.match(/(\d{4})\s*$/) || [])[1] || 0);
  const events = [...new Set(all.filter((r) => r.scope.startsWith("holo:")).map((r) => r.scope.slice(5)))]
    .sort((x, y) => year(x) - year(y) || rank(x) - rank(y) || (x < y ? -1 : 1));   // oldest Major first
  const scopes = [["holos", "All holos"], ...events.map((e) => [`holo:${e}`, `${e} holos`])];
  if (count("agents")) scopes.push(["agents", "Agents"]);
  if (count("other")) scopes.push(["other", "Other stickers and capsules"]);
  const nounFor = (sc) => ({ holos: "holos", agents: "agents", other: "other items" }[sc] || `${sc.slice(5)} holos`);

  let metric = ui("mv:metric", "losers"), per = ui("mv:period", "1D"), scope = ui("mv:scope", "holos"), mine = ui("mv:mine", false);
  if (!MV_METRICS.some(([v]) => v === metric)) metric = "losers";
  if (!MV_PERIODS.some(([v]) => v === per)) per = "1D";
  if (!scopes.some(([v]) => v === scope)) scope = "holos";

  const lede = h("p", { class: "lede mv-lede", "aria-live": "polite" });
  const note = h("p", { class: "note" });
  const list = h("div", { class: "rows mv-rows", role: "list" });
  const more = h("div");
  const PHRASE = { 1: "Since yesterday", 7: "Over the past week", 30: "Over the past 30 days", 90: "Over the past 90 days" };

  const draw = () => {
    const days = MV_PERIODS.find(([v]) => v === per)[1];
    const rows = (moverRows(days) || []).filter((r) => inScope(r, scope) && (!mine || r.own));
    const noun = nounFor(scope);
    list.replaceChildren(); more.replaceChildren(); note.textContent = "";
    if (!rows.length) {
      const lens = state.series.items.filter((it) => inScope({ scope: scopeOf(it.mhn) }, scope)).map((it) => it.ask.length);
      const longest = lens.length ? Math.max(...lens) : 0;
      lede.textContent = mine && !all.some((r) => inScope(r, scope) && r.own) ? `You don't own any ${noun}.`
        : longest && longest <= days ? `Not enough history for this period yet: these have been recorded for ${int(longest)} ${longest === 1 ? "day" : "days"}.`
          : "Nothing to compare over this period.";
      return;
    }
    const b = breadth(rows);
    const lines = [`${PHRASE[days]}, ${countLine(b, noun, mine)}.`, askBidLine(b)];
    if (!isPriceMetric(metric) && b.listed)
      lines.push(`Listings fell on ${int(b.ldown)} and rose on ${int(b.lup)}; in total they ${moved(b.lchange)}.`);
    lede.textContent = lines.filter(Boolean).join(" ");
    const ranked = rankMovers(rows, metric);
    const show = (n) => {
      list.replaceChildren(...(ranked.length ? ranked.slice(0, n).map((r, i) => moverRow(r, metric, i, days, true))
        : [emptyNote(emptyMovers(metric, noun, mine))]));
      more.replaceChildren(ranked.length > n ? h("button", { type: "button", class: "more", onclick: () => show(ranked.length) },
        `Show all ${int(ranked.length)}`) : "");
    };
    show(MV_PAGE);
    note.textContent = isPriceMetric(metric)
      ? "Price is the lowest listing (ask). Tap a row for its chart."
      : `Counts items with at least ${MV_MIN_LISTINGS} listings at the start of the period. Tap a row for its chart.`;
  };

  const scopeSel = h("select", { class: "select", "aria-label": "Group", onchange: (e) => { scope = e.target.value; setUi("mv:scope", scope); draw(); } },
    scopes.map(([v, l]) => h("option", { value: v, selected: v === scope }, `${l} (${int(count(v))})`)));
  const own = h("label", { class: "toggle" },
    h("input", { type: "checkbox", checked: mine, onchange: (e) => { mine = e.target.checked; setUi("mv:mine", mine); draw(); } }),
    h("span", { text: "Only stickers I own" }));
  draw();
  return h("div", { class: "view movers-view" },
    intro(lede,
      h("div", { class: "filters" },
        segControl("Show", MV_METRICS, metric, (v) => { metric = v; setUi("mv:metric", v); draw(); }),
        segControl("Period", MV_PERIODS.map(([v]) => [v, v]), per, (v) => { per = v; setUi("mv:period", v); draw(); }),
        scopeSel, own),
      note),
    section("list", list, more));
}

function agentHeadline(a) {
  const al = (a.alerts || []).map(parseAlert);
  const n = (k) => al.filter((x) => x.kind === k).length;
  const bits = [];
  if (n("entry")) bits.push(`${n("entry")} ${n("entry") === 1 ? "entry" : "entries"}`);
  if (n("exit")) bits.push(`${n("exit")} exit ${n("exit") === 1 ? "watch" : "watches"}`);
  if (n("move")) bits.push(`${n("move")} big ${n("move") === 1 ? "move" : "moves"}`);
  if (a.alerts == null) return "Today's agent alerts arrive with the next nightly run";
  if (!bits.length) return "No alerts from the agent today";
  return "The agent flagged " + (bits.length > 1 ? bits.slice(0, -1).join(", ") + " and " + bits.at(-1) : bits[0]);
}
function modeText(a) {
  if (a.paused) return "paused";
  if (a.autopilot) return "autopilot";
  return a.mode || "";
}
function agentStats(a) {
  const pnlPct = a.bankroll ? a.pnl / a.bankroll : null;
  return h("div", { class: "stats" },
    stat("Equity", money(a.equity)),
    stat("P&L", smoney(a.pnl), pnlPct != null ? delta(pnlPct) : null),
    stat("Cash", a.equity ? pct(a.cash / a.equity, 0).replace("+", "") : "—", h("span", { class: "stat-sub", text: money(a.cash) })),
    stat("Positions", int((a.holdings || []).length), h("span", { class: "stat-sub", text: money(a.mark) })));
}
function equityChart(box, height) {
  const start = (state.summary.agent && state.summary.agent.start) || "";   // current paper book only
  const log = (state.summary.log || []).filter((r) => r.equity != null && r.date >= start);
  if (log.length < 2) { box.appendChild(emptyNote("The equity history builds up one point per nightly run.")); return; }
  timeChart(box, {
    dates: log.map((r) => r.date), height, fmt: money, tickFmt: (v) => "¥" + compact(v), connectGaps: true,
    series: [{ name: "Agent equity", values: log.map((r) => r.equity), color: "var(--s-agent)", kind: "line" }],
    label: "Agent equity per nightly run",
  });
}
function agentBrief(a) {
  if (!a) return section("brief agent", kicker("Agent"), emptyNote("No agent state found."));
  const box = h("div", { class: "chart-box" });
  queueMicrotask(() => equityChart(box, 110));
  const alerts = a.alerts || [];
  return section("brief agent",
    kicker(`Agent, day ${a.day ?? "?"}, ${modeText(a)}`),
    h("h2", { class: "headline", text: agentHeadline(a) }),
    agentStats(a),
    box,
    alerts.length ? h("div", { class: "alerts" }, alerts.slice(0, 4).map(alertRow)) : null,
    alerts.length > 4 ? h("a", { class: "more", href: "#/agent" }, `All ${alerts.length} alerts`) : null);
}

function catTiles(d, onPick) {
  return h("div", { class: "tiles" }, d.cells.map((c) => h("button", {
    type: "button", class: "tile", disabled: !c.n, onclick: () => onPick(c.cat),
    "aria-label": `${c.cat}: ${c.n} names. ${c.label}`,
  }, sig(c.cat, "lg"), h("span", { class: "tile-code", text: c.cat }), h("span", { class: "tile-n", text: c.n }),
     h("span", { class: "tile-label", text: catDesc(c.label) }))));
}
function changeRow(c) {
  return h("button", { type: "button", class: "change-row", onclick: () => openSticker(c.mhn) },
    h("span", { class: "change-sigs" }, sig(c.frm), h("span", { class: "arrow", "aria-hidden": "true", text: "→" }), sig(c.to)),
    nameBlock(c.mhn),
    h("span", { class: "change-codes" }, c.frm && c.to ? `${c.frm} to ${c.to}` : c.to ? `New in ${c.to}` : `Left ${c.frm}`));
}
function changesList(items, limit) {
  const box = h("div", { class: "changes" });
  const draw = (all) => {
    box.replaceChildren(...(all ? items : items.slice(0, limit)).map(changeRow));
    if (!all && items.length > limit)
      box.appendChild(h("button", { type: "button", class: "more", onclick: () => draw(true) }, `Show all ${items.length} changes`));
  };
  draw(false);
  return box;
}
function driftBrief(d) {
  if (!d) return null;
  const ch = d.changes || {};
  const n = ch.items ? ch.items.length : null;
  const headline = n == null ? `${d.items.length} names are drifting`
    : n === 0 ? `No category changes since ${longDay(ch.since)}`
      : `${n} ${n === 1 ? "name" : "names"} changed category since ${longDay(ch.since)}`;
  return section("brief drift",
    kicker(`Drift desk, ${d.items.length} names`),
    h("h2", { class: "headline", text: headline }),
    catTiles(d, (cat) => { setUi("drift:cat", cat); go("#/drift"); }),
    n ? changesList(ch.items, 6) : null,
    watchNote());
}
function watchNote() {
  const w = state.summary.watch;
  if (!w || !w.items || !w.items.length) return null;
  const parts = (w.groups || []).filter((g) => g.drifting).map((g) => `${groupLabel(g.name)} ${g.drifting} of ${g.n}`);
  return h("p", { class: "watch-note" },
    `Watching ${w.items.length} more outside the agent's set` + (parts.length ? `, drifting: ${parts.join(", ")}. ` : ". "),
    h("a", { href: "#/watch" }, "Open Watching"));
}
function pipelineNote(s) {
  const p = s.pipeline || {};
  const cat = p.catalog;
  return h("footer", { class: "pipeline" },
    h("p", null, `Exported ${new Date(s.generated_at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} from ${int(p.names)} tracked stickers.`),
    cat ? h("p", null, `Catalog refresh on ${fmtDay(toDate(cat.date))}: ${cat.ok === true ? "ok" : cat.ok === false ? "failed" : "skipped"}${cat.detail ? `, ${cat.detail}` : ""}.`) : null,
    p.stale && p.stale.length ? h("p", { class: "warn-text" }, `${p.stale.length} stickers have no price for the latest day.`) : null,
    p.run_url ? h("p", null, h("a", { href: p.run_url, target: "_blank", rel: "noopener" }, "Open the nightly run log")) : null);
}

// ------------------------------------------------------------------ Drift desk
function viewDrift() {
  const d = state.summary.drift;
  const cat = ui("drift:cat", "ALL");
  const ownedOnly = ui("drift:owned", false);
  const items = d.items.filter((x) => (cat === "ALL" || x.cat === cat) && (!ownedOnly || x.own));
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Category" },
    [{ cat: "ALL", n: d.items.length, label: "All categories" }, ...d.cells].map((c) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(cat === c.cat), disabled: !c.n,
      onclick: () => { setUi("drift:cat", c.cat); render(); },
    }, c.cat === "ALL" ? null : sig(c.cat), h("span", { text: c.cat === "ALL" ? "All" : c.cat }), h("span", { class: "chip-n", text: c.n }))));
  const own = h("label", { class: "toggle" },
    h("input", { type: "checkbox", checked: ownedOnly, onchange: (e) => { setUi("drift:owned", e.target.checked); render(); } }),
    h("span", { text: "Only stickers I own" }));
  const cell = d.cells.find((c) => c.cat === cat);
  const th = d.thresholds || { W: -0.05, M: -0.1, Q: -0.1 };
  const ch = d.changes || {};
  return h("div", { class: "view drift" },
    section("intro",
      h("h1", { class: "title", text: "Drift desk" }),
      h("p", { class: "lede" }, "Stickers whose listings are draining, compared with a week, a month and a quarter ago. ",
        h("span", { class: "legend-inline" }, sig("W"), ` week ≤ ${pct(th.W, 0)}`), " ",
        h("span", { class: "legend-inline" }, sig("M"), ` month ≤ ${pct(th.M, 0)}`), " ",
        h("span", { class: "legend-inline" }, sig("Q"), ` quarter ≤ ${pct(th.Q, 0)}`)),
      h("div", { class: "filters" }, chips, own),
      cell ? h("p", { class: "cat-note" }, sig(cell.cat, "lg"), h("span", null, h("b", { text: cell.cat }), `: listings down over the ${catDesc(cell.label)}`)) : null),
    ch.items && ch.items.length && cat === "ALL" && !ownedOnly ? h("details", { class: "band changes-box" },
      h("summary", null, `${ch.items.length} category changes since ${longDay(ch.since)}`),
      changesList(ch.items, 400)) : null,
    section("list",
      items.length ? h("div", { class: "rows drift-rows", role: "list" }, items.map(driftRow))
        : emptyNote(ownedOnly ? "None of your stickers are in this category." : "Nothing in this category today.")));
}
function driftRow(x) {
  const [s0, s1, , s3] = x.st, [p0, p1, , p3] = x.px;
  return h("button", { type: "button", class: "row drift-row", role: "listitem", onclick: () => openSticker(x.mhn) },
    h("span", { class: "c-sig" }, sig(x.cat)),
    h("span", { class: "c-name" }, nameBlock(x.mhn, x.own ? h("span", { class: "own", title: `You own ${x.own}` }, ` ★ ${x.own}`) : null),
      h("span", { class: "tags" }, h("span", { class: "tag", text: x.cat }), h("span", { class: `tag trend-${(x.tag || "").toLowerCase()}`, text: x.tag }))),
    h("span", { class: "c-list" }, h("span", { class: "k", text: "Listings" }), h("b", { text: int(s0) }),
      h("span", { class: "dd" }, pair("W", ndelta(x.dW)), pair("M", ndelta(x.dM)), pair("Q", ndelta(x.dQ)))),
    h("span", { class: "c-px" }, h("span", { class: "k", text: "Ask" }), h("b", { text: price(p0) }),
      h("span", { class: "dd" }, pair("1w", delta(p1 ? p0 / p1 - 1 : null, "", 0)), pair("1mo", delta(p3 ? p0 / p3 - 1 : null, "", 0)))),
    h("span", { class: "c-spark", title: "Listings, last 90 days" }, spark(x.mhn, "stock", 90, "var(--s-list)")),
  );
}

// ------------------------------------------------------------------ Watching
function groupLabel(g) {
  const [ev, v] = String(g).split(" · ");
  return v ? `${ev} ${v === "Holo" ? "holos" : v.toLowerCase()}` : ev;
}
const WATCH_SORTS = [["drift", "Drift category"], ["p7", "Price, 7 days"], ["p30", "Price, 30 days"], ["l30", "Listings, 30 days"], ["name", "Name"]];
function viewWatch() {
  const w = state.summary.watch;
  const intro = (...kids) => section("intro", h("h1", { class: "title", text: "Watching" }), ...kids);
  if (!w || !w.items || !w.items.length) {
    return h("div", { class: "view watch" }, intro(emptyNote(
      "Nothing here yet. Budapest 2025 and Cologne 2026 holos and agent skins appear after the first nightly run with the new tracking.")));
  }
  const groups = w.groups || [];
  let grp = ui("watch:group", "ALL");
  if (grp !== "ALL" && !groups.some((g) => g.name === grp)) grp = "ALL";
  const driftOnly = ui("watch:drifting", false);
  const sort = ui("watch:sort", "drift");
  let items = w.items.filter((x) => (grp === "ALL" || x.group === grp) && (!driftOnly || x.cat));
  const keyf = { p7: (x) => x.ch["7d"], p30: (x) => x.ch["30d"], l30: (x) => x.lch["30d"], name: (x) => x.mhn }[sort];
  if (keyf) {
    items = items.slice().sort((a, b) => {
      const x = keyf(a), y = keyf(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Group" },
    [{ name: "ALL", n: w.items.length }, ...groups].map((g) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(grp === g.name),
      onclick: () => { setUi("watch:group", g.name); render(); },
    }, h("span", { text: g.name === "ALL" ? "All" : groupLabel(g.name) }), h("span", { class: "chip-n", text: g.n }))));
  const drifting = h("label", { class: "toggle" },
    h("input", { type: "checkbox", checked: driftOnly, onchange: (e) => { setUi("watch:drifting", e.target.checked); render(); } }),
    h("span", { text: "Only drifting" }));
  const sortSel = h("select", { class: "select", "aria-label": "Sort by", onchange: (e) => { setUi("watch:sort", e.target.value, true); render(); } },
    WATCH_SORTS.map(([v, l]) => h("option", { value: v, selected: v === sort }, `Sort: ${l}`)));
  const list = (xs) => h("div", { class: "rows drift-rows", role: "list" }, xs.map(watchRow));
  let body;
  if (!items.length) body = emptyNote(driftOnly ? "Nothing in this group is drifting today." : "Nothing in this group yet.");
  else if (grp === "ALL" && sort === "drift") {
    body = groups.map((g) => {
      const xs = items.filter((x) => x.group === g.name);
      return xs.length ? h("div", { class: "watch-group" },
        h("h2", { class: "h2 group-head" }, h("span", { text: groupLabel(g.name) }),
          h("span", { class: "muted group-n", text: `${g.n} items${g.drifting ? `, ${g.drifting} drifting` : ""}` })),
        list(xs)) : null;
    });
  } else body = list(items);
  return h("div", { class: "view watch" },
    intro(h("p", { class: "lede" },
      "Recorded every night but not traded by the agent. Categories use the drift desk's rules on listings: ",
      h("span", { class: "legend-inline" }, sig("W"), " week"), " ",
      h("span", { class: "legend-inline" }, sig("M"), " month"), " ",
      h("span", { class: "legend-inline" }, sig("Q"), " quarter"),
      ` once an item has ${w.min_days || 95} days of history.`),
      h("div", { class: "filters" }, chips, drifting, sortSel)),
    section("list", body));
}
function watchRow(x) {
  const young = x.days < (state.summary.watch.min_days || 95);
  const hasDrift = x.dW != null;
  return h("button", { type: "button", class: "row drift-row", role: "listitem", onclick: () => openSticker(x.mhn) },
    h("span", { class: "c-sig" }, sig(x.cat)),
    h("span", { class: "c-name" }, nameBlock(x.mhn, x.own ? h("span", { class: "own", title: `You own ${x.own}` }, ` ★ ${x.own}`) : null),
      h("span", { class: "tags" },
        x.cat ? h("span", { class: "tag", text: x.cat }) : null,
        x.tag ? h("span", { class: `tag trend-${x.tag.toLowerCase()}`, text: x.tag }) : null,
        x.in_universe ? h("span", { class: "tag", text: "In the agent's set" }) : null,
        young ? h("span", { class: "tag new", text: x.days <= 1 ? `Recording since ${fmtDay(toDate(x.first))}` : `${x.days} days recorded` }) : null)),
    h("span", { class: "c-list" }, h("span", { class: "k", text: "Listings" }), h("b", { text: int(x.listings) }),
      h("span", { class: "dd" }, ...(hasDrift
        ? [pair("W", ndelta(x.dW)), pair("M", ndelta(x.dM)), pair("Q", ndelta(x.dQ))]
        : [pair("7d", ndelta(x.lch["7d"])), pair("30d", ndelta(x.lch["30d"]))]))),
    h("span", { class: "c-px" }, h("span", { class: "k", text: "Ask" }), h("b", { text: price(x.ask) }),
      h("span", { class: "dd" }, pair("1w", delta(x.ch["7d"], "", 0)), pair("1mo", delta(x.ch["30d"], "", 0)))),
    h("span", { class: "c-spark", title: "Listings, last 90 days" }, spark(x.mhn, "stock", 90, "var(--s-list)")),
  );
}

// ------------------------------------------------------------------ Book
function viewBook() {
  const b = state.summary.book;
  if (!b || !b.count) return h("div", { class: "view book" }, section("intro", h("h1", { class: "title", text: "Your book" }),
    emptyNote("No holdings yet. Add them to live/mybook.csv in your tracker repo as mhn,units[,basis].")));
  const sort = ui("book:sort", "value");
  const ev = ui("book:event", null);
  const byEvent = new Map();
  for (const p of b.positions) {
    const e = nameParts(p.mhn).event || "Other";
    const r = byEvent.get(e) || { name: e, value: 0, n: 0 };
    r.value += p.mark || 0; r.n += 1;
    byEvent.set(e, r);
  }
  const evRows = [...byEvent.values()].sort((a, c) => c.value - a.value);
  const key = { value: (p) => -(p.mark || 0), d1: (p) => p.ch["1d"] ?? 0, d7: (p) => p.ch["7d"] ?? 0, d30: (p) => p.ch["30d"] ?? 0, name: (p) => p.mhn }[sort];
  const rows = b.positions.filter((p) => !ev || nameParts(p.mhn).event === ev)
    .sort((a, c) => { const x = key(a), y = key(c); return x < y ? -1 : x > y ? 1 : 0; });
  const total = b.value || 0;

  const evBox = h("div", { class: "event-bars" });
  barList(evBox, evRows.map((r) => ({
    name: r.name, value: r.value, sub: `${pct(r.value / total, 0).replace("+", "")} of book, ${r.n} stickers`,
    onClick: () => { setUi("book:event", ev === r.name ? null : r.name); render(); },
  })), { fmt: money, color: "var(--s-book)", label: "Book value by Major" });

  const search = h("input", { type: "search", class: "search", placeholder: "Find a team or Major", value: ui("book:q", ""), "aria-label": "Find a team or Major",
    oninput: (e) => { setUi("book:q", e.target.value); drawRows(); } });
  const sortSel = h("select", { class: "select", "aria-label": "Sort by", onchange: (e) => { setUi("book:sort", e.target.value, true); render(); } },
    [["value", "Value"], ["d1", "Today's change"], ["d7", "7-day change"], ["d30", "30-day change"], ["name", "Name"]]
      .map(([v, l]) => h("option", { value: v, selected: v === sort }, `Sort: ${l}`)));
  const list = h("div", { class: "rows book-rows", role: "list" });
  const drawRows = () => {
    const qq = (ui("book:q", "") || "").toLowerCase();
    const shown = rows.filter((p) => !qq || p.mhn.toLowerCase().includes(qq));
    list.replaceChildren(...(shown.length ? shown.map((p) => bookRow(p, total)) : [emptyNote("No holdings match.")]));
  };
  drawRows();
  const ch = b.change["1d"];
  return h("div", { class: "view book" },
    section("intro",
      h("h1", { class: "title", text: "Your book" }),
      h("div", { class: "hero" }, h("span", { class: "hero-val", text: money(b.value) }), ch ? delta(ch.pct, "chip") : null),
      h("p", { class: "muted" }, `${int(b.count)} stickers, ${int(b.units)} units. Mid price, net of the 1% sell fee.`),
      b.unmatched && b.unmatched.length ? h("p", { class: "warn-text" }, `${b.unmatched.length} names in mybook.csv aren't tracked: ${b.unmatched.join("; ")}`) : null),
    section("by-event", h("h2", { class: "h2", text: "By Major" }), evBox,
      ev ? h("button", { type: "button", class: "linkish", onclick: () => { setUi("book:event", null); render(); } }, `Showing ${ev} only. Show all`) : null),
    section("list", h("div", { class: "filters" }, search, sortSel), list));
}
function bookRow(p, total) {
  return h("button", { type: "button", class: "row book-row", role: "listitem", onclick: () => openSticker(p.mhn) },
    h("span", { class: "c-name" }, nameBlock(p.mhn), p.cat ? h("span", { class: "tags" }, sig(p.cat), h("span", { class: "tag", text: p.cat })) : null),
    h("span", { class: "c-units" }, h("span", { class: "k", text: "Ask" }), h("b", { text: price(p.ask) })),
    h("span", { class: "c-val" }, h("span", { class: "k", text: "Value" }), h("b", { text: money(p.mark) }),
      h("span", { class: "sub", text: `${int(p.units)} units, ${pct((p.mark || 0) / total, 1).replace("+", "")}` })),
    h("span", { class: "c-ch" }, pair("1d", delta(p.ch["1d"])), pair("7d", delta(p.ch["7d"])), pair("30d", delta(p.ch["30d"], "", 0))),
    h("span", { class: "c-spark", title: "Ask price, last 30 days" }, spark(p.mhn, "ask", 30, "var(--s-price)")));
}

// ------------------------------------------------------------------ Agent
function viewAgent() {
  const a = state.summary.agent;
  if (!a) return h("div", { class: "view agent" }, section("intro", h("h1", { class: "title", text: "Agent" }), emptyNote("No agent state found.")));
  const box = h("div", { class: "chart-box" });
  queueMicrotask(() => equityChart(box, 190));
  const side = ui("agent:side", "ALL");
  const intents = a.intents || [];
  const shown = intents.filter((x) => side === "ALL" || x.side === side);
  const top = intents.filter((x) => x.opinion);
  const sideSeg = h("div", { class: "seg", role: "group", "aria-label": "Side" },
    [["ALL", "All"], ["BUY", "Buys"], ["SELL", "Sells"]].map(([v, l]) => h("button", {
      type: "button", class: "seg-btn", "aria-pressed": String(side === v), onclick: () => { setUi("agent:side", v); render(); },
    }, `${l} ${v === "ALL" ? intents.length : intents.filter((x) => x.side === v).length}`)));
  return h("div", { class: "view agent" },
    section("intro",
      h("h1", { class: "title", text: "Agent" }),
      h("p", { class: "lede" }, `${a.start ? `Running since ${fmtDay(toDate(a.start))}, day` : "Day"} ${a.day ?? "?"}, ${modeText(a)}.`
        + (a.source === "ledger" ? " Rebuilt from the ledger; alerts arrive with the next nightly run." : "")
        + ` Started with ${money(a.bankroll)}.`),
      agentStats(a), box,
      a.flip_note ? h("p", { class: "warn-text", text: a.flip_note.replace(/\*/g, "").trim() }) : null),
    section("alerts-sec", h("h2", { class: "h2", text: agentHeadline(a) }),
      (a.alerts || []).length ? h("div", { class: "alerts" }, a.alerts.map(alertRow)) : null),
    section("intents-sec",
      h("h2", { class: "h2" }, `${intents.length} intents, buys worth ${money(a.intents_buy_value)}`),
      top.length ? h("div", { class: "top-intents" }, top.map(intentCard)) : null,
      h("div", { class: "filters" }, sideSeg),
      shown.length ? intentTable(shown) : emptyNote("No intents on this side today.")),
    section("holdings-sec", h("h2", { class: "h2" }, `Paper book, ${int((a.holdings || []).length)} positions`),
      (a.holdings || []).length ? holdingsTable(a.holdings) : emptyNote("The paper book is empty.")),
    a.message ? h("details", { class: "band raw" }, h("summary", null, "Original Discord message"),
      h("pre", { text: a.message.replace(/\*\*/g, "") })) : null);
}
function intentCard(x) {
  return h("button", { type: "button", class: "intent-card", onclick: () => openSticker(x.mhn) },
    h("span", { class: `side ${x.side.toLowerCase()}`, text: x.side === "BUY" ? "Buy" : "Sell" }),
    h("span", { class: "ic-main" }, h("b", null, `${int(x.units)} × `), nameBlock(x.mhn)),
    h("span", { class: "ic-px" }, `at ~${price(x.px)}, ${money(x.units * x.px)}, ${x.state.toLowerCase()}`),
    h("ul", { class: "facts" }, (parseLD(x.opinion) || []).map((t) => h("li", { text: t }))));
}
function table(head, rows, cls) {
  return h("div", { class: "table-wrap" }, h("table", { class: `tbl ${cls || ""}` },
    h("thead", null, h("tr", null, head.map(([t, c]) => h("th", { class: c || null, scope: "col", text: t })))),
    h("tbody", null, rows)));
}
function intentTable(items) {
  return table([["Side"], ["Sticker"], ["Units", "num"], ["Price", "num"], ["Value", "num"], ["Type"]],
    items.map((x) => h("tr", { tabindex: 0, class: "tappable", onclick: () => openSticker(x.mhn), onkeydown: (e) => { if (e.key === "Enter") openSticker(x.mhn); } },
      h("td", null, h("span", { class: `side ${x.side.toLowerCase()}`, text: x.side === "BUY" ? "Buy" : "Sell" })),
      h("td", { text: shortName(x.mhn) }), h("td", { class: "num", text: int(x.units) }),
      h("td", { class: "num", text: price(x.px) }), h("td", { class: "num", text: money(x.units * x.px) }),
      h("td", { text: x.state.toLowerCase() }))), "intents");
}
function holdingsTable(hs) {
  return table([["Sticker"], ["Units", "num"], ["Mark", "num"]],
    hs.map((x) => h("tr", { tabindex: 0, class: "tappable", onclick: () => openSticker(x.mhn), onkeydown: (e) => { if (e.key === "Enter") openSticker(x.mhn); } },
      h("td", { text: shortName(x.mhn) }), h("td", { class: "num", text: int(x.units) }), h("td", { class: "num", text: money(x.mark) }))));
}

// ------------------------------------------------------------------ sheets
function renderSheet(sheet) {
  const root = $("#sheet-root");
  const open = !!sheet && !!cfg.token;
  if (!open) {
    if (root.childNodes.length) {
      root.replaceChildren();
      document.body.classList.remove("sheet-open");
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }
    return;
  }
  if (!root.childNodes.length) lastFocus = document.activeElement;
  let content, label;
  if (sheet.type === "settings") { content = viewSettings(); label = "Settings"; }
  else {
    if (!state.summary) return;
    content = viewSticker(sheet.mhn); label = shortName(sheet.mhn);
  }
  const panel = h("div", { class: `sheet ${sheet.type}`, role: "dialog", "aria-modal": "true", "aria-label": label, tabindex: "-1" },
    h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "Close", onclick: closeSheet }, navIcon("M6 6l12 12M18 6L6 18")),
    content);
  root.replaceChildren(h("div", { class: "scrim", onclick: closeSheet }), panel);
  document.body.classList.add("sheet-open");
  panel.focus({ preventScroll: true });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#sheet-root").childNodes.length) closeSheet(); });

function viewSticker(mhn) {
  const s = state.summary;
  const p = nameParts(mhn);
  const drift = s.drift.items.find((x) => x.mhn === mhn)
    || ((s.watch && s.watch.items) || []).find((x) => x.mhn === mhn && x.cat);
  const watched = ((s.watch && s.watch.items) || []).find((x) => x.mhn === mhn && !x.in_universe);
  const pos = s.book.positions.find((x) => x.mhn === mhn);
  const a = s.agent || {};
  const held = (a.holdings || []).find((x) => x.mhn === mhn);
  const intents = (a.intents || []).filter((x) => x.mhn === mhn);
  const alerts = (a.alerts || []).filter((t) => parseAlert(t).mhn === mhn);
  const full = seriesFor(mhn, null);
  const lastOf = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return [arr[i], i]; return [null, -1]; };
  const back = (arr, i, k) => (i - k >= 0 ? arr[i - k] : null);
  const ratio = (a1, b1) => (a1 != null && b1 ? a1 / b1 - 1 : null);

  const head = h("header", { class: "st-head" },
    h("h2", { class: "st-title", text: p.team + (p.variant && p.variant !== "Holo" ? ` (${p.variant})` : "") }),
    h("p", { class: "st-sub" }, h("span", { text: p.event }), p.variant ? h("span", { text: `${p.variant} sticker` }) : null),
    h("div", { class: "tags" },
      drift ? h("span", { class: "tag strong" }, sig(drift.cat), ` ${drift.cat}`) : h("span", { class: "tag", text: "No drift category" }),
      drift && drift.tag ? h("span", { class: `tag trend-${drift.tag.toLowerCase()}`, text: drift.tag }) : null,
      watched ? h("span", { class: "tag", text: "Watching, not traded by the agent" }) : null,
      pos ? h("span", { class: "tag own" }, `★ You own ${int(pos.units)}`) : null,
      held ? h("span", { class: "tag" }, `Agent holds ${int(held.units)}`) : null));

  if (!full) {
    return h("div", { class: "st" }, head,
      emptyNote(state.series ? "No price history for this sticker in the export." : "Loading price history…"));
  }
  const [ask, ia] = lastOf(full.ask);
  const [stk, is] = lastOf(full.stock);
  const bid = ia >= 0 ? full.bid[ia] : null;
  const stats = h("div", { class: "stats st-stats" },
    stat("Ask", price(ask), h("span", { class: "dd" },
      ...[["1d", 1], ["7d", 7], ["30d", 30], ["90d", 90]].map(([l, k]) => pair(l, delta(ratio(ask, back(full.ask, ia, k))))))),
    stat("Bid", price(bid > 0 && bid <= ask ? bid : null), ask && bid > 0 && bid <= ask ? h("span", { class: "stat-sub" }, `spread ${pct(1 - bid / ask, 1).replace("+", "")}`) : null),
    stat("Listings", int(stk), h("span", { class: "dd" },
      ...[["7d", 7], ["30d", 30], ["90d", 90]].map(([l, k]) => pair(l, ndelta(ratio(stk, back(full.stock, is, k))))))),
    pos ? stat("Your value", money(pos.mark), h("span", { class: "stat-sub" }, `${int(pos.units)} units at mid ${price(pos.mid)}`)) : null);

  const charts = h("div", { class: "st-charts" });
  const tableBox = h("div", { class: "st-table" });
  let showTable = false;
  const toggle = h("button", { type: "button", class: "linkish", onclick: () => { showTable = !showTable; drawTable(); } }, "Show as table");
  let cur = null;
  const draw = (r) => {
    charts.replaceChildren();
    const ss = seriesFor(mhn, RANGES[r]);
    cur = ss;
    const g = crosshairGroup();
    const lo = ss.bid.map((b, i) => (b > 0 && ss.ask[i] != null && b <= ss.ask[i] ? b : null));
    const hi = ss.ask.map((v, i) => (lo[i] != null ? v : null));
    timeChart(charts, { dates: ss.dates, height: 170, fmt: price, tickFmt: numTick, group: g,
      series: [{ name: "Ask", values: ss.ask, color: "var(--s-price)", kind: "line", band: { lo, hi, name: "Bid" } }],
      label: `Ask price with bid-ask range, ${r}` });
    timeChart(charts, { dates: ss.dates, height: 120, fmt: int, tickFmt: numTick, group: g,
      series: [{ name: "Listings", values: ss.stock, color: "var(--s-list)", kind: "line" }],
      label: `Listings on sale, ${r}` });
    drawTable();
  };
  const drawTable = () => {
    toggle.textContent = showTable ? "Hide table" : "Show as table";
    tableBox.replaceChildren();
    if (!showTable || !cur) return;
    const rows = [];
    for (let i = cur.dates.length - 1; i >= 0 && rows.length < 120; i--) {
      rows.push(h("tr", null, h("td", { text: fmtDay(toDate(cur.dates[i])) }), h("td", { class: "num", text: price(cur.ask[i]) }),
        h("td", { class: "num", text: price(cur.bid[i]) }), h("td", { class: "num", text: int(cur.stock[i]) })));
    }
    tableBox.appendChild(table([["Day"], ["Ask", "num"], ["Bid", "num"], ["Listings", "num"]], rows));
  };
  const seg = rangeControl("range:st", "3M", draw, ["1M", "3M", "1Y", "All"]);
  queueMicrotask(() => draw(ui("range:st", "3M")));

  const agentBits = [];
  for (const x of intents) agentBits.push(h("p", null, h("span", { class: `side ${x.side.toLowerCase()}`, text: x.side === "BUY" ? "Buy" : "Sell" }),
    ` ${int(x.units)} at ~${price(x.px)} (${x.state.toLowerCase()}) in today's intents`));
  if (held) agentBits.push(h("p", null, `Paper book holds ${int(held.units)} units, marked at ${money(held.mark)}.`));
  const driftBits = drift ? h("div", { class: "st-drift" },
    drift.st && drift.px ? table([[""], ["Now", "num"], ["1 week", "num"], ["2 weeks", "num"], ["1 month", "num"]], [
      h("tr", null, h("th", { scope: "row", text: "Listings" }), drift.st.map((v) => h("td", { class: "num", text: int(v) }))),
      h("tr", null, h("th", { scope: "row", text: "Ask" }), drift.px.map((v) => h("td", { class: "num", text: price(v) }))),
    ]) : null,
    h("p", { class: "muted" }, `Listings drift: week ${pct(drift.dW, 0)}, month ${pct(drift.dM, 0)}, quarter ${pct(drift.dQ, 0)}.`)) : null;

  return h("div", { class: "st" }, head, stats,
    h("div", { class: "filters" }, seg), charts, toggle, tableBox,
    alerts.length ? h("section", { class: "st-sec" }, h("h3", { class: "h3", text: "Agent alerts" }), h("div", { class: "alerts" }, alerts.map(alertRow))) : null,
    agentBits.length ? h("section", { class: "st-sec" }, h("h3", { class: "h3", text: "Agent" }), agentBits) : null,
    driftBits ? h("section", { class: "st-sec" }, h("h3", { class: "h3", text: "Drift snapshot" }), driftBits) : null);
}

// ------------------------------------------------------------------ phone push
// The nightly run's push_notify.py sends one loud push every morning; its
// settings (topic, delivery time) live in live/push.json in the tracker repo,
// which this reads with the same read-only token.
const NTFY = "https://ntfy.sh";
const NTFY_PLAY = "https://play.google.com/store/apps/details?id=io.heckel.ntfy";
const NTFY_IOS = "https://apps.apple.com/us/app/ntfy/id1625396347";
let pushCfg;   // undefined: not checked yet; null: the repo has none; {error}: couldn't check; else live/push.json

const appUrl = () => location.origin + location.pathname;

// The same text push_notify.py sends (kept in step with it by hand).
function pushText() {
  const rows = (moverRows(1) || []).filter((r) => inScope(r, "holos"));
  if (!rows.length) return null;
  const pc = (p, coarse) => {
    if (p == null) return "n/a";
    const r = roundTo(p, 1);
    if (r === 0) return "0%";
    return (r > 0 ? "+" : MINUS) + (Math.abs(p) * 100).toFixed(coarse && Math.abs(p) >= 0.095 ? 0 : 1) + "%";
  };
  const yen = (x) => (x == null ? "¥?" : x >= 100 ? "¥" + nf0.format(x) : "¥" + nf2.format(x));
  const cities = new Map();
  for (const r of rows) {
    const ev = nameParts(r.mhn).event, city = ev.replace(/\s+\S+$/, "");
    cities.set(city, (cities.get(city) || new Set()).add(ev));
  }
  const name = (r) => {
    const p = nameParts(r.mhn), city = p.event.replace(/\s+\S+$/, "");
    return `${p.team} (${cities.get(city).size <= 1 ? city : p.event})`;
  };
  const star = (r) => (r.own ? `, ★${r.own}` : "");
  const gain = rankMovers(rows, "gainers").slice(0, 5), drain = rankMovers(rows, "ldown").slice(0, 5);
  const lines = [
    "Top gainers:",
    ...(gain.length ? gain.map((r) => `${name(r)}: price ${pc(r.da)}, listings ${pc(r.ds, true)}${star(r)}`) : ["none today"]),
    "",
    "Top listings decreases:",
    ...(drain.length ? drain.map((r) => `${name(r)}: listings ${pc(r.ds, true)} (${int(r.s0)}→${int(r.s1)}), price ${pc(r.da)} ${yen(r.a1)}${star(r)}`)
      : ["none today"]),
  ];
  return { title: `Movers · ${longDay(state.summary.as_of)}`, message: lines.join("\n") };
}

async function sendPush(topic, { title, message }, loud) {
  const q = new URLSearchParams({ title, priority: loud ? "5" : "3", click: appUrl() + "#/movers" });
  const r = await fetch(`${NTFY}/${encodeURIComponent(topic)}?${q}`, { method: "POST", body: message });
  if (!r.ok) throw new Error(`ntfy answered HTTP ${r.status}`);
}

function pushSection() {
  const body = h("div");
  const sec = h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Phone notifications" }), body);
  const msg = h("p", { class: "form-msg", role: "status" });
  const isAndroid = /android/i.test(navigator.userAgent);
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => { msg.textContent = "Topic copied."; }, () => { msg.textContent = "Couldn't copy; select the topic and copy it."; });
  const test = async (topic) => {
    const t = state.series ? pushText() : null;
    msg.textContent = "Sending…";
    try {
      await sendPush(topic, t || { title: "StickerTracker test", message: "If you can read this on your phone, the morning push will arrive too." }, !!t);
      msg.textContent = t ? "Sent at full volume: this is today's push, the way it lands every morning." : "Sent. Check your phone.";
    } catch (e) { msg.textContent = e.message.startsWith("ntfy") ? e.message : "Couldn't reach ntfy.sh."; }
  };
  const draw = () => {
    if (pushCfg === undefined) { body.replaceChildren(h("p", { class: "muted", text: "Checking your tracker's push settings…" })); return; }
    if (pushCfg && pushCfg.error) {
      body.replaceChildren(h("p", { class: "muted" }, `Couldn't check your tracker's push settings (${pushCfg.error}). `,
        h("button", { type: "button", class: "linkish", onclick: () => { pushCfg = undefined; fetchCfg(); } }, "Try again")));
      return;
    }
    const topic = pushCfg && pushCfg.topic;
    if (topic) {
      const at = pushCfg.deliver_at || "06:00";
      const where = String(pushCfg.tz || "Europe/Warsaw").split("/").pop().replace(/_/g, " ");
      body.replaceChildren(
        h("p", { class: "muted" }, `Every morning at ${at} ${where} time, the nightly run sends one loud push: the top 5 gainers with what their listings did, and the top 5 listings decreases with what their price did. Tap it to open Movers.`),
        h("ol", { class: "steps" },
          h("li", null, "Install ntfy, a free notification app: ",
            h("a", { href: NTFY_PLAY, target: "_blank", rel: "noopener" }, "Google Play"), " or ",
            h("a", { href: NTFY_IOS, target: "_blank", rel: "noopener" }, "App Store"), "."),
          h("li", null, isAndroid ? "Subscribe to your tracker's topic: " : "In ntfy, tap + and subscribe to your tracker's topic: ",
            h("code", { class: "topic", text: topic }),
            h("div", { class: "row-btns" },
              isAndroid ? h("a", { class: "btn small", href: `ntfy://ntfy.sh/${encodeURIComponent(topic)}?display=Stickers` }, "Subscribe in ntfy") : null,
              h("button", { type: "button", class: "btn ghost small", onclick: () => copy(topic) }, "Copy topic"))),
          h("li", null, "Check it works: ",
            h("button", { type: "button", class: "btn ghost small", onclick: () => test(topic) }, "Send today's push now"))),
        msg);
      return;
    }
    // No settings file in the tracker repo: the older way, a topic made here plus an Actions secret.
    const own = cfg.ntfyTopic || "";
    const secretsUrl = cfg.repo ? `https://github.com/${cfg.repo}/settings/secrets/actions/new` : null;
    const genTopic = () => {
      const a = new Uint8Array(12); crypto.getRandomValues(a);
      saveCfg({ ntfyTopic: "stickers-" + Array.from(a, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("") });
      draw();
    };
    body.replaceChildren(
      h("p", { class: "muted" }, "The nightly run can send a push through ntfy, a free notification app, with a link back here."),
      h("ol", { class: "steps" },
        h("li", null, "Install the ntfy app on your phone (",
          h("a", { href: NTFY_PLAY, target: "_blank", rel: "noopener" }, "Google Play"), " or ",
          h("a", { href: NTFY_IOS, target: "_blank", rel: "noopener" }, "App Store"), ")."),
        h("li", null, own ? h("span", null, "Subscribe to this topic in the app: ", h("code", { class: "topic", text: own }))
          : h("span", null, h("button", { type: "button", class: "btn small", onclick: genTopic }, "Make a private topic name"))),
        h("li", null, "Add it to your tracker repo as an Actions secret named ", h("code", { text: "NTFY_TOPIC" }), ". ",
          secretsUrl ? h("a", { href: secretsUrl, target: "_blank", rel: "noopener" }, "Open the secrets page") : null)),
      own ? h("div", { class: "row-btns" }, h("button", { type: "button", class: "btn ghost", onclick: () => test(own) }, "Send a test push"),
        h("button", { type: "button", class: "btn ghost", onclick: () => copy(own) }, "Copy topic"),
        h("button", { type: "button", class: "linkish", onclick: genTopic }, "Make a new topic")) : null,
      msg);
  };
  const fetchCfg = () => {
    draw();
    gh(`/repos/${cfg.repo}/contents/live/push.json`, RAW)
      .then((t) => { const j = JSON.parse(t); pushCfg = j && typeof j === "object" ? j : null; },
        (e) => { pushCfg = e.status === 404 ? null : { error: e.status === 0 ? "offline" : e.message }; })
      .catch(() => { pushCfg = null; })     // unreadable file: treat as none
      .then(draw);
  };
  if (pushCfg === undefined && cfg.token && cfg.repo) fetchCfg();
  else draw();
  return sec;
}

// ------------------------------------------------------------------ settings
function viewSettings() {
  const msg = h("p", { class: "form-msg", role: "status" });
  const tokenIn = h("input", { type: "password", class: "input", placeholder: "github_pat_…", autocomplete: "off", spellcheck: "false", "aria-label": "New token" });
  const repoIn = h("input", { type: "text", class: "input", value: cfg.repo || "", autocomplete: "off", spellcheck: "false", "aria-label": "Repository (owner/name)" });
  const branchIn = h("input", { type: "text", class: "input", value: cfg.branch || DEFAULT_BRANCH, autocomplete: "off", spellcheck: "false", "aria-label": "Data branch" });
  const saveConn = async () => {
    const next = { token: tokenIn.value.trim() || cfg.token, repo: repoIn.value.trim(), branch: branchIn.value.trim() || DEFAULT_BRANCH };
    msg.textContent = "Checking…";
    try {
      await gh(contentsPath("summary.json", next), RAW, next.token);
      saveCfg(next);
      pushCfg = undefined;
      msg.textContent = "Connected. Data found.";
      state.summary = null; state.series = null;
      await cacheClear();
      load({ force: true });
    } catch (e) {
      if (e.status === 404 && isAppRepo(next.repo)) { msg.textContent = "That's this app's own repository. Enter your tracker repository instead."; return; }
      if (e.status === 404) { cantSeeTracker(msg); msg.prepend("Can't find app data there. Check the repository name and branch. If they're right, then: "); return; }
      msg.textContent = e.status === 401 ? "GitHub rejected that token." : `Check failed: ${e.message}`;
    }
  };
  const theme = cfg.theme || "system";
  const themeSeg = h("div", { class: "seg", role: "group", "aria-label": "Theme" },
    [["system", "Match device"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => h("button", {
      type: "button", class: "seg-btn", "aria-pressed": String(theme === v), onclick: () => { saveCfg({ theme: v }); render(); },
    }, l)));

  // Phone setup link / QR
  const qrBox = h("div", { class: "qr-box" });
  const setupLink = () => {
    const payload = btoa(JSON.stringify({ t: cfg.token, r: cfg.repo, b: cfg.branch || DEFAULT_BRANCH })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${location.origin}${location.pathname}#setup=${payload}`;
  };
  const showQr = async () => {
    qrBox.replaceChildren(h("p", { class: "muted", text: "Making the code…" }));
    try {
      const { default: qrcode } = await import("./vendor/qrcode.mjs");
      const q = qrcode(0, "M");
      q.addData(setupLink());
      q.make();
      const wrap = h("div", { class: "qr" });
      wrap.innerHTML = q.createSvgTag({ cellSize: 4, margin: 3, scalable: true }); // library output, no user text
      qrBox.replaceChildren(wrap, h("p", { class: "muted" }, "Scan it with your phone's camera and the app opens already connected. On iPhone, an app on the Home Screen keeps its own storage, so if you've installed it there, paste a token inside the installed app instead."),
        h("button", { type: "button", class: "btn ghost", onclick: () => qrBox.replaceChildren() }, "Hide code"));
    } catch (e) { qrBox.replaceChildren(h("p", { class: "warn-text", text: `Couldn't make the code: ${e.message}` })); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(setupLink()); msg2.textContent = "Setup link copied. Send it only to yourself."; }
    catch { msg2.textContent = "Couldn't copy. Use the QR code instead."; }
  };
  const msg2 = h("p", { class: "form-msg", role: "status" });

  // Install
  const install = installPrompt ? h("button", { type: "button", class: "btn", onclick: async () => { installPrompt.prompt(); installPrompt = null; render(); } }, "Install StickerTracker") : null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;

  return h("div", { class: "settings" },
    h("h2", { class: "st-title", text: "Settings" }),
    h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Connection" }),
      h("p", { class: "muted" }, `Reading ${cfg.repo || "?"} (${cfg.branch || DEFAULT_BRANCH} branch) with a token ending in ${(cfg.token || "").slice(-4)}.`),
      h("label", { class: "field" }, h("span", { text: "Repository" }), repoIn),
      h("label", { class: "field" }, h("span", { text: "Data branch" }), branchIn),
      h("label", { class: "field" }, h("span", { text: "Replace token" }), tokenIn),
      h("div", { class: "row-btns" }, h("button", { type: "button", class: "btn", onclick: saveConn }, "Save and check"),
        h("a", { class: "btn ghost", href: TOKENS_URL, target: "_blank", rel: "noopener" }, "Edit token access"),
        h("a", { class: "btn ghost", href: TOKEN_URL, target: "_blank", rel: "noopener" }, "Create a new token")),
      msg),
    h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Use it on your phone" }),
      standalone ? null : h("p", { class: "muted" }, isIOS ? "On iPhone: tap Share, then Add to Home Screen. Open it from there and paste a token."
        : "Install it from your browser's menu (Install app, or Add to Home screen) to get its own icon and window."),
      install,
      h("p", { class: "muted" }, "To connect another device without making a new token, open this link there. It contains your read-only token, so only send it to yourself."),
      h("div", { class: "row-btns" }, h("button", { type: "button", class: "btn ghost", onclick: showQr }, "Show setup QR code"),
        h("button", { type: "button", class: "btn ghost", onclick: copyLink }, "Copy setup link")),
      msg2, qrBox),
    pushSection(),
    h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Appearance" }), themeSeg),
    h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "This device" }),
      state.summary ? h("p", { class: "muted" }, `Showing data for ${longDay(state.summary.as_of)}, exported ${ago(state.summary.generated_at)}.`) : null,
      h("div", { class: "row-btns" },
        h("button", { type: "button", class: "btn ghost", onclick: async () => { await cacheClear(); state.summary = null; state.series = null; load({ force: true }); } }, "Reload all data"),
        h("button", { type: "button", class: "btn danger", onclick: async () => {
          if (!confirm("Disconnect this device? The token and saved data are removed from it.")) return;
          await cacheClear(); store.set({ theme: cfg.theme }); cfg = store.get(); pushCfg = undefined; state.summary = null; state.series = null; sheetPushed = false; go("#/today"); render();
        } }, "Disconnect this device")),
      h("p", { class: "muted small" }, `StickerTracker app ${VERSION}`)));
}

// ------------------------------------------------------------------ setup
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
  name: "StickerTracker app", description: "Read-only access for the StickerTracker app", expires_in: "366", contents: "read",
}).toString();
const TOKENS_URL = "https://github.com/settings/personal-access-tokens";

// The repository this app is served from on GitHub Pages (owner.github.io/repo).
// It holds only the app's code, so it is never the tracker.
function appRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}`.toLowerCase() : null;
}
const isAppRepo = (full) => !!full && full.toLowerCase() === appRepo();

// The tracker is the repository with the nightly data branch.
async function hasDataBranch(full, token) {
  try { await gh(`/repos/${full}/branches/${encodeURIComponent(DEFAULT_BRANCH)}`, undefined, token); return true; }
  catch (e) { if (e.status === 404 || e.status === 403) return false; throw e; }
}
function cantSeeTracker(el) {
  el.replaceChildren(
    "This token can't read your tracker repository. On GitHub, open the token and choose Edit. Under Repository access, pick Only select repositories and your private tracker repository (not this app's own repository). Then under Permissions, add Contents: Read-only in the Repositories box. Without it, GitHub saves the token as public-only. Update, then try again. ",
    h("a", { href: TOKENS_URL, target: "_blank", rel: "noopener" }, "Open your tokens on GitHub"));
}

function viewSetup() {
  const tokenIn = h("input", { type: "password", class: "input", placeholder: "github_pat_…", autocomplete: "off", spellcheck: "false", id: "tok" });
  const msg = h("p", { class: "form-msg", role: "status" });
  const pick = h("div", { class: "pick" });
  const connect = async (repo) => {
    const token = tokenIn.value.trim();
    if (!token) { msg.textContent = "Paste the token first."; tokenIn.focus(); return; }
    msg.textContent = "Checking with GitHub…";
    try {
      if (!repo) {
        const repos = await gh("/user/repos?per_page=100&sort=pushed", undefined, token);
        const cands = repos.filter((r) => r.permissions?.pull && !isAppRepo(r.full_name));
        const probed = await Promise.all(cands.slice(0, 30).map((r) =>
          hasDataBranch(r.full_name, token).then((ok) => (ok ? r : null))));
        const withData = probed.filter(Boolean);
        // No data branch anywhere yet: fall back to the private repositories.
        const list = withData.length ? withData : cands.filter((r) => r.private);
        if (!list.length) { cantSeeTracker(msg); return; }
        if (list.length > 1) {
          msg.textContent = "Which repository holds your tracker?";
          pick.replaceChildren(...list.map((r) => h("button", { type: "button", class: "btn ghost", onclick: () => connect(r.full_name) }, r.full_name)));
          return;
        }
        repo = list[0].full_name;
      }
      const next = { token, repo, branch: DEFAULT_BRANCH };
      try { await gh(contentsPath("summary.json", next), RAW, token); }
      catch (e) {
        if (e.status !== 404) throw e;
        msg.textContent = `Connected to ${repo}, but there's no app data yet. It appears after the next nightly run with the app-data step.`;
      }
      saveCfg(next);
      go("#/today");
      render();
      load({ force: true });
    } catch (e) {
      msg.textContent = e.status === 401 ? "GitHub rejected that token. Check you copied all of it."
        : e.status === 0 ? "Can't reach GitHub. Check your connection." : `That didn't work: ${e.message}`;
    }
  };
  return h("main", { class: "setup" },
    h("div", { class: "setup-card" },
      h("img", { src: "icons/icon.svg", alt: "", width: 56, height: 56, class: "setup-icon" }),
      h("h1", { class: "title", text: "Connect your tracker" }),
      h("p", { class: "lede", text: "This app reads the nightly summary from your private tracker repository. It needs a read-only GitHub token, which stays on this device." }),
      h("ol", { class: "steps" },
        h("li", null, h("a", { class: "btn", href: TOKEN_URL, target: "_blank", rel: "noopener" }, "Create a read-only token"),
          h("p", { class: "muted" }, "On GitHub, set Repository access to Only select repositories and pick your private tracker repository, the one the nightly workflow runs in (not this app's own repository). Contents read access is already filled in. Then generate the token and copy it.")),
        h("li", null, h("label", { class: "field", for: "tok" }, h("span", { text: "Paste the token" }), tokenIn),
          h("button", { type: "button", class: "btn", onclick: () => connect(null) }, "Connect"), msg, pick)),
      h("p", { class: "muted small", text: "Have a setup link from your other device? Open it on this one and you're connected." })));
}

// ------------------------------------------------------------------ theme, install, boot
function applyTheme() {
  const t = cfg.theme || "system";
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#0f1318" : "#f3f5f8";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });

function importSetupLink() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
    if (j.t && j.r) saveCfg({ token: j.t, repo: j.r, branch: j.b || DEFAULT_BRANCH });
  } catch { /* ignore a malformed link */ }
  history.replaceState(null, "", location.pathname + location.search + "#/today");
  return true;
}

function toast(text, actionLabel, action) {
  const t = h("div", { class: "toast", role: "status" }, h("span", { text }),
    actionLabel ? h("button", { type: "button", class: "linkish", onclick: action }, actionLabel) : null);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), actionLabel ? 15000 : 4000);
}

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller)
          toast("A new version of the app is ready.", "Reload", () => location.reload());
      });
    });
  }).catch(() => { /* offline-first is optional */ });
}

window.addEventListener("hashchange", () => {
  const r = route();
  // Opening or closing a sheet keeps the page underneath as it is.
  if (cfg.token && $("#view") && (r.sheet || r.tab === renderedTab)) {
    if (!r.sheet) sheetPushed = false;
    renderSheet(r.sheet);
    return;
  }
  sheetPushed = false;
  if (r.tab !== "movers") moversViaLink = false;
  render();
  window.scrollTo(0, state.ui[`scroll:${state.tab}`] || 0);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && cfg.token && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 10 * 60000) load();
});

importSetupLink();
render();
load();

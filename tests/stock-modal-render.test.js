// tests/stock-modal-render.test.js — 2026-11-12. The standing render test owed since 4e71a4a (STATUS, "Owed, with a
// condition that enforces itself"; tests/stock-modal-edit-guard.test.js pinned openStockModal until it existed).
//
// openStockModal writes the Add button and, just before it, captures what the screen showed
// (state.appShowedOnScreen, read by the buy as appShowedAtBuy). It reads several of the function's own variables; one
// out of scope would throw, the catch would show "Failed to load data" INSTEAD of the Add button, and Roman could not
// buy. So this runs the REAL app (core/*.js, shell/registry.js, app.js, in index.html's order) in a Node VM with a
// fake DOM, replaces only the network (bars, Alpaca, Supabase) and the chart library, and renders the modal for the
// three footers: not held (+ Add to Portfolio), held (+ Record another buy), a pending order (+ Record another
// order). The app's own functions stay real, so a scope error in them still throws here.
// Node built-ins only (CI has no browser and no npm install).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { run, REPO_ROOT } = require('./_lib');

// A fake element: enough DOM for the app's renders (innerHTML/textContent stored, never parsed).
function fakeDom() {
  const byId = new Map();
  const el = (id = null) => {
    const cls = new Set();
    const e = {
      id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, disabled: false, children: [],
      classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)), contains: c => cls.has(c), toggle: (c, on) => (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c) },
      appendChild: c => { e.children.push(c); return c; }, insertAdjacentHTML: (w, h) => { e.innerHTML += h; }, insertAdjacentElement: () => {},
      querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {},
      setAttribute: () => {}, getAttribute: () => null, remove: () => {}, focus: () => {}, scrollIntoView: () => {},
      getContext: () => new Proxy({}, { get: () => () => {} }), getBoundingClientRect: () => ({ width: 360, height: 200, top: 0, left: 0 }),
      scrollWidth: 0, clientWidth: 0, offsetWidth: 360, offsetHeight: 200,
    };
    return e;
  };
  const document = {
    getElementById: id => { if (!byId.has(id)) byId.set(id, el(id)); return byId.get(id); },
    createElement: () => el(), querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
    body: el('body'), documentElement: el('html'), head: el('head'), visibilityState: 'visible',
  };
  return { document, byId };
}

function loadApp() {
  const { document, byId } = fakeDom();
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} }, document, localStorage: store(), sessionStorage: store(),
    navigator: { serviceWorker: undefined, userAgent: 'node' }, location: { href: 'http://localhost/', reload() {} },
    fetch: async () => { throw new Error('no network in this test'); }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, Intl, Date, Math, JSON, Promise, URL, URLSearchParams, Map, Set, Proxy, Number, String, Array, Object, Error,
    Chart: class { constructor() {} destroy() {} update() {} },
    supabase: { createClient: () => ({ from: () => { throw new Error('no Supabase in this test'); } }) },
    Notification: undefined, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    innerWidth: 390, innerHeight: 844, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"?]+)\?v=\d+"><\/script>/g)].map(m => m[1]);
  assert.ok(scripts.includes('app.js') && scripts.indexOf('app.js') === scripts.length - 1, 'index.html loads app.js last');
  for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'), ctx, { filename: f });
  return { ctx, byId };
}

// Fixture bars: 260 trading days (weekday steps), deterministic.
function bars(n, stepMs, start = Date.parse('2025-11-10T21:00:00Z'), base = 5) {
  const out = [];
  for (let i = 0, t = start; out.length < n; i++, t += stepMs) {
    const d = new Date(t).getUTCDay();
    if (stepMs >= 86400000 && (d === 0 || d === 6)) continue;
    const c = +(base + Math.sin(i / 7) * 0.4 + i * 0.002).toFixed(2);
    out.push({ t: new Date(t).toISOString(), o: c, h: +(c + 0.1).toFixed(2), l: +(c - 0.1).toFixed(2), c, v: 100000 + i * 10 });
  }
  return out;
}

async function renderModal({ ownedPosition = null, pending = null } = {}) {
  const { ctx, byId } = loadApp();
  vm.runInContext(`
    fetchSingleBars = async () => __bars.daily;
    fetchMinuteBars = async () => __bars.minute;
    fetchHourlyBars = async () => __bars.hourly;
    state.settings.alpacaKey = 'k'; state.settings.alpacaSecret = 's';
    state.signals = [__signal];
    state.portfolio = __portfolio;
  `, Object.assign(ctx, {
    __bars: { daily: bars(260, 86400000), minute: bars(390, 60000, Date.parse('2026-11-11T14:30:00Z')), hourly: bars(70, 3600000, Date.parse('2026-11-01T14:30:00Z')) },
    __signal: { ticker: 'XYZ', company: 'Xyz Corp', price: 5.12, todayChange: 2.1, score: 74, signal: 'BUY', rsi: 55, volRatio: 1.6, ma20: 4.9,
      target: 5.6, stop: 4.7, entry: 5.12, duration: '3-DAY', risk: 5, signalsFired: [], atr: 0.2, maPct: 4.5, priceRange: 0.4,
      volTrend: 'rising', meanReversion: null, scoringVersion: 2, scannedAt: Date.now() },
    __portfolio: [ownedPosition, pending].filter(Boolean),
  }));
  const errors = [];
  ctx.console.error = (...a) => errors.push(a.join(' '));
  await vm.runInContext(`openStockModal('XYZ')`, ctx);
  // state is a top-level const of the app's scripts, not a property of the context: read it inside
  const shown = vm.runInContext('state.appShowedOnScreen', ctx);
  return { ctx, shown, body: byId.get('stock-modal-body')?.innerHTML || '', footer: byId.get('stock-modal-footer')?.innerHTML || '', errors };
}

const held = { id: '1762900000000', ticker: 'XYZ', company: 'Xyz Corp', shares: 10, buyPrice: 4.9, buyDate: '2026-11-10', target: 5.6, stop: 4.6,
  duration: '3-DAY', scoreAtBuy: 70, orderType: 'market', filledAt: '2026-11-10T15:00:00Z', engineSource: 'EDGE', codeVersion: { app: '20261112002000', scoring: 2 } };
const pendingOrder = { ...held, id: '1762900000001', orderType: 'limit', filledAt: null };

(async () => {
await run('not held: the modal renders with the Add button, and the capture of what it showed runs', async () => {
  const r = await renderModal();
  assert.ok(!/Failed to load data/.test(r.body), `the modal failed: ${r.body.slice(0, 300)}`);
  assert.ok(r.footer.includes(`onclick="openAddPortfolioModal('XYZ')">+ Add to Portfolio</button>`), 'the Add button');
  const a = r.shown;
  assert.ok(a && a.ticker === 'XYZ' && a.held === false && typeof a.renderedAt === 'string', 'the capture ran');
  assert.ok('gate' in a && 'daySuppressed' in a && 'score' in a && 'label' in a && a.scoreSource === 'scan', JSON.stringify(a));
  // 2026-11-12 (the scan price history): the modal carries its section, and the Add button is still there with it
  assert.ok(r.body.includes('Your recent scans of XYZ') && r.body.includes('id="scan-hist-modal"'), 'the scan history section');
});

await run('held: "Record another buy", and the capture says held', async () => {
  const r = await renderModal({ ownedPosition: held });
  assert.ok(!/Failed to load data/.test(r.body), r.body.slice(0, 300));
  assert.ok(r.footer.includes('✓ In Portfolio · + Record another buy'));
  assert.strictEqual(r.shown.held, true);
});

await run('a pending order: "Record another order", and the capture runs', async () => {
  const r = await renderModal({ pending: pendingOrder });
  assert.ok(!/Failed to load data/.test(r.body), r.body.slice(0, 300));
  assert.ok(r.footer.includes('⏳ Order pending · + Record another order'));
  assert.strictEqual(r.shown.ticker, 'XYZ');
});

await run('the harness can fail: a variable out of scope in the capture shows "Failed to load data" and no Add button', async () => {
  // the control: the same render with the capture made to read a name that does not exist (the defect this test is
  // for), applied to the real source in memory. If this passed, the three renders above would prove nothing.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'app.js'), 'utf8');
  const broken = src.replace('daySuppressed: !!daySuppressed,', 'daySuppressed: !!notInScopeAnywhere,');
  assert.notStrictEqual(broken, src, 'the capture line to break');
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...a) => (String(p).endsWith(`${path.sep}app.js`) ? broken : real(p, ...a));
  try {
    const r = await renderModal();
    assert.ok(/Failed to load data/.test(r.body), 'the scope error reached the catch');
    assert.ok(!r.footer.includes('+ Add to Portfolio'), 'and there is no Add button');
  } finally { fs.readFileSync = real; }
});
})();

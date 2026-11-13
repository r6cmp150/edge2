// tests/_app-vm.js -- 2026-11-12. The REAL app (index.html's scripts, in its order) in a Node VM with a fake DOM, the
// network and the chart library replaced. Moved verbatim out of tests/stock-modal-render.test.js so the macro scan test
// (tests/macro-observe-only.test.js) uses the same loader rather than a copy. Not a test file (the leading underscore).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT } = require('./_lib');

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

module.exports = { fakeDom, loadApp, bars };

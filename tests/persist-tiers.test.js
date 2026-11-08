// tests/persist-tiers.test.js -- 2026-11-08, change 4a. The quota was full: the `sold`
// cache (1,734,554 chars for 608 sales) shared it with the only copy of an unrecorded
// sale, and the cache was winning. Now: a queue or measured-state write that hits the
// quota evicts rebuildable caches, largest first; a cache never evicts anything; the
// `sold` cache is stored bounded, with its own date and the total; and a failure record
// is cleared only by its own key, never overwritten by a lower tier.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const store = readSource('core/store.js');
const block = store.match(/const PERSIST_TIER = \{[\s\S]*?\nfunction persist\(key\) \{[\s\S]*?\n\}/)[0];

// A localStorage with a real quota, in characters of key + value, like WebKit's.
function quotaStorage(limit, initial = {}) {
  const m = new Map(Object.entries(initial));
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    removeItem: k => { m.delete(k); },
    setItem: (k, v) => {
      const before = m.has(k) ? k.length + m.get(k).length : 0;
      if (used() - before + k.length + v.length > limit) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    },
  };
}
function load(storage, st = {}) {
  global.localStorage = storage;
  global.state = { ...st };
  global.__banner = 0;
  global.updateMarketBanner = () => { global.__banner++; };
  const quiet = { warn: console.warn, error: console.error };
  // eslint-disable-next-line no-eval
  eval(block + '\nglobal.__p = { persist, boundSoldCache, PERSIST_TIER, SOLD_CACHE_MAX_CHARS };');
  return { ...global.__p, quiet };
}
const muted = fn => async () => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { await fn(); } finally { console.warn = w; console.error = e; } };
const big = n => 'x'.repeat(n);

run('a queue write that hits the quota evicts caches, largest first, until it fits; the queue lands', muted(async () => {
  const s = quotaStorage(3000, { edge_news: big(900), edge_signals: big(1500), edge_ownedScores: big(300) });
  const { persist } = load(s, { saleWriteFailures: { 1: { ticker: 'UEC', note: big(1200) } } });
  assert.strictEqual(persist('saleWriteFailures'), true);
  assert.ok(s.m.has('edge_saleWriteFailures'), 'the queue is saved');
  assert.ok(!s.m.has('edge_signals'), 'the largest cache went first');
  assert.ok(s.m.has('edge_ownedScores'), 'no more evicted than needed');
  assert.deepStrictEqual(global.state.persistEvictions[0].evicted.map(e => e.key), s.m.has('edge_news') ? ['signals'] : ['signals', 'news']);
  assert.strictEqual(global.state.persistFailure, undefined, 'no failure recorded: it landed');
}));

run('measured state (tier 2) evicts caches too', muted(async () => {
  const s = quotaStorage(1200, { edge_news: big(1000) });
  const { persist } = load(s, { ownedPeakRSI: { UEC: 71.2, pad: big(400) } });
  assert.strictEqual(persist('ownedPeakRSI'), true);
  assert.ok(!s.m.has('edge_news'));
}));

run('a cache write never evicts anything, and its failure is recorded', muted(async () => {
  const s = quotaStorage(1200, { edge_news: big(500), edge_saleWriteFailures: big(500) });
  const { persist } = load(s, { signals: [big(600)] });
  assert.strictEqual(persist('signals'), false);
  assert.ok(s.m.has('edge_news') && s.m.has('edge_saleWriteFailures'), 'nothing evicted for a cache');
  assert.strictEqual(global.state.persistFailure.key, 'signals');
}));

run('a queue write never evicts a queue or measured state, only caches; with no cache left it fails, said', muted(async () => {
  const s = quotaStorage(1200, { edge_snapshotWriteFailures: big(500), edge_ownedPrevRSI: big(500) });
  const { persist } = load(s, { saleWriteFailures: { 1: big(400) } });
  assert.strictEqual(persist('saleWriteFailures'), false);
  assert.ok(s.m.has('edge_snapshotWriteFailures') && s.m.has('edge_ownedPrevRSI'));
  assert.strictEqual(global.state.persistFailure.key, 'saleWriteFailures');
  assert.strictEqual(global.state.persistFailure.tier, 1);
}));

run('a lower-tier failure never overwrites a higher-tier one; a same-or-higher tier does', muted(async () => {
  const s = quotaStorage(10);
  const { persist } = load(s, { saleWriteFailures: { 1: 'x' }, news: ['n'], ownedPeakRSI: { a: 1 } });
  persist('saleWriteFailures');
  persist('news');
  assert.strictEqual(global.state.persistFailure.key, 'saleWriteFailures', 'a cache failure does not cover a queue failure');
  persist('ownedPeakRSI');
  assert.strictEqual(global.state.persistFailure.key, 'saleWriteFailures', 'tier 2 does not cover tier 1');
  global.state.persistFailure = { key: 'news', tier: 4 };
  persist('ownedPeakRSI');
  assert.strictEqual(global.state.persistFailure.key, 'ownedPeakRSI', 'tier 2 does cover a cache failure');
}));

run('only the failed key saving clears its failure', muted(async () => {
  const s = quotaStorage(100000);
  const { persist } = load(s, { news: ['n'], saleWriteFailures: {}, persistFailure: { key: 'saleWriteFailures', tier: 1 } });
  persist('news');
  assert.strictEqual(global.state.persistFailure.key, 'saleWriteFailures');
  persist('saleWriteFailures');
  assert.strictEqual(global.state.persistFailure, null);
}));

run('sold is stored bounded: the most recent sales under the cap, with its own date and the total', muted(async () => {
  const s = quotaStorage(10_000_000);
  const sale = i => ({ id: `r${i}`, ticker: 'T' + i, pad: big(2800) });
  const sold = Array.from({ length: 300 }, (_, i) => sale(i));
  const { persist, SOLD_CACHE_MAX_CHARS } = load(s, { sold });
  const before = Date.now();
  persist('sold');
  const stored = JSON.parse(s.m.get('edge_sold'));
  assert.strictEqual(stored.format, 'bounded-v1');
  assert.strictEqual(stored.total, 300);
  assert.ok(stored.rows.length > 0 && stored.rows.length < 300);
  assert.strictEqual(stored.rows[0].id, 'r0', 'the most recent first (state.sold is newest first)');
  assert.deepStrictEqual(stored.rows.map(r => r.id), sold.slice(0, stored.rows.length).map(r => r.id), 'a prefix: the most recent N, none skipped');
  assert.ok(JSON.stringify(stored.rows).length <= SOLD_CACHE_MAX_CHARS + stored.rows.length, 'under the cap');
  assert.ok(Date.parse(stored.storedAt) >= before - 1000, 'dated when this copy was written');
  assert.strictEqual(global.state.sold.length, 300, 'memory keeps the whole list: only the stored copy is bounded');
}));

run('uneven sizes: the copy stops at the first sale that does not fit, never skips it for older smaller ones', muted(async () => {
  const s = quotaStorage(10_000_000);
  const cap = Number(store.match(/const SOLD_CACHE_MAX_CHARS = (\d+)/)[1]);
  const { persist } = load(s, { sold: [{ id: 'n1', pad: big(100) }, { id: 'huge', pad: big(cap) }, { id: 'old1', pad: big(100) }, { id: 'old2', pad: big(100) }] });
  persist('sold');
  const stored = JSON.parse(s.m.get('edge_sold'));
  assert.deepStrictEqual(stored.rows.map(r => r.id), ['n1'], 'the most recent N is a prefix: a skipped sale would make it a sample');
  assert.strictEqual(stored.total, 4);
}));

run('offline on a bounded copy plus a new sale: the total is the copy total plus what was added', muted(async () => {
  const s = quotaStorage(10_000_000);
  const { persist } = load(s, { sold: [{ id: 'new' }, { id: 'a' }, { id: 'b' }], soldCacheInfo: { storedAt: 'x', total: 608, kept: 2 } });
  persist('sold');
  assert.strictEqual(JSON.parse(s.m.get('edge_sold')).total, 609);
  load(s, { sold: [{ id: 'a' }], soldCacheInfo: { storedAt: null, total: 1, kept: 1, legacy: true } });
  global.__p.persist('sold');
  assert.strictEqual(JSON.parse(s.m.get('edge_sold')).total, 1, 'a legacy copy has no larger total to add to');
}));

run('every key persist() is called with anywhere has a tier; every tier-4 key is a cache', () => {
  const files = ['app.js', 'core/store.js', 'core/universe.js', 'core/edgar.js', 'engines/warrior/gate.js'];
  const keys = new Set();
  for (const f of files) for (const m of readSource(f).matchAll(/\bpersist\('([A-Za-z0-9_]+)'\)/g)) keys.add(m[1]);
  const { PERSIST_TIER } = load(quotaStorage(1));
  const missing = [...keys].filter(k => !(k in PERSIST_TIER));
  assert.deepStrictEqual(missing, [], 'a persisted key with no tier would default to 3 silently: give it one');
  for (const k of ['saleWriteFailures', 'snapshotWriteFailures', 'ratingWriteFailures']) assert.strictEqual(PERSIST_TIER[k], 1, k);
  for (const k of ['ownedPeakRSI', 'ownedPrevRSI', 'warriorPreMarketRvolObservations']) assert.strictEqual(PERSIST_TIER[k], 2, k);
  assert.strictEqual(PERSIST_TIER.sold, 4);
});

run('loadState: a bounded copy is unwrapped with its facts; a legacy array is marked undated; the notice says which', () => {
  const app = readSource('app.js');
  const i = app.indexOf('state.soldCacheInfo = null;\n  if (state.sold && !Array.isArray(state.sold)');
  assert.ok(i > 0, 'the unwrap in loadState');
  const unwrap = app.slice(i, app.indexOf('\n  // Signals stored before scannedAt', i));
  const run1 = sold => { global.state = { sold }; eval(unwrap); return global.state; }; // eslint-disable-line no-eval
  let st = run1({ format: 'bounded-v1', storedAt: '2026-11-08T20:00:00.000Z', total: 608, rows: [{ id: 1 }, { id: 2 }] });
  assert.deepStrictEqual(st.sold, [{ id: 1 }, { id: 2 }]);
  assert.deepStrictEqual(st.soldCacheInfo, { storedAt: '2026-11-08T20:00:00.000Z', total: 608, kept: 2 });
  st = run1([{ id: 1 }]);
  assert.deepStrictEqual(st.soldCacheInfo, { storedAt: null, total: 1, kept: 1, legacy: true });
  st = run1(undefined);
  assert.deepStrictEqual(st.sold, []); assert.strictEqual(st.soldCacheInfo, null);
  const n = app.search(/^function soldCacheNotice\(/m);
  eval(app.slice(n, app.indexOf('\n}\n', n) + 3) + '\nglobal.__n = soldCacheNotice;'); // eslint-disable-line no-eval
  // Dated two days back: the notice must carry the COPY's date, never the time it renders.
  global.state = { soldCacheInfo: { storedAt: '2026-11-06T17:30:00.000Z', total: 608, kept: 87 } };
  const h = global.__n();
  assert.ok(h.includes('the most recent 87 of 608 sales') && h.includes('Nov 6') && h.includes('9:30') && h.includes('PT') && h.includes('figures below cover only these'), h);
  global.state = { soldCacheInfo: { storedAt: null, total: 40, kept: 40, legacy: true } };
  assert.ok(global.__n().includes("at a time it didn't record"));
  global.state = { soldCacheInfo: null };
  assert.strictEqual(global.__n(), '');
  assert.ok(/state\.soldCacheInfo = null; \/\/ the full list from the database/.test(app), 'the database read clears it');
  for (const tab of ['renderSoldTab', 'renderAnalyticsTab']) {
    const t = app.search(new RegExp('^(async )?function ' + tab + '\\(', 'm'));
    assert.ok(t > 0, tab + ' found');
    assert.ok(app.slice(t, app.indexOf('\n}\n', t)).includes('${soldCacheNotice()}'), tab + ' shows the notice');
  }
});

// tests/prefilter-rejections.test.js — phase-10 §7.6 steps 1e and 1f. The
// EDGE pre-filter is one predicate (core/universe.js edgePrefilterFailures)
// that decides both who passes and what is logged for who doesn't, shared by
// app.js runScreener and the logger. Its fallback mode must pass exactly the
// symbols the old inline filter passed, and every mode names missing data
// rather than reading it as 0. (The trailing-volume rule itself:
// tests/edge-liquidity-gate.test.js.)
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

global.getLivePrice = snap => snap.dailyBar?.c || snap.latestTrade?.p; // core/market-data.js's rule
global.state = {}; global.persist = () => {};
const uni = readSource('core/universe.js');
const fnSrc = uni.match(/function edgePrefilterFailures\([^)]*\) \{[\s\S]*?\n\}/)[0];
// eslint-disable-next-line no-eval
eval(fnSrc + '\nglobal.__pf = edgePrefilterFailures;');
const limits = { minPrice: 1, maxPrice: 20, minAvgShares: 1000000, minIexVolume: 100000 };
const FALLBACK = { mode: 'iex_today', limits, listingBySymbol: null, liquidity: null };
const pf = (s, ctx = FALLBACK, sym = 'X') => global.__pf(sym, s, ctx);
const snap = (price, vol) => ({ dailyBar: { c: price, v: vol } });
const oldFilter = s => { const p = global.getLivePrice(s); const v = s.dailyBar?.v || 0; return p >= 1 && p <= 20 && v >= 100000; };

run('the fallback passes exactly what the old inline filter passed (generated snapshots)', () => {
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20000; i++) {
    const price = rnd() < 0.05 ? undefined : rnd() < 0.05 ? 0 : rnd() * 30;
    const vol = rnd() < 0.05 ? undefined : Math.floor(rnd() * 300000);
    const s = { dailyBar: { c: price, v: vol }, latestTrade: rnd() < 0.5 ? { p: rnd() * 30 } : undefined };
    assert.strictEqual(pf(s).length === 0, oldFilter(s), `snapshot ${JSON.stringify(s)}`);
  }
});

run('every failed test is named, and missing data is not read as 0', () => {
  assert.deepStrictEqual(pf(snap(0.5, 50000)), ['price_below_min', 'volume_below_min'], 'both failures, not just the first');
  assert.deepStrictEqual(pf(snap(25, 500000)), ['price_above_max']);
  assert.deepStrictEqual(pf(snap(5, undefined)), ['no_volume']);
  assert.deepStrictEqual(pf({ dailyBar: {} }), ['no_price', 'no_volume']);
  assert.deepStrictEqual(pf(undefined), ['no_snapshot'], 'a universe symbol with no snapshot is logged too, not skipped');
  assert.deepStrictEqual(pf(snap(5, 200000)), []);
});

run('the listing test applies in either mode, and is skipped (not passed on a guess) only when the list is unknown', () => {
  const listingBySymbol = { DEAD: 'asset_inactive', HALT: 'asset_not_tradable', OK: 'listed' };
  const ctx = { ...FALLBACK, listingBySymbol };
  assert.deepStrictEqual(pf(snap(5, 200000), ctx, 'DEAD'), ['asset_inactive']);
  assert.deepStrictEqual(pf(snap(5, 200000), ctx, 'HALT'), ['asset_not_tradable']);
  assert.deepStrictEqual(pf(snap(5, 200000), ctx, 'OK'), []);
});

run('both callers build candidates, rejections and the rule from the one shared function', () => {
  const logger = readSource('scripts/log-signals-edge.mjs');
  const app = readSource('app.js');
  assert.ok(/await global\.runEdgePrefilter\(TICKERS, snapshots,/.test(logger), 'the logger uses runEdgePrefilter');
  assert.ok(/prefilter_rejections: prefilterRejections,/.test(logger), 'rejections are written on the scan_runs row');
  assert.ok(/prefilter_rule: prefilterRule,/.test(logger), 'the rule applied is written on the scan_runs row (db/032)');
  assert.ok(/assertColumnsExist\(SUPABASE_URL, SUPABASE_ANON_KEY, 'scan_runs', Object\.keys\(scanRun\)\)/.test(logger), 'so assertColumnsExist checks both columns');
  const screener = app.match(/async function runScreener\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/await runEdgePrefilter\(TICKERS, snapshots,/.test(screener), 'app.js runScreener uses runEdgePrefilter');
  for (const [name, s] of [['app.js runScreener', screener], ['the logger', logger]]) {
    assert.ok(!/dailyBar\?\.v/.test(s), `${name} still reads snapshot volume itself: a second copy of the rule`);
    assert.ok(!/function prefilterFailures/.test(s), `${name} still defines its own predicate`);
  }
  const runner = uni.match(/async function runEdgePrefilter\([^)]*\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/edgePrefilterFailures\(t, snap, ctx\)/.test(runner) && (runner.match(/edgePrefilterFailures\(/g) || []).length === 1,
    'candidates and rejections come from ONE call of the predicate per symbol');
});

// The rejection rows store the volume the snapshot carried, keyed iex_volume
// because fetchSnapshots requests feed:'iex' (one venue, a median 6.3% of
// consolidated volume). If the feed ever changes, this fails, so the key
// can't silently mislabel what was measured.
run('rejection volume is labelled with the feed it was measured on', () => {
  const md = readSource('core/market-data.js');
  const fs = md.match(/async function fetchSnapshots\([^)]*\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/feed:\s*'iex'/.test(fs), 'fetchSnapshots no longer requests feed:iex: rename iex_volume in core/universe.js (and db/029) to the new feed');
  assert.ok(/iex_volume: snap\?\.dailyBar\?\.v \?\? null/.test(uni) && !/\bvolume: snap\??\.dailyBar/.test(uni), 'rejections use iex_volume, not an unlabelled volume');
});

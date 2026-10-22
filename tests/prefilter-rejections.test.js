// tests/prefilter-rejections.test.js — phase-10 §7.6 step 1e. The EDGE
// pre-filter is one predicate (prefilterFailures) that decides both who
// passes and what is logged for who doesn't; it must pass exactly the
// symbols the old inline filter passed, and name missing data rather
// than read it as 0.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const src = readSource('scripts/log-signals-edge.mjs');
const fnSrc = src.match(/function prefilterFailures\([^)]*\) \{[\s\S]*?\n\}/)[0];
global.getLivePrice = snap => snap.dailyBar?.c || snap.latestTrade?.p; // core/market-data.js's rule
// eslint-disable-next-line no-eval
eval(fnSrc + '\nglobal.__pf = prefilterFailures;');
const L = { minPrice: 1, maxPrice: 20, minVol: 100000 };
const snap = (price, vol) => ({ dailyBar: { c: price, v: vol } });
const oldFilter = s => { const p = global.getLivePrice(s); const v = s.dailyBar?.v || 0; return p >= 1 && p <= 20 && v >= 100000; };

run('passes exactly what the old inline filter passed (generated snapshots)', () => {
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20000; i++) {
    const price = rnd() < 0.05 ? undefined : rnd() < 0.05 ? 0 : rnd() * 30;
    const vol = rnd() < 0.05 ? undefined : Math.floor(rnd() * 300000);
    const s = { dailyBar: { c: price, v: vol }, latestTrade: rnd() < 0.5 ? { p: rnd() * 30 } : undefined };
    assert.strictEqual(global.__pf(s, L).length === 0, oldFilter(s), `snapshot ${JSON.stringify(s)}`);
  }
});

run('every failed test is named, and missing data is not read as 0', () => {
  assert.deepStrictEqual(global.__pf(snap(0.5, 50000), L), ['price_below_min', 'volume_below_min'], 'both failures, not just the first');
  assert.deepStrictEqual(global.__pf(snap(25, 500000), L), ['price_above_max']);
  assert.deepStrictEqual(global.__pf(snap(5, undefined), L), ['no_volume']);
  assert.deepStrictEqual(global.__pf({ dailyBar: {} }, L), ['no_price', 'no_volume']);
  assert.deepStrictEqual(global.__pf(snap(5, 200000), L), []);
});

run('the logger builds candidates and rejections from that one predicate, onto the scan_runs row', () => {
  assert.ok(/const candidates = Object\.entries\(snapshots\)\.filter\(\(\[, snap\]\) => prefilterFailures\(snap, filterLimits\)\.length === 0\);/.test(src), 'candidates come from prefilterFailures');
  assert.ok(/failed: prefilterFailures\(snap, filterLimits\)/.test(src), 'rejections come from the same predicate');
  assert.ok(/failed: \['no_snapshot'\]/.test(src), 'a universe symbol with no snapshot is logged too, not skipped');
  assert.ok(/prefilter_rejections: prefilterRejections,/.test(src), 'written on the scan_runs row (and so checked by assertColumnsExist)');
  assert.ok(/assertColumnsExist\(SUPABASE_URL, SUPABASE_ANON_KEY, 'scan_runs', Object\.keys\(scanRun\)\)/.test(src));
});

// The rejection rows store the volume the filter tested, keyed iex_volume
// because fetchSnapshots requests feed:'iex' (one venue, a median 6.3% of
// consolidated volume). If the feed ever changes, this fails, so the key
// can't silently mislabel what was measured.
run('rejection volume is labelled with the feed it was measured on', () => {
  const md = readSource('core/market-data.js');
  const fs = md.match(/async function fetchSnapshots\([^)]*\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/feed:\s*'iex'/.test(fs), 'fetchSnapshots no longer requests feed:iex: rename iex_volume in log-signals-edge.mjs (and db/029) to the new feed');
  assert.ok(/iex_volume: snap\.dailyBar\?\.v \?\? null/.test(src) && !/\bvolume: snap\.dailyBar/.test(src), 'rejections use iex_volume, not an unlabelled volume');
});

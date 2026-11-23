// tests/count-substituted-inputs.test.js -- 2026-11-20 (the reviewer). The substituted-input count, on fixtures: each
// path's exact signature is counted when present and not when a measured value merely lands near it; a path that
// cannot be seen is bounded, not zeroed; the stale bar is three states; the macro keys come from the scorer's own
// table; and the output carries the two notes (the re-run spent unused, and superseded by the outcome measurements).
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/count-substituted-inputs.mjs')).href);
const keys = M.macroKeys(readSource('core/edge-scoring.js'));
const bars = (n, v = 1000) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), v }));
const trade = (id, o = {}) => ({ position_id: id, volume_ratio_at_buy: 0.8, price_momentum_pts: 10, duration_classification: '3-DAY', macro_condition: 'CHOPPY', ...o });
const snap = (o = {}) => ({ snapshot: { price: 5, prevClose: 4.8, volume: 800, volRatio: 0.8, bars: bars(20), macroCondition: 'CHOPPY', category: 'TECH', dailyBarAgeTradingDays: 0, ...o } });

await run('the macro keys are read from the scorer\'s own table', () => {
  assert.ok(keys.conditions.has('BROAD_RALLY') && keys.conditions.has('CHOPPY') && !keys.conditions.has('NEUTRAL'));
  assert.ok(keys.categories.has('OTHER') && keys.categories.has('REAL_ESTATE') && keys.categories.size === 9);
});

await run('a clean sample counts 0 everywhere, and the stored ratio recomputes from the stored bars', () => {
  const c = M.count([trade('1'), trade('2')], new Map([['1', snap()]]), keys);
  assert.deepStrictEqual([c.withSnap, c.noSnap, c.established, c.snapRatioMismatch, c.a_boundNoSnap], [1, 1, 0, 0, 0]);
});

await run('each signature is counted: ratio exactly 1, exactly 0, prevClose equal to the price, a table miss', () => {
  const ts = [trade('1', { volume_ratio_at_buy: 1 }), trade('2', { volume_ratio_at_buy: 0 }), trade('3'), trade('4')];
  const ss = new Map([['3', snap({ prevClose: 5 })], ['4', snap({ category: 'CRYPTO' })]]);
  const c = M.count(ts, ss, keys);
  assert.deepStrictEqual([c.c_ratioOne, c.b_ratioZero, c.a_snap, c.e_snapMiss, c.established], [1, 1, 1, 1, 4]);
});

await run('a measured value NEAR a signature is not one: 0.99994 is not 1; a null ratio is missing, not 0', () => {
  const c = M.count([trade('1', { volume_ratio_at_buy: 0.9999422 }), trade('2', { volume_ratio_at_buy: null }), trade('3', { volume_ratio_at_buy: '' })], new Map(), keys);
  assert.deepStrictEqual([c.c_ratioOne, c.b_ratioZero, c.ratioMissing], [0, 0, 2]);
});

await run('(a) where it cannot be seen is bounded by momentum 0 or not recorded, never counted as 0', () => {
  const c = M.count([trade('1', { price_momentum_pts: 0 }), trade('2', { price_momentum_pts: null }), trade('3', { price_momentum_pts: 20 }), trade('4', { price_momentum_pts: undefined })], new Map(), keys);
  assert.strictEqual(c.a_boundNoSnap, 3, 'null and an absent field are both not recorded'); assert.strictEqual(c.established, 0);
});

await run('avgVol10 of 0 and a snapshot disagreeing with its own bars are both caught', () => {
  const c = M.count([trade('1'), trade('2')], new Map([['1', snap({ bars: bars(20, 0), volRatio: 1, volume: 0 })], ['2', snap({ volRatio: 0.7 })]]), keys);
  assert.strictEqual(c.c_snapAvgZero, 1); assert.strictEqual(c.snapRatioMismatch, 2, 'trade 1 snapshot vs row, trade 2 snapshot vs its bars');
  assert.strictEqual(M.avgVol10([...bars(10, 1), ...bars(10, 10)].map((b, i) => ({ ...b, t: new Date(Date.UTC(2026, 0, 20 - i)).toISOString() }))), 1, 'the LAST 10 by time, whatever the order');
});

await run('(d) and the stale bar: an unknown duration counts; the bar\'s age is three states', () => {
  const ts = [trade('1', { duration_classification: 'MONTH' }), trade('2'), trade('3'), trade('4')];
  const c = M.count(ts, new Map([['2', snap({ dailyBarAgeTradingDays: 2 })], ['3', snap()], ['4', snap({ dailyBarAgeTradingDays: undefined })]]), keys);
  assert.deepStrictEqual([c.d_other, c.stale, c.fresh, c.staleNotRecorded], [1, 1, 1, 1]);
});

await run('the output carries both notes', () => {
  const src = readSource('scripts/count-substituted-inputs.mjs');
  assert.ok(M.RERUN_SPENT.includes('IS SPENT WITHOUT BEING USED') && M.SUPERSEDED.startsWith('SUPERSEDED:') && M.SUPERSEDED.includes('84d161a'));
  assert.ok(src.includes('console.log(`\\n${RERUN_SPENT}`);') && src.includes('console.log(SUPERSEDED);'));
});
})();

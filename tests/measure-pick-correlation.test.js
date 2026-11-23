// tests/measure-pick-correlation.test.js -- 2026-11-23. The pick-correlation measurement's machinery on fixtures,
// committed BEFORE its first run: Pearson, returns aligned by bar time, a pair with too few common bars skipped and
// counted, the effective number of independent positions, and the three-way reading at its edges.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-pick-correlation.mjs')).href);
const near = (a, b) => Math.abs(a - b) < 1e-9;

await run('the declared constants', () => {
  assert.deepStrictEqual([M.SCAN_REV, M.TRADE_REV, M.MIN_PICKS, M.MIN_COMMON, M.DRAWS, M.SEED], ['2c78d11', '98bcc07', 5, 30, 1000, 20261123]);
});

await run('Pearson: +1, -1, and none for a flat series', () => {
  assert.ok(near(M.pearson([1, 2, 3], [2, 4, 6]), 1)); assert.ok(near(M.pearson([1, 2, 3], [3, 2, 1]), -1));
  assert.strictEqual(M.pearson([1, 1, 1], [1, 2, 3]), null);
});

await run('returns are aligned by bar time, not by position; too few common intervals skips the pair', () => {
  const bars = (ts, cs) => ts.map((t, i) => ({ t, c: cs[i] }));
  const T = Array.from({ length: 40 }, (_, i) => `2026-11-13T15:${String(i).padStart(2, '0')}:00Z`);
  const a = M.barReturns(bars(T, T.map((_, i) => 10 + Math.sin(i))));
  const b = M.barReturns(bars(T.slice(5), T.slice(5).map((_, i) => 20 + 2 * Math.sin(i + 5)))); // same moves, a later start
  assert.ok(M.pairCorr(a, b) > 0.99, 'aligned by time: the same moves correlate');
  assert.strictEqual(M.pairCorr(a, b, 100), null, 'fewer common intervals than required: skipped');
  const m = M.meanPairwise([a, b, new Map()]);
  assert.strictEqual(m.pairs, 1); assert.strictEqual(m.skipped, 2);
});

await run('effective independent positions: n at r 0, 1 at r 1', () => {
  assert.strictEqual(M.effectiveN(48, 0), 48); assert.ok(near(M.effectiveN(48, 1), 1)); assert.ok(near(M.effectiveN(48, 0.2), 48 / (1 + 47 * 0.2)));
  assert.strictEqual(M.effectiveN(48, null), null);
});

await run('the reading: every day above the 95th is MUCH MORE; none is NO MORE; otherwise MIXED', () => {
  assert.strictEqual(M.reading([{ percentile: 99 }, { percentile: 96 }]), 'MUCH MORE CORRELATED');
  assert.strictEqual(M.reading([{ percentile: 95 }, { percentile: 10 }]), 'NO MORE THAN RANDOM', '95 exactly is not above');
  assert.strictEqual(M.reading([{ percentile: 99 }, { percentile: 50 }]), 'MIXED');
});
})();

// tests/power-selection-differential.test.js -- 2026-11-23. The power calculation's arithmetic on fixtures, committed
// BEFORE its first run: the variance components recover a known day and trade variance, the day count and the smallest
// detectable effect follow the stated formulas, and the declared constants.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/power-selection-differential.mjs')).href);
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

await run('the declared constants', () => {
  assert.deepStrictEqual([M.EFFECT, M.Z_ALPHA, M.Z_POWER, M.HORIZON, M.PACES], [0.52, 1.645, 0.842, 60, [10, 20, 40]]);
  assert.deepStrictEqual(M.HISTORY_DAYS.map(d => d.mean), [0.26, 0.69, 0.30, 0.07]);
});

await run('variance components: no day effect gives s2Day 0; a pure day effect gives s2Trade 0', () => {
  const none = [[1, -1, 1, -1], [1, -1, 1, -1], [1, -1, 1, -1]];
  const c = M.varianceComponents(none);
  assert.strictEqual(c.s2Day, 0); assert.ok(near(c.s2Trade, 4 * 3 / 9), JSON.stringify(c));
  const pure = [[2, 2, 2], [-2, -2, -2], [0, 0, 0]];
  const p = M.varianceComponents(pure);
  assert.strictEqual(p.s2Trade, 0); assert.ok(near(p.s2Day, 4), JSON.stringify(p));
  // both: day means +2 and -2 with noise +-1. MSW = 4/2 = 2, MSB = 16, n0 = 2, so s2Day = (16 - 2) / 2 = 7, not 8
  const mixed = M.varianceComponents([[3, 1], [-1, -3]]);
  assert.ok(near(mixed.s2Day, 7) && near(mixed.s2Trade, 2), JSON.stringify(mixed));
});

await run('days needed and the smallest detectable effect, by the stated formulas, and inverse to each other', () => {
  const v = 9; // a day-mean SD of 3 points
  const d = M.daysNeeded(0.52, v);
  assert.strictEqual(d, Math.ceil((1.645 + 0.842) ** 2 * 9 / 0.52 ** 2));
  assert.ok(M.smallestDetectable(d, v) <= 0.52 && M.smallestDetectable(d - 1, v) > 0.52, 'd is the first day count that reaches the effect');
  assert.ok(near(M.dayMeanVariance({ s2Day: 1, s2Trade: 20 }, 10), 3));
  assert.ok(near(M.sampleVariance([1, 2, 3]), 1));
});
})();

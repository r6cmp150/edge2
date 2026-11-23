// tests/measure-selection-differential.test.js -- 2026-11-23. The standing selection differential's machinery, on
// fixtures, committed BEFORE its first run: the price at a minute (never a later bar, never beyond the lookback), the
// universe's mean with unpriced stocks left out and counted, and the statement that it begins 11-12.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-selection-differential.mjs')).href);
const T = m => Date.parse('2026-11-13T15:00:00Z') + m * 60000;
const bar = (m, c) => ({ t: new Date(T(m)).toISOString(), c });

await run('the declared constants', () => {
  assert.deepStrictEqual([M.FIRST_DAY, M.LOOKBACK_MIN, M.BENCH], ['2026-11-12', 15, 'IWM']);
});

await run('the price at a minute: the latest bar at or before it, within 15 minutes, never after', () => {
  assert.strictEqual(M.priceAt([bar(-3, 9), bar(0, 10), bar(1, 99)], T(0)), 10);
  assert.strictEqual(M.priceAt([bar(-3, 9), bar(1, 99)], T(0)), 9);
  assert.strictEqual(M.priceAt([bar(-16, 9)], T(0)), null, 'older than the lookback: not a price at this minute');
  assert.strictEqual(M.priceAt([], T(0)), null);
});

await run('the universe mean leaves out a stock without a price at either end, and counts it', () => {
  const at1 = { A: [bar(0, 10)], B: [bar(0, 20)], C: [bar(-30, 5)] }, at2 = { A: [bar(60, 11)], B: [bar(60, 18)], C: [bar(60, 6)] };
  const u = M.universeReturn(at1, at2, ['A', 'B', 'C', 'D'], T(0), T(60));
  assert.ok(Math.abs(u.value - (10 + -10) / 2) < 1e-9, 'A +10%, B -10%; C too old at the start, D no bars');
  assert.deepStrictEqual([u.covered, u.of], [2, 4]);
  assert.strictEqual(M.universeReturn({}, {}, ['A'], T(0), T(1)).value, null);
});

await run('it says where it begins, first and last, and that it is the figure about picking', () => {
  const src = readSource('scripts/measure-selection-differential.mjs');
  assert.ok(M.BEGINS.startsWith('THE SELECTION DIFFERENTIAL BEGINS 2026-11-12') && M.BEGINS.includes('nothing earlier can be computed'));
  assert.ok(src.includes("console.log(BEGINS + '\\n');") && src.includes('console.log(`\\n${BEGINS}`);'));
  assert.ok(src.includes('the universe against IWM over the same windows'), 'the explanation 7e15b5b needs is printed beside it');
});
})();

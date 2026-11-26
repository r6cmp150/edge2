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

await run('the start line: one declared instant; a position counts only if it was added after it; history is apart', () => {
  assert.strictEqual(M.START_LINE, '2026-11-26T20:31:43.000Z', 'the restart of 2026-11-26 (b86d5c3 served)');
  assert.strictEqual(M.afterStart({ position_id: String(Date.parse('2026-11-26T20:31:44Z')) }), true);
  assert.strictEqual(M.afterStart({ position_id: String(Date.parse('2026-11-26T20:31:42Z')) }), false, 'not after: before the build was served');
  assert.strictEqual(M.afterStart({ position_id: String(Date.parse(M.START_LINE)) }), false, 'the instant itself is not after it');
  assert.strictEqual(M.afterStart({ position_id: null, buy_date: '2026-11-27', buy_time: '07:00' }), true, 'no position_id: the Pacific buy minute');
  // the first attempt's positions are OUTSIDE the test, by the start line (the reviewer, 2026-11-26)
  assert.strictEqual(M.afterStart({ position_id: String(Date.parse('2026-11-24T17:17:00Z')) }), false, 'the first add under the first line (11-24 17:17Z) is outside');
  assert.strictEqual(M.afterStart({ position_id: null, buy_date: '2026-11-25', buy_time: '12:59' }), false, 'an 11-25 add is outside');
  assert.strictEqual(M.afterStart({ position_id: '1795000000000', buy_date: '2026-11-17', buy_time: '07:00' }), false, 'a 11-17 add is before the line');
  assert.ok(M.BEGINS.startsWith('THE FORWARD SELECTION DIFFERENTIAL BEGINS AT THE START LINE, 2026-11-26T20:31:43Z'));
  assert.ok(M.BEGINS.includes('never the test'));
  const src = readSource('scripts/measure-selection-differential.mjs');
  assert.ok(src.includes("NO CLOSED POSITION opened after the start line yet: nothing to report, which is not zero."));
});

await run('it says where it begins, first and last, and that it is the figure about picking', () => {
  const src = readSource('scripts/measure-selection-differential.mjs');
  assert.ok(M.BEGINS_DATA.includes('nothing earlier can be computed'));
  assert.ok(src.includes("console.log(BEGINS + ' ' + BEGINS_DATA + '\\n');") && src.includes('console.log(`\\n${BEGINS}`);'));
  assert.ok(src.includes('the universe against IWM over the same windows'), 'the explanation 7e15b5b needs is printed beside it');
});
})();

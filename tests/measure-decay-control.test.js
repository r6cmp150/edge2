// tests/measure-decay-control.test.js -- 2026-11-23. The decay control's machinery, committed BEFORE its first run: the
// close N trading days after the SALE (counted in bars, not calendar days), excess decay against the benchmark, and the
// three-way reading at its edges.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-decay-control.mjs')).href);
const near = (a, b) => Math.abs(a - b) < 1e-9;

await run('the close N TRADING days after the sale: counted in bars, so a weekend is skipped', () => {
  const bars = ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'].map((d, i) => ({ t: `${d}T05:00:00Z`, c: 10 + i }));
  assert.strictEqual(M.closeAfter(bars, '2026-11-06', 1), 12, 'Friday + 1 trading day = Monday');
  assert.strictEqual(M.closeAfter([...bars].reverse(), '2026-11-05', 2), 12, 'order does not matter');
  assert.strictEqual(M.closeAfter(bars, '2026-11-10', 1), null, 'past the data');
  assert.strictEqual(M.closeAfter(bars, '2026-11-07', 1), null, 'no bar on the sale date');
});

await run('excess decay: holding past the exit, beyond what the benchmark did over the same windows', () => {
  const stock = { exit: 1, h: { 1: -1, 2: -2, 5: -3 } }, bench = { exit: 0.5, h: { 1: 0, 2: -1, 5: -0.5 } };
  const d = M.excessDecay(stock, bench);
  assert.ok(near(d[1], (-1 - 0) - (1 - 0.5)) && near(d[2], -1 - 0.5) && near(d[5], -2.5 - 0.5));
  const same = M.excessDecay(stock, stock);
  assert.ok([1, 2, 5].every(n => near(same[n], 0)), 'a stock against itself has no excess decay');
});

await run('the reading: MARKET when every interval holds zero; SPECIFIC needs monotone means AND all intervals below zero', () => {
  const iv = (lo, hi) => ({ lo, hi });
  assert.strictEqual(M.reading({ 1: iv(-1, 1), 2: iv(-1, 1), 5: iv(-2, 0.5) }, { 1: 0, 2: -0.1, 5: -0.5 }), 'MARKET');
  assert.strictEqual(M.reading({ 1: iv(-2, -0.1), 2: iv(-3, -0.5), 5: iv(-4, -1) }, { 1: -1, 2: -2, 5: -3 }), 'SPECIFIC');
  assert.strictEqual(M.reading({ 1: iv(-2, -0.1), 2: iv(-3, -0.5), 5: iv(-4, -1) }, { 1: -1, 2: -3, 5: -2 }), 'NOT ESTABLISHED', 'not monotone');
  assert.strictEqual(M.reading({ 1: iv(-1, 0.5), 2: iv(-3, -0.5), 5: iv(-4, -1) }, { 1: -0.2, 2: -2, 5: -3 }), 'NOT ESTABLISHED', 'one interval holds zero, the others do not');
});

await run('declared: IWM labelled the weaker proxy, the universe apart, the window printed first and last', () => {
  const src = readSource('scripts/measure-decay-control.mjs');
  assert.deepStrictEqual([M.REV, M.FROM, M.HORIZONS], ['98bcc07', '2026-10-23', [1, 2, 5]]);
  assert.ok(src.includes('IWM over the same windows (THE WEAKER PROXY)'));
  assert.ok(src.includes('THE SCANNED UNIVERSE, where it exists') && src.includes('apart, beside IWM on the same trades'));
  assert.ok(M.WINDOW.includes('2026-10-27 to 2026-11-13') && src.includes("console.log(WINDOW + '\\n');") && src.includes('console.log(`\\n${WINDOW}`);'));
});
})();

// tests/measure-forward-test.test.js -- 2026-11-25. The forward test's measures B and C, on fixtures, built and tested
// BEFORE the first evaluation (and not run on the live positions: that would be an early look). The qualifying-day
// unit and backstop, the first 60 qualifying days only, the watch line read from the scorer, the readings at their
// edges, and the SD-ratio interval in both directions.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-forward-test.mjs')).href);
const iv = (lo, hi) => ({ lo, hi });

await run('the declared constants, and the watch line read from the scorer (v3: 20)', () => {
  assert.deepStrictEqual([M.QUALIFYING_DAYS, M.BACKSTOP_TRADING_DAYS, M.FIRST_QUALIFYING, M.HORIZONS, M.HURDLE], [60, 180, '2026-11-24', [0, 1, 2, 5], 0.291]);
  assert.strictEqual(M.watchLine(readSource('core/edge-scoring.js')), 20);
  assert.throws(() => M.watchLine('no table'), /no version-3 watch line/);
});

await run('the state: EVALUATE at 60 qualifying days; NOT ESTABLISHED FOR WANT OF DAYS past the backstop; INTERIM otherwise', () => {
  assert.strictEqual(M.testState(60, 90), 'EVALUATE');
  assert.strictEqual(M.testState(60, 400), 'EVALUATE', 'reaching 60 decides it, whenever');
  assert.strictEqual(M.testState(59, 181), 'NOT ESTABLISHED FOR WANT OF DAYS');
  assert.strictEqual(M.testState(59, 180), 'INTERIM', '180 itself is still inside the backstop');
  assert.strictEqual(M.testState(2, 2), 'INTERIM');
});

await run('qualifying days are days with a position opened; only the first 60 are in the test', () => {
  const ps = Array.from({ length: 70 }, (_, i) => ({ buy_date: new Date(Date.UTC(2026, 10, 24) + i * 864e5).toISOString().slice(0, 10) }));
  ps.push({ buy_date: ps[0].buy_date });
  const q = M.qualifying(ps);
  assert.strictEqual(q.days.length, 70, 'a second position on a day is not a second day');
  assert.strictEqual(new Set(q.positions.map(p => p.buy_date)).size, 60);
  assert.ok(!q.positions.some(p => p.buy_date > q.days[59]), 'nothing after the 60th qualifying day');
});

await run('B: SPECIFIC needs monotone excess AND all three intervals below zero', () => {
  assert.strictEqual(M.readingB({ 1: iv(-2, -0.1), 2: iv(-3, -0.5), 5: iv(-4, -1) }, { 1: -1, 2: -2, 5: -3 }), 'SPECIFIC');
  assert.strictEqual(M.readingB({ 1: iv(-2, 0.1), 2: iv(-3, -0.5), 5: iv(-4, -1) }, { 1: -1, 2: -2, 5: -3 }), 'NOT SPECIFIC');
  assert.strictEqual(M.readingB({ 1: iv(-2, -0.1), 2: iv(-3, -0.5), 5: iv(-4, -1) }, { 1: -1, 2: -3, 5: -2 }), 'NOT SPECIFIC');
});

await run('C: movement from the SD ratio interval above 1; return from the mean interval', () => {
  assert.deepStrictEqual(M.readingC(iv(0.1, 0.5), iv(1.2, 2)), { movement: 'SELECTS FOR MOVEMENT', ret: 'ADDS RETURN' });
  assert.deepStrictEqual(M.readingC(iv(-0.5, -0.1), iv(0.9, 2)), { movement: 'NOT SHOWN TO SELECT FOR MOVEMENT', ret: 'COSTS RETURN' });
  assert.deepStrictEqual(M.readingC(iv(-0.5, 0.5), iv(1, 2)), { movement: 'NOT SHOWN TO SELECT FOR MOVEMENT', ret: 'NO RETURN DIFFERENCE SHOWN' });
});

await run('the SD ratio interval: wild picks against calm others sit above 1; alike, it holds 1', () => {
  const wild = [], alike = [];
  for (let d = 0; d < 20; d++) for (let k = 0; k < 4; k++) {
    const calm = [-0.5, 0.5, -0.4, 0.4, -0.3, 0.3];
    wild.push({ day: `D${d}`, opened: (k % 2 ? 4 : -4) + d * 0.01, notOpened: calm });
    alike.push({ day: `D${d}`, opened: [-0.5, 0.5, -0.4, 0.4][k], notOpened: calm });
  }
  assert.ok(M.sdRatioInterval(wild, { resamples: 1000 }).lo > 1);
  const a = M.sdRatioInterval(alike, { resamples: 1000 });
  assert.ok(a.lo <= 1.2 && a.hi >= 0.8, JSON.stringify(a));
});

await run('interim prints progress and no reading; the count is on every run\'s first and last line', () => {
  const src = readSource('scripts/measure-forward-test.mjs');
  assert.ok(src.includes("INTERIM: figures below are progress, NOT a reading; no interval is compared with any bar."));
  assert.ok(src.includes("${q.days.length} of ${QUALIFYING_DAYS} QUALIFYING DAYS"));
  assert.ok(/state === 'EVALUATE' \? ` -> \$\{Object\.values\(readingC/.test(src) && src.includes("if (state === 'EVALUATE' && [1, 2, 5].every(n => ivB[n]))"), 'readings only when evaluating');
});
})();

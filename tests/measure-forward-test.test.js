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
  assert.ok(src.includes("const evaluating = state === 'EVALUATE';"), 'evaluating means EVALUATE');
  assert.ok(src.includes("${evaluating ? ` -> ${Object.values(readingC(iv, riv))"), 'C reading only when evaluating');
  assert.ok(src.includes("${evaluating ? ` -> ${readingA(iv)}` : ''}"), 'A reading only when evaluating');
  assert.ok(src.includes("if (evaluating && [1, 2, 5].every(n => ivB[n]))"), 'B reading only when evaluating');
});

await run('THE FUTILITY RULE: FUTILE only when A and B both sit at or below zero with the upper end under the hurdle', () => {
  const m = (mean, hi) => ({ mean, hi });
  assert.strictEqual(M.FUTILITY_AT, 30);
  assert.strictEqual(M.futility(m(-0.1, 0.2), m(-0.2, 0.1)), 'FUTILE');
  assert.strictEqual(M.futility(m(0, 0.29), m(0, 0.29)), 'FUTILE', 'zero exactly counts as at or below zero');
  assert.strictEqual(M.futility(m(-0.1, 0.291), m(-0.2, 0.1)), 'CONTINUE', 'an upper end AT the hurdle could still pay for the spread');
  assert.strictEqual(M.futility(m(0.01, 0.2), m(-0.2, 0.1)), 'CONTINUE', 'A above zero');
  assert.strictEqual(M.futility(m(-0.1, 0.2), m(-0.2, 0.5)), 'CONTINUE', 'B could still clear the hurdle');
  const seen = new Set();
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) for (const h of [0, 0.3, 2]) seen.add(M.futility(m(a, h), m(b, h)));
  assert.deepStrictEqual([...seen].sort(), ['CONTINUE', 'FUTILE'], 'the look can only stop or continue: no positive is in its range');
  const src = readSource('scripts/lib/forward-declaration.mjs');
  const body = src.slice(src.indexOf('export function futility'), src.indexOf('export function lookState')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/SHOWN|POSITIVE|SPECIFIC|EXTEND|ADDS/.test(body), 'no positive verdict word in the look');
});

await run('the look: not before 30 qualifying days; then only on its fixed set, once complete', () => {
  assert.strictEqual(M.lookState(29, true), 'NOT YET');
  assert.strictEqual(M.lookState(30, false), 'PENDING');
  assert.strictEqual(M.lookState(30, true), 'TAKE');
  assert.strictEqual(M.lookState(41, true), 'TAKE', 'a later run sees the same fixed set, so the same one look');
  const st = new Map([[1, 'DONE'], [2, 'UNPRICED'], [3, 'OPEN'], [4, 'PENDING']]);
  assert.strictEqual(M.lookSetComplete([1, 2], st), true, 'unpriced for good does not hold it up');
  assert.strictEqual(M.lookSetComplete([1, 3], st), false, 'a position not yet sold holds it up');
  assert.strictEqual(M.lookSetComplete([1, 4], st), false, 'a +5 not yet happened holds it up');
  assert.strictEqual(M.lookSetComplete([1, 5], st), false, 'an unmeasured position holds it up');
  const ps = Array.from({ length: 40 }, (_, i) => ({ buy_date: new Date(Date.UTC(2026, 10, 24) + i * 864e5).toISOString().slice(0, 10) }));
  assert.strictEqual(new Set(M.qualifying(ps, 30).positions.map(p => p.buy_date)).size, 30, 'the look set is the first 30 qualifying days');
  const src = readSource('scripts/measure-forward-test.mjs');
  const take = src.indexOf("if (ls === 'TAKE') {"), print = src.indexOf('THE FUTILITY LOOK (the first');
  assert.ok(take > 0 && print > take && print < src.indexOf("} else if (ls === 'PENDING')"), 'the comparison is printed inside TAKE only');
  assert.ok(src.includes('lookPids.has(r.position_id)') && src.includes('r.n === 0 && inLook.has(r.id)'), 'the look uses only its fixed set, and B at +0');
});

await run('C is computed only while include_under2 is true; otherwise it says so', () => {
  assert.deepStrictEqual(M.cComputable([{ include_under2: true }]), { ok: true });
  assert.strictEqual(M.cComputable([{ include_under2: false }]).ok, false);
  assert.strictEqual(M.cComputable([]).ok, false, 'no settings row is not permission');
  assert.ok(readSource('scripts/measure-forward-test.mjs').includes('for (const n of cGuard.ok ? HORIZONS : [])'));
});

await run('FUTILE is final: it overrides EVALUATE and the backstop; CONTINUE changes nothing', () => {
  assert.strictEqual(M.testState(60, 100, 'FUTILE'), 'FUTILE');
  assert.strictEqual(M.testState(30, 200, 'FUTILE'), 'FUTILE');
  assert.strictEqual(M.testState(30, 40, 'CONTINUE'), 'INTERIM');
  assert.strictEqual(M.testState(60, 100, 'CONTINUE'), 'EVALUATE');
});

await run('A reads SHOWN only above zero; the differential is cut to the first 60 qualifying days and prints the count', () => {
  assert.strictEqual(M.readingA({ lo: 0.01, hi: 1 }), 'PICKING SHOWN');
  assert.strictEqual(M.readingA({ lo: 0, hi: 1 }), 'PICKING NOT SHOWN');
  const d = readSource('scripts/measure-selection-differential.mjs');
  assert.ok(d.includes('const q = qualifying([...closed, ...open]), inTest = new Set(q.positions);'));
  assert.ok(d.includes('${q.days.length} of ${QUALIFYING_DAYS} QUALIFYING DAYS'));
  assert.ok(d.includes('closed = closed.filter(r => inTest.has(r)); open = open.filter(r => inTest.has(r));'), 'both lists cut to the first 60 qualifying days');
});
})();

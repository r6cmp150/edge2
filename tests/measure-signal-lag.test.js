// tests/measure-signal-lag.test.js -- 2026-11-22 (the reviewer). The signal-lag measurement, on fixtures, written and
// committed with the script BEFORE its first run on the data: every trade in exactly one state, the same-day sighting
// before an earlier day's, a sighting after the buy never read as a lag of 0, BELOW_THRESHOLD not counted as shown,
// the buy moment from position_id when present, and the declared reading's three outcomes at their edges.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-signal-lag.mjs')).href);
const row = (symbol, date, iso, tier = 'SHOWN', build_version = null) => ({ symbol, signal_date: date, first_shown_at: iso, tier, build_version });
const trade = (o = {}) => ({ ticker: 'ABC', buy_date: '2026-10-05', buy_time: '08:00', position_id: null, ...o }); // 08:00 PDT = 15:00Z

await run('the declared constants', () => {
  assert.deepStrictEqual([M.REV, M.LOG_FIRST_DAY, M.LOOKBACK_DAYS, M.MIN_MEASURED, M.SMALL_MEDIAN_MIN, M.SMALL_WITHIN_MIN], ['314f6e0', '2026-09-11', 7, 293, 15, 30]);
  assert.ok(Math.abs(M.SMALL_SHARE - 2 / 3) < 1e-12);
});

await run('the buy moment: position_id when present, else the Pacific minute', () => {
  assert.strictEqual(M.buyMoment(trade()), Date.parse('2026-10-05T15:00:00Z'));
  assert.strictEqual(M.buyMoment(trade({ position_id: '1791212345678' })), 1791212345678);
  assert.strictEqual(M.buyMoment(trade({ buy_date: '2026-11-05', buy_time: '06:50' })), Date.parse('2026-11-05T14:50:00Z'), 'PST from 11-01');
});

await run('SAME_DAY uses the earliest same-day sighting; other tickers and BELOW_THRESHOLD are ignored', () => {
  const rows = [row('ABC', '2026-10-05', '2026-10-05T14:20:00Z'), row('ABC', '2026-10-05', '2026-10-05T13:30:00Z', 'BELOW_THRESHOLD'), row('XYZ', '2026-10-05', '2026-10-05T13:00:00Z'), row('ABC', '2026-10-02', '2026-10-02T14:00:00Z')];
  const c = M.classify(trade(), rows);
  assert.strictEqual(c.state, 'SAME_DAY'); assert.strictEqual(c.lagMin, 40);
});

await run('EARLIER_DAY: no same-day sighting at or before the buy, the latest earlier-day sighting within 7 days', () => {
  const rows = [row('ABC', '2026-10-01', '2026-10-01T14:00:00Z'), row('ABC', '2026-10-02', '2026-10-02T15:00:00Z'), row('ABC', '2026-09-27', '2026-09-27T15:00:00Z')];
  const c = M.classify(trade(), rows);
  assert.strictEqual(c.state, 'EARLIER_DAY'); assert.strictEqual(c.lagMin, 3 * 24 * 60);
  assert.strictEqual(M.classify(trade(), [row('ABC', '2026-09-27', '2026-09-27T15:00:00Z')]).state, 'NO_SIGNAL', '8 days back is outside the window');
});

await run('a same-day sighting AFTER the buy is LOGGED_AFTER, never a lag of 0; an earlier day wins over it', () => {
  const after = [row('ABC', '2026-10-05', '2026-10-05T18:00:00Z')];
  const c = M.classify(trade(), after);
  assert.strictEqual(c.state, 'LOGGED_AFTER'); assert.strictEqual(c.afterMin, 180); assert.strictEqual(c.lagMin, undefined);
  assert.strictEqual(M.classify(trade(), [...after, row('ABC', '2026-10-03', '2026-10-03T15:00:00Z')]).state, 'EARLIER_DAY');
});

await run('NO_SIGNAL, split by a BELOW_THRESHOLD row; PRE_LOG before the log began', () => {
  assert.deepStrictEqual(M.classify(trade(), [row('ABC', '2026-10-05', '2026-10-05T14:00:00Z', 'BELOW_THRESHOLD')]), { state: 'NO_SIGNAL', below: true });
  assert.deepStrictEqual(M.classify(trade(), []), { state: 'NO_SIGNAL', below: false });
  assert.deepStrictEqual(M.classify(trade({ buy_date: '2026-09-10' }), [row('ABC', '2026-09-10', '2026-09-10T14:00:00Z')]), { state: 'PRE_LOG' });
  assert.strictEqual(M.classify(trade({ buy_date: '2026-09-11', buy_time: '08:00' }), [row('ABC', '2026-09-11', '2026-09-11T14:00:00Z')]).state, 'SAME_DAY', 'the first day counts');
});

await run('the reading: NOT ESTABLISHED under 293; SMALL needs the median <= 15 AND two thirds within 30; else LARGE', () => {
  assert.strictEqual(M.reading(Array(292).fill(1)), 'NOT ESTABLISHED');
  assert.strictEqual(M.reading(Array(293).fill(15)), 'SMALL');
  assert.strictEqual(M.reading(Array(293).fill(15.5)), 'LARGE', 'median over 15');
  const lopsided = [...Array(150).fill(1), ...Array(150).fill(31)]; // median 16 -> LARGE either way; build one that splits the halves
  assert.strictEqual(M.reading(lopsided), 'LARGE');
  const fewWithin = [...Array(160).fill(10), ...Array(140).fill(45)]; // median 10, but 160/300 < 2/3 within 30
  assert.strictEqual(M.reading(fewWithin), 'LARGE', 'the second half of the bar binds');
  assert.strictEqual(M.reading([...Array(200).fill(10), ...Array(100).fill(45)]), 'SMALL', 'exactly two thirds within 30');
});

await run('the lag table counts every SAME_DAY once and EARLIER_DAY apart; quantile interpolates', () => {
  const res = [0, 4.9, 5, 14, 15, 29, 30, 59, 60, 179, 180, 600].map(l => ({ state: 'SAME_DAY', lagMin: l })).concat([{ state: 'EARLIER_DAY', lagMin: 2000 }, { state: 'LOGGED_AFTER' }]);
  assert.deepStrictEqual(M.lagTable(res).map(b => b.n), [2, 2, 2, 2, 2, 2, 1]);
  assert.strictEqual(M.quantile([1, 2, 3, 4], 0.5), 2.5); assert.strictEqual(M.quantile([], 0.5), null);
});

await run('the output says the score test is not re-run, and prints the three readings as declared', () => {
  const src = readSource('scripts/measure-signal-lag.mjs');
  assert.ok(M.NO_RERUN.startsWith('IN NO CASE IS THE SCORE TEST RE-RUN'));
  assert.ok(src.includes('console.log(NO_RERUN);'));
  assert.ok(src.includes('downgrades from "no relationship" to "not established on this sample"'));
  assert.ok(!/score-vs-return/.test(src.replace(/^\/\/.*$/gm, '')), 'the score test is not imported');
});
})();

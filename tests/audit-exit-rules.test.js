// tests/audit-exit-rules.test.js — 2026-11-06. The exit-rule replay: a rule's fill must be one the bars allow, the
// stop must not see the bar that armed it, a gap fills at the open, and the summary reports the total without its
// single best contributor and per day, because a rule acting on a position gets one big winner by chance.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, readSource, REPO_ROOT } = require('./_lib');

(async () => {
const m = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-exit-rules.mjs')).href);
const bar = (t, o, h, l) => ({ t: `2026-10-08T${t}:00Z`, o, h, l });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

await run('a trailing stop arms on a bar\'s high, and only the NEXT bar can hit it', () => {
  // buy 10: the 14:00 bar reaches 10.30 (+3%) and falls to 10.10 inside the same bar: not a stop, order unknown
  const bars = [bar('14:00', 10, 10.3, 10.1), bar('14:01', 10.25, 10.4, 10.25), bar('14:02', 10.35, 10.35, 10.2)];
  const e = m.trailingExit(bars, 10, 3, 1);
  near(e.price, 10.3, 'peak 10.40 is +4%, so the stop is +3% = 10.30');
  assert.strictEqual(e.at, '2026-10-08T14:02:00Z');
  assert.strictEqual(m.trailingExit([bar('14:00', 10, 10.3, 9.0)], 10, 3, 1), null, 'arming and falling in one bar is no exit');
  assert.strictEqual(m.trailingExit([bar('14:00', 10, 10.2, 9.5)], 10, 3, 1), null, 'never armed, never exits: the actual sale stands');
});

await run('a gap below the stop fills at the open; a gap above the target fills at the open', () => {
  const e = m.trailingExit([bar('14:00', 10, 10.5, 10.4), bar('14:01', 9.8, 9.9, 9.7)], 10, 3, 1);
  near(e.price, 9.8, 'opened below the 10.40 stop');
  const f = m.fixedExit([bar('14:00', 10, 10.1, 9.9), bar('14:01', 10.6, 10.7, 10.5)], 10, 3);
  near(f.price, 10.6, 'opened above the 10.30 target');
  near(m.fixedExit([bar('14:00', 10, 10.31, 9.9)], 10, 3).price, 10.3, 'reached inside the bar: the target');
  assert.strictEqual(m.fixedExit([bar('14:00', 10, 10.29, 9.9)], 10, 3), null);
});

await run('the hold is the regular session between the fill and the recorded sale', () => {
  const t = { buy_date: '2026-10-08', sell_date: '2026-10-08', buy_time: '06:31', filled_at: '2026-10-08T14:00:00Z', sell_time: '12:00' };
  const bars = [bar('12:00', 1, 1, 1), bar('13:59', 1, 9, 1), bar('14:05', 1, 2, 1), bar('19:30', 1, 9, 1), bar('20:30', 1, 9, 1)];
  assert.deepStrictEqual(m.holdBars(t, bars).map(b => b.t), ['2026-10-08T14:05:00Z'], 'not pre-market, not before the fill, not after the recorded sale');
});

await run('the summary: without the best contributor, and by day', () => {
  const row = (delta, day, fired = true) => ({ t: { ticker: 'X', buy_date: day }, exit: fired ? { price: 1 } : null, day, delta });
  const s = m.summarise([row(100, 'a'), row(-30, 'a'), row(-20, 'b'), row(0, 'c', false)]);
  assert.strictEqual(s.total, 50); assert.strictEqual(s.withoutBest, -50, 'the +100 alone carried it');
  near(s.perTradeWithoutBest, -50 / 3, 'per trade over the rest');
  assert.strictEqual(s.better, 1); assert.strictEqual(s.worse, 2);
  assert.strictEqual(s.daysUp, 1); assert.strictEqual(s.daysDown, 1); assert.strictEqual(s.allDays, 3);
  assert.deepStrictEqual(s.largestDay, ['a', 70]);
});

await run('the spec records the replay, with its limits in the same breath', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  for (const s of ['**Exit rules, replayed (2026-11-06): none clears the +$2.25-a-trade bar.**', 'the peak runs to the recorded sale time', 'the sample is days, not trades', 'AIXI']) assert.ok(spec.includes(s), s);
});

await run('a row with no sell_time is its own state: holdBars refuses it rather than run the hold to 13:00', () => {
  const t = { buy_date: '2026-10-08', sell_date: '2026-10-08', buy_time: '06:31', filled_at: '2026-10-08T14:00:00Z', ticker: 'X' };
  assert.throws(() => m.holdBars({ ...t, sell_time: null }, []), /no sale time/);
  assert.throws(() => m.holdBars(t, []), /no sale time/);
});
})();

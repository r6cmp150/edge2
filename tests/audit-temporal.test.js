// tests/audit-temporal.test.js -- 2026-11-22. The temporal audit's detectors on fixtures, with the real
// core/clock.js classifySession: each impossibility is found when present and not when absent, a same-minute round trip
// is its own (possible) state rather than an exit before its entry (the first run's mixed-precision artefact), a
// Sunday is a non-trading date, and a repeated lot is found by position_id or, without one, as a candidate.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-temporal.mjs')).href);
const cs = M.loadClassifySession(readSource('core/clock.js'));
const row = (o = {}) => ({ id: 'x', ticker: 'ABC', shares: 10, buy_price: 5, buy_date: '2026-10-05', buy_time: '08:00', sell_date: '2026-10-06', sell_time: '09:00', position_id: null, filled_at: null, sell_filled_at: null, ...o });
const count = a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.length]));
const zero = { EXIT_BEFORE_ENTRY: 0, SAME_MINUTE: 0, DATE_ORDER: 0, EXIT_OUTSIDE_SESSION: 0, ENTRY_OUTSIDE_SESSION: 0, TWO_EXITS_ONE_LOT: 0, EXIT_WITH_NO_ENTRY: 0 };

await run('a clean trade trips nothing', () => {
  assert.deepStrictEqual(count(M.audit([row()], cs)), zero);
});

await run('an exit before its entry, by minute and by date; a same-minute round trip is SAME_MINUTE, not an impossibility', () => {
  assert.deepStrictEqual(count(M.audit([row({ sell_date: '2026-10-05', sell_time: '07:59' })], cs)), { ...zero, EXIT_BEFORE_ENTRY: 1 });
  assert.deepStrictEqual(count(M.audit([row({ sell_date: '2026-10-02', sell_time: '09:00' })], cs)), { ...zero, EXIT_BEFORE_ENTRY: 1, DATE_ORDER: 1 });
  // APPS's shape: a typed buy fill with seconds, the sale at its recorded minute
  const apps = row({ buy_date: '2026-11-05', buy_time: '08:37', filled_at: '2026-11-05T16:37:15.994+00:00', sell_date: '2026-11-05', sell_time: '08:37' });
  assert.deepStrictEqual(count(M.audit([apps], cs)), { ...zero, SAME_MINUTE: 1 });
});

await run('outside any session: a Sunday is a non-trading date; 00:30 PT on a weekday is outside the hours; 06:00 PT pre-market is in', () => {
  const sun = M.audit([row({ buy_date: '2026-09-27', buy_time: '07:38', sell_date: '2026-09-28', sell_time: '07:18' })], cs);
  assert.strictEqual(sun.ENTRY_OUTSIDE_SESSION.length, 1); assert.strictEqual(sun.ENTRY_OUTSIDE_SESSION[0].why, 'non-trading date');
  const night = M.audit([row({ sell_date: '2026-10-06', sell_time: '00:30' })], cs);
  assert.strictEqual(night.EXIT_OUTSIDE_SESSION.length, 1); assert.strictEqual(night.EXIT_OUTSIDE_SESSION[0].why, 'outside the hours');
  assert.strictEqual(M.audit([row({ sell_time: '06:00' })], cs).EXIT_OUTSIDE_SESSION.length, 0);
  assert.strictEqual(M.audit([row({ sell_time: '16:59' })], cs).EXIT_OUTSIDE_SESSION.length, 0, 'after hours runs to 17:00 PT');
  assert.strictEqual(M.audit([row({ sell_time: '17:00' })], cs).EXIT_OUTSIDE_SESSION.length, 1);
});

await run('a typed fill places the moment over the recorded clock', () => {
  const r = row({ sell_time: '00:30', sell_filled_at: '2026-10-06T16:00:00Z' }); // recorded at night, filled 09:00 PT
  assert.strictEqual(M.audit([r], cs).EXIT_OUTSIDE_SESSION.length, 0);
});

await run('two exits on one lot: by a repeated position_id, or a candidate by ticker/date/price/shares', () => {
  const byId = M.audit([row({ id: 'a', position_id: '1' }), row({ id: 'b', position_id: '1' }), row({ id: 'c', position_id: '2' })], cs).TWO_EXITS_ONE_LOT;
  assert.strictEqual(byId.length, 1); assert.strictEqual(byId[0].candidate, false); assert.strictEqual(byId[0].rows.length, 2);
  const cand = M.audit([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', shares: 11 })], cs).TWO_EXITS_ONE_LOT;
  assert.strictEqual(cand.length, 1); assert.strictEqual(cand[0].candidate, true);
});

await run('an exit with no entry: no buy date, price, shares or time; and it is not checked further', () => {
  for (const o of [{ buy_date: null }, { buy_price: null }, { buy_price: '' }, { shares: 0 }, { buy_time: null }])
    assert.deepStrictEqual(count(M.audit([row(o)], cs)), { ...zero, EXIT_WITH_NO_ENTRY: 1 }, JSON.stringify(o));
});

await run('the record is pinned and the 586 are marked', () => {
  assert.strictEqual(M.REV, '98bcc07'); assert.strictEqual(M.SAMPLE_REV, '314f6e0');
  assert.ok(readSource('scripts/replay-budget-constrained.mjs').includes('No trade records an exit before its'), 'the replay\'s claim is corrected');
});
})();

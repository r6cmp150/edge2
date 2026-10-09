// tests/orders.test.js — core/orders.js (order vs fill, db/027) and
// core/clock.js holdSpan, under frozen clocks. Pins the fill rule's every
// branch, the holding/pending predicate, staleness, fill validation, and
// that hold duration starts at the fill when one is known.
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

const RealDate = Date;
function at(iso, fn) {
  const t = new RealDate(iso).getTime();
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } };
  try { return fn(); } finally { global.Date = RealDate; }
}
global.state = { settings: {}, portfolio: [] };
evalModule(readSource('core/clock.js'), { expose: ['getPT', 'ptDateStr', 'classifySession', 'ptWallClockToInstant', 'holdSpan', 'marketClosesHeld', 'marketDaysLabel', 'HOLD_RANGE_LABEL'] });
evalModule(readSource('core/orders.js'), { expose: ['isPendingOrder', 'getHoldings', 'getPendingOrders', 'isStalePendingOrder', 'orderEntryState', '_readFillInstant', 'ORDER_TYPES'] });
const PT = (d, h, m) => global.ptWallClockToInstant(d, h, m).toISOString();

run('order vs fill: predicate, fill rule, staleness, validation, holdSpan', () => {
  // predicate: legacy (orderType null) is a holding; orderType set + no fill is pending
  const legacy = { id: 'a', orderType: null, filledAt: null };
  const pendingLimit = { id: 'b', orderType: 'limit', filledAt: null, buyDate: '2026-10-09' };
  const filled = { id: 'c', orderType: 'limit', filledAt: '2026-10-09T15:00:00Z' };
  assert.strictEqual(global.isPendingOrder(legacy), false);
  assert.strictEqual(global.isPendingOrder(pendingLimit), true);
  assert.strictEqual(global.isPendingOrder(filled), false);
  global.state.portfolio = [legacy, pendingLimit, filled];
  assert.deepStrictEqual(global.getHoldings().map(p => p.id), ['a', 'c']);
  assert.deepStrictEqual(global.getPendingOrders().map(p => p.id), ['b']);

  // fill rule, today's order date, market order, by session (Fri 2026-10-09)
  const d = '2026-10-09';
  // Only REGULAR auto-fills. Extended hours are pending until Roman confirms what his broker does with a
  // plain market order there: a wrong 'pending' costs one tap, a wrong 'filled' fabricates filled_at.
  assert.strictEqual(at(PT(d, 5, 0), () => global.orderEntryState('market', d)).auto, 'pending'); // PRE_MARKET
  assert.strictEqual(at(PT(d, 10, 0), () => global.orderEntryState('market', d)).auto, 'filled'); // REGULAR
  assert.strictEqual(at(PT(d, 15, 0), () => global.orderEntryState('market', d)).auto, 'pending'); // AFTER_HOURS
  assert.match(at(PT(d, 15, 0), () => global.orderEntryState('market', d)).note, /after-hours/);
  assert.strictEqual(at(PT(d, 6, 29), () => global.orderEntryState('market', d)).auto, 'pending'); // one minute before the open
  assert.strictEqual(at(PT(d, 6, 30), () => global.orderEntryState('market', d)).auto, 'filled');  // the open
  assert.strictEqual(at(PT(d, 12, 59), () => global.orderEntryState('market', d)).auto, 'filled'); // last regular minute
  assert.strictEqual(at(PT(d, 13, 0), () => global.orderEntryState('market', d)).auto, 'pending'); // the close
  assert.strictEqual(at(PT('2026-11-27', 10, 30), () => global.orderEntryState('market', '2026-11-27')).auto, 'pending'); // after an early close
  assert.strictEqual(at(PT(d, 21, 0), () => global.orderEntryState('market', d)).auto, 'pending'); // CLOSED overnight: broker takes limits only
  assert.strictEqual(at(PT('2026-10-10', 10, 0), () => global.orderEntryState('market', '2026-10-10')).auto, 'pending'); // Saturday
  assert.strictEqual(at(PT('2026-11-26', 10, 0), () => global.orderEntryState('market', '2026-11-26')).auto, 'pending'); // Thanksgiving
  // non-market types never fill on placement; Roman chooses, default pending
  for (const [t] of global.ORDER_TYPES.filter(([v]) => v !== 'market')) {
    const st = at(PT(d, 10, 0), () => global.orderEntryState(t, d));
    assert.strictEqual(st.auto, null, t); assert.strictEqual(st.defaultFilled, false, t);
  }
  // entered after the fact: Roman chooses; a past market order defaults to filled
  const back = at(PT(d, 10, 0), () => global.orderEntryState('market', '2026-10-07'));
  assert.strictEqual(back.auto, null); assert.strictEqual(back.defaultFilled, true);

  // fill validation
  at(PT(d, 10, 0), () => {
    assert.match(global._readFillInstant('', '', d, 'limit').error, /fill date and time/);
    assert.match(global._readFillInstant('2026-10-08', '09:00', d, 'limit').error, /before the order date/);
    assert.match(global._readFillInstant(d, '12:00', d, 'limit').error, /future/);
    assert.strictEqual(global._readFillInstant(d, '07:31', d, 'limit').filledAt, PT(d, 7, 31));
  });

  // staleness: pending through >= 1 close
  const placedFri = { orderType: 'limit', filledAt: null, buyDate: '2026-10-09' };
  assert.strictEqual(at(PT('2026-10-09', 12, 0), () => global.isStalePendingOrder(placedFri)), false);
  assert.strictEqual(at(PT('2026-10-12', 8, 0), () => global.isStalePendingOrder(placedFri)), true); // sat through Friday's close
  const placedSun = { orderType: 'limit', filledAt: null, buyDate: '2026-09-27' };
  assert.strictEqual(at(PT('2026-09-28', 7, 0), () => global.isStalePendingOrder(placedSun)), false); // no close yet

  // holdSpan: from the fill when known, basis stated, closes not calendar
  assert.deepStrictEqual(global.holdSpan({ buyDate: '2026-10-02', orderType: null, filledAt: null }, '2026-10-05'),
    { startDate: '2026-10-02', basis: 'order date (legacy row)', closes: 1 }); // Fri -> Mon = 1
  assert.deepStrictEqual(global.holdSpan({ buyDate: '2026-09-27', orderType: 'limit', filledAt: PT('2026-09-28', 6, 31) }, '2026-09-29'),
    { startDate: '2026-09-28', basis: 'fill', closes: 1 });
  assert.strictEqual(global.holdSpan({ buyDate: '2026-10-09', orderType: 'limit', filledAt: null }, '2026-10-09').basis, 'order date (fill not recorded)');
  // one name, the report's number (no +1)
  assert.strictEqual(global.marketDaysLabel(0), 'Same day');
  assert.strictEqual(global.marketDaysLabel(1), '1 market day');
  assert.strictEqual(global.marketDaysLabel(2), '2 market days');
  assert.strictEqual(global.marketDaysLabel(null), '—');
  assert.deepStrictEqual(global.HOLD_RANGE_LABEL, { DAY: 'same day', '3-DAY': '2–3 market days', WEEK: '4–5 market days' });
  // a late-evening PT fill stays on its PT date (no UTC rollover)
  assert.strictEqual(global.holdSpan({ buyDate: '2026-10-08', orderType: 'limit', filledAt: PT('2026-10-08', 20, 30) }, '2026-10-09').startDate, '2026-10-08');
});

// tests/one-session-classifier.test.js — since 2026-10-09 getMarketStatus,
// isPreMarketHours and isMarketHoursNow delegate to classifySession. This pins
// the property, not a few examples: across ordinary days, a weekend, a
// holiday and both EARLY_CLOSES days, at every 5 minutes of the PT day, the
// presentation-layer status must equal classifySession's answer. Before the
// change, the early-close days disagreed from 10:00 to 13:00 PT (OPEN vs
// AFTER_HOURS).
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

const RealDate = Date;
function at(iso, fn) { // freeze "now" for getPT()/new Date()
  const t = new RealDate(iso).getTime();
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } };
  try { return fn(); } finally { global.Date = RealDate; }
}

global.state = { settings: {} };
evalModule(readSource('core/clock.js'), { expose: ['getMarketStatus', 'classifySession', 'isPreMarketHours', 'isMarketHoursNow', 'ptWallClockToInstant'] });
const MAP = { REGULAR: 'OPEN', PRE_MARKET: 'PRE', AFTER_HOURS: 'AH', CLOSED: 'CLOSED' };

run('one classifier: getMarketStatus/isPreMarketHours/isMarketHoursNow agree with classifySession', () => {
  const days = ['2026-10-09', '2026-10-03', '2026-10-04', '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-31'];
  let checked = 0;
  for (const d of days) {
    for (let m = 0; m < 1440; m += 5) {
      const hh = Math.floor(m / 60), mm = m % 60, hhmm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      const instant = global.ptWallClockToInstant(d, hh, mm).toISOString();
      const cls = global.classifySession(d, hhmm);
      at(instant, () => {
        assert.strictEqual(global.getMarketStatus().status, MAP[cls], `${d} ${hhmm}: getMarketStatus vs classifySession=${cls}`);
        assert.strictEqual(global.isPreMarketHours(), cls === 'PRE_MARKET', `${d} ${hhmm}: isPreMarketHours`);
        assert.strictEqual(global.isMarketHoursNow(), cls === 'REGULAR', `${d} ${hhmm}: isMarketHoursNow`);
      });
      checked++;
    }
  }
  // The cases that motivated it, stated explicitly.
  at('2026-10-04T02:28:55Z', () => assert.strictEqual(global.getMarketStatus().status, 'CLOSED')); // Sat 19:28 PT (scan 3da6957d)
  at(global.ptWallClockToInstant('2026-11-27', 11, 0).toISOString(), () => {
    const s = global.getMarketStatus();
    assert.strictEqual(s.status, 'AH'); // was OPEN before 2026-10-09
    assert.match(s.label, /EARLY CLOSE/);
  });
  at(global.ptWallClockToInstant('2026-11-26', 10, 0).toISOString(), () => assert.strictEqual(global.getMarketStatus().status, 'CLOSED')); // Thanksgiving
  assert.ok(checked > 2000);
});

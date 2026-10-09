// tests/market-closes-held.test.js — core/clock.js marketClosesHeld, the
// closed-trade hold-duration definition since 2026-10-09: regular-session
// closes held through, not calendar days.
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

global.state = { settings: {} };
evalModule(readSource('core/clock.js'), { expose: ['marketClosesHeld'] });

run('marketClosesHeld: counts closes, not calendar days', () => {
  const f = global.marketClosesHeld;
  assert.strictEqual(f('2026-10-01', '2026-10-01'), 0); // same day
  assert.strictEqual(f('2026-09-29', '2026-09-30'), 1); // Tue -> Wed
  assert.strictEqual(f('2026-10-02', '2026-10-05'), 1); // Fri -> Mon: one close (was 3 calendar days)
  assert.strictEqual(f('2026-09-27', '2026-09-28'), 0); // Sun-placed -> Mon: no close held, either fill
  assert.strictEqual(f('2026-09-27', '2026-09-29'), 1); // Sun -> Tue: Monday's close
  assert.strictEqual(f('2026-09-04', '2026-09-08'), 1); // Fri -> Tue over Labor Day (9/7): one close
  assert.strictEqual(f('2026-11-27', '2026-11-30'), 1); // early close still a close
  assert.strictEqual(f('2026-09-28', '2026-10-09'), 9); // two-week span
});

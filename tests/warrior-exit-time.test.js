// tests/warrior-exit-time.test.js — phase-10 §7.7 (2026-10-27). Warrior's
// evaluateExit judges two time-of-day rules (12:30 close discipline, the
// 08:00 momentum window). A live card judges them against now; a SALE must
// judge them against the sale, never the moment it was recorded. The sale
// form has a date but no time: recorded on the sale date, the recording
// instant is the best known time; recorded later, the time is unknown
// (at: null) and the time rules are not judged. Without a price rule to
// stand on, that's CANNOT_EVALUATE, never a HOLDING verdict.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, run: runNow, REPO_ROOT } = require('./_lib');
// Sequential: the engine is captured once through register(), and the
// module graph leaves a handle open, so the file exits explicitly at the end.
const queue = []; const run = (n, f) => queue.push([n, f]);

let _engine = null;
async function engine() {
  if (_engine) return _engine;
  // eslint-disable-next-line no-eval
  eval(readSource('core/clock.js') + '\nglobal.getPT = getPT; global.ptDateStr = ptDateStr;');
  let captured = null;
  global.registerEngine = (id, obj) => { if (id === 'WARRIOR') captured = obj; };
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'engines/warrior/index.js')).href);
  mod.register();
  _engine = captured;
  return captured;
}
// 2026-11-02 (PST, UTC-8): 07:30 PST = 15:30Z, 09:00 PST = 17:00Z, 12:45 PST = 20:45Z.
const at = hm => Date.parse(`2026-11-02T${hm}:00Z`);
const pos = { stop: 9, buyPrice: 10, peakPrice: 10.2 };

run('a live card (no at) judges against now; an explicit at is used instead of the clock', async () => {
  const { evaluateExit } = await engine();
  assert.strictEqual(evaluateExit(pos, { price: 10.15, at: at('15:30') }).status, 'HOLDING', '07:30 PST: inside the momentum window');
  assert.strictEqual(evaluateExit(pos, { price: 10.15, at: at('17:00') }).status, 'SELL_SOON', '09:00 PST: past 08:00');
  assert.strictEqual(evaluateExit(pos, { price: 10.15, at: at('20:45') }).status, 'SELL_NOW', '12:45 PST: close discipline');
  const live = evaluateExit(pos, { price: 10.15 });
  assert.ok(['HOLDING', 'SELL_SOON', 'SELL_NOW'].includes(live.status), 'no at: judged against the real clock, as before');
});

run('time unknown (recorded on a later day): time rules not judged, and said', async () => {
  const { evaluateExit } = await engine();
  // 10.15: above the stop, below 2R, and not having given back half its
  // peak gain (10 + 0.2 x 0.5 = 10.1), so no price rule fires.
  const none = evaluateExit(pos, { price: 10.15, at: null });
  assert.strictEqual(none.status, 'CANNOT_EVALUATE', 'no price rule fired: an abstention, not HOLDING');
  assert.ok(none.reasons.some(r => /Time of sale unknown/.test(r)));
  const stop = evaluateExit(pos, { price: 8.9, at: null });
  assert.strictEqual(stop.status, 'SELL_NOW', 'the stop needs no clock');
  assert.ok(stop.reasons.some(r => /Time of sale unknown/.test(r)), 'with the note that time rules were not judged');
  const target = evaluateExit(pos, { price: 12.1, at: null });
  assert.strictEqual(target.status, 'SELL_SOON');
  assert.ok(target.reasons.some(r => /Time of sale unknown/.test(r)));
});

run('the sale passes its time: now if recorded on the sale date, null if later', () => {
  const app = readSource('app.js');
  const i = app.indexOf('function computeUnifiedSaleFields('); const f = app.slice(i, app.indexOf('\n}\n', i));
  assert.ok(f.includes("const saleAt = saleDate === ptDateStr(getPT()) ? Date.now() : null;"));
  assert.ok(f.includes('dispatchedEngine.evaluateExit(pos, { price: salePrice, at: saleAt })'));
});

run('weekdays come from the entered dates, not the recording day', () => {
  const app = readSource('app.js');
  assert.ok(app.includes("buyDayOfWeek: DAY_NAMES[new Date(date + 'T12:00:00Z').getUTCDay()],"));
  assert.ok(app.includes("sellDayOfWeek: DAY_NAMES[new Date(saleDate + 'T12:00:00Z').getUTCDay()],"));
  assert.ok(!/DayOfWeek: DAY_NAMES\[getPT\(\)\.getDay\(\)\]/.test(app), 'no weekday read from the recording clock in app.js');
  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  assert.strictEqual(DAY[new Date('2026-10-23T12:00:00Z').getUTCDay()], 'Friday', 'the expression gives the date\'s own weekday in any timezone');
});

(async () => { for (const [n, f] of queue) await runNow(n, f); process.exit(process.exitCode || 0); })();

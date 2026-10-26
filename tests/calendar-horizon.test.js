// tests/calendar-horizon.test.js — core/clock.js's HOLIDAYS and EARLY_CLOSES
// are hand-kept tables, and every session decision (classifySession,
// getMarketStatus), staleness count (tradingDaysBetween) and trading-day walk
// reads them. Until 2026-10-22 HOLIDAYS ended at 2026-12-25, so on
// 2027-01-01 the app would have treated a closed market as open, with
// nothing announcing it. This guard refuses that: it fails once the table's
// last date is less than 90 days away (every late September or so), and
// someone adds next year's dates from Alpaca's /v2/calendar. The same shape
// as tests/sw-cache-name.test.js: refuse the divergence, don't remind.
//
// WHEN THIS FAILS, extending the end is half the job. The table was never
// complete, not just short: 2025-01-09 (a one-off closure) was missing for
// almost two years, and a horizon check can't see a hole in the middle.
// So the annual task also VERIFIES the years already there, against Alpaca's
// market calendar (/v2/calendar, which a test can't call): every weekday it
// doesn't list is a closure that must be in HOLIDAYS, and every session
// closing before 16:00 ET must be in EARLY_CLOSES, for each year each table
// covers. One command does it:
//
//   node scripts/check-market-calendar.mjs
//
// (2026-10-26: HOLIDAYS 2024-2027 and EARLY_CLOSES 2026-2027 match; the six
// 2024-2025 early closes are absent by decision and print as NOTEs.)
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

// eslint-disable-next-line no-eval
eval(readSource('core/clock.js') + '\nglobal.__H = HOLIDAYS; global.__E = EARLY_CLOSES; global.__today = ptDateStr(getPT());');
const HORIZON_DAYS = 90;

run(`HOLIDAYS reaches at least ${HORIZON_DAYS} days ahead`, () => {
  const latest = [...global.__H].sort().at(-1);
  const horizon = new Date(global.__today + 'T12:00:00Z'); horizon.setUTCDate(horizon.getUTCDate() + HORIZON_DAYS);
  const need = horizon.toISOString().slice(0, 10);
  console.log(`today ${global.__today} | HOLIDAYS ends ${latest} | needs to reach ${need}`);
  assert.ok(latest >= need, `core/clock.js HOLIDAYS ends ${latest}, less than ${HORIZON_DAYS} days ahead of ${global.__today}. Add next year's market closures (and EARLY_CLOSES) from Alpaca /v2/calendar, then run \`node scripts/check-market-calendar.mjs\`, which also verifies every year already in both tables.`);
});

run('EARLY_CLOSES is kept as far ahead as HOLIDAYS', () => {
  const hYear = [...global.__H].sort().at(-1).slice(0, 4);
  const eYear = Object.keys(global.__E).sort().at(-1).slice(0, 4);
  assert.strictEqual(eYear, hYear, `HOLIDAYS runs through ${hYear} but EARLY_CLOSES only through ${eYear}: add ${hYear}'s early closes too (every year has one, the day after Thanksgiving)`);
});

run('every entry is a well-formed weekday date', () => {
  for (const d of [...global.__H, ...Object.keys(global.__E)]) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d), d);
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    assert.ok(dow !== 0 && dow !== 6, `${d} is a weekend: a closure on a weekend changes nothing, so it's probably the unobserved date`);
  }
});

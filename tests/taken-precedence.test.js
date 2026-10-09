// tests/taken-precedence.test.js — scripts/lib/taken-precedence.mjs, the
// causality precondition on fill-outcomes' taken_resolution matching: a
// signal cannot be taken by a trade that predates it. Fixtures are the real
// production rows found 2026-10-09 (4 same-day matches, every one a buy
// before first_shown_at), plus a real cross-day match that must still pass.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, evalModule, run, REPO_ROOT } = require('./_lib');

global.state = { settings: {} };
evalModule(readSource('core/clock.js'), { expose: ['ptWallClockToInstant'] });

run('taken precedence: signal must be first shown at or before the buy', async () => {
  const { signalPrecedesTrade, tradeBuyInstant } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/taken-precedence.mjs')).href);
  const conv = global.ptWallClockToInstant;

  // buy_time is PT wall clock; 07:18 PDT on 2026-09-29 = 14:18Z.
  assert.strictEqual(tradeBuyInstant({ buy_date: '2026-09-29', buy_time: '07:18' }, conv).toISOString(), '2026-09-29T14:18:00.000Z');

  // The 4 real violations: bought in the morning, signal logged ~12:05-12:15 PT.
  const violations = [
    [{ signal_date: '2026-09-18', first_shown_at: '2026-09-18T19:15:07Z' }, { buy_date: '2026-09-18', buy_time: '09:26' }], // STUB
    [{ signal_date: '2026-10-01', first_shown_at: '2026-10-01T19:05:57Z' }, { buy_date: '2026-10-01', buy_time: '08:03' }], // CCO
    [{ signal_date: '2026-10-01', first_shown_at: '2026-10-01T19:05:57Z' }, { buy_date: '2026-10-01', buy_time: '08:03' }], // TDAY
    [{ signal_date: '2026-10-01', first_shown_at: '2026-10-01T19:05:57Z' }, { buy_date: '2026-10-01', buy_time: '08:47' }], // GO
  ];
  for (const [row, trade] of violations) assert.strictEqual(signalPrecedesTrade(row, trade, conv), false);

  // Real cross-day match (LUMN): signal 9/25 noon, bought 10/2 07:18 -- still taken.
  assert.strictEqual(signalPrecedesTrade({ signal_date: '2026-09-25', first_shown_at: '2026-09-25T19:12:36Z' }, { buy_date: '2026-10-02', buy_time: '07:18' }, conv), true);

  // Same day, bought after the sighting -- taken. Equal instant counts (<=).
  assert.strictEqual(signalPrecedesTrade({ signal_date: '2026-10-01', first_shown_at: '2026-10-01T19:05:57Z' }, { buy_date: '2026-10-01', buy_time: '12:30' }, conv), true);
  assert.strictEqual(signalPrecedesTrade({ signal_date: '2026-10-01', first_shown_at: '2026-10-01T19:06:00Z' }, { buy_date: '2026-10-01', buy_time: '12:06' }, conv), true);

  // No buy_time: only a strictly later calendar day proves precedence.
  assert.strictEqual(signalPrecedesTrade({ signal_date: '2026-10-01', first_shown_at: '2026-10-01T19:05:57Z' }, { buy_date: '2026-10-01', buy_time: null }, conv), false);
  assert.strictEqual(signalPrecedesTrade({ signal_date: '2026-10-01', first_shown_at: '2026-10-01T19:05:57Z' }, { buy_date: '2026-10-02', buy_time: null }, conv), true);
});

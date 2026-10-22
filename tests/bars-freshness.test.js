// tests/bars-freshness.test.js — the as-of date of the price history each
// signal was scored on (2026-10-22, db/031). 32 of 676 logged EDGE signals
// were scored on histories more than one trading day old (PSKY shown as a
// SOFT BUY on 8 days on bars ending 09-15), and nothing marked it.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { execSync } = require('child_process');
const { readSource, run, REPO_ROOT } = require('./_lib');

const ctx = { Date, Math, JSON, Set, Intl, console, state: { settings: {} } };
vm.createContext(ctx);
vm.runInContext(readSource('core/clock.js') + '\n;globalThis.__tdb = tradingDaysBetween; globalThis.__bf = barsFreshness;', ctx);

run('tradingDaysBetween counts trading days, holidays excluded', () => {
  assert.strictEqual(ctx.__tdb('2026-10-21', '2026-10-21'), 0, 'same day');
  assert.strictEqual(ctx.__tdb('2026-10-16', '2026-10-19'), 1, 'Friday -> Monday is one trading day');
  assert.strictEqual(ctx.__tdb('2026-11-25', '2026-11-27'), 1, 'the day after Thanksgiving is one trading day after the Wednesday (businessDaysBetween would say 2)');
  assert.strictEqual(ctx.__tdb('2026-08-28', '2026-10-14'), 32, 'AREN: scored on 10-14 from bars ending 08-28');
});

run('barsFreshness: newest bar date and its age; no bars is unknown, never 0', () => {
  const b = d => ({ t: `${d}T04:00:00Z` });
  assert.strictEqual(JSON.stringify(ctx.__bf([b('2026-10-19'), b('2026-10-21'), b('2026-10-20')], '2026-10-21')), JSON.stringify({ barsAsOf: '2026-10-21', barsAgeTradingDays: 0 }));
  assert.strictEqual(JSON.stringify(ctx.__bf([b('2026-10-20')], '2026-10-21')), JSON.stringify({ barsAsOf: '2026-10-20', barsAgeTradingDays: 1 }));
  assert.strictEqual(JSON.stringify(ctx.__bf([], '2026-10-21')), JSON.stringify({ barsAsOf: null, barsAgeTradingDays: null }));
});

run('the logged data: 32 stale signals, 9 of them SHOWN (pinned backup de95a93)', () => {
  let raw;
  try { raw = JSON.parse(execSync('git show de95a93:data/backups/signal_log.json', { cwd: REPO_ROOT, maxBuffer: 1e9 }).toString()); }
  catch (e) { console.log('  (de95a93 not readable from git; skipped)'); return; }
  const rows = (Array.isArray(raw) ? raw : raw.rows).filter(r => r.engine_source === 'EDGE' && r.signal_snapshot?.bars?.length);
  const stale = rows.filter(r => ctx.__bf(r.signal_snapshot.bars, r.signal_date).barsAgeTradingDays > 1);
  assert.strictEqual(stale.length, 32);
  assert.strictEqual(stale.filter(r => r.tier === 'SHOWN').length, 9);
});

run('entryGateForSignal: a history older than one trading day is not buyable, and says why', () => {
  const g = { Date, Math, console, state: { settings: {} }, classifySession: () => 'REGULAR', getPT: () => new Date('2026-10-21T17:00:00Z'), ptDateStr: () => '2026-10-21' };
  vm.createContext(g);
  vm.runInContext(readSource('core/entry-gate.js') + '\n;globalThis.__eg = entryGateForSignal;', g);
  const stale = g.__eg({ barsAsOf: '2026-09-15', barsAgeTradingDays: 26 });
  assert.ok(stale.gated && stale.rule === 'STALE_BARS' && /2026-09-15 \(26 trading days old\) — not buyable/.test(stale.label), JSON.stringify(stale));
  assert.strictEqual(g.__eg({ barsAsOf: '2026-10-20', barsAgeTradingDays: 1 }).rule, null, 'yesterday\'s bar is current');
  assert.strictEqual(g.__eg({}).rule, null, 'an unstamped signal is not judged stale');
});

run('wiring: stamped in both scans, gated at all three advice sites, carried buy -> sale, logged', () => {
  const app = readSource('app.js');
  assert.ok(/Object\.assign\(s, barsFreshness\(bars, ptDateStr\(getPT\(\)\)\)\);/.test(app), 'app scan stamps the signal');
  assert.strictEqual((app.match(/entryGateForSignal\(s\)/g) || []).length, 3, 'card overlay, action banner and modal use the per-signal gate');
  assert.ok(!/entryGateNow\(\)/.test(app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')), 'no advice site uses the time-only gate any more');
  assert.ok(/barsAsOfAtBuy: sig\?\.barsAsOf \?\? null/.test(app) && /bars_as_of_at_buy: pos\.barsAsOfAtBuy \?\? null/.test(app), 'buy -> position -> trades_v2');
  const store = readSource('core/store.js');
  assert.ok(/barsAsOfAtBuy: row\.bars_as_of_at_buy \?\? null/.test(store) && /bars_as_of_at_buy: position\.barsAsOfAtBuy \?\? null/.test(store), 'mapped both ways, so the update path resends it');
  const lg = readSource('scripts/log-signals-edge.mjs');
  assert.ok(/Object\.assign\(s, global\.barsFreshness\(bars, today\)\)/.test(lg) && /bars_as_of: r\.signal\?\.barsAsOf \?\? null/.test(lg) && /'bars_as_of'/.test(lg), 'logger stamps, writes and asserts the column');
});

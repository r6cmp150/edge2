// scripts/audit-macro-stale-moves.mjs -- of the historical macro conditions,
// how many came from a STALE reading: yesterday's move, read as today's
// because the snapshot's dailyBar was still the previous session's? (phase-10
// spec, observe-only, 2026-11-03.) Answerable only where the moves behind the
// condition were stored, which is signal_snapshot_at_buy (db/033): no other
// row of trades_v2 keeps them, and nothing anywhere keeps the ETF bars' dates.
//
// THE TEST: a stale ETF's stored move equals that ETF's full previous-session
// move, close over close, on the same feed (IEX). A context is STALE if any
// ETF matches, since one stale ETF withholds the whole reading. POSITIVE
// CONTROL: the test must find the three known stale stocks of 10-30 (APUS,
// BIAF, IPDN; tests/prior-session-daily-bar.test.js) from their stored
// todayChange, or its "not stale" means nothing, and the run fails.
//   node scripts/audit-macro-stale-moves.mjs [--rev d6e277d]
// Source: backups at --rev (pinned); Alpaca IEX daily bars, fetched at run time.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REV = process.argv.includes('--rev') ? process.argv[process.argv.indexOf('--rev') + 1] : 'd6e277d';
const load = t => (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${REV}:data/backups/${t}.json`, { cwd: ROOT, maxBuffer: 2e9 }).toString()));
const ETFS = ['SPY', 'XLE', 'XLK', 'XBI', 'XLF', 'XLI', 'XLRE', 'XLY'];
const CONTROL = ['APUS', 'BIAF', 'IPDN'];
const TOLERANCE_PTS = 0.0005;

const trades = load('trades_v2'), atBuy = load('signal_snapshot_at_buy');
const H = alpacaHeaders(ROOT);
const daily = await fetchBars(H, [...ETFS, ...CONTROL], { timeframe: '1Day', start: '2026-10-15T00:00:00Z', end: '2026-10-31T00:00:00Z', feed: 'iex' });
const fetchedAt = new Date().toISOString();
const sessionMove = (s, day) => {
  const bars = daily[s] || [];
  const i = bars.findIndex(b => b.t.slice(0, 10) === day);
  return i > 0 ? ((bars[i].c - bars[i - 1].c) / bars[i - 1].c) * 100 : null;
};
const sessionBefore = (s, day) => { const b = (daily[s] || []).filter(x => x.t.slice(0, 10) < day).pop(); return b ? b.t.slice(0, 10) : null; };
const near = (a, b) => a != null && b != null && Math.abs(a - b) < TOLERANCE_PTS;

console.log(`source: backups at ${REV}; Alpaca IEX daily bars fetched ${fetchedAt}`);
console.log('\nPOSITIVE CONTROL: the known stale stocks of 10-30, stored todayChange vs their 10-29 session move');
const failures = [];
for (const s of CONTROL) {
  const r = atBuy.find(x => x.snapshot?.ticker === s && String(x.captured_at).startsWith('2026-10-30'));
  const stored = r?.snapshot?.todayChange ?? null, prior = sessionMove(s, sessionBefore(s, '2026-10-30'));
  const hit = near(stored, prior);
  console.log(`  ${s}: stored ${stored == null ? 'none' : stored.toFixed(4)} | previous session ${prior == null ? 'none' : prior.toFixed(4)} | ${hit ? 'DETECTED' : 'not detected'}`);
  if (!hit) failures.push(s);
}

const contexts = new Map();
for (const r of atBuy) {
  const m = r.snapshot?.macroChanges;
  if (!m) continue;
  const k = JSON.stringify(m);
  if (!contexts.has(k)) contexts.set(k, { moves: m, rows: [] });
  contexts.get(k).rows.push(r);
}
console.log('\nSTORED MACRO CONTEXTS');
const staleIds = new Set(), judgedIds = new Set();
for (const { moves, rows } of contexts.values()) {
  const day = String(rows[0].captured_at).slice(0, 10);
  const stale = ETFS.filter(s => near(moves[s], sessionMove(s, sessionBefore(s, day))));
  for (const r of rows) { judgedIds.add(r.position_id); if (stale.length) staleIds.add(r.position_id); }
  console.log(`  ${day} ${String(rows[0].captured_at).slice(11, 16)}Z  ${String(rows.length).padStart(2)} row(s)  SPY ${moves.SPY.toFixed(3)}  stored ${rows[0].snapshot.macroCondition}  ${stale.length ? `STALE: ${stale.join(',')}` : 'no ETF matches its previous session'}`);
}

// The population the replay reported: a stored condition, in its window, with
// a replay reading at or before the buy (07:00 PT or later, on a session day).
const sessionDays = new Set((await fetchBars(H, ['SPY'], { timeframe: '1Day', start: '2026-08-13T00:00:00Z', end: '2026-10-31T00:00:00Z', feed: 'sip' })).SPY.map(b => b.t.slice(0, 10)));
const population = trades.filter(t => t.macro_condition && sessionDays.has(String(t.buy_date).slice(0, 10)) && String(t.buy_time ?? '').slice(0, 5) >= '07:00');
const judged = population.filter(t => judgedIds.has(t.position_id)), stale = judged.filter(t => staleIds.has(t.position_id));
console.log(`\nHISTORICAL CONDITIONS (trades_v2 at ${REV}): ${population.length} in the replay's population`);
console.log(`  judgeable, moves stored: ${judged.length} | of those stale: ${stale.length}`);
console.log(`  NOT judgeable, no moves stored: ${population.length - judged.length} (unknown: not "not stale")`);
if (failures.length) { console.error(`\nFAILED: the positive control missed ${failures.join(', ')}, so "no ETF matches" above means nothing.`); process.exit(1); }

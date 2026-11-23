#!/usr/bin/env node
// scripts/measure-same-window-days.mjs -- Roman's picks against the logger's shown signals, on the SAME window: entry to
// that session's close. Read only. (2026-11-23, the reviewer: his day comparison set Roman's pnl_pct, buy to his chosen
// exit, against the logger's ret_close, reference to the close -- "it conflates what he bought with when he sold".)
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   DAYS: every post-change buy day (from 2026-10-23) with both Roman's verified trades (trades_v2 @ 98bcc07) and EDGE
//     SHOWN logger rows with a ret_close (signal_log @ 98bcc07).
//   ROMAN: per trade, the entry is the SIP reference at the buy minute (scripts/lib/sip-ref.mjs, as 84d161a), the exit is
//     the buy day's SIP daily close (raw); return = 100 x (close - entry) / entry. His own exit is NOT used.
//   LOGGER: ret_close as stored (fill-outcomes.mjs: reference_price at first_shown_at to that session's close).
//   LIMITS, printed: the two sets are different stocks (the logger never saw most of his tickers); the logger's
//     reference price is its own getLivePrice reading at the time, not a SIP reference; and this is DESCRIPTIVE, no bar.
//   REPORTED: per day, each side's n, mean and win rate on the same window; and both pooled.
//   node scripts/measure-same-window-days.mjs [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc } from './measure-entry-price-gap.mjs';
import { sipRef } from './lib/sip-ref.mjs';
import { mean, ret } from './measure-good-days.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '98bcc07', FROM = '2026-10-23';
export const LIMITS = 'SAME WINDOW (entry to that session\'s close) for both, DESCRIPTIVE, no bar. The sets are different stocks (the logger never saw most of Roman\'s tickers), and the logger\'s entry is its own reading at the time, not a SIP reference.';
export const win = xs => (xs.length ? 100 * xs.filter(x => x > 0).length / xs.length : null);
// the daily bar whose date is the given day; null when none
export const closeOn = (bars, day) => (bars || []).find(b => String(b.t).slice(0, 10) === day)?.c ?? null;

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const logged = ['2026-10', '2026-11'].flatMap(m => show(`signal_log/${m}.json`)).filter(r => r.engine_source === 'EDGE' && r.tier === 'SHOWN' && r.ret_close != null);
  const trades = show('trades_v2.json').filter(r => r.sell_price_unverified === false && String(r.buy_date).slice(0, 10) >= FROM);
  const days = [...new Set(trades.map(r => String(r.buy_date).slice(0, 10)))].filter(d => logged.some(r => r.signal_date === d)).sort();
  console.log(LIMITS + '\n');
  const fmt = x => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  const allR = [], allL = [];
  for (const d of days) {
    const ts = trades.filter(r => String(r.buy_date).slice(0, 10) === d);
    const bars = await fetchBars(headers, [...new Set(ts.map(r => r.ticker))], { timeframe: '1Day', start: `${d}T00:00:00Z`, end: `${d}T23:59:59Z`, feed: 'sip' });
    const r = [];
    for (const t of ts) {
      const e = await sipRef(headers, t.ticker, pacificMinuteUtc(d, t.buy_time)), c = closeOn(bars[t.ticker], d);
      if (e && c != null) r.push(ret(e.price, c));
    }
    const l = logged.filter(x => x.signal_date === d).map(x => Number(x.ret_close));
    allR.push(...r); allL.push(...l);
    console.log(`  ${d}  Roman ${String(r.length).padStart(3)} mean ${fmt(mean(r)).padStart(7)} win ${win(r).toFixed(1).padStart(5)}%   |   logger shown ${String(l.length).padStart(3)} mean ${fmt(mean(l)).padStart(7)} win ${win(l).toFixed(1).padStart(5)}%`);
  }
  console.log(`\nPOOLED  Roman ${allR.length} mean ${fmt(mean(allR))} win ${win(allR).toFixed(1)}%   |   logger shown ${allL.length} mean ${fmt(mean(allL))} win ${win(allL).toFixed(1)}%`);
  console.log(`\n${LIMITS}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

#!/usr/bin/env node
// scripts/prereg-peak-before-after.mjs -- PRE-REGISTERED 2026-11-11, committed before its first run.
// Two questions about the +3% give-back finding, reported BESIDE each other and never merged: "gives back what he
// had" and "exits before the move completes" are different findings, and both can be true of different trades.
//
// SOURCE, the same as audit-peak-gain.mjs: trades_v2 at a pinned rev (default 164099a), its population() (501 rows),
// SIP minute bars, regular session (06:30-13:00 PT), Alpaca historical bars (read-only, cached, paginated).
// GATE: before any new number, this reproduces the published table (peak >= +3%: n 101, captured under half 28, ended
// at a loss 6) from audit-peak-gain.mjs's own giveBack(); if it does not, it prints FAIL and stops.
//
// WHAT sell_time IS: the moment the sale was RECORDED, at or after the real sale. For a paper trade the recording is
// the decision, so the gap is about zero; for a trade placed at the broker it is however long he took to record it,
// which is NOT MEASURED. Every row's execution mode is not_known until the Robinhood match exists, so the gap is
// unknown per row. THIS ANALYSIS IS RE-RUNNABLE ONCE THE ROBINHOOD MATCH EXISTS, which will say which rows were paper
// (no gap) and which live (a broker delay, and the real fill time).
//
// QUESTION 1, the residual in the published table. The peak is the high between the buy fill and the recorded
// sell_time, so it is an UPPER BOUND on what he could have had. Of the trades whose peak reached +3%, how many have
// that peak within the last W minutes before sell_time, where a recording delay could put it after the real sale?
// W = 5, 15 and 60 minutes: AN ARBITRARY SENSITIVITY SWEEP, not a threshold anyone derived. The same for the 28 that
// kept under half, and for the five biggest winners, per trade.
//   Null: few of the 28 inside the windows -> the give-back reading stands, bounded. Most inside -> give-back is not
//   established for those trades.
//
// QUESTION 2, a separate question: after sell_time, how far above the sale price did it go?
//   PRIMARY: how many trades had a post-sale high (sell_time to the next trading day's close) above their pre-sale peak.
//   Money: the dollars left on the table, (price - sale price) x shares, at the SALE-DAY CLOSE and at the NEXT TRADING
//   DAY'S CLOSE (a hold to that close; negative = the sale avoided a loss), and at the post-sale HIGH through each (the
//   best any later exit could have done: an upper bound nobody could time). Each total with its largest contributor
//   removed: if one trade carries the result, it is a trade, not a pattern.
//   Null: no evidence he exits before the move completes.
//
// COVERAGE, each its own state: no regular-session bar in the hold; sell_time at or after the close (no sale-day
// post-sale window); no next-trading-day bars within 5 calendar days.
//   node scripts/prereg-peak-before-after.mjs [rev]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { population } from './audit-first-hour-cell.mjs';
import { barsWithRetry, ptInstant, ptOf, noSaleTime } from './audit-render-sampled-inputs.mjs';
import { giveBack, band, highWithTime } from './audit-peak-gain.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPEN = 390, CLOSE = 780, WINDOWS = [5, 15, 60];
const PUBLISHED = { n: 101, underHalf: 28, loss: 6 };

const rev = process.argv[2] || '164099a';
const env = Object.fromEntries(readFileSync('C:/Users/cmp15/edge2/.env.local', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const H = { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID || env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY || env.ALPACA_SECRET_KEY };
const cacheDir = process.env.BARS_CACHE || path.join(ROOT, '.bars-cache');
const day = d => String(d).slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const regular = b => { const m = ptOf(Date.parse(b.t)).minutes; return m >= OPEN && m < CLOSE; };
// the last regular-session bar of a PT date: its close is that day's close
const closeOf = (bars, date) => { let last = null; for (const b of bars) if (regular(b) && ptOf(Date.parse(b.t)).date === date) last = b; return last ? last.c : null; };
const f = (x, d = 2) => (x == null ? 'n/a' : x.toFixed(d));
const money = x => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

// A row with no sell_time is its own state, counted and excluded (added after the first run, 2026-11-11, declared:
// 0 such rows at 164099a, so the first run's figures are unchanged).
const all = population(JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 2e9, encoding: 'utf8' })));
const trades = all.filter(t => !noSaleTime(t));
console.log(`no sale time (its own state, excluded): ${all.length - trades.length}`);
const rows = [];
for (const t of trades) {
  const buyDate = day(t.buy_date), sellDate = day(t.sell_date);
  // the published table's own bars (the same cache key as audit-peak-gain.mjs), then the days after the sale
  const hold = await barsWithRetry(H, t.ticker, { timeframe: '1Min', start: `${buyDate}T00:00:00Z`, end: new Date(ptInstant(sellDate, '23:59')).toISOString(), feed: 'sip' }, cacheDir);
  const after = await barsWithRetry(H, t.ticker, { timeframe: '1Min', start: new Date(ptInstant(addDays(sellDate, 1), '00:00')).toISOString(), end: new Date(ptInstant(addDays(sellDate, 5), '23:59')).toISOString(), feed: 'sip' }, cacheDir);
  const g = giveBack(t, hold);
  const nextDay = after.filter(regular).map(b => ptOf(Date.parse(b.t)).date).sort()[0] || null;
  rows.push({ t, g, hold, after, nextDay });
}

// GATE: the published table, reproduced first.
const b3 = band(rows, 3);
const gate = b3.n === PUBLISHED.n && b3.halfOrMoreGivenBack === PUBLISHED.underHalf && b3.endedAtALoss === PUBLISHED.loss;
console.log(`source: trades_v2 at ${rev}, population ${trades.length}; SIP minute bars, regular session`);
console.log(`GATE, the published table: peak >= +3% n ${b3.n} (published ${PUBLISHED.n}), captured under half ${b3.halfOrMoreGivenBack} (${PUBLISHED.underHalf}), ended at a loss ${b3.endedAtALoss} (${PUBLISHED.loss}): ${gate ? 'REPRODUCED' : 'FAIL -- nothing below is reported'}`);
if (!gate) process.exit(1);

const noBars = rows.filter(x => x.g.peak == null);
console.log(`coverage: no regular-session bar in the hold ${noBars.length}; sell_time at or after the close ${rows.filter(x => ptOf(x.g.soldAt).minutes >= CLOSE).length}; no next-trading-day bars within 5 days ${rows.filter(x => !x.nextDay).length}`);

// ---- QUESTION 1 ----
console.log(`\nQUESTION 1: is the pre-sale peak inside a window where a recording delay could put it after the real sale?`);
console.log(`  The peak runs to the RECORDED sell_time, so it is an upper bound on what he could have had. Window sizes ${WINDOWS.join(', ')} minutes are an ARBITRARY sensitivity sweep, not a rule.`);
const inWindow = (x, w) => x.g.peakAt != null && x.g.peakAt > x.g.soldAt - w * 60000;
const ge3 = rows.filter(x => x.g.peak != null && x.g.peak >= 3), under = ge3.filter(x => x.g.captured < 0.5);
for (const [label, set] of [['peak >= +3%', ge3], ['of those, captured under half', under]]) {
  console.log(`  ${label} (n ${set.length}): ${WINDOWS.map(w => `peak within ${w} min of the recorded sale ${set.filter(x => inWindow(x, w)).length}`).join('; ')}; earlier than ${WINDOWS[WINDOWS.length - 1]} min ${set.filter(x => !inWindow(x, WINDOWS[WINDOWS.length - 1])).length}`);
}
const hm = ms => { const p = ptOf(ms); return `${p.date.slice(5)} ${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`; };
console.log(`  the five biggest winners by peak, per trade:`);
for (const x of [...rows].filter(x => x.g.peak != null).sort((a, b) => b.g.peak - a.g.peak).slice(0, 5)) {
  const mins = Math.round((x.g.soldAt - x.g.peakAt) / 60000);
  console.log(`    ${x.t.ticker.padEnd(5)} peak +${f(x.g.peak, 1)}% at ${hm(x.g.peakAt)} PT, ${mins} min before the recorded sale (${hm(x.g.soldAt)} PT); captured ${f(x.g.captured * 100, 0)}%`);
}

// ---- QUESTION 2 ----
console.log(`\nQUESTION 2 (separate): after the recorded sale, how far above the sale price did it go?`);
const q2 = rows.filter(x => x.g.peak != null).map(x => {
  const sell = Number(x.t.sell_price), sh = Number(x.t.shares), sellDate = day(x.t.sell_date);
  const saleDayHigh = highWithTime(x.hold.filter(regular), x.g.soldAt + 1, ptInstant(sellDate, '13:00'));
  const nextHigh = x.nextDay ? highWithTime(x.after.filter(regular), 0, ptInstant(x.nextDay, '13:00')) : null;
  const postHigh = Math.max(saleDayHigh ? saleDayHigh.h : -Infinity, nextHigh ? nextHigh.h : -Infinity);
  const closeSale = closeOf(x.hold, sellDate), closeNext = x.nextDay ? closeOf(x.after, x.nextDay) : null;
  const preSalePeakPrice = Number(x.t.buy_price) * (1 + x.g.peak / 100);
  return {
    x, sh, sell,
    hasPost: postHigh > -Infinity,
    aboveOwnPeak: postHigh > -Infinity && postHigh > preSalePeakPrice,
    toSaleClose: closeSale == null || ptOf(x.g.soldAt).minutes >= CLOSE ? null : (closeSale - sell) * sh,
    toNextClose: closeNext == null ? null : (closeNext - sell) * sh,
    highSaleDay: saleDayHigh ? Math.max(0, (saleDayHigh.h - sell) * sh) : null,
    highThroughNext: postHigh > -Infinity ? Math.max(0, (postHigh - sell) * sh) : null,
  };
});
const withPost = q2.filter(r => r.hasPost);
console.log(`  PRIMARY: post-sale high (to the next trading day's close) above the trade's own pre-sale peak: ${withPost.filter(r => r.aboveOwnPeak).length} of ${withPost.length} with any post-sale bar (${q2.length - withPost.length} have none)`);
const sum = (rs, k) => rs.filter(r => r[k] != null).reduce((s, r) => s + r[k], 0);
const report = (k, label) => {
  const rs = q2.filter(r => r[k] != null);
  if (!rs.length) { console.log(`  ${label}: no trade has it`); return; }
  const tot = sum(rs, k), top = [...rs].sort((a, b) => Math.abs(b[k]) - Math.abs(a[k]))[0];
  console.log(`  ${label}: n ${rs.length}, total ${money(tot)}, per trade ${money(tot / rs.length)}; without its largest contributor (${top.x.t.ticker} ${String(top.x.t.sell_date).slice(0, 10)}, ${money(top[k])}): ${money(tot - top[k])}`);
};
report('toSaleClose', 'held to the SALE-DAY CLOSE instead (negative = the sale avoided a loss)');
report('toNextClose', 'held to the NEXT TRADING DAY\'S CLOSE instead');
report('highSaleDay', 'sold at the post-sale HIGH of the sale day instead (an upper bound nobody could time)');
report('highThroughNext', 'sold at the post-sale HIGH through the next day instead (the same bound)');
for (const [label, set] of [['peak >= +3%', ge3], ['captured under half', under]]) {
  const ids = new Set(set.map(x => x.t.id)), rs = q2.filter(r => ids.has(r.x.t.id) && r.hasPost);
  console.log(`  within ${label} (n ${set.length}): post-sale high above the pre-sale peak ${rs.filter(r => r.aboveOwnPeak).length} of ${rs.length}; held to the sale-day close ${money(sum(rs, 'toSaleClose'))}, to the next close ${money(sum(rs, 'toNextClose'))}`);
}
console.log(`\nRe-runnable once the Robinhood match exists: it will say which rows were paper (no recording gap) and which were live (a broker delay and the real fill time).`);

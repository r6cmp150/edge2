// scripts/audit-sell-dates-vs-tape.mjs -- is each stored sell_date the day
// the sale actually happened? (2026-11-02.) The Mark as Sold form's date
// field defaults to TODAY, so a sale recorded on a later day with the
// default left in place stores the recording date. Every hold-length figure
// (holdSpan: market closes from the fill to sell_date) would then read long.
//
// Two tests, verified rows only:
//   1. RECORDING LAG: sell_date vs the PT date the row was written
//      (created_at). Same day = the default or a same-day sale (can't tell
//      which); sell_date EARLIER = Roman edited the date (the field gets
//      changed, at least sometimes).
//   2. TAPE: sell_price must have traded on sell_date -- inside the SIP
//      minute bars' full-day range (04:00-20:00 ET, extended hours
//      included) +-$0.005. If not, the first of the up-to-5 earlier trading
//      days whose range contains it is reported: evidence the real sale was
//      that day.
// SHIFT_DAYS=<n> moves every sell_date n trading days later, as a placebo
// for the test's power (how often a WRONG date still contains the price).
//
// SIDE=buy runs the same tape test on the BUY end (hold length has two):
// the date tested is the buy fill's PT date (filled_at) when recorded, else
// buy_date (the order date, which the add form defaults to today). Test 1
// does not apply there: trades_v2.created_at is the SALE's write time, so
// it says nothing about when the buy was entered. Weekend order dates have
// no bars by construction (the 24 Sunday orders, fill not recorded) and
// are counted apart, not as passes.
//
//   node scripts/audit-sell-dates-vs-tape.mjs [--rev <commit>]   (default d6e277d)
//   SIDE=buy SHIFT_DAYS=-1 node scripts/audit-sell-dates-vs-tape.mjs
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revArg = process.argv.indexOf('--rev');
const REV = revArg > 0 ? process.argv[revArg + 1] : 'd6e277d';
const SHIFT_DAYS = Number(process.env.SHIFT_DAYS || 0);
const SIDE = process.env.SIDE || 'sell';
if (SIDE !== 'sell' && SIDE !== 'buy') throw new Error(`SIDE must be sell or buy, got ${SIDE}`);
const H = alpacaHeaders(ROOT);

const all = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
const rows = all.filter(r => !r.sell_price_unverified && r.sell_date && r.sell_price != null);

const ptDate = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const sideDate = r => SIDE === 'sell' ? String(r.sell_date).slice(0, 10) : (r.filled_at ? ptDate(r.filled_at) : String(r.buy_date).slice(0, 10));
const sidePrice = r => Number(SIDE === 'sell' ? r.sell_price : r.buy_price);
const isWeekend = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };
// Trading-day arithmetic on weekdays (holidays come out as "no bars" and are skipped).
const addWeekdays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); let k = Math.abs(n); const s = Math.sign(n); while (k > 0) { x.setUTCDate(x.getUTCDate() + s); const w = x.getUTCDay(); if (w !== 0 && w !== 6) k--; } return x.toISOString().slice(0, 10); };

// 1. recording lag
const lag = { same: 0, sellEarlier: 0, sellLater: 0, noCreated: 0 };
const edited = [];
for (const r of SIDE === 'sell' ? rows : []) {
  if (!r.created_at) { lag.noCreated++; continue; }
  const rec = ptDate(r.created_at), sd = String(r.sell_date).slice(0, 10);
  if (rec === sd) lag.same++; else if (sd < rec) { lag.sellEarlier++; edited.push(`${r.ticker} sold ${sd} recorded ${rec}`); } else lag.sellLater++;
}

// 2. tape: full-day minute range per (ticker, date), fetched by date
const rangeCache = new Map();
async function dayRanges(date, tickers) {
  const need = tickers.filter(t => !rangeCache.has(`${t}|${date}`));
  if (need.length) {
    const start = `${date}T08:00:00Z`, end = `${date}T23:59:00Z`; // 04:00 ET .. after 20:00 ET (EDT/EST both covered)
    // One date per call, many calls: back off on 429 rather than die (a dead
    // run prints nothing, which is not a result).
    let bars;
    for (let attempt = 0; ; attempt++) {
      try { bars = await fetchBars(H, need, { timeframe: '1Min', start, end, feed: 'sip' }); break; }
      catch (e) { if (!/HTTP 429/.test(e.message) || attempt >= 8) throw e; await new Promise(r => setTimeout(r, 15000 * (attempt + 1))); }
    }
    for (const t of need) {
      const b = bars[t] || [];
      rangeCache.set(`${t}|${date}`, b.length ? { lo: Math.min(...b.map(x => x.l)), hi: Math.max(...b.map(x => x.h)) } : null);
    }
  }
  return Object.fromEntries(tickers.map(t => [t, rangeCache.get(`${t}|${date}`)]));
}
const inRange = (p, r) => r && p >= r.lo - 0.005 && p <= r.hi + 0.005;

const byDate = {};
const weekendOrders = [];
for (const r of rows) {
  const d0 = sideDate(r);
  if (isWeekend(d0)) { weekendOrders.push(r); continue; }
  const d = addWeekdays(d0, SHIFT_DAYS); (byDate[d] ||= []).push(r);
}
const res = [];
for (const [d, rs] of Object.entries(byDate)) {
  const ranges = await dayRanges(d, [...new Set(rs.map(r => r.ticker))]);
  for (const r of rs) res.push({ r, d, ok: ranges[r.ticker] ? inRange(sidePrice(r), ranges[r.ticker]) : null });
}
// For each outside: the first earlier day (up to 5) whose range contains the price.
for (const x of res.filter(x => x.ok === false)) {
  const buy = String(x.r.buy_date).slice(0, 10);
  for (let k = 1; k <= 5; k++) {
    const d = addWeekdays(x.d, -k);
    if (SIDE === 'sell' && d < buy) break;
    const rg = (await dayRanges(d, [x.r.ticker]))[x.r.ticker];
    if (inRange(sidePrice(x.r), rg)) { x.fits = { date: d, back: k }; break; }
  }
}

const n = res.length, ok = res.filter(x => x.ok === true).length, out = res.filter(x => x.ok === false), none = res.filter(x => x.ok == null).length;
console.log(`source: trades_v2 @ ${REV}, SIDE=${SIDE}, verified rows with a sale: ${rows.length} (of ${all.length})${SHIFT_DAYS ? `  [PLACEBO: ${SIDE} date shifted ${SHIFT_DAYS > 0 ? '+' : ''}${SHIFT_DAYS} trading day(s)]` : ''}`);
if (SIDE === 'buy') console.log(`   weekend order dates, fill not recorded (no bars by construction, not tested): ${weekendOrders.length}`);
if (SIDE === 'sell') console.log(`1. recording lag: sell_date = recording date ${lag.same}, sell_date EARLIER than recording (edited) ${lag.sellEarlier}, later ${lag.sellLater}, no created_at ${lag.noCreated}`);
if (edited.length) console.log(`   edited examples: ${edited.slice(0, 8).join('; ')}`);
console.log(`2. tape: ${SIDE}_price inside the ${SIDE} date's SIP full-day range: ${ok} of ${n - none} checkable (${Math.round(100 * ok / Math.max(1, n - none))}%), outside ${out.length}, no bars ${none}`);
const fit = out.filter(x => x.fits);
console.log(`   of the ${out.length} outside: ${fit.length} fit an EARLIER day (${fit.map(x => x.fits.back).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}) && JSON.stringify(fit.map(x => x.fits.back).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}))} by days back), ${out.length - fit.length} fit no day within 5`);
for (const x of out) console.log(`   ${x.r.ticker} ${SIDE} date ${x.d} @${sidePrice(x.r)} recorded ${x.r.created_at ? ptDate(x.r.created_at) : '?'}${x.fits ? `  -> fits ${x.fits.date} (${x.fits.back} back)` : '  -> no earlier day fits'}`);

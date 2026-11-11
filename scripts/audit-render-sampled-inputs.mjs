#!/usr/bin/env node
// scripts/audit-render-sampled-inputs.mjs -- how wrong was render sampling? (phase-10 §7.6 step 2.5, 2026-11-05)
// For each sold trade, the exit-engine inputs stored from Portfolio renders against what SIP bars say:
// peak_price and its date, momentum_protection, peak_rsi_during_hold. Regular session only, as step 2.5 decided.
// The sale's fill isn't stored, so a hold ends at the RECORDED sale, which is at or after the fill: the high
// through it is an UPPER bound. A LOWER bound stops before the sale day, so it exists only for multi-day holds.
// Read-only: pinned trades_v2, Alpaca historical bars.
//   node scripts/audit-render-sampled-inputs.mjs [rev]      (default 164099a)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fetchBars } from './lib/alpaca-bars.mjs';

// Rate limits are waited out (429, up to 8 tries with backoff); any other failure stops the run. A row is never
// dropped quietly: the first run of this script turned 305 rate-limited rows into silent nulls.
export async function barsWithRetry(headers, sym, opts, cacheDir, wait = ms => new Promise(r => setTimeout(r, ms))) {
  const key = path.join(cacheDir, `${sym}-${opts.timeframe}-${opts.start}-${opts.end}.json`.replace(/:/g, ''));
  if (existsSync(key)) return JSON.parse(readFileSync(key, 'utf8'));
  for (let i = 0; ; i++) {
    try { const b = (await fetchBars(headers, [sym], opts))[sym] || []; writeFileSync(key, JSON.stringify(b)); return b; }
    catch (e) { if (!/HTTP 429/.test(e.message) || i >= 7) throw e; await wait(2000 * 2 ** Math.min(i, 4)); }
  }
}
import { population } from './audit-first-hour-cell.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPEN = 390, CLOSE = 780;
const ptFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const ptOf = ms => { const p = Object.fromEntries(ptFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }; };
// PT wall clock to an instant: PDT before 2026-11-01, PST from it, which covers this book.
export const ptInstant = (date, hhmm) => { const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number); return Date.parse(`${date}T00:00:00Z`) + ((h + (date >= '2026-11-01' ? 8 : 7)) * 60 + m) * 60000; };
// The instant a sale was RECORDED. A row without sell_time is its own state, "no sale time": every caller counts it
// and excludes it before calling, and this refuses rather than give it a time. (2026-11-11: this replaces
// `t.sell_time || '13:00'` at three sites. It never fired on the 164099a population, where 519 of 519 verified sales
// carry a sell_time; it was still a defect, a time nobody recorded standing in for a missing one. "It never fired"
// is a fact about that population, not about the code.)
export const noSaleTime = t => !t.sell_time;
export function recordedSaleAt(t) {
  if (noSaleTime(t)) throw new Error(`${t.ticker} ${String(t.sell_date).slice(0, 10)}: no sale time -- its own state; exclude it before calling`);
  return ptInstant(String(t.sell_date).slice(0, 10), t.sell_time);
}

// The regular-session high between two instants, from minute bars. NULL when no bar falls in range:
// a missing high is never the high of whatever arrived.
export function sessionHigh(bars, fromMs, toMs) {
  let best = null;
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (t < fromMs || t > toMs) continue;
    const m = ptOf(t).minutes;
    if (m < OPEN || m >= CLOSE) continue;
    if (!best || b.h > best.h) best = { h: b.h, date: ptOf(t).date };
  }
  return best;
}

// The app's own RSI (core/indicators.js), loaded, not rewritten: a re-implementation here once used Wilder
// smoothing where the app averages the last 14 changes, and gave a different answer.
const indicators = {};
new Function('out', readFileSync(path.join(ROOT, 'core/indicators.js'), 'utf8') + '\nout.calcRSI = calcRSI;')(indicators);
export const rsi14 = closes => closes.length < 15 ? null : indicators.calcRSI(closes); // the app answers 50 below 15 closes; that is no measurement

export function compare(t, minute, daily) {
  const start = t.filled_at ? Date.parse(t.filled_at) : ptInstant(String(t.buy_date).slice(0, 10), t.buy_time);
  const sellDate = String(t.sell_date).slice(0, 10);
  const end = recordedSaleAt(t);
  const upper = sessionHigh(minute, start, end);
  let allHigh = null; // every session, for explaining a lower regular-session high only; never a decision input
  for (const b of minute) { const t = Date.parse(b.t); if (t >= start && t <= end && (allHigh == null || b.h > allHigh)) allHigh = b.h; }
  const lower = sellDate > String(t.buy_date).slice(0, 10) ? sessionHigh(minute, start, ptInstant(sellDate, '00:00')) : null;
  // RSI at each completed session's close inside the hold, the step 2.5 definition.
  const closesTo = d => daily.filter(b => String(b.t).slice(0, 10) <= d).map(b => b.c);
  const holdDays = daily.filter(b => { const d = String(b.t).slice(0, 10); return d >= String(t.buy_date).slice(0, 10) && d < sellDate; }).map(b => String(b.t).slice(0, 10));
  const rsis = holdDays.map(d => rsi14(closesTo(d))).filter(x => x != null);
  return {
    stored: { peak: t.peak_price == null ? null : Number(t.peak_price), peakDate: t.peak_price_date ? String(t.peak_price_date).slice(0, 10) : null, momentum: !!t.momentum_protection, peakRsi: t.peak_rsi_during_hold == null ? null : Number(t.peak_rsi_during_hold), rsiAtBuy: t.rsi_at_buy == null ? null : Number(t.rsi_at_buy) },
    upper, lower, allHigh, buy: Number(t.buy_price),
    momentumUpper: upper ? upper.h >= Number(t.buy_price) * 1.2 : null,
    momentumLower: lower ? lower.h >= Number(t.buy_price) * 1.2 : null,
    peakRsiDerived: rsis.length ? Math.max(...rsis) : null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rev = process.argv[2] || '164099a';
  const env = Object.fromEntries(readFileSync('C:/Users/cmp15/edge2/.env.local', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const H = { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID || env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY || env.ALPACA_SECRET_KEY };
  const withPeak = population(JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 2e9, encoding: 'utf8' }))).filter(t => t.peak_price != null);
  const rows = withPeak.filter(t => !noSaleTime(t));
  console.log(`no sale time (its own state, excluded): ${withPeak.length - rows.length}`);
  const cacheDir = process.env.BARS_CACHE || path.join(ROOT, '.bars-cache');
  mkdirSync(cacheDir, { recursive: true });
  const out = [];
  for (const t of rows) {
    const buyDate = String(t.buy_date).slice(0, 10), sellDate = String(t.sell_date).slice(0, 10);
    const m = await barsWithRetry(H, t.ticker, { timeframe: '1Min', start: `${buyDate}T00:00:00Z`, end: new Date(ptInstant(sellDate, '23:59')).toISOString(), feed: 'sip' }, cacheDir);
    const d = await barsWithRetry(H, t.ticker, { timeframe: '1Day', start: new Date(Date.parse(buyDate) - 60 * 864e5).toISOString().slice(0, 10), end: sellDate, feed: 'sip' }, cacheDir);
    out.push({ t, r: compare(t, m, d) });
  }
  const ok = out.filter(x => x.r && x.r.upper);
  const pct = (a, b) => ((a / b) - 1) * 100;
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
  const none = out.filter(x => !x.r.upper);
  console.log(`source: trades_v2 at ${rev}, the 501-row population, ${rows.length} with a stored peak; ${ok.length} with a regular-session SIP bar in the hold, ${none.length} with none: ${none.map(x => `${x.t.ticker} ${String(x.t.buy_date).slice(5, 10)} ${x.t.buy_time}-${String(x.t.sell_date).slice(5, 10)} ${x.t.sell_time}`).join('; ')}`);
  const diffs = ok.map(x => pct(x.r.upper.h, x.r.stored.peak));
  const higher = diffs.filter(x => x > 0.5).length, same = diffs.filter(x => Math.abs(x) <= 0.5).length, lower = diffs.filter(x => x < -0.5).length;
  console.log(`\nPEAK, derived (upper bound) against stored: higher by >0.5% on ${higher}, within 0.5% on ${same}, lower by >0.5% on ${lower} (of ${ok.length})`);
  console.log(`  difference, percent of the stored peak: p25 ${q(diffs, 0.25).toFixed(2)}, median ${q(diffs, 0.5).toFixed(2)}, p75 ${q(diffs, 0.75).toFixed(2)}, p90 ${q(diffs, 0.9).toFixed(2)}`);
  const multi = ok.filter(x => x.r.lower);
  const ld = multi.map(x => pct(x.r.lower.h, x.r.stored.peak));
  console.log(`  multi-day holds with a lower bound: ${multi.length}; lower bound above the stored peak by >0.5% on ${ld.filter(x => x > 0.5).length}, median ${multi.length ? q(ld, 0.5).toFixed(2) : 'n/a'}%`);
  const sameDayRows = ok.filter(x => String(x.t.buy_date).slice(0, 10) === String(x.t.sell_date).slice(0, 10));
  const sd = sameDayRows.map(x => pct(x.r.upper.h, x.r.stored.peak));
  console.log(`  same-day holds (upper bound only): ${sameDayRows.length}; median ${q(sd, 0.5).toFixed(2)}%`);
  const lowerRows = ok.filter(x => pct(x.r.upper.h, x.r.stored.peak) < -0.5);
  console.log(`  the ${lowerRows.length} lower: ${lowerRows.slice(0, 12).map(x => `${x.t.ticker} ${String(x.t.buy_date).slice(5, 10)} stored ${x.r.stored.peak} derived ${x.r.upper.h} (${x.t.buy_session})`).join('; ')}`);
  const bySession = {}; for (const x of lowerRows) bySession[x.t.buy_session] = (bySession[x.t.buy_session] || 0) + 1;
  console.log(`  the lower ones by buy session: ${JSON.stringify(bySession)}; buy on a Sunday: ${lowerRows.filter(x => new Date(String(x.t.buy_date).slice(0, 10) + 'T12:00:00Z').getUTCDay() === 0).length}`);
  // Why lower. Mark filled sets peakPrice to the fill price, and the derived high starts after the fill instant,
  // so a stock that fell straight after filling reads lower. And step 2.5 drops extended hours, which a render saw.
  const why = lowerRows.map(x => {
    const s = x.r.stored.peak, buy = Number(x.t.buy_price);
    if (Math.abs(s - buy) < 0.005) return 'stored peak is the buy price (set at fill)';
    if (x.r.allHigh != null && x.r.allHigh >= s - 0.005) return 'reached in extended hours';
    return 'unexplained';
  });
  const whyCount = {}; for (const w of why) whyCount[w] = (whyCount[w] || 0) + 1;
  console.log(`  why lower: ${JSON.stringify(whyCount)}${why.includes('unexplained') ? '; unexplained: ' + lowerRows.filter((x, i) => why[i] === 'unexplained').map(x => `${x.t.ticker} ${String(x.t.buy_date).slice(5, 10)} stored ${x.r.stored.peak} regular ${x.r.upper.h} all-session ${x.r.allHigh}`).join('; ') : ''}`);
  const dateMatch =ok.filter(x => x.r.stored.peakDate && x.r.stored.peakDate === x.r.upper.date).length;
  console.log(`  peak date matches: ${dateMatch} of ${ok.filter(x => x.r.stored.peakDate).length}`);
  console.log(`\nMOMENTUM PROTECTION: stored on ${ok.filter(x => x.r.stored.momentum).length}; derived on ${ok.filter(x => x.r.momentumUpper).length} by the upper bound, ${multi.filter(x => x.r.momentumLower).length} by the lower (of ${multi.length} multi-day)`);
  const winners = ok.filter(x => x.r.momentumUpper).map(x => `${x.t.ticker} ${String(x.t.buy_date).slice(5, 10)} +${pct(x.r.upper.h, x.r.buy).toFixed(0)}%`);
  console.log(`  ${winners.slice(0, 15).join(', ')}`);
  const rr = ok.filter(x => x.r.peakRsiDerived != null && x.r.stored.peakRsi != null);
  const rd = rr.map(x => x.r.peakRsiDerived - x.r.stored.peakRsi);
  console.log(`\nPEAK RSI DURING HOLD: comparable on ${rr.length} (multi-day, with 15+ prior closes); derived minus stored: p25 ${rr.length ? q(rd, 0.25).toFixed(1) : '-'}, median ${rr.length ? q(rd, 0.5).toFixed(1) : '-'}, p75 ${rr.length ? q(rd, 0.75).toFixed(1) : '-'}`);
  console.log(`  above 70, the WINNER EXIT TIMING report's filter: stored ${rr.filter(x => x.r.stored.peakRsi > 70).length}, derived ${rr.filter(x => x.r.peakRsiDerived > 70).length} (of ${rr.length})`);
  console.log(`  stored peak RSI equals the RSI at buy (the old fallback, no render seen) on ${ok.filter(x => x.r.stored.peakRsi != null && x.r.stored.rsiAtBuy != null && Math.abs(x.r.stored.peakRsi - x.r.stored.rsiAtBuy) < 1e-9).length} of ${ok.length}`);
}

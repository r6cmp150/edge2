#!/usr/bin/env node
// scripts/measure-decay-control.mjs -- is the decay after Roman's exits a property of his stocks, or of the market over
// those dates? Read only. (2026-11-23, the reviewer's declaration: "the market control ... my decay reading was missing
// it".)
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   TRADES: the covered set -- verified trades bought from 2026-10-23 that carry price_at_plus1_day/2_days/5_days
//     (trades_v2 @ 98bcc07: sold 2026-10-27 to 2026-11-13). Nothing here extends past that window; it is printed with
//     every figure.
//   WINDOWS, all from the SAME entry (the SIP reference at the buy minute, scripts/lib/sip-ref.mjs, as 84d161a):
//     EXIT = his actual exit (the SIP reference at the sale minute); +1, +2, +5 = the stored price_at_plus closes, the
//     closes 1, 2 and 5 trading days after the SALE (scripts/lib/sell-timing.mjs: adjusted closes; split windows
//     nulled). The benchmark over each identical window: entry minute to exit minute, and entry minute to the close of
//     the same trading day (the benchmark's own adjusted daily bars, counted from the sale date).
//   BENCHMARK: IWM on every trade -- THE WEAKER PROXY, labelled as such. The SCANNED UNIVERSE only where it exists: the
//     covered trades bought on a day with a full scan saved (11-12, 11-13); there, the universe's mean over the same
//     windows, reported apart, beside IWM on the same subset. Never blended into one column.
//   EXCESS at a horizon = his return minus the benchmark's, over the same window. EXCESS DECAY at +N = excess(+N) minus
//     excess(EXIT): what holding past his exit cost him beyond what it cost the benchmark.
//   INTERVALS: 95%, resampling whole buy days, 10,000, seed 20261123 (scripts/measure-change-split.mjs dayInterval).
//   THE READING, fixed now (IWM, all covered trades):
//     MARKET if the excess-decay interval includes zero at +1, +2 and +5: the decay is the market; his same-day exits
//       were "not being in a falling market", a market-timing claim, not a claim about his stocks, and a far weaker one;
//     SPECIFIC if the mean excess decay falls +1 > +2 > +5 AND all three intervals are below zero: these stocks give
//       back more than the market after entry, and exiting fast is specific to them;
//     otherwise NOT ESTABLISHED, and what would settle it is printed.
//   node scripts/measure-decay-control.mjs [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc } from './measure-entry-price-gap.mjs';
import { sipRef } from './lib/sip-ref.mjs';
import { dayInterval } from './measure-change-split.mjs';
import { mean, ret } from './measure-good-days.mjs';
import { priceAt } from './measure-selection-differential.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '98bcc07', FROM = '2026-10-23', HORIZONS = [1, 2, 5];
export const WINDOW = 'THE COVERED WINDOW: trades sold 2026-10-27 to 2026-11-13. Nothing here extends past it.';

// the close of the Nth trading-day bar after the bar dated `day`; null when either is missing
export function closeAfter(dailyBars, day, n) {
  const s = [...(dailyBars || [])].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const i = s.findIndex(b => String(b.t).slice(0, 10) === day);
  return i < 0 || !s[i + n] ? null : s[i + n].c;
}
// excess decay at each horizon from per-trade { exit, h: {1,2,5} } returns for stock and benchmark
export function excessDecay(stock, bench) {
  const out = {};
  for (const n of HORIZONS) out[n] = (stock.h[n] - bench.h[n]) - (stock.exit - bench.exit);
  return out;
}
export function reading(intervals, means) {
  const allIncludeZero = HORIZONS.every(n => intervals[n].lo <= 0 && intervals[n].hi >= 0);
  const specific = means[1] > means[2] && means[2] > means[5] && HORIZONS.every(n => intervals[n].hi < 0);
  return specific ? 'SPECIFIC' : allIncludeZero ? 'MARKET' : 'NOT ESTABLISHED';
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const trades = show('trades_v2.json').filter(r => r.sell_price_unverified === false && String(r.buy_date).slice(0, 10) >= FROM && r.price_at_plus1_day != null && r.price_at_plus2_days != null && r.price_at_plus5_days != null);
  const files = execSync(`git ls-tree --name-only ${REV} data/backups/rating_snapshots/`, { cwd: ROOT }).toString().trim().split('\n');
  const scans = files.flatMap(f => show(f.replace('data/backups/', '')));
  const ptDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const uni = new Map();
  for (const r of scans) { const d = ptDate(r.captured_at); (uni.get(d) || uni.set(d, { t: new Set(), min: Infinity }).get(d)).t.add(r.ticker); uni.get(d).min = Math.min(uni.get(d).min, r.score); }
  const fullDay = d => uni.get(d)?.min === 0;
  console.log(WINDOW + '\n');
  const sells = trades.map(t => String(t.sell_date).slice(0, 10)).sort();
  const iwmDaily = (await fetchBars(headers, ['IWM'], { timeframe: '1Day', start: `${sells[0]}T00:00:00Z`, end: new Date(Date.parse(sells.at(-1)) + 14 * 864e5).toISOString(), feed: 'sip', adjustment: 'all' })).IWM || [];
  const rows = [], skipped = [];
  for (const t of trades) {
    const bd = String(t.buy_date).slice(0, 10), sd = String(t.sell_date).slice(0, 10);
    const b = pacificMinuteUtc(bd, t.buy_time), s = pacificMinuteUtc(sd, t.sell_time);
    const [eb, es, ib, is] = [await sipRef(headers, t.ticker, b), await sipRef(headers, t.ticker, s), await sipRef(headers, 'IWM', b), await sipRef(headers, 'IWM', s)];
    const iwmN = Object.fromEntries(HORIZONS.map(n => [n, closeAfter(iwmDaily, sd, n)]));
    if (!eb || !es || !ib || !is || HORIZONS.some(n => iwmN[n] == null)) { skipped.push(`${t.ticker} ${bd}`); continue; }
    const stock = { exit: ret(eb.price, es.price), h: { 1: ret(eb.price, Number(t.price_at_plus1_day)), 2: ret(eb.price, Number(t.price_at_plus2_days)), 5: ret(eb.price, Number(t.price_at_plus5_days)) } };
    const iwm = { exit: ret(ib.price, is.price), h: Object.fromEntries(HORIZONS.map(n => [n, ret(ib.price, iwmN[n])])) };
    rows.push({ day: bd, sd, ticker: t.ticker, b, s, stock, iwm, ex: excessDecay(stock, iwm) });
  }
  const fmt = x => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  console.log(`COVERED: ${rows.length} trades on ${new Set(rows.map(r => r.day)).size} buy days${skipped.length ? `; without a reference: ${skipped.length}` : ''}.`);
  console.log(`\nRAW, his stocks (entry to each horizon): exit ${fmt(mean(rows.map(r => r.stock.exit)))}, +1 ${fmt(mean(rows.map(r => r.stock.h[1])))}, +2 ${fmt(mean(rows.map(r => r.stock.h[2])))}, +5 ${fmt(mean(rows.map(r => r.stock.h[5])))}`);
  console.log(`IWM over the same windows (THE WEAKER PROXY): exit ${fmt(mean(rows.map(r => r.iwm.exit)))}, +1 ${fmt(mean(rows.map(r => r.iwm.h[1])))}, +2 ${fmt(mean(rows.map(r => r.iwm.h[2])))}, +5 ${fmt(mean(rows.map(r => r.iwm.h[5])))}`);
  const intervals = {}, means = {};
  for (const n of HORIZONS) { const xs = rows.map(r => ({ day: r.day, diff: r.ex[n] })); intervals[n] = dayInterval(xs); means[n] = mean(xs.map(x => x.diff)); }
  console.log('EXCESS DECAY against IWM (holding past his exit, beyond what IWM did; 95% by days):');
  for (const n of HORIZONS) console.log(`  +${n}: ${fmt(means[n])} (${fmt(intervals[n].lo)} to ${fmt(intervals[n].hi)})`);
  const r = reading(intervals, means);
  console.log(`\nTHE READING (declared; IWM, all covered trades): ${r}.`);
  console.log(r === 'MARKET' ? 'MARKET: the decay is the market. His same-day exits were "not being in a falling market": a market-timing claim, not a claim about his stocks, and a far weaker one.'
    : r === 'SPECIFIC' ? 'SPECIFIC: these stocks give back more than the market after entry, and exiting fast is specific to them (on this window).'
    : 'NOT ESTABLISHED: settled only by the forward test with the control from day one (positions after the start line, at the same-day close and +1, +2, +5, each against the benchmark over the identical window).');

  // the scanned universe, where it exists, apart
  const sub = rows.filter(r => fullDay(r.day));
  if (sub.length) {
    const urows = [];
    const barsCache = new Map();
    const minuteBars = async (syms, ms) => { if (!barsCache.has(ms)) { barsCache.set(ms, await fetchBars(headers, syms, { timeframe: '1Min', start: new Date(ms - 15 * 60000).toISOString(), end: new Date(ms).toISOString(), feed: 'sip' })); await new Promise(res => setTimeout(res, 400)); } return barsCache.get(ms); };
    for (const day of [...new Set(sub.map(r => r.day))]) {
      const syms = [...uni.get(day).t];
      const daily = await fetchBars(headers, syms, { timeframe: '1Day', start: `${day}T00:00:00Z`, end: new Date(Date.parse(day) + 21 * 864e5).toISOString(), feed: 'sip', adjustment: 'all' });
      for (const x of sub.filter(r => r.day === day)) {
        const at1 = await minuteBars(syms, x.b), at2 = await minuteBars(syms, x.s);
        const per = syms.map(sy => { const e = priceAt(at1[sy], x.b), q = priceAt(at2[sy], x.s); const h = HORIZONS.map(n => closeAfter(daily[sy], x.sd, n)); return e && q && h.every(v => v != null) ? { exit: ret(e, q), h: Object.fromEntries(HORIZONS.map((n, i) => [n, ret(e, h[i])])) } : null; }).filter(Boolean);
        if (!per.length) continue;
        const u = { exit: mean(per.map(p => p.exit)), h: Object.fromEntries(HORIZONS.map(n => [n, mean(per.map(p => p.h[n]))])) };
        urows.push({ ...x, u, exU: excessDecay(x.stock, u) });
      }
    }
    console.log(`\nTHE SCANNED UNIVERSE, where it exists (${[...new Set(urows.map(r => r.day))].join(', ')}; ${urows.length} trades), apart, beside IWM on the same trades:`);
    for (const n of HORIZONS) console.log(`  +${n}: excess decay against the universe ${fmt(mean(urows.map(r => r.exU[n])))}; against IWM, same trades ${fmt(mean(urows.map(r => r.ex[n])))}`);
    console.log('  (two days: descriptive only; the reading above is the declared one)');
  }
  console.log(`\n${WINDOW}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

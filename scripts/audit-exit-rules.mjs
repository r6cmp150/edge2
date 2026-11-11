#!/usr/bin/env node
// scripts/audit-exit-rules.mjs -- what would an exit rule have done? A replay, not a recommendation. (2026-11-06)
// On every trade in the population, from SIP minute bars (regular session only), against what he actually got:
//   trail3   a trailing stop that arms when a bar's high reaches buy +3%, then sits 1 point of gain below the peak
//   trail5   the same, arming at +5%
//   fixed3   sell at buy +3% the first time a bar reaches it
// Fills: a stop sells at the stop, or at the bar's open if the bar opened below it (a gap); a target sells at the
// target, or at the open if the bar opened above it. A bar can't both arm the stop and hit it: its high and low come
// in an unknown order, so the stop counts from the next bar (the conservative order). A rule that never fires leaves
// the actual sale.
// LIMITS, stated with every result: the bars run to the RECORDED sale time, which is at or after the fill, so a rule
// can "exit" after he had already sold (it then moves the sale price to a moment he wasn't in); and the trades sit on
// a few dozen trading days, so the effective sample is days, not trades.
//   node scripts/audit-exit-rules.mjs [rev]      (default 164099a)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { population } from './audit-first-hour-cell.mjs';
import { barsWithRetry, ptInstant, ptOf, noSaleTime, recordedSaleAt } from './audit-render-sampled-inputs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The hold's regular-session bars, in time order.
export function holdBars(t, minute) {
  const start = t.filled_at ? Date.parse(t.filled_at) : ptInstant(String(t.buy_date).slice(0, 10), t.buy_time);
  const end = recordedSaleAt(t); // refuses a row with no sale time: the caller excludes those first
  return minute.filter(b => { const ms = Date.parse(b.t), m = ptOf(ms).minutes; return ms >= start && ms <= end && m >= 390 && m < 780; })
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// The exit price a rule produces, or null when it never fires (the actual sale stands).
export function trailingExit(bars, buy, armPct, givePts) {
  let peak = null, armed = false;
  for (const b of bars) {
    if (armed) {
      const stop = buy * (1 + ((peak / buy - 1) * 100 - givePts) / 100);
      if (b.l <= stop) return { price: Math.min(stop, b.o), at: b.t };
    }
    peak = peak == null ? b.h : Math.max(peak, b.h);
    if (peak >= buy * (1 + armPct / 100)) armed = true; // counts from the next bar
  }
  return null;
}
export function fixedExit(bars, buy, pct) {
  const target = buy * (1 + pct / 100);
  for (const b of bars) if (b.h >= target) return { price: Math.max(target, b.o), at: b.t };
  return null;
}

export function summarise(rows) {
  const changed = rows.filter(r => r.exit);
  const total = rows.reduce((s, r) => s + r.delta, 0);
  const best = changed.reduce((m, r) => (r.delta > (m?.delta ?? -Infinity) ? r : m), null);
  const byDay = {};
  for (const r of rows) byDay[r.day] = (byDay[r.day] || 0) + r.delta;
  const days = Object.values(byDay).filter(v => v !== 0);
  const largestDay = Object.entries(byDay).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  return {
    n: rows.length, changed: changed.length, total, perTrade: total / rows.length,
    withoutBest: best ? total - best.delta : total, perTradeWithoutBest: best ? (total - best.delta) / (rows.length - 1) : total / rows.length,
    best, better: changed.filter(r => r.delta > 0).length, worse: changed.filter(r => r.delta < 0).length,
    daysWith: days.length, daysUp: days.filter(v => v > 0).length, daysDown: days.filter(v => v < 0).length,
    allDays: Object.keys(byDay).length, largestDay, largestDayShare: largestDay && total ? largestDay[1] / total : null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rev = process.argv[2] || '164099a';
  const env = Object.fromEntries(readFileSync('C:/Users/cmp15/edge2/.env.local', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const H = { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID || env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY || env.ALPACA_SECRET_KEY };
  const cacheDir = process.env.BARS_CACHE || path.join(ROOT, '.bars-cache');
  const all = population(JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 2e9, encoding: 'utf8' })));
  const trades = all.filter(t => !noSaleTime(t));
  console.log(`no sale time (its own state, excluded): ${all.length - trades.length}`);
  const RULES = { trail3: (b, buy) => trailingExit(b, buy, 3, 1), trail5: (b, buy) => trailingExit(b, buy, 5, 1), fixed3: (b, buy) => fixedExit(b, buy, 3) };
  const out = Object.fromEntries(Object.keys(RULES).map(k => [k, []]));
  for (const t of trades) {
    const buyDate = String(t.buy_date).slice(0, 10), sellDate = String(t.sell_date).slice(0, 10);
    const minute = await barsWithRetry(H, t.ticker, { timeframe: '1Min', start: `${buyDate}T00:00:00Z`, end: new Date(ptInstant(sellDate, '23:59')).toISOString(), feed: 'sip' }, cacheDir);
    const bars = holdBars(t, minute), buy = Number(t.buy_price), sell = Number(t.sell_price), shares = Number(t.shares);
    for (const [k, rule] of Object.entries(RULES)) {
      const exit = rule(bars, buy);
      out[k].push({ t, exit, day: sellDate, delta: exit ? (exit.price - sell) * shares : 0 });
    }
  }
  const actual = trades.reduce((s, t) => s + Number(t.pnl_dollars), 0);
  const days = new Set(trades.map(t => String(t.sell_date).slice(0, 10))).size;
  console.log(`source: trades_v2 at ${rev}, the ${trades.length}-row population, sold on ${days} trading days; actual P&L $${actual.toFixed(2)}`);
  console.log('LIMITS: bars run to the recorded sale time (at or after the fill), so a rule can exit after he had sold; the sample is days, not trades.\n');
  for (const [k, rows] of Object.entries(out)) {
    const s = summarise(rows);
    console.log(`${k}: changes ${s.changed} of ${s.n} (better ${s.better}, worse ${s.worse}); total $${s.total.toFixed(2)}, $${s.perTrade.toFixed(2)} a trade; without its best contributor (${s.best ? `${s.best.t.ticker} ${String(s.best.t.buy_date).slice(5, 10)} +$${s.best.delta.toFixed(2)}` : 'none'}) $${s.withoutBest.toFixed(2)}, $${s.perTradeWithoutBest.toFixed(2)} a trade; days better ${s.daysUp}, worse ${s.daysDown} of ${s.daysWith} days it changed anything (${s.allDays} days); largest day ${s.largestDay?.[0]} $${s.largestDay?.[1].toFixed(2)} (${s.largestDayShare == null ? '-' : (s.largestDayShare * 100).toFixed(0) + '%'} of the total)`);
    if (process.argv.includes('--trades')) {
      for (const r of rows.filter(r => r.exit).sort((a, b) => b.delta - a.delta)) {
        console.log(`    ${r.t.ticker.padEnd(5)} ${String(r.t.buy_date).slice(5, 10)} buy ${r.t.buy_price} sold ${r.t.sell_price} -> rule ${r.exit.price.toFixed(4)} at ${ptOf(Date.parse(r.exit.at)).date.slice(5)} ${String(Math.floor(ptOf(Date.parse(r.exit.at)).minutes / 60)).padStart(2, '0')}:${String(ptOf(Date.parse(r.exit.at)).minutes % 60).padStart(2, '0')} PT x${r.t.shares}: ${r.delta >= 0 ? '+' : ''}$${r.delta.toFixed(2)}`);
      }
    }
  }
}

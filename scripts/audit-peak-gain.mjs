#!/usr/bin/env node
// scripts/audit-peak-gain.mjs -- does he give back his biggest gains? (2026-11-05)
// An exit measurement that happens to settle a threshold: momentum protection arms at a hold high >= buy x 1.20,
// and is only worth having if big gains are given back. Per trade, from SIP bars (never from renders):
//   peak: the regular-session high in the hold, as a gain on the buy price
//   realized: the sale price on the buy price
//   given back: peak minus realized, in points; captured: realized as a share of the peak
// The peak's UPPER bound runs to the recorded sale time, which is at or after the fill, so it can include prices
// after he sold and overstate what he gave back. The LOWER bound stops before the sale day (multi-day holds only).
// The peak's own time is printed for the top trades, so a peak after the sale is visible rather than averaged in.
// Read-only: pinned trades_v2, Alpaca historical bars (cached).
//   node scripts/audit-peak-gain.mjs [rev]      (default 164099a)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { population } from './audit-first-hour-cell.mjs';
import { barsWithRetry, ptInstant, ptOf } from './audit-render-sampled-inputs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The regular-session high between two instants, with its time. NULL with no bar in range.
export function highWithTime(bars, fromMs, toMs) {
  let best = null;
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (t < fromMs || t > toMs) continue;
    const m = ptOf(t).minutes;
    if (m < 390 || m >= 780) continue;
    if (!best || b.h > best.h) best = { h: b.h, t };
  }
  return best;
}

export function giveBack(t, minute) {
  const buyDate = String(t.buy_date).slice(0, 10), sellDate = String(t.sell_date).slice(0, 10);
  const buy = Number(t.buy_price), sell = Number(t.sell_price);
  const start = t.filled_at ? Date.parse(t.filled_at) : ptInstant(buyDate, t.buy_time);
  const soldAt = ptInstant(sellDate, t.sell_time || '13:00');
  const up = highWithTime(minute, start, soldAt);
  const lo = sellDate > buyDate ? highWithTime(minute, start, ptInstant(sellDate, '00:00')) : null;
  const pct = x => (x / buy - 1) * 100;
  const realized = pct(sell);
  const peak = up ? pct(up.h) : null;
  return {
    peak, peakAt: up ? up.t : null, lowerPeak: lo ? pct(lo.h) : null, realized, soldAt,
    givenBack: peak == null ? null : peak - realized,
    captured: peak == null || peak <= 0 ? null : realized / peak,
  };
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
export function band(rows, min) {
  const r = rows.filter(x => x.g.peak != null && x.g.peak >= min);
  if (!r.length) return { n: 0 };
  return {
    n: r.length,
    medianPeak: q(r.map(x => x.g.peak), 0.5), medianRealized: q(r.map(x => x.g.realized), 0.5),
    medianGivenBack: q(r.map(x => x.g.givenBack), 0.5), medianCaptured: q(r.map(x => x.g.captured), 0.5),
    halfOrMoreGivenBack: r.filter(x => x.g.captured < 0.5).length, endedAtALoss: r.filter(x => x.g.realized < 0).length,
    peakOnSaleDay: r.filter(x => ptOf(x.g.peakAt).date === String(x.t.sell_date).slice(0, 10)).length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rev = process.argv[2] || '164099a';
  const env = Object.fromEntries(readFileSync('C:/Users/cmp15/edge2/.env.local', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const H = { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID || env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY || env.ALPACA_SECRET_KEY };
  const cacheDir = process.env.BARS_CACHE || path.join(ROOT, '.bars-cache');
  const trades = population(JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 2e9, encoding: 'utf8' })));
  const rows = [];
  for (const t of trades) {
    const buyDate = String(t.buy_date).slice(0, 10), sellDate = String(t.sell_date).slice(0, 10);
    const minute = await barsWithRetry(H, t.ticker, { timeframe: '1Min', start: `${buyDate}T00:00:00Z`, end: new Date(ptInstant(sellDate, '23:59')).toISOString(), feed: 'sip' }, cacheDir);
    rows.push({ t, g: giveBack(t, minute) });
  }
  const none = rows.filter(x => x.g.peak == null);
  const f = (x, d = 2) => x == null ? 'n/a' : x.toFixed(d);
  const dist = a => `median ${f(q(a, 0.5))}%, p90 ${f(q(a, 0.9))}%, p99 ${f(q(a, 0.99))}%, max ${f(Math.max(...a))}%`;
  console.log(`source: trades_v2 at ${rev}, the ${trades.length}-row population; a regular-session SIP bar in the hold for ${trades.length - none.length}, none for ${none.length}`);
  const peaks = rows.filter(x => x.g.peak != null).map(x => x.g.peak);
  console.log(`PEAK GAIN, upper bound (through the recorded sale): n ${peaks.length}, ${dist(peaks)}; at or over +3% ${peaks.filter(x => x >= 3).length}, +5% ${peaks.filter(x => x >= 5).length}, +10% ${peaks.filter(x => x >= 10).length}, +20% ${peaks.filter(x => x >= 20).length}`);
  const lows = rows.filter(x => x.g.lowerPeak != null).map(x => x.g.lowerPeak);
  console.log(`PEAK GAIN, lower bound (multi-day, before the sale day): n ${lows.length}, ${dist(lows)}`);
  const wins = rows.filter(x => Number(x.t.pnl_dollars) > 0);
  console.log(`REALIZED, winners: n ${wins.length}, ${dist(wins.map(x => x.g.realized))}; average win $${(wins.reduce((s, x) => s + Number(x.t.pnl_dollars), 0) / wins.length).toFixed(2)} on an average position of $${(wins.reduce((s, x) => s + Number(x.t.buy_price) * Number(x.t.shares), 0) / wins.length).toFixed(0)}`);
  console.log(`\nGIVE-BACK BY PEAK (upper-bound peak, so given back is an upper bound too):`);
  for (const min of [3, 5, 10]) {
    const b = band(rows, min);
    console.log(`  peak >= +${min}%: n ${b.n}; median peak ${f(b.medianPeak)}%, median realized ${f(b.medianRealized)}%, median given back ${f(b.medianGivenBack)} pts, median captured ${f(b.medianCaptured * 100, 0)}%; captured under half ${b.halfOrMoreGivenBack}, ended at a loss ${b.endedAtALoss}; peak on the sale day ${b.peakOnSaleDay}`);
  }
  console.log(`\nTOP FIVE BY PEAK, per trade (at n=5 one trade is the whole figure):`);
  const hm = ms => { const p = ptOf(ms); return `${p.date.slice(5)} ${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`; };
  for (const x of [...rows].filter(x => x.g.peak != null).sort((a, b) => b.g.peak - a.g.peak).slice(0, 5)) {
    const g = x.g;
    console.log(`  ${x.t.ticker.padEnd(5)} bought ${String(x.t.buy_date).slice(5, 10)} at ${x.t.buy_price}; peak +${f(g.peak, 1)}% at ${hm(g.peakAt)} PT${g.lowerPeak != null ? ` (before the sale day: +${f(g.lowerPeak, 1)}%)` : ''}; sold at ${x.t.sell_price}, recorded ${hm(g.soldAt)} PT: realized ${f(g.realized, 1)}%, given back ${f(g.givenBack, 1)} pts, captured ${f(g.captured * 100, 0)}%; ${g.peakAt > g.soldAt - 60000 ? 'PEAK AT OR AFTER THE RECORDING' : 'peak before the recorded sale'}`);
  }
}

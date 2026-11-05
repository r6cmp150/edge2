#!/usr/bin/env node
// scripts/audit-step25-current.mjs -- step 2.5's before and after on the positions held now (2026-11-05).
// Step 2.5 changes three inputs (spec §7.6). In the EDGE verdict they reach the label through exactly two factors:
//   momentum protection: +30 near the peak, -25 / -50 pulled back 15% / 20% (calcUnifiedRecommendation)
//   "RSI declining from peak": -30 when prevRSI > 70 and RSI is below it; peak risk, which decides
//     HOLD STRONG against LOCK IN PROFITS only (composite >= 30, in profit)
// So a position whose two factors come out the same both ways cannot change label, whatever else the card holds.
// The phone's scan state (the score, the previous render's RSI) is not readable from here, so the composite is
// not rebuilt; where a factor does differ, the label change it can make is stated.
// Read-only: portfolio at a pinned backup, Alpaca market data now.
//   node scripts/audit-step25-current.mjs [rev]      (default 164099a)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBars } from './lib/alpaca-bars.mjs';
import { ptOf, rsi14 } from './audit-render-sampled-inputs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rev = process.argv[2] || '164099a';
const env = Object.fromEntries(readFileSync('C:/Users/cmp15/edge2/.env.local', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const H = { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID || env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY || env.ALPACA_SECRET_KEY };
const positions = JSON.parse(execSync(`git show ${rev}:data/backups/portfolio.json`, { cwd: ROOT, maxBuffer: 1e9, encoding: 'utf8' }));
const tickers = [...new Set(positions.map(p => p.ticker))];
const now = Date.now();
const todayPT = ptOf(now).date;

// The app's own inputs for RSI and price: IEX snapshots, IEX daily bars adjustment=all, 180 days (core/market-data.js).
const snapRes = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${tickers.join(',')}&feed=iex`, { headers: H });
if (!snapRes.ok) throw new Error(`snapshots HTTP ${snapRes.status}`);
const snaps = await snapRes.json();
const daily = await fetchBars(H, tickers, { timeframe: '1Day', start: new Date(now - 180 * 864e5).toISOString().slice(0, 10), end: new Date(now).toISOString(), feed: 'iex', adjustment: 'all' });
// The hold high: SIP minute bars, regular session only (decision (i)), raw so they compare with buy_price.
// Basic plan: SIP must be at least 15 minutes old, so the minute bars stop 16 minutes ago; the live price covers the rest.
const sipEnd = new Date(now - 16 * 60000).toISOString();
const earliest = new Date(Math.min(...positions.map(p => Date.parse(p.filled_at || `${String(p.buy_date).slice(0, 10)}T00:00:00Z`)))).toISOString();
const minute = await fetchBars(H, tickers, { timeframe: '1Min', start: earliest, end: sipEnd, feed: 'sip', adjustment: 'raw' });

console.log(`positions: portfolio at ${rev}; market data at ${new Date(now).toISOString()} (PT ${todayPT}); SIP minute bars to ${sipEnd}`);
const rows = [];
for (const p of positions) {
  const s = snaps[p.ticker];
  const price = s?.dailyBar?.c || s?.latestTrade?.p || null; // getLivePrice
  const bars = (daily[p.ticker] || []).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const closes = bars.map(b => b.c);
  const rsi = closes.length >= 15 ? rsi14(closes) : null;
  const completed = bars.filter(b => ptOf(Date.parse(b.t) + 12 * 3600e3).date < todayPT);
  const prevSession = completed.length >= 15 ? rsi14(completed.map(b => b.c)) : null;
  const start = Date.parse(p.filled_at || `${String(p.buy_date).slice(0, 10)}T00:00:00Z`);
  let high = null;
  for (const b of minute[p.ticker] || []) {
    const t = Date.parse(b.t); const m = ptOf(t).minutes;
    if (t >= start && m >= 390 && m < 780 && (high == null || b.h > high)) high = b.h;
  }
  const holdHigh = high == null ? null : Math.max(high, price ?? -Infinity);
  const buy = Number(p.buy_price);
  const protAfter = holdHigh == null ? null : holdHigh >= buy * 1.2;
  const protBefore = !!p.momentum_protection_activated;
  const declAfter = prevSession != null && rsi != null && prevSession > 70 && rsi < prevSession;
  // The most the previous render's RSI could have been: each of the last three completed sessions, closed at its
  // high (RSI rises with the last close). Below 70 on all three, no render in them could have fired the factor.
  const maxRenderRsi = Math.max(...[1, 2, 3].map(k => { const c = completed.slice(0, completed.length - k + 1).map(b => b.c); if (c.length < 15) return -1; c[c.length - 1] = completed[completed.length - k].h; return rsi14(c); }));
  const pnl = price ? (price - buy) / buy * 100 : null;
  rows.push({ p, price, pnl, rsi, prevSession, maxRenderRsi, storedPeak: Number(p.peak_price), holdHigh, protBefore, protAfter, declAfter });
}
for (const r of rows) {
  const f = (x, d = 2) => x == null ? 'n/a' : Number(x).toFixed(d);
  console.log(`${r.p.ticker.padEnd(5)} buy ${f(r.p.buy_price)} now ${f(r.price)} (${f(r.pnl, 1)}%) | peak stored ${f(r.storedPeak)} derived ${f(r.holdHigh)} (+${f((r.holdHigh / Number(r.p.buy_price) - 1) * 100, 1)}% of buy) | protection ${r.protBefore} -> ${r.protAfter} | RSI now ${f(r.rsi, 1)}, prev session ${f(r.prevSession, 1)}, render max bound ${f(r.maxRenderRsi, 1)} | declining after: ${r.declAfter}`);
}
const protChanges = rows.filter(r => r.protBefore !== r.protAfter);
const declAfter = rows.filter(r => r.declAfter);
const declBeforePossible = rows.filter(r => r.maxRenderRsi > 70);
console.log(`\nprotection changes on ${protChanges.length} of ${rows.length}; "RSI declining" fires after on ${declAfter.length}; could have fired before (render bound above 70) on ${declBeforePossible.length}: ${declBeforePossible.map(r => r.p.ticker).join(', ') || 'none'}`);

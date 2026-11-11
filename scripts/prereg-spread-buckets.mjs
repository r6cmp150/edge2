#!/usr/bin/env node
// scripts/prereg-spread-buckets.mjs -- does performance after costs vary with the spread of the name traded?
// Read-only. (2026-11-11)
//
// PRE-REGISTERED (CC-cost-verdict-and-spread-question.md, 2026-11-11), and this script was written and committed
// before its first run. Nothing below changes after seeing its output without saying so in the commit that changes it.
//
// WHAT THE BOOK IS: a frictionless paper simulation for the paper rows, over rows whose execution mode is NOT_KNOWN
// (Roman, 2026-11-11: "some real, some paper, not sure which"). Same caveat as scripts/prereg-costs.mjs.
//
// SAID IN ADVANCE: at 34 buy days across four buckets, every bucket is expected to have fewer than 20 buy days, so
// this is likely to produce NO VERDICT. The descriptive figures are still worth having: they say whether the effect
// is large enough to be worth a forward test.
//
// FIXED HERE, before the run:
//   - Population: the 513 trades scripts/prereg-costs.mjs charges on both sides (same book @ 314f6e0, same moments,
//     same quotes, read from the same cache), base-case costs (half the quoted spread on each side).
//   - A trade's spread: the mean of its buy-side and sale-side quoted spread as a share of mid.
//   - Spread buckets: the quartile cut points already published from the 1,026 quotes (STATUS.md, 2026-11-11):
//     0.11%, 0.20%, 0.36%. Fixed numbers, not computed from this run. S1 <= 0.11% < S2 <= 0.20% < S3 <= 0.36% < S4.
//   - Price and position-size buckets: the quartiles of the 513 trades' buy price, and of buy price x shares,
//     computed blind to outcome. P1..P4, Z1..Z4, lowest first.
//   - Per bucket: trades, buy days, frictionless total, cost drag, after-cost total, after-cost mean per buy day,
//     after-cost win rate, win/loss ratio, and the break-even ratio at that bucket's win share.
//   - Primary outcome: the after-cost mean per buy day in S1, the tightest-spread bucket. Direction: greater than
//     zero. Bar: prereg-pnl.mjs's bootstrap, unchanged, on S1's daily means, with the 20-buy-day floor.
//   - A null, written now: "if after-cost performance does not improve in tighter-spread names, the costs are not a
//     selection problem, and the strategy needs a larger edge per trade or fewer trades, not different tickers."
//   - Entanglement: the spread-by-price and spread-by-size cross-tabs of trade counts, so a reader can see how much
//     the three track each other. No cause is claimed.
//   node scripts/prereg-spread-buckets.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DESIGN, blockBootstrapMean, perDay } from './prereg-pnl.mjs';
import { LOOKBACK_MS, tradeMoments, pickQuote, costFor } from './prereg-costs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SPREAD_CUTS = [0.0011, 0.0020, 0.0036]; // published 2026-11-11, fixed
const day = v => (v == null ? null : String(v).slice(0, 10));
const num = v => (v == null || v === '' ? null : Number(v));

export function bucketOf(x, cuts) { let i = 0; while (i < cuts.length && x > cuts[i]) i++; return i; } // 0..cuts.length
export function quartileCuts(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = f => s[Math.floor(f * (s.length - 1))];
  return [q(0.25), q(0.5), q(0.75)];
}
export function summarize(items) {
  // items: [{ t, c }] with base-case cost c.base
  const sum = a => a.reduce((s, x) => s + x, 0);
  const fr = items.map(x => num(x.t.pnl_dollars)), cost = items.map(x => x.c.base);
  const after = items.map((x, i) => ({ buy_date: x.t.buy_date, pnl_dollars: fr[i] - cost[i] }));
  const days = perDay(after);
  const wins = after.filter(r => r.pnl_dollars > 0), losses = after.filter(r => r.pnl_dollars < 0);
  const avgW = wins.length ? sum(wins.map(r => r.pnl_dollars)) / wins.length : null;
  const avgL = losses.length ? sum(losses.map(r => r.pnl_dollars)) / losses.length : null;
  return {
    n: items.length, days: days.length, frictionless: sum(fr), drag: sum(cost), after: sum(after.map(r => r.pnl_dollars)),
    perDay: days.length ? sum(after.map(r => r.pnl_dollars)) / days.length : null,
    winRate: after.length ? wins.length / after.length : null,
    ratio: avgW != null && avgL ? avgW / Math.abs(avgL) : null,
    breakEven: wins.length ? losses.length / wins.length : null,
    series: days.map(([, v]) => v),
  };
}

const $ = x => (x == null ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const f3 = x => (x == null ? '—' : x.toFixed(3));
const line = (label, s) => `  ${label.padEnd(26)} trades ${String(s.n).padStart(3)}  buy days ${String(s.days).padStart(2)}  frictionless ${$(s.frictionless).padStart(9)}  drag ${$(s.drag).padStart(8)}  after ${$(s.after).padStart(9)}  per day ${$(s.perDay).padStart(8)}  win ${s.winRate == null ? '—' : (100 * s.winRate).toFixed(1) + '%'}  ratio ${f3(s.ratio)}  break-even ${f3(s.breakEven)}`;

async function quotesAt(headers, sym, at, cacheDir) {
  // The same cache key as scripts/prereg-costs.mjs, so the quotes are the ones it charged.
  const start = new Date(at - LOOKBACK_MS).toISOString(), end = new Date(at).toISOString();
  const key = path.join(cacheDir, `${sym}-${start}-${end}.json`.replace(/:/g, ''));
  if (existsSync(key)) return JSON.parse(readFileSync(key, 'utf8'));
  const { fetchQuotes } = await import('./lib/alpaca-quotes.mjs');
  for (let i = 0; ; i++) {
    try { const q = await fetchQuotes(headers, sym, { start, end, feed: 'sip' }); writeFileSync(key, JSON.stringify(q)); return q; }
    catch (e) { if (!/HTTP 429/.test(e.message) || i >= 7) throw e; await new Promise(r => setTimeout(r, 2000 * 2 ** Math.min(i, 4))); }
  }
}

async function main() {
  const revArg = process.argv.indexOf('--rev');
  const REV = revArg > 0 ? process.argv[revArg + 1] : '314f6e0';
  console.log('WHAT THE BOOK IS: a frictionless paper simulation for the paper rows, over rows whose execution mode is NOT_KNOWN (Roman, 2026-11-11). Said in advance: every bucket is expected to fall short of 20 buy days, so no verdict is expected; the figures are descriptive.');
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const book = all.filter(r => r.sell_price_unverified === false && num(r.pnl_dollars) != null);
  const { alpacaHeaders } = await import('./lib/alpaca-bars.mjs');
  const headers = alpacaHeaders(process.env.EDGE2_ENV_DIR || ROOT);
  const cacheDir = process.env.QUOTES_CACHE || path.join(os.tmpdir(), 'edge2-quotes-cache');
  mkdirSync(cacheDir, { recursive: true });
  const charged = [];
  for (const t of book) {
    const m = tradeMoments(t);
    if (m.buy == null || m.sell == null) continue;
    const bq = pickQuote(await quotesAt(headers, t.ticker, m.buy, cacheDir), m.buy);
    const sq = pickQuote(await quotesAt(headers, t.ticker, m.sell, cacheDir), m.sell);
    if (bq && sq) charged.push({ t, c: costFor(t, bq, sq) });
  }
  console.log(`SOURCE: data/backups/trades_v2.json @ ${REV}; ${charged.length} trades charged on both sides (prereg-costs.mjs's population)`);
  const spread = x => (x.c.buyRel + x.c.sellRel) / 2, price = x => num(x.t.buy_price), size = x => num(x.t.buy_price) * num(x.t.shares);
  const pCuts = quartileCuts(charged.map(price)), zCuts = quartileCuts(charged.map(size));
  const dims = [
    ['SPREAD (share of mid; cuts 0.11% / 0.20% / 0.36%, fixed)', 'S', spread, SPREAD_CUTS, v => `${(100 * v).toFixed(2)}%`],
    [`PRICE (buy price quartiles: $${pCuts.map(v => v.toFixed(2)).join(' / $')})`, 'P', price, pCuts, v => `$${v.toFixed(2)}`],
    [`POSITION SIZE (buy price x shares quartiles: $${zCuts.map(v => v.toFixed(0)).join(' / $')})`, 'Z', size, zCuts, v => `$${v.toFixed(0)}`],
  ];
  const bucketsBy = {};
  for (const [title, code, fn, cuts] of dims) {
    console.log(`\n${title}`);
    const b = [[], [], [], []];
    for (const x of charged) b[bucketOf(fn(x), cuts)].push(x);
    bucketsBy[code] = charged.map(x => bucketOf(fn(x), cuts));
    b.forEach((items, i) => console.log(line(`${code}${i + 1}`, summarize(items))));
    if (code === 'S') {
      const s1 = summarize(b[0]);
      console.log(`  PRIMARY (S1, the tightest spreads): after-cost mean per buy day ${$(s1.perDay)} over ${s1.days} buy days.`);
      if (s1.days < DESIGN.minDaysForVerdict) console.log(`  fewer than ${DESIGN.minDaysForVerdict} buy days: no interval, no verdict (as said in advance). Descriptive only.`);
      else {
        const ci = blockBootstrapMean(s1.series, DESIGN);
        console.log(`  95% moving-block bootstrap: ${$(ci.lower)} to ${$(ci.upper)}`);
        console.log(ci.lower > 0 ? '  VERDICT: in the tightest-spread names, the strategy is positive after costs.' : '  VERDICT: the interval includes zero or lies below it: in the tightest-spread names it is not shown to be positive after costs.');
      }
    }
  }
  console.log('\nENTANGLEMENT (trade counts; rows spread S1..S4, columns P1..P4 then Z1..Z4). No cause is claimed.');
  for (let s = 0; s < 4; s++) {
    const row = k => [0, 1, 2, 3].map(j => charged.filter((_, i) => bucketsBy.S[i] === s && bucketsBy[k][i] === j).length);
    console.log(`  S${s + 1}   price ${row('P').map(v => String(v).padStart(3)).join(' ')}    size ${row('Z').map(v => String(v).padStart(3)).join(' ')}`);
  }
  console.log('\nTHE NULL, as written before the run: if after-cost performance does not improve in tighter-spread names, the costs are not a selection problem, and the strategy needs a larger edge per trade or fewer trades, not different tickers.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });

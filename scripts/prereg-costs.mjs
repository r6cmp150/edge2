#!/usr/bin/env node
// scripts/prereg-costs.mjs -- does the book survive realistic entry and exit costs? Read-only. (2026-11-11)
//
// PRE-REGISTERED (CC-PAPER-TRADING-everything-changes.md and CC-mixed-book-csv-resolves-it.md, 2026-11-11),
// and this script was written and committed before its first run. Nothing below changes after seeing its output
// without saying so in the commit that changes it.
//
// WHAT THE BOOK IS: a frictionless paper simulation for the paper rows (every trade filled in full, instantly, at
// the displayed price), over rows whose execution mode is NOT_KNOWN: Roman, 2026-11-11, "some real, some paper, not
// sure which". For a row that was actually live with a typed fill, a cost model measures something different;
// the Robinhood matcher is what will separate them. This is reported now, with that caveat, not held.
//
// THE QUESTION: what does the book become after realistic entry and exit costs?
// THE METHOD, fixed here:
//   - Population: the same as scripts/prereg-pnl.mjs: data/backups/trades_v2.json @ 314f6e0, sell_price_unverified
//     false (the 586 the Sold tab counts).
//   - The moments: the buy at filled_at when recorded, else buy_date + buy_time (PT); the sale at sell_date +
//     sell_time (PT). Both are the RECORDING moments (sell_time means recorded-at since 5cf9863), which for a paper
//     trade is when the price was taken. A row without one is its own state, not charged.
//   - The quote: SIP NBBO from Alpaca's historical quotes; the LAST valid quote (bid > 0, ask >= bid) in the 60
//     seconds up to and including the moment. None: its own state, never charged zero and never an average.
//   - Costs: BASE CASE half the quoted spread x shares, on the buy and again on the sale. HARSH CASE the full
//     spread on each side, reported beside it with no verdict.
//   - Primary outcome: the cost-adjusted total, and the cost-adjusted mean per buy day, over the trades charged on
//     both sides; the same trades' frictionless figures printed beside them.
//   - Bar and interval: scripts/prereg-pnl.mjs's DESIGN, unchanged (moving-block bootstrap over buy days, blocks of
//     3, 10,000, seed 20261108, 95% two-sided), on the cost-adjusted daily means; at least 20 buy days for a verdict.
//   - What it means, written now: upper bound below zero: "the strategy does not survive costs as traded, and that
//     is the finding." Lower bound above zero: it survives costs, bounded by the largest-contributor test.
//     Otherwise: it cannot be distinguished from break-even after costs.
//   - Also: the cost drag per trade and in total, the break-even win/loss ratio after costs, and coverage: how many
//     trades were charged, and why each other one was not.
//
// Keys: the Alpaca market-data keys from .env.local (permitted by Roman, 2026-11-11), read in memory by
// scripts/lib/alpaca-bars.mjs's alpacaHeaders, never printed and never written. Quote responses are cached
// outside the repo (QUOTES_CACHE, default the OS temp dir) so a re-run reads the same quotes.
//   node scripts/prereg-costs.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DESIGN, blockBootstrapMean, perDay } from './prereg-pnl.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const LOOKBACK_MS = 60_000;
const day = v => (v == null ? null : String(v).slice(0, 10));
const num = v => (v == null || v === '' ? null : Number(v));

// PT wall clock to an instant: PDT before 2026-11-01, PST from it (the book's range).
export const ptInstant = (date, hhmm) => {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Date.parse(`${date}T00:00:00Z`) + ((h + (date >= '2026-11-01' ? 8 : 7)) * 60 + m) * 60000;
};

// The two recording moments, or why one is missing.
export function tradeMoments(t) {
  const buy = t.filled_at ? Date.parse(t.filled_at) : (t.buy_time ? ptInstant(day(t.buy_date), t.buy_time) : null);
  const sell = t.sell_time ? ptInstant(day(t.sell_date), t.sell_time) : null;
  return { buy: Number.isFinite(buy) ? buy : null, sell: Number.isFinite(sell) ? sell : null };
}

// The last valid quote at or before `at`, no older than LOOKBACK_MS. null when there is none.
export function pickQuote(quotes, at) {
  let best = null;
  for (const q of quotes) {
    const t = Date.parse(q.t);
    if (!(t <= at && t >= at - LOOKBACK_MS)) continue;
    if (!(q.bp > 0 && q.ap >= q.bp)) continue;
    if (!best || t >= Date.parse(best.t)) best = q;
  }
  return best;
}

// Costs for one trade: base = half spread each side, harsh = full spread each side, in dollars.
export function costFor(t, buyQ, sellQ) {
  const sh = num(t.shares);
  const bs = buyQ.ap - buyQ.bp, ss = sellQ.ap - sellQ.bp;
  return { base: sh * (bs / 2 + ss / 2), harsh: sh * (bs + ss), buySpread: bs, sellSpread: ss, buyRel: bs / ((buyQ.ap + buyQ.bp) / 2), sellRel: ss / ((sellQ.ap + sellQ.bp) / 2) };
}

export function verdictLine(ci, days) {
  if (days < DESIGN.minDaysForVerdict || !ci) return `fewer than ${DESIGN.minDaysForVerdict} buy days charged: no interval, no verdict`;
  if (ci.upper < 0) return 'VERDICT: the interval is below zero. The strategy does not survive costs as traded, and that is the finding.';
  if (ci.lower > 0) return 'VERDICT: the lower bound is above zero. It survives the base-case costs, bounded by the largest-contributor test.';
  return 'VERDICT: the interval includes zero. After costs it cannot be distinguished from break-even.';
}

const $ = x => (x == null ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);

async function quotesAt(headers, sym, at, cacheDir) {
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
  console.log('WHAT THE BOOK IS: a frictionless paper simulation for the paper rows, over rows whose execution mode is NOT_KNOWN (Roman, 2026-11-11: "some real, some paper, not sure which"). For a row that was live with a typed fill, this cost model measures something different; the Robinhood matcher will separate them.');
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const book = all.filter(r => r.sell_price_unverified === false && num(r.pnl_dollars) != null);
  console.log(`SOURCE: data/backups/trades_v2.json @ ${REV}: ${all.length} rows; population ${book.length} (sell_price_unverified false, with a P&L)`);
  const { alpacaHeaders } = await import('./lib/alpaca-bars.mjs');
  // .env.local lives in the main checkout; a worktree points at it with EDGE2_ENV_DIR. Read in memory only.
  const headers = alpacaHeaders(process.env.EDGE2_ENV_DIR || ROOT);
  const cacheDir = process.env.QUOTES_CACHE || path.join(os.tmpdir(), 'edge2-quotes-cache');
  mkdirSync(cacheDir, { recursive: true });

  const states = {}, charged = [];
  const note = (k, t, missAt = null, rawEmpty = null) => { (states[k] = states[k] || []).push({ t, missAt, rawEmpty }); };
  for (const t of book) {
    const m = tradeMoments(t);
    if (m.buy == null) { note('no recorded buy moment', t); continue; }
    if (m.sell == null) { note('no recorded sale moment', t); continue; }
    const bRaw = await quotesAt(headers, t.ticker, m.buy, cacheDir), sRaw = await quotesAt(headers, t.ticker, m.sell, cacheDir);
    const bq = pickQuote(bRaw, m.buy);
    const sq = pickQuote(sRaw, m.sell);
    if (!bq && !sq) { note('no valid quote at either moment', t, m.buy, bRaw.length === 0); continue; }
    if (!bq) { note('no valid quote at the buy', t, m.buy, bRaw.length === 0); continue; }
    if (!sq) { note('no valid quote at the sale', t, m.sell, sRaw.length === 0); continue; }
    charged.push({ t, c: costFor(t, bq, sq) });
  }
  console.log(`\nCOVERAGE: ${charged.length} of ${book.length} trades charged on both sides`);
  for (const [k, v] of Object.entries(states)) console.log(`  not charged, ${k}: ${v.length}`);
  // ADDED 2026-11-11 after the first run, declared (CC-cost-verdict-and-spread-question.md): what the uncharged
  // trades are. A description of coverage, not a new analysis: nothing above is computed differently.
  const period = d => (d < '2026-09-15' ? 'A' : d < '2026-10-21' ? 'B' : d < '2026-11-01' ? 'D' : 'E');
  const ptHour = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit' });
  const count = (arr, f) => arr.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
  console.log('  UNCHARGED, DESCRIBED (added after the first run, declared):');
  console.log(`    charged: frictionless total ${$(charged.reduce((a, x) => a + num(x.t.pnl_dollars), 0))}, periods ${JSON.stringify(count(charged, x => period(day(x.t.buy_date))))}`);
  for (const [k, v] of Object.entries(states)) {
    const withMoment = v.filter(x => x.missAt != null);
    console.log(`    ${k}: ${v.length}, frictionless total ${$(v.reduce((a, x) => a + num(x.t.pnl_dollars), 0))}, periods ${JSON.stringify(count(v, x => period(day(x.t.buy_date))))}` +
      (withMoment.length ? `; no quote at all in the 60 s window: ${withMoment.filter(x => x.rawEmpty).length} of ${withMoment.length}; PT hour of the missing moment: ${JSON.stringify(count(withMoment, x => ptHour(x.missAt)))}` : ''));
  }

  const frictionless = charged.map(x => x.t), sum = a => a.reduce((s, x) => s + x, 0);
  const adj = (which) => charged.map(x => ({ buy_date: x.t.buy_date, pnl_dollars: num(x.t.pnl_dollars) - x.c[which] }));
  for (const which of ['base', 'harsh']) {
    const rows = adj(which), days = perDay(rows), series = days.map(([, v]) => v);
    const total = sum(rows.map(r => r.pnl_dollars)), drag = sum(charged.map(x => x.c[which]));
    const wins = rows.filter(r => r.pnl_dollars > 0).length, losses = rows.filter(r => r.pnl_dollars < 0).length;
    const avgW = wins ? sum(rows.filter(r => r.pnl_dollars > 0).map(r => r.pnl_dollars)) / wins : null;
    const avgL = losses ? sum(rows.filter(r => r.pnl_dollars < 0).map(r => r.pnl_dollars)) / losses : null;
    console.log(`\n${which === 'base' ? 'BASE CASE (half spread each side): the primary outcome' : 'HARSH CASE (full spread each side): reported, no verdict'}`);
    console.log(`  frictionless on the same ${charged.length} trades: total ${$(sum(frictionless.map(t => num(t.pnl_dollars))))}, per buy day ${$(sum(frictionless.map(t => num(t.pnl_dollars))) / perDay(frictionless).length)}`);
    console.log(`  cost drag: total ${$(drag)}, per trade ${$(drag / charged.length)}`);
    console.log(`  cost-adjusted: total ${$(total)}, ${days.length} buy days, mean per buy day ${$(total / days.length)}, per trade ${$(total / rows.length)}`);
    console.log(`  after costs W/L ${wins}/${losses}, avg win ${$(avgW)}, avg loss ${$(avgL)}, ratio ${avgW != null && avgL ? (avgW / Math.abs(avgL)).toFixed(3) : '—'}; break-even ratio at this win share: losses / wins = ${wins ? (losses / wins).toFixed(3) : '—'}`);
    if (which === 'base') {
      const ci = days.length >= DESIGN.minDaysForVerdict ? blockBootstrapMean(series, DESIGN) : null;
      if (ci) console.log(`  95% moving-block bootstrap (blocks of ${DESIGN.blockLength}, ${DESIGN.resamples} resamples, seed ${DESIGN.seed}): ${$(ci.lower)} to ${$(ci.upper)}`);
      console.log(`  ${verdictLine(ci, days.length)}`);
    }
  }
  const rel = charged.flatMap(x => [x.c.buyRel, x.c.sellRel]).sort((a, b) => a - b);
  const q = f => (rel.length ? (100 * rel[Math.floor(f * (rel.length - 1))]).toFixed(2) + '%' : '—');
  console.log(`\nQUOTED SPREAD at the moments, as a share of the midpoint (both sides, ${rel.length} quotes): p25 ${q(0.25)}, median ${q(0.5)}, p75 ${q(0.75)}, p90 ${q(0.9)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });

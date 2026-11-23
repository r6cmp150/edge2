#!/usr/bin/env node
// scripts/measure-spread-net.mjs -- what did the 586 return buying at the ask and selling at the bid? Read only.
// (2026-11-20, the reviewer: "flat before costs, now measure the spread and be done".) Cost accounting, NOT a
// hypothesis test: there is no bar, and it is reported whichever way it falls. It does not bear on the score
// question, which is closed (ef99790; on corrected entries, 84d161a).
//
// WHAT CAME BEFORE: scripts/prereg-costs.mjs (2026-11-11, STATUS.md) charged half the quoted spread on each side ON
// TOP OF THE RECORDED PRICES: on its 513 trades, -$0.12 a trade frictionless became -$1.57. The recorded prices are
// now known to be wrong on some trades (84d161a, 8bc7432). This replaces the recorded price with the quote itself:
// a taker buys at the ask and sells at the bid, so neither end depends on what was recorded.
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   SAMPLE: the pre-registered 586: trades_v2 @ 314f6e0, sell_price_unverified false.
//   MOMENTS AND QUOTES: exactly prereg-costs.mjs's, imported, not copied: the buy at filled_at when recorded, else
//     buy_date + buy_time (Pacific); the sale at sell_date + sell_time; the SIP NBBO there is the LAST VALID quote
//     (bid > 0, ask >= bid) in the 60 seconds up to and including the moment. So the coverage is comparable with the
//     11-11 run's (513 quoted at both ends), and it is printed beside it.
//   A TRADE WITHOUT A VALID QUOTE AT EITHER END is not charged and not given a P&L: it is counted by reason and named.
//     No constant spread, no average and no proxy stands in for a missing quote.
//   PER TRADE (recorded shares, never re-sized): NET = shares x (sale bid - buy ask). Beside it, on the same trades,
//     MID = shares x (sale mid - buy mid), the frictionless figure at the quote; SPREAD COST = MID - NET.
//     ROUND-TRIP SPREAD = half the buy spread over the buy mid plus half the sale spread over the sale mid, as a
//     percentage of the position: what crossing costs on one round trip.
//   REPORTED: coverage; net, mid and spread cost in total and per trade; the median round-trip spread; the median
//     quoted spread per side; and CONCENTRATION, the standing check: the share of the net total from its 5 largest
//     contributors by absolute size, and what the rest net.
//   CONSTRAINED: scripts/replay-budget-constrained.mjs (478e142), unchanged ($1,500, Available = budget minus open
//     positions at cost, recorded share counts, same-minute entries by score), run over the trades quoted at both ends
//     with the ASK as each entry's price (so its cost) and NET as its P&L, with the same figures and concentration.
//     LIMIT, printed: an unquoted trade is absent from the replay, so the budget fills as if it never existed.
//   LIMIT, RECORDED AFTER THE RUN (2026-11-22, the reviewer; no number here changes): the 73 unquoted include all 24 buys
//     of Sunday 2026-09-27, a day with no market (scripts/audit-temporal.mjs, af9d788). 23 had no buy quote, 1 none at
//     either end. None of the 24 is in the 513.
//   node scripts/measure-spread-net.mjs [--env-root <dir with .env.local>] [--out <file.csv outside the repo>]
//   (quotes are cached outside the repo, as prereg-costs.mjs does: QUOTES_CACHE, default the OS temp dir)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';
import { tradeMoments, pickQuote, quotesAt, LOOKBACK_MS } from './prereg-costs.mjs';
import { replay } from './replay-budget-constrained.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0';
export const TOP_N = 5;
export const NOT_THE_SCORE_QUESTION = 'Cost accounting, not a hypothesis test: no bar. This does not bear on the score question, which is closed (ef99790; on corrected entries, 84d161a).';

const mid = q => (q.ap + q.bp) / 2;
export const netDollars = (shares, buyQ, sellQ) => Number(shares) * (sellQ.bp - buyQ.ap);
export const midDollars = (shares, buyQ, sellQ) => Number(shares) * (mid(sellQ) - mid(buyQ));
export const roundTripSpreadPct = (buyQ, sellQ) => 100 * ((buyQ.ap - buyQ.bp) / 2 / mid(buyQ) + (sellQ.ap - sellQ.bp) / 2 / mid(sellQ));
// why a trade is not charged, or null when it is
export const uncharged = (bq, sq) => (!bq && !sq ? 'no valid quote at either end' : !bq ? 'no valid quote at the buy' : !sq ? 'no valid quote at the sale' : null);
// the share of a total from its n largest contributors by absolute size, and what the rest net
export function concentration(values, n = TOP_N) {
  const total = values.reduce((a, v) => a + v, 0);
  const top = [...values].sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, n).reduce((a, v) => a + v, 0);
  return { total, top, rest: total - top, n: Math.min(n, values.length) };
}
// the trade as the replay sees it: entry at the ask (its cost), P&L the net
export const atQuotes = (r, buyQ, sellQ) => ({ ...r, buy_price: buyQ.ap, sell_price: sellQ.bp, pnl_dollars: netDollars(r.shares, buyQ, sellQ) });
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const usd = x => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const concLine = c => `the ${c.n} largest contribute ${usd(c.top)} of ${usd(c.total)}; the rest net ${usd(c.rest)}`;

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const cacheDir = process.env.QUOTES_CACHE || path.join(os.tmpdir(), 'edge2-quotes-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const sample = all.filter(r => r.sell_price_unverified === false);
  console.log('A FRICTIONLESS PAPER SIMULATION re-priced at the quote, not P&L (STATUS). Read only; SIP NBBO.');
  console.log(`SOURCE: data/backups/trades_v2.json @ ${REV}: the sample (sell_price_unverified false): ${sample.length}. Quote: the last valid one in the ${LOOKBACK_MS / 1000} s up to each moment.`);
  const out = [];
  for (const r of sample) {
    const m = tradeMoments(r);
    const bq = m.buy == null ? null : pickQuote(await quotesAt(headers, r.ticker, m.buy, cacheDir), m.buy);
    const sq = m.sell == null ? null : pickQuote(await quotesAt(headers, r.ticker, m.sell, cacheDir), m.sell);
    out.push({ r, bq, sq, why: uncharged(bq, sq) });
  }
  const charged = out.filter(x => !x.why);
  const reasons = {}; for (const x of out.filter(x => x.why)) (reasons[x.why] ||= []).push(`${x.r.ticker} ${String(x.r.buy_date).slice(0, 10)}`);
  console.log(`\nCOVERAGE: quoted at both ends ${charged.length} of ${out.length} (11-11, prereg-costs.mjs: 513).`);
  for (const [k, v] of Object.entries(reasons)) console.log(`  not charged, ${k}: ${v.length} -- ${v.join('; ')}`);

  const net = charged.map(x => netDollars(x.r.shares, x.bq, x.sq)), mids = charged.map(x => midDollars(x.r.shares, x.bq, x.sq));
  const sum = a => a.reduce((s, v) => s + v, 0), n = charged.length;
  console.log(`\nFULL (the ${n} quoted at both ends):`);
  console.log(`  MID (frictionless at the quote): ${usd(sum(mids))}, ${usd(sum(mids) / n)} a trade`);
  console.log(`  SPREAD COST:                     ${usd(sum(mids) - sum(net))}, ${usd((sum(mids) - sum(net)) / n)} a trade`);
  console.log(`  NET (buy at the ask, sell at the bid): ${usd(sum(net))}, ${usd(sum(net) / n)} a trade`);
  console.log(`  median round-trip spread ${median(charged.map(x => roundTripSpreadPct(x.bq, x.sq))).toFixed(3)}% of the position; median quoted spread over mid: buy ${median(charged.map(x => 100 * (x.bq.ap - x.bq.bp) / mid(x.bq))).toFixed(3)}%, sale ${median(charged.map(x => 100 * (x.sq.ap - x.sq.bp) / mid(x.sq))).toFixed(3)}%`);
  console.log(`  CONCENTRATION of NET: ${concLine(concentration(net))}`);

  const rc = replay(charged.map(x => atQuotes(x.r, x.bq, x.sq)));
  const takenNet = [...rc.taken].map(r => Number(r.pnl_dollars));
  console.log(`\nCONSTRAINED ($1,500), the ${n} quoted trades at the ask and the bid: taken ${rc.taken.size}, skipped ${rc.skipped}: NET ${usd(rc.constrained.total)}, ${usd(rc.constrained.perTrade)} a trade.`);
  console.log(`  CONCENTRATION of NET: ${concLine(concentration(takenNet))}`);
  console.log(`  LIMIT: the ${out.length - n} unquoted trades are absent from the replay, so the budget fills as if they never existed.`);
  console.log(`\n${NOT_THE_SCORE_QUESTION}`);
  const file = arg('--out');
  if (file) {
    if (path.resolve(file).startsWith(path.resolve(ROOT))) throw new Error('--out must be outside the repository');
    fs.writeFileSync(file, ['ticker,buy_date,shares,buy_bid,buy_ask,sell_bid,sell_ask,net,mid,why',
      ...out.map(x => [x.r.ticker, String(x.r.buy_date).slice(0, 10), x.r.shares, x.bq?.bp ?? '', x.bq?.ap ?? '', x.sq?.bp ?? '', x.sq?.ap ?? '', x.why ? '' : netDollars(x.r.shares, x.bq, x.sq), x.why ? '' : midDollars(x.r.shares, x.bq, x.sq), x.why ?? ''].join(','))].join('\n'));
    console.log(`rows: ${file}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

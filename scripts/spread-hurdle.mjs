#!/usr/bin/env node
// scripts/spread-hurdle.mjs -- THE BAR, NOT A RESULT: the gross return any strategy trading Roman's universe the way he
// trades it must exceed to break even after crossing the spread. Read only. (2026-11-22, the reviewer: "record the
// hurdle before this closes ... the arithmetic shown, not just the figure".) Descriptive arithmetic on the 513 trades
// scripts/measure-spread-net.mjs (ece5bdd) priced at the quote, with its own moments, quotes and functions, imported;
// the quotes are read from the same cache, so it reproduces that run's 513.
//   PER TRADE: position value V = shares x buy mid. Round-trip spread cost C = shares x (half the buy spread + half the
//     sale spread) = MID - NET (a taker pays half the spread each way against the mid). RT% = C / V x 100 at each side's
//     own mid (measure-spread-net's roundTripSpreadPct).
//   THE HURDLE: a strategy's gross return per trade must exceed the spread it pays. In percent of the position, the
//     dollar-weighted figure SUM(C) / SUM(V); in dollars at a typical position, the median V times that percent. The
//     median and mean of RT% are printed beside it, and the same for buys under $5 and at $5 or more (by buy mid).
//   CONCENTRATION (the standing habit): the share of SUM(C) from its 5 largest trades.
//   node scripts/spread-hurdle.mjs [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';
import { tradeMoments, pickQuote, quotesAt } from './prereg-costs.mjs';
import { midDollars, netDollars, roundTripSpreadPct, uncharged, concentration } from './measure-spread-net.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0', SPLIT_PRICE = 5;
const mid = q => (q.ap + q.bp) / 2;
// one trade's V, C and RT%
export const tradeCost = (shares, bq, sq) => { const V = Number(shares) * mid(bq), C = midDollars(shares, bq, sq) - netDollars(shares, bq, sq); return { V, C, rt: roundTripSpreadPct(bq, sq) }; };
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
// the hurdle over a set of trade costs: { n, sumC, sumV, weightedPct, medianV, hurdleDollars, medianRt, meanRt }
export function hurdle(costs) {
  const sumC = costs.reduce((a, x) => a + x.C, 0), sumV = costs.reduce((a, x) => a + x.V, 0), weightedPct = 100 * sumC / sumV, medianV = median(costs.map(x => x.V));
  return { n: costs.length, sumC, sumV, weightedPct, medianV, hurdleDollars: medianV * weightedPct / 100, medianRt: median(costs.map(x => x.rt)), meanRt: mean(costs.map(x => x.rt)) };
}
const usd = x => `$${x.toFixed(2)}`;
function lines(label, h) {
  return [`${label} (${h.n} trades):`,
    `  SUM(C) ${usd(h.sumC)} / SUM(V) ${usd(h.sumV)} x 100 = ${h.weightedPct.toFixed(3)}% of the position, dollar-weighted`,
    `  median position V ${usd(h.medianV)} x ${h.weightedPct.toFixed(3)}% = ${usd(h.hurdleDollars)} a trade`,
    `  RT% per trade: median ${h.medianRt.toFixed(3)}%, mean ${h.meanRt.toFixed(3)}%`];
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const cacheDir = process.env.QUOTES_CACHE || path.join(os.tmpdir(), 'edge2-quotes-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const sample = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString())).filter(r => r.sell_price_unverified === false);
  const costs = [];
  for (const r of sample) {
    const m = tradeMoments(r);
    const bq = m.buy == null ? null : pickQuote(await quotesAt(headers, r.ticker, m.buy, cacheDir), m.buy);
    const sq = m.sell == null ? null : pickQuote(await quotesAt(headers, r.ticker, m.sell, cacheDir), m.sell);
    if (!uncharged(bq, sq)) costs.push({ ...tradeCost(r.shares, bq, sq), buyMid: mid(bq) });
  }
  console.log(`THE BAR, NOT A RESULT. Source: trades_v2 @ ${REV}, the ${costs.length} trades quoted at both ends (ece5bdd: 513), SIP NBBO.`);
  for (const l of lines('ALL', hurdle(costs))) console.log(l);
  for (const l of lines(`buy mid under $${SPLIT_PRICE}`, hurdle(costs.filter(x => x.buyMid < SPLIT_PRICE)))) console.log(l);
  for (const l of lines(`buy mid $${SPLIT_PRICE} or more`, hurdle(costs.filter(x => x.buyMid >= SPLIT_PRICE)))) console.log(l);
  const c = concentration(costs.map(x => x.C));
  console.log(`CONCENTRATION of SUM(C): the ${c.n} largest ${usd(c.top)} of ${usd(c.total)}; the rest ${usd(c.rest)}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

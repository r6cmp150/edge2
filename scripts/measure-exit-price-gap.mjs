#!/usr/bin/env node
// scripts/measure-exit-price-gap.mjs -- is each recorded sell_price the price the market was trading at the sell
// minute, and what did the 586 return with BOTH ends at the traded price? Read only. (2026-11-20, the reviewer: "the
// score question is closed, now finish the P&L".) This does NOT bear on the score question: that is closed
// (ef99790, and on corrected entries 84d161a), and nothing here re-runs it.
//
// THE CODE, read before this was written: the Mark as Sold form pre-fills its price from the portfolio row's
// currentPrice = getLivePrice(snap) || p.buyPrice (app.js:5535), the same getLivePrice as the entry
// (core/market-data.js:37, a daily bar's close preferred however old). Two guards were added later: the buyPrice
// fallback renders an empty field instead (its 22 trades are the sell_price_unverified rows, outside this sample), and
// since 3f15225 (2026-11-02) an earlier session's close is withheld rather than pre-filled. Before 11-02 a stale close
// could be pre-filled as the sale price.
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   SAMPLE: the pre-registered 586: trades_v2 @ 314f6e0, sell_price_unverified false. No exclusions.
//   SELL MINUTE: sell_date + sell_time, a Pacific wall clock: sell_time is the RECORDING time (getPT() at the save,
//     app.js:7689). On 586 of 586 it lies within 2 minutes of the row's created_at (printed again below), so each sale
//     was recorded at the minute it was made and sell_date was not moved off the recording day.
//   REFERENCE, BOTH ENDS: exactly the entry measurement's (scripts/measure-entry-price-gap.mjs, 84d161a): the close of
//     the latest SIP 1-minute bar starting at or before the minute, raw, looking back 7 days. The entry end is fetched
//     again by the same code, and its count of trades off by 1% or more is printed beside 84d161a's 51.
//   EXIT GAP: 100 x (sell_price - reference) / reference, signed (positive: the recorded sale was above the market,
//     which flatters the result).
//   BIASED (fixed now): a mean signed gap of at least 0.25% in either direction. Applied to both ends and printed for
//     each; the entry end's measured +0.069% (84d161a) is below it. A biased end is named as a finding about
//     systematically distorted results. It does not reopen the score test.
//   THE P&L, RECOMPUTED (no bar: it is correcting the arithmetic inputs of a reported number, reported whichever way it
//     moves). Per trade: recorded shares x (exit reference - entry reference); recorded shares are never changed. On
//     the recorded prices this arithmetic reproduces pnl_dollars on 586 of 586 to the cent (-$300.43), so recorded and
//     corrected are the same sum over different prices. Reported: the full 586 (total and per trade), and the
//     budget-constrained replay (scripts/replay-budget-constrained.mjs, 478e142) run again unchanged with the
//     corrected entry as its cost and the corrected P&L. Each beside its recorded figure, and the full figure with
//     only the entry corrected and with only the exit corrected, so the movement can be attributed.
//   If any trade lacks either reference, no corrected figure is computed: the trades are named and it goes back to the
//     reviewer. Nothing is substituted.
//   Frictionless, as every figure before it: no costs.
//   node scripts/measure-exit-price-gap.mjs [--env-root <dir with .env.local>] [--out <file.csv outside the repo>]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc, pickReference, gapPct, gapTable, ageTable, latestSipBar, MATERIAL_GAP_PCT } from './measure-entry-price-gap.mjs';
import { replay } from './replay-budget-constrained.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0';
export const BIAS_PCT = 0.25;
export const NOT_THE_SCORE_QUESTION = 'This does not bear on the score question: it is closed (ef99790; on corrected entries, 84d161a) and is not re-run here.';

export const meanOf = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const isBiased = gaps => Math.abs(meanOf(gaps)) >= BIAS_PCT;
export const pnlDollars = (shares, buy, sell) => Number(shares) * (Number(sell) - Number(buy));
// the trade as the replay sees it, with the given entry and exit: cost and P&L follow; nothing else changes
export const repriced = (r, buy, sell) => ({ ...r, buy_price: buy, sell_price: sell, pnl_dollars: pnlDollars(r.shares, buy, sell) });
export function totals(rows) { const total = rows.reduce((a, r) => a + Number(r.pnl_dollars), 0); return { n: rows.length, total, perTrade: rows.length ? total / rows.length : null }; }
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const usd = x => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const fig = f => `${f.n} trades, ${usd(f.total)}, ${usd(f.perTrade)} a trade`;

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const sample = all.filter(r => r.sell_price_unverified === false);
  console.log('A FRICTIONLESS PAPER SIMULATION, not P&L (STATUS). Read only; SIP 1-minute bars, raw.');
  console.log(`SOURCE: data/backups/trades_v2.json @ ${REV}: the sample (sell_price_unverified false): ${sample.length}.`);
  const sellMs = r => pacificMinuteUtc(String(r.sell_date).slice(0, 10), r.sell_time);
  const recordedAtSale = sample.filter(r => Math.abs(Date.parse(r.created_at) - sellMs(r)) <= 2 * 60000).length;
  console.log(`SELL MINUTE: sell_date + sell_time (Pacific) within 2 minutes of created_at on ${recordedAtSale} of ${sample.length}.`);
  console.log(`sell_price of 0: ${sample.filter(r => Number(r.sell_price) === 0).length}; missing: ${sample.filter(r => r.sell_price == null || r.sell_price === '').length}.`);

  const out = [];
  for (const r of sample) {
    const bMs = pacificMinuteUtc(String(r.buy_date).slice(0, 10), r.buy_time), sMs = sellMs(r);
    const buyRef = pickReference(await latestSipBar(headers, r.ticker, bMs), bMs);
    await new Promise(res => setTimeout(res, 320));
    const sellRef = pickReference(await latestSipBar(headers, r.ticker, sMs), sMs);
    await new Promise(res => setTimeout(res, 320));
    out.push({ r, buyRef, sellRef, buyGap: buyRef ? gapPct(r.buy_price, buyRef.price) : null, sellGap: sellRef ? gapPct(r.sell_price, sellRef.price) : null });
  }
  const noBuy = out.filter(x => !x.buyRef), noSell = out.filter(x => !x.sellRef);
  const buyGaps = out.filter(x => x.buyRef).map(x => x.buyGap), sellGaps = out.filter(x => x.sellRef).map(x => x.sellGap);
  console.log(`\nENTRY END, fetched again: reference for ${buyGaps.length} of ${out.length}; |gap| >= ${MATERIAL_GAP_PCT}%: ${buyGaps.filter(g => Math.abs(g) >= MATERIAL_GAP_PCT).length} (84d161a: 51).`);
  console.log(`EXIT END: reference for ${sellGaps.length} of ${out.length}${noSell.length ? '; NO REFERENCE: ' + noSell.map(x => `${x.r.ticker} ${String(x.r.sell_date).slice(0, 10)} ${x.r.sell_time}`).join('; ') : ''}.`);
  console.log('EXIT REFERENCE AGE:'); for (const a of ageTable(out.filter(x => x.sellRef).map(x => x.sellRef.ageMin))) console.log(`  ${a.label.padEnd(12)} ${a.n}`);
  console.log('EXIT |GAP| (recorded sell_price against the SIP reference):'); for (const g of gapTable(sellGaps)) console.log(`  ${g.label.padEnd(14)} ${g.n}`);
  const split = gs => `above the market ${gs.filter(g => g > 0).length}, below ${gs.filter(g => g < 0).length}, equal ${gs.filter(g => g === 0).length}`;
  for (const [name, gs] of [['ENTRY', buyGaps], ['EXIT', sellGaps]]) console.log(`${name}: mean signed gap ${meanOf(gs).toFixed(3)}%, median signed ${median(gs).toFixed(3)}%, median |gap| ${median(gs.map(Math.abs)).toFixed(3)}%; ${split(gs)} -> ${isBiased(gs) ? `BIASED (|mean| >= ${BIAS_PCT}%)` : `not biased (|mean| < ${BIAS_PCT}%)`}.`);
  const pre = out.filter(x => x.sellRef && String(x.r.sell_date).slice(0, 10) < '2026-11-02'), post = out.filter(x => x.sellRef && String(x.r.sell_date).slice(0, 10) >= '2026-11-02');
  console.log(`EXIT |gap| >= ${MATERIAL_GAP_PCT}% by the 11-02 withholding guard (3f15225): sold before 11-02 ${pre.filter(x => Math.abs(x.sellGap) >= MATERIAL_GAP_PCT).length} of ${pre.length}; from 11-02 ${post.filter(x => Math.abs(x.sellGap) >= MATERIAL_GAP_PCT).length} of ${post.length}.`);
  console.log('LARGEST 10 EXIT |gap|:'); for (const x of out.filter(x => x.sellRef).sort((a, b) => Math.abs(b.sellGap) - Math.abs(a.sellGap)).slice(0, 10)) console.log(`  ${x.r.ticker.padEnd(5)} sold ${String(x.r.sell_date).slice(0, 10)} ${x.r.sell_time}  recorded ${x.r.sell_price}  SIP ${x.sellRef.price} (${x.sellRef.ageMin} min old)  gap ${x.sellGap >= 0 ? '+' : ''}${x.sellGap.toFixed(2)}%`);

  console.log('\nTHE P&L, RECOMPUTED (frictionless; recorded shares):');
  if (noBuy.length || noSell.length) console.log(`NOT COMPUTED: ${noBuy.length} trade(s) without an entry reference and ${noSell.length} without an exit reference. Back to the reviewer.`);
  else {
    const recorded = out.map(x => x.r);
    const both = out.map(x => repriced(x.r, x.buyRef.price, x.sellRef.price));
    const entryOnly = out.map(x => repriced(x.r, x.buyRef.price, x.r.sell_price)), exitOnly = out.map(x => repriced(x.r, x.r.buy_price, x.sellRef.price));
    console.log(`  FULL, recorded prices:       ${fig(totals(recorded))}`);
    console.log(`  FULL, entry corrected only:  ${fig(totals(entryOnly))}`);
    console.log(`  FULL, exit corrected only:   ${fig(totals(exitOnly))}`);
    console.log(`  FULL, BOTH CORRECTED:        ${fig(totals(both))}`);
    const rc = replay(recorded), cc = replay(both);
    console.log(`  CONSTRAINED ($1,500), recorded:   ${fig(rc.constrained)} (taken ${rc.taken.size}, skipped ${rc.skipped})`);
    console.log(`  CONSTRAINED ($1,500), CORRECTED:  ${fig(cc.constrained)} (taken ${cc.taken.size}, skipped ${cc.skipped})`);
  }
  console.log(`\n${NOT_THE_SCORE_QUESTION}`);
  const file = arg('--out');
  if (file) {
    if (path.resolve(file).startsWith(path.resolve(ROOT))) throw new Error('--out must be outside the repository');
    fs.writeFileSync(file, ['ticker,buy_date,buy_time,buy_price,buy_ref,buy_ref_age,buy_gap,sell_date,sell_time,sell_price,sell_ref,sell_ref_age,sell_gap,shares,pnl_dollars',
      ...out.map(x => [x.r.ticker, String(x.r.buy_date).slice(0, 10), x.r.buy_time, x.r.buy_price, x.buyRef?.price ?? '', x.buyRef?.ageMin ?? '', x.buyGap ?? '', String(x.r.sell_date).slice(0, 10), x.r.sell_time, x.r.sell_price, x.sellRef?.price ?? '', x.sellRef?.ageMin ?? '', x.sellGap ?? '', x.r.shares, x.r.pnl_dollars].join(','))].join('\n'));
    console.log(`rows: ${file}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

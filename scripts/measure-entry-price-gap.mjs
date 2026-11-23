#!/usr/bin/env node
// scripts/measure-entry-price-gap.mjs -- is each recorded buy_price the price the market was trading at the buy
// minute? Read only. (2026-11-20, the reviewer: "the entry price is the outcome variable, measure it first".)
// Why: buy_price is the add form's pre-fill (app.js:4429/4452), which is the signal's price, which is
// getLivePrice(snap) = snap.dailyBar?.c || snap.latestTrade?.p || 0 (core/market-data.js:37): the daily bar's close is
// preferred even when the bar is days old. On the 244 trades with a signal_snapshot_at_buy, buy_price equals that
// pre-fill (to 2 dp) on 244 of 244, and 2 of the 156 that record the bar's age scored on a bar 1 or 2 trading days old.
// Every result in this project is measured from buy_price, so this comes before anything else.
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   SAMPLE: the pre-registered 586: trades_v2 @ 314f6e0, sell_price_unverified false. No exclusions.
//   FEED: Alpaca SIP (consolidated tape), 1-minute bars, adjustment raw (buy_price is a raw price). Checked
//     2026-11-20 before this was written: the key returns feed=sip for historical minutes (prints from several
//     exchanges). The two probes were DRVN and IPST 2026-11-05, the two trades already known to have scored on a
//     stale bar, so their gaps were seen before this was declared; no other trade's was.
//   BUY MINUTE: buy_date + buy_time, a Pacific wall clock (app.js:4957, getPT() at the add), PDT (UTC-7) before
//     2026-11-01 and PST (UTC-8) from it. On the 316 trades with a position_id (Date.now() at the add) this equals
//     the position_id instant to the minute on 316 of 316 (printed again below). CORRECTED 2026-11-22 (the
//     self-referential-guard sweep): BOTH ARE THE ADD'S OWN CLOCK, so that agreement checks only the Pacific
//     conversion and that buy_date was not moved off the add's day. It says NOTHING about when the buy was decided.
//     The price work stands on a different ground: in a paper book the add is when the price was taken, so the add's
//     minute IS the reference for "was the recorded price the market price". For the 270 without a position_id even
//     the conversion is not checkable: a backdated add would carry the add's clock time on a different day.
//   REFERENCE: the close of the latest SIP 1-minute bar starting at or before the buy minute, looking back up to 7
//     days (the last sale, whatever the session). The bar of the buy minute itself counts, so its close can be up to
//     59 seconds after the add. Its age (buy minute minus the bar's start) is printed. A trade with no bar in 7 days
//     has NO REFERENCE and is named; nothing is substituted for it.
//   GAP: 100 x (buy_price - reference) / reference, signed (positive: recorded above the market).
//   WHAT THE GAP IS: the whole error of the recorded entry against the consolidated tape. It mixes a stale bar with
//     the IEX-versus-SIP difference of the scorer's feed and does not separate them.
//   NOT MEASURED HERE: sell_price. The same question applies to it; this measurement does not answer it.
//   MATERIAL (fixed now): at least 30 of the 586 (5%) have |gap| >= 1%. A shortfall is NOT MATERIAL.
//   THE RULE (the reviewer's, 2026-11-20, written before the gap was known): if entry prices are materially wrong,
//     the score-versus-return test (scripts/score-vs-return.mjs, ef99790) is re-run with CORRECTED returns,
//     100 x (sell_price - reference) / reference, on all 586, no exclusions, the bar unchanged (rho > 0 and
//     one-sided p < 0.05, shuffled within days). If any trade has no reference, "all 586" cannot be applied: the
//     re-run does not run, the trades are named, and the question goes back to the reviewer. If NOT MATERIAL, the
//     re-run is not computed at all.
//   THIS IS THE LAST RE-RUN: if corrected returns are also null, that is the answer.
//   node scripts/measure-entry-price-gap.mjs [--env-root <dir with .env.local>] [--out <file.csv outside the repo>]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';
import { analyse, bucketLine, PERMUTATIONS, SEED } from './score-vs-return.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0';
export const MATERIAL_GAP_PCT = 1, MATERIAL_MIN_TRADES = 30, LOOKBACK_DAYS = 7;
export const GAP_BUCKETS = [0.25, 0.5, 1, 2, 5];
export const AGE_BUCKETS = [[0, 0, 'same minute'], [1, 5, '1-5 min'], [6, 15, '6-15 min'], [16, 60, '16-60 min'], [61, Infinity, 'over 60 min']];
export const LAST_RERUN = 'THIS IS THE LAST RE-RUN: if corrected returns are also null, that is the answer, and the only thing left to do with this sample is write down what it taught us.';

// a Pacific wall-clock minute -> its UTC instant (ms). PDT before 2026-11-01, PST from it (the sample is 2026-08..11).
export function buyMinuteUtc(date, hm) {
  const off = date >= '2026-11-01' ? 8 : 7;
  const [h, m] = String(hm).slice(0, 5).split(':').map(Number);
  return Date.parse(`${date}T00:00:00Z`) + ((h + off) * 60 + m) * 60000;
}
// the latest bar STARTING AT OR BEFORE the buy minute; never one after it. null when there is none.
export function pickReference(bars, buyMs) {
  let best = null;
  for (const b of bars || []) { const t = Date.parse(b.t); if (t <= buyMs && (!best || t > best.t)) best = { t, price: b.c }; }
  return best && { price: best.price, barStart: new Date(best.t).toISOString(), ageMin: Math.round((buyMs - best.t) / 60000) };
}
export const gapPct = (buyPrice, ref) => 100 * (Number(buyPrice) - ref) / ref;
export const correctedReturnPct = (sellPrice, ref) => 100 * (Number(sellPrice) - ref) / ref;
export const isMaterial = gaps => gaps.filter(g => Math.abs(g) >= MATERIAL_GAP_PCT).length >= MATERIAL_MIN_TRADES;
// 'run' | 'not-material' | 'cannot-apply' (a trade without a reference: "all 586" is impossible)
export const rerunDecision = ({ material, missing }) => (!material ? 'not-material' : missing > 0 ? 'cannot-apply' : 'run');
export function gapTable(gaps) {
  const edges = [0, ...GAP_BUCKETS, Infinity];
  return edges.slice(0, -1).map((lo, i) => ({ label: edges[i + 1] === Infinity ? `>= ${lo}%` : `${lo}% to <${edges[i + 1]}%`, n: gaps.filter(g => Math.abs(g) >= lo && Math.abs(g) < edges[i + 1]).length }));
}
export function ageTable(ages) { return AGE_BUCKETS.map(([lo, hi, label]) => ({ label, n: ages.filter(a => a >= lo && a <= hi).length })); }
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

// One request per trade, and the ONLY bar wanted is the latest at or before the buy minute: sort=desc&limit=1 returns
// exactly that bar, so no page holding a wanted bar can exist (CLAUDE.md pagination rule: the window is asked for one
// bar and one bar is all that is used).
export async function latestSipBar(headers, sym, buyMs) {
  const start = new Date(buyMs - LOOKBACK_DAYS * 86400000).toISOString(), end = new Date(buyMs).toISOString();
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(sym)}&timeframe=1Min&start=${start}&end=${end}&feed=sip&adjustment=raw&limit=1&sort=desc`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429 && attempt < 6) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const body = await res.json();
    if (!res.ok) throw new Error(`bars sip ${sym}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    return body.bars?.[sym] || [];
  }
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const sample = all.filter(r => r.sell_price_unverified === false);
  console.log('A FRICTIONLESS PAPER SIMULATION, not P&L (STATUS). Read only; SIP 1-minute bars, raw.');
  console.log(`SOURCE: data/backups/trades_v2.json @ ${REV}: the sample (sell_price_unverified false): ${sample.length}.`);
  console.log(`buy_price of 0: ${sample.filter(r => Number(r.buy_price) === 0).length}; missing: ${sample.filter(r => r.buy_price == null || r.buy_price === '').length}.`);
  const withId = sample.filter(r => r.position_id != null);
  const agree = withId.filter(r => Math.floor(Number(r.position_id) / 60000) * 60000 === buyMinuteUtc(String(r.buy_date).slice(0, 10), r.buy_time)).length;
  console.log(`BUY MINUTE: buy_date + buy_time (Pacific) equals the position_id instant to the minute on ${agree} of ${withId.length}; ${sample.length - withId.length} have no position_id to check against. Both are the add's own clock: this checks the conversion, not when the buy was decided.`);

  const out = [];
  for (const r of sample) {
    const buyMs = buyMinuteUtc(String(r.buy_date).slice(0, 10), r.buy_time);
    const ref = pickReference(await latestSipBar(headers, r.ticker, buyMs), buyMs);
    out.push({ r, buyMs, ref, gap: ref ? gapPct(r.buy_price, ref.price) : null });
    await new Promise(res => setTimeout(res, 320)); // under the free plan's 200 requests a minute
  }
  const have = out.filter(x => x.ref), missing = out.filter(x => !x.ref), gaps = have.map(x => x.gap);
  console.log(`\nREFERENCE found for ${have.length} of ${out.length}; NO REFERENCE: ${missing.length}${missing.length ? ' -- ' + missing.map(x => `${x.r.ticker} ${String(x.r.buy_date).slice(0, 10)} ${x.r.buy_time}`).join('; ') : ''}.`);
  console.log('REFERENCE AGE (buy minute minus the bar start):');
  for (const a of ageTable(have.map(x => x.ref.ageMin))) console.log(`  ${a.label.padEnd(12)} ${a.n}`);
  console.log('|GAP| (recorded buy_price against the SIP reference):');
  for (const g of gapTable(gaps)) console.log(`  ${g.label.padEnd(14)} ${g.n}`);
  const above = gaps.filter(g => g > 0).length, below = gaps.filter(g => g < 0).length;
  console.log(`median |gap| ${median(gaps.map(Math.abs))?.toFixed(3)}%; mean signed gap ${(gaps.reduce((a, g) => a + g, 0) / (gaps.length || 1)).toFixed(3)}%; recorded above the market ${above}, below ${below}, equal ${gaps.length - above - below}.`);
  const bySession = {};
  for (const x of have) { const k = x.r.buy_session || 'NULL'; (bySession[k] ||= { n: 0, off1: 0 }); bySession[k].n++; if (Math.abs(x.gap) >= MATERIAL_GAP_PCT) bySession[k].off1++; }
  console.log('by buy_session (n, |gap| >= 1%):', Object.entries(bySession).map(([k, v]) => `${k} ${v.n}/${v.off1}`).join(', '));
  const worst = [...have].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 15);
  console.log('LARGEST 15 |gap|:'); for (const x of worst) console.log(`  ${x.r.ticker.padEnd(5)} ${String(x.r.buy_date).slice(0, 10)} ${x.r.buy_time} ${x.r.buy_session}  recorded ${x.r.buy_price}  SIP ${x.ref.price} (${x.ref.ageMin} min old)  gap ${x.gap >= 0 ? '+' : ''}${x.gap.toFixed(2)}%  recorded return ${Number(x.r.pnl_pct).toFixed(2)}%`);

  const offCount = gaps.filter(g => Math.abs(g) >= MATERIAL_GAP_PCT).length, material = isMaterial(gaps);
  console.log(`\nMATERIAL (declared: at least ${MATERIAL_MIN_TRADES} of the 586 with |gap| >= ${MATERIAL_GAP_PCT}%): ${offCount} -> ${material ? 'MATERIAL' : 'NOT MATERIAL'}.`);
  const decision = rerunDecision({ material, missing: missing.length });
  if (decision === 'not-material') console.log('THE RULE DOES NOT FIRE: the re-run is not computed, and ef99790\'s verdict stands.');
  else if (decision === 'cannot-apply') console.log(`THE RULE FIRES BUT CANNOT BE APPLIED AS DECLARED ("all 586, no exclusions"): ${missing.length} trade(s) have no reference. Not run; back to the reviewer.`);
  else {
    const corrected = out.map(x => ({ ...x.r, pnl_pct: correctedReturnPct(x.r.sell_price, x.ref.price) }));
    const a = analyse(corrected);
    console.log(`\nTHE RE-RUN (corrected returns, all ${a.covered} of ${corrected.length}; ${a.excluded} excluded):`);
    for (const b of a.buckets) console.log(bucketLine(b));
    console.log(`Spearman rho ${a.rho >= 0 ? '+' : ''}${a.rho.toFixed(4)}; one-sided p ${a.p.toFixed(4)} (${PERMUTATIONS} shuffles within each buy day, seed ${SEED}).`);
    console.log(`VERDICT: ${a.relationship ? 'a RELATIONSHIP is shown (rho > 0 and p < 0.05)' : 'NO RELATIONSHIP shown (the declared bar is rho > 0 and p < 0.05)'}.`);
  }
  console.log(LAST_RERUN);
  console.log('NOT MEASURED HERE: sell_price. The gap mixes a stale bar with IEX-versus-SIP and does not separate them.');
  const file = arg('--out');
  if (file) {
    if (path.resolve(file).startsWith(path.resolve(ROOT))) throw new Error('--out must be outside the repository');
    fs.writeFileSync(file, ['ticker,buy_date,buy_time,buy_session,buy_price,sip_ref,ref_bar_start,ref_age_min,gap_pct,sell_price,pnl_pct,signal_score',
      ...out.map(x => [x.r.ticker, String(x.r.buy_date).slice(0, 10), x.r.buy_time, x.r.buy_session, x.r.buy_price, x.ref?.price ?? '', x.ref?.barStart ?? '', x.ref?.ageMin ?? '', x.gap ?? '', x.r.sell_price, x.r.pnl_pct, x.r.signal_score].join(','))].join('\n'));
    console.log(`rows: ${file}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

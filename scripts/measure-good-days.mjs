#!/usr/bin/env node
// scripts/measure-good-days.mjs -- Roman's observation, tested to FALSIFY, not to confirm. Read only. (2026-11-23.)
// Roman: "after we made changes to focus on stock entry there were 2 days (i think oct 23 and 24) where virtually every
// stock I get was the right one. I want to know how we can get there to be daily."
//
// THE FRAMING, printed with the output: the days were chosen BECAUSE they looked good. In any null run of days, some
// day is the best; finding a remembered day good establishes nothing. If a market-wide move explains the good days, the
// observation is accounted for and there is nothing to build (the most likely result). If it does not, that is an
// anomaly worth one FORWARD test declared in advance, never a conclusion from these days.
//
// FOUND BEFORE THIS WAS WRITTEN (from the data's shape, no return read): 2026-10-24 was a Saturday; NO trade bought
// 2026-10-19 to 10-26 exists anywhere (trades_v2 @ 98bcc07, all 908 rows; portfolio; the old trades table); the
// entry-gate changes landed 10-21 and 10-22 (1c39926, 38a1ceb, 87d5e26, 587fe33, 4d2043c) and the first buys after
// them are 10-27 (19) and 10-28 (53). And THE UNIVERSE IS NOT RECOVERABLE for any sample day: before 2026-11-12 the
// app saved only scan rows scoring 60 or more (rating_snapshots), and nothing from 10-13 to 10-22; the logger's ~80
// symbols a day are not what Roman scanned (72 of his 547 trades from 09-11 have a ticker it ever logged).
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   SAMPLE: the pre-registered 586 (trades_v2 @ 314f6e0, sell_price_unverified false). A day = the trade's buy_date.
//   CORRECTED RETURN per trade: 100 x (exit ref - entry ref) / entry ref, the SIP references of 84d161a / 8bc7432
//     (the latest 1-minute SIP bar at or before the minute), imported.
//   (a) RANK every buy day by the mean corrected return of its trades; print the top ten with their dates and n; a day
//     with fewer than 5 trades is marked "(too few to read)". Then say whether 10-23 and 10-24 are among them.
//   (b) THE MARKET PROXY, NAMED AS ONE: IWM (small caps; EDGE trades small caps) over each trade's OWN window, entry
//     minute to exit minute, by the same SIP reference. Per trade: differential = corrected return - IWM return. Per
//     day: the mean of each. This tests "a market-wide move explains it"; it is NOT the universe differential the
//     reviewer asked for, which cannot be computed for these days (above).
//   (d) THE DISTRIBUTION: each top-ten day's rank on the mean DIFFERENTIAL among all days. And whether the spread of
//     daily mean differentials is wider than chance: the standard deviation of the daily means, against 10,000
//     shuffles of the trades' differentials across days (day sizes kept), seed 20261123; one-sided p.
//   THE READINGS (the reviewer's, 2026-11-23, with the proxy in place of the universe):
//     the proxy explains the top days (their differentials are not high; IWM moved with them) -> CLOSED: it was the
//       market, and nobody can make the market do that daily;
//     the differential is large on the top days and unremarkable elsewhere -> an outlier in a distribution already shown
//       null: NOT EVIDENCE, at most grounds for one declared forward test;
//     the differential is large and persistent across many days -> it would contradict ef99790: to be explained in
//       detail before it is believed.
//   NOTHING HERE REOPENS THE SCORE QUESTION.
//   node scripts/measure-good-days.mjs [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc, pickReference, latestSipBar } from './measure-entry-price-gap.mjs';
import { rng } from './score-vs-return.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0', BENCH = 'IWM', MIN_DAY_N = 5, TOP = 10, SHUFFLES = 10000, SEED = 20261123;
export const REMEMBERED = ['2026-10-23', '2026-10-24'];
export const FRAMING = 'THE DAYS WERE CHOSEN BECAUSE THEY LOOKED GOOD: finding a remembered day good establishes nothing. A market-wide move explaining them closes the question; otherwise it is at most grounds for one forward test declared in advance. The universe differential cannot be computed for these days; IWM is a named proxy for the market, not the universe. Nothing here reopens the score question.';

export const ret = (from, to) => 100 * (to - from) / from;
export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
// per-day aggregates from per-trade { day, ret, diff }
export function byDay(rows) {
  const m = new Map();
  for (const r of rows) (m.get(r.day) || m.set(r.day, []).get(r.day)).push(r);
  return [...m].map(([day, rs]) => ({ day, n: rs.length, ret: mean(rs.map(r => r.ret)), bench: mean(rs.map(r => r.bench)), diff: mean(rs.map(r => r.diff)) }));
}
// rank (1 = highest) of each day on a key
export const rankOn = (days, key) => new Map([...days].sort((a, b) => b[key] - a[key]).map((d, i) => [d.day, i + 1]));
// is the spread of daily mean differentials wider than shuffling the trades across days (sizes kept) gives?
export function spreadTest(rows, { shuffles = SHUFFLES, seed = SEED } = {}) {
  const sizes = byDay(rows).map(d => d.n), diffs = rows.map(r => r.diff);
  const daySd = arr => { let i = 0; return sd(sizes.map(n => mean(arr.slice(i, (i += n))))); };
  const ordered = byDay(rows).flatMap(d => rows.filter(r => r.day === d.day).map(r => r.diff));
  const observed = daySd(ordered), rand = rng(seed), s = diffs.slice();
  let atLeast = 1;
  for (let k = 0; k < shuffles; k++) {
    for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
    if (daySd(s) >= observed) atLeast++;
  }
  return { observed, p: atLeast / (shuffles + 1) };
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const sample = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString())).filter(r => r.sell_price_unverified === false);
  console.log(FRAMING + '\n');
  const rows = [], missing = [];
  // A dropped connection (fetch failed: ECONNRESET, which ended the first run after ~1 minute with no number printed)
  // is retried, up to 5 times with backoff: transport only, the same request and the same method (2026-11-23).
  const fetchBar = async (sym, ms) => {
    for (let i = 0; ; i++) {
      try { return await latestSipBar(headers, sym, ms); }
      catch (e) { if (!(e instanceof TypeError) || i >= 5) throw e; await new Promise(res => setTimeout(res, 2000 * (i + 1))); }
    }
  };
  const ref = async (sym, ms) => { const r = pickReference(await fetchBar(sym, ms), ms); await new Promise(res => setTimeout(res, 320)); return r; };
  for (const t of sample) {
    const b = pacificMinuteUtc(String(t.buy_date).slice(0, 10), t.buy_time), s = pacificMinuteUtc(String(t.sell_date).slice(0, 10), t.sell_time);
    const [eb, es, ib, is] = [await ref(t.ticker, b), await ref(t.ticker, s), await ref(BENCH, b), await ref(BENCH, s)];
    if (!eb || !es || !ib || !is) { missing.push(`${t.ticker} ${String(t.buy_date).slice(0, 10)}`); continue; }
    const r = ret(eb.price, es.price), bench = ret(ib.price, is.price);
    rows.push({ day: String(t.buy_date).slice(0, 10), ret: r, bench, diff: r - bench });
  }
  console.log(`SOURCE: trades_v2 @ ${REV}, ${sample.length} trades; with all four SIP references: ${rows.length}${missing.length ? `; WITHOUT: ${missing.length} (${missing.join(', ')})` : ''}.`);
  const days = byDay(rows), rRet = rankOn(days, 'ret'), rDiff = rankOn(days, 'diff');
  console.log(`DAYS: ${days.length}.`);
  const fmt = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  console.log(`\n(a) TOP ${TOP} DAYS BY MEAN CORRECTED RETURN (and each one's IWM over the same windows, the differential, and its rank on the differential of ${days.length}):`);
  for (const d of [...days].sort((a, b) => b.ret - a.ret).slice(0, TOP)) console.log(`  ${d.day}  n ${String(d.n).padStart(3)}  picks ${fmt(d.ret).padStart(8)}  IWM ${fmt(d.bench).padStart(7)}  differential ${fmt(d.diff).padStart(8)}  rank on differential ${rDiff.get(d.day)}${d.n < MIN_DAY_N ? '  (too few to read)' : ''}`);
  for (const r of REMEMBERED) console.log(`  ${r}: ${rRet.has(r) ? `rank ${rRet.get(r)} on return, ${rDiff.get(r)} on the differential` : 'NO TRADES that day in the sample (and none anywhere in the record)'}.`);
  const all = rows.map(r => r.diff);
  console.log(`\nALL TRADES: mean corrected return ${fmt(mean(rows.map(r => r.ret)))}, IWM over the same windows ${fmt(mean(rows.map(r => r.bench)))}, mean differential ${fmt(mean(all))}.`);
  const st = spreadTest(rows);
  console.log(`(d) SPREAD of daily mean differentials: SD ${st.observed.toFixed(3)} points; one-sided p ${st.p.toFixed(4)} against ${SHUFFLES} shuffles of trades across days (sizes kept, seed ${SEED}) -- ${st.p < 0.05 ? 'WIDER than chance' : 'not wider than chance'}.`);
  console.log(`\n${FRAMING}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

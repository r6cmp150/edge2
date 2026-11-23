#!/usr/bin/env node
// scripts/measure-change-split.mjs -- Roman's hypothesis at its own boundary: did picking work AFTER the entry changes?
// Read only. (2026-11-23, the reviewer: "testing a dated claim at its date is the test, not a search".)
// Roman: "after we made changes to focus on stock entry ... virtually every stock I get was the right one". The changes
// landed 2026-10-21 and 10-22 (git: 1c39926, 38a1ceb, 87d5e26, 587fe33, 4d2043c) and stayed in place.
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   SAMPLE: the pre-registered 586 (trades_v2 @ 314f6e0, sell_price_unverified false). BEFORE: buy_date up to
//     2026-10-22; AFTER: from 2026-10-23 (no trade was bought 10-19 to 10-26, so no trade sits on the boundary).
//   PER TRADE: corrected return (the SIP references of 84d161a, scripts/lib/sip-ref.mjs) minus IWM over the trade's own
//     window, entry minute to exit minute -- the measurement of b81cd85. IWM IS A PROXY FOR THE SMALL-CAP MARKET, NOT THE
//     UNIVERSE: it answers "did small caps go up", never "did the chosen beat the unchosen", and every figure here
//     carries that limit.
//   REPORTED, each side: trades, days, mean picks, mean IWM, mean difference; its 95% interval by resampling DAYS (trades
//     on one day move together, b81cd85), 10,000, seed 20261123; and on the AFTER side, how many days had a positive mean
//     difference.
//   THE READING, fixed now: the hypothesis is ALIVE only if the AFTER difference's interval lies above zero AND more
//     than half the after-days are positive (clearly positive, sustained); that would contradict ef99790 and is to be
//     explained in detail before it is believed. Otherwise it is DEAD NOW: 10-27 was one good day among 35, and the
//     changes did not make picking work.
//   NOTHING HERE REOPENS THE SCORE QUESTION.
//   node scripts/measure-change-split.mjs [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc } from './measure-entry-price-gap.mjs';
import { sipRef } from './lib/sip-ref.mjs';
import { rng } from './score-vs-return.mjs';
import { mean, ret } from './measure-good-days.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0', BENCH = 'IWM', LAST_BEFORE = '2026-10-22', RESAMPLES = 10000, SEED = 20261123;
export const LIMIT = 'IWM IS A PROXY FOR THE SMALL-CAP MARKET, NOT THE UNIVERSE: it answers "did small caps go up", never "did the chosen beat the unchosen". Nothing here reopens the score question.';

export const side = day => (day <= LAST_BEFORE ? 'before' : 'after');
// 95% interval of the trade-weighted mean difference, resampling whole days
export function dayInterval(rows, { resamples = RESAMPLES, seed = SEED } = {}) {
  const days = [...new Set(rows.map(r => r.day))], byDay = new Map(days.map(d => [d, rows.filter(r => r.day === d).map(r => r.diff)]));
  const rand = rng(seed), means = [];
  for (let k = 0; k < resamples; k++) {
    const pick = Array.from({ length: days.length }, () => byDay.get(days[Math.floor(rand() * days.length)])).flat();
    means.push(mean(pick));
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * resamples)], hi: means[Math.ceil(0.975 * resamples) - 1] };
}
export function reading(afterRows) {
  const ci = dayInterval(afterRows);
  const days = [...new Set(afterRows.map(r => r.day))];
  const positive = days.filter(d => mean(afterRows.filter(r => r.day === d).map(r => r.diff)) > 0).length;
  const alive = ci.lo > 0 && positive > days.length / 2;
  return { ci, days: days.length, positive, verdict: alive ? 'ALIVE' : 'DEAD' };
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const sample = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString())).filter(r => r.sell_price_unverified === false);
  console.log(LIMIT + '\n');
  const rows = [], missing = [];
  for (const t of sample) {
    const b = pacificMinuteUtc(String(t.buy_date).slice(0, 10), t.buy_time), s = pacificMinuteUtc(String(t.sell_date).slice(0, 10), t.sell_time);
    const [eb, es, ib, is] = [await sipRef(headers, t.ticker, b), await sipRef(headers, t.ticker, s), await sipRef(headers, BENCH, b), await sipRef(headers, BENCH, s)];
    if (!eb || !es || !ib || !is) { missing.push(t.ticker); continue; }
    const r = ret(eb.price, es.price), bench = ret(ib.price, is.price);
    rows.push({ day: String(t.buy_date).slice(0, 10), ret: r, bench, diff: r - bench });
  }
  console.log(`SOURCE: trades_v2 @ ${REV}: ${sample.length} trades, ${rows.length} with all four references${missing.length ? `, ${missing.length} without` : ''}.`);
  const fmt = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  for (const s of ['before', 'after']) {
    const rs = rows.filter(r => side(r.day) === s), ci = dayInterval(rs);
    console.log(`${s.toUpperCase().padEnd(6)} ${s === 'before' ? `(to ${LAST_BEFORE})` : `(from 2026-10-23)`}: ${rs.length} trades on ${new Set(rs.map(r => r.day)).size} days; picks ${fmt(mean(rs.map(r => r.ret)))}, IWM ${fmt(mean(rs.map(r => r.bench)))}, difference ${fmt(mean(rs.map(r => r.diff)))} (95% by days ${fmt(ci.lo)} to ${fmt(ci.hi)})`);
  }
  const r = reading(rows.filter(x => side(x.day) === 'after'));
  console.log(`AFTER-days with a positive mean difference: ${r.positive} of ${r.days}.`);
  console.log(`\nTHE READING (declared: ALIVE only if the after interval is above zero AND more than half the after-days are positive): ${r.verdict}.`);
  console.log(r.verdict === 'DEAD' ? 'DEAD NOW: 10-27 was one good day among 35, and the entry changes did not make picking work.' : 'ALIVE: this contradicts ef99790 and is to be explained in detail before it is believed.');
  console.log(`\n${LIMIT}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

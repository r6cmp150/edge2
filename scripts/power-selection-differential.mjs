#!/usr/bin/env node
// scripts/power-selection-differential.mjs -- can a forward test tell the effect seen so far from zero, on Roman's
// timescale? Read only; no new market data (the SIP references come from scripts/lib/sip-ref.mjs's cache). (2026-11-23,
// the reviewer: "if the answer is about a year, that is the finding".)
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   MODEL: trades on one day move together (b81cd85: daily spread wider than chance, p 0.007), so a trade's difference is
//     a day effect plus its own noise. The mean over D days of m trades each has variance (s2_day + s2_trade / m) / D.
//   PRIMARY ESTIMATE of s2_day and s2_trade: one-way method of moments over the 586 trades' picks-minus-IWM differences
//     (7e15b5b's per-trade figures, re-read from the SIP cache), days as groups; s2_day floored at 0. The only estimate
//     built on more than a handful of days. It is CONSERVATIVE for the forward test, which compares with the scanned
//     universe: IWM absorbs less of a day's move than the universe does.
//   SENSITIVITY: the four history days of the universe difference (STATUS, 0e27942's first reading @ 98bcc07: +0.26,
//     +0.69, +0.30, +0.07 on 32, 34, 47, 42 trades): the observed spread of their day means, used as the day-mean
//     variance at about 39 trades a day. OPTIMISTIC, and four days is too few to rely on.
//   THE BAR: one-sided alpha 0.05 (z 1.645), power 0.80 (z 0.842), the project's one-sided bar.
//   REPORTED: the trading days needed to tell +0.52% from zero (7e15b5b's after-change figure), and the smallest effect
//     60 trading days could detect, each at 10, 20 and 40 trades a day; and the same under the sensitivity estimate.
//   A CALCULATION, not a test: nothing here is a result about picking.
//   node scripts/power-selection-differential.mjs [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc } from './measure-entry-price-gap.mjs';
import { sipRef } from './lib/sip-ref.mjs';
import { ret } from './measure-good-days.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const EFFECT = 0.52, Z_ALPHA = 1.645, Z_POWER = 0.842, HORIZON = 60, PACES = [10, 20, 40];
export const HISTORY_DAYS = [{ mean: 0.26, n: 32 }, { mean: 0.69, n: 34 }, { mean: 0.30, n: 47 }, { mean: 0.07, n: 42 }];

// one-way method of moments: groups = arrays of values. -> { s2Day, s2Trade }
export function varianceComponents(groups) {
  const k = groups.length, N = groups.reduce((a, g) => a + g.length, 0);
  const grand = groups.flat().reduce((a, b) => a + b, 0) / N;
  const means = groups.map(g => g.reduce((a, b) => a + b, 0) / g.length);
  const ssw = groups.reduce((a, g, i) => a + g.reduce((s, x) => s + (x - means[i]) ** 2, 0), 0);
  const ssb = groups.reduce((a, g, i) => a + g.length * (means[i] - grand) ** 2, 0);
  const msw = ssw / (N - k), msb = ssb / (k - 1);
  const n0 = (N - groups.reduce((a, g) => a + g.length ** 2, 0) / N) / (k - 1);
  return { s2Day: Math.max(0, (msb - msw) / n0), s2Trade: msw };
}
export const dayMeanVariance = (c, m) => c.s2Day + c.s2Trade / m;
export const daysNeeded = (effect, v) => Math.ceil(((Z_ALPHA + Z_POWER) ** 2 * v) / effect ** 2);
export const smallestDetectable = (days, v) => (Z_ALPHA + Z_POWER) * Math.sqrt(v / days);
export function sampleVariance(xs) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1); }

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const sample = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync('git show 314f6e0:data/backups/trades_v2.json', { cwd: ROOT, maxBuffer: 1e9 }).toString())).filter(r => r.sell_price_unverified === false);
  const byDay = new Map();
  for (const t of sample) {
    const b = pacificMinuteUtc(String(t.buy_date).slice(0, 10), t.buy_time), s = pacificMinuteUtc(String(t.sell_date).slice(0, 10), t.sell_time);
    const [eb, es, ib, is] = [await sipRef(headers, t.ticker, b), await sipRef(headers, t.ticker, s), await sipRef(headers, 'IWM', b), await sipRef(headers, 'IWM', s)];
    if (!eb || !es || !ib || !is) continue;
    const d = String(t.buy_date).slice(0, 10); (byDay.get(d) || byDay.set(d, []).get(d)).push(ret(eb.price, es.price) - ret(ib.price, is.price));
  }
  const c = varianceComponents([...byDay.values()]);
  console.log(`A CALCULATION, not a test. Bar: one-sided 0.05, power 0.80. Effect to detect: +${EFFECT.toFixed(2)}% a trade.`);
  console.log(`\nPRIMARY (586 trades on ${byDay.size} days, picks minus IWM): day SD ${Math.sqrt(c.s2Day).toFixed(3)} points, trade SD ${Math.sqrt(c.s2Trade).toFixed(3)} points.`);
  for (const m of PACES) { const v = dayMeanVariance(c, m); console.log(`  at ${String(m).padStart(2)} trades a day: ${daysNeeded(EFFECT, v)} trading days to detect +${EFFECT}%; the smallest effect ${HORIZON} days can detect is ${smallestDetectable(HORIZON, v).toFixed(2)}%`); }
  const v4 = sampleVariance(HISTORY_DAYS.map(d => d.mean));
  console.log(`\nSENSITIVITY (the 4 history days of the universe difference, ~39 trades a day; OPTIMISTIC, too few days): day-mean SD ${Math.sqrt(v4).toFixed(3)} points: ${daysNeeded(EFFECT, v4)} trading days to detect +${EFFECT}%; the smallest effect ${HORIZON} days can detect is ${smallestDetectable(HORIZON, v4).toFixed(2)}%.`);
  console.log('\nA CALCULATION, not a test: nothing here is a result about picking.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

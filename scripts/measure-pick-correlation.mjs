#!/usr/bin/env node
// scripts/measure-pick-correlation.mjs -- are Roman's same-day picks more correlated with each other than stocks drawn
// at random from what EDGE scanned that day? A RISK measurement, not a strategy one. Read only. (2026-11-23, the
// reviewer: "forty-eight open positions are not forty-eight bets ... quantify it, once, bounded".)
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   DAYS: those with a FULL scan saved (rating_snapshots @ 2c78d11 with a minimum score of 0: the app saves every scored
//     row from 2026-11-12) and at least 5 distinct tickers bought (trades_v2 and portfolio @ 98bcc07, by buy_date).
//     Expected: 11-12, 11-13, 11-16, 11-17. Before 11-12 the universe is not recoverable (field list).
//   UNIVERSE of a day: the distinct tickers its scans saved (Pacific date of captured_at).
//   SERIES: SIP 5-minute bars, raw, over that day's regular session (06:30 to 13:00 Pacific); returns between
//     consecutive bars. A pair's correlation is Pearson over the intervals both have; a pair with fewer than 30 common
//     intervals is skipped and counted.
//   PER DAY: the picks' mean pairwise correlation; the same for 1,000 random draws of as many stocks from the day's
//     universe excluding the picks (seed 20261123); the picks' percentile among the draws; and, as a risk translation,
//     the effective number of independent positions n / (1 + (n - 1) x mean r), for the picks and for a random draw.
//   THE READING, fixed now: MUCH MORE CORRELATED if on every measured day the picks' mean correlation is above the 95th
//     percentile of the random draws (it goes in front of Roman and on the field list); NO MORE THAN RANDOM if on no day
//     it is (nothing to report); otherwise MIXED, stated day by day.
//   NOTHING HERE TOUCHES THE SCORE QUESTION.
//   node scripts/measure-pick-correlation.mjs [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import { rng } from './score-vs-return.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SCAN_REV = '2c78d11', TRADE_REV = '98bcc07', MIN_PICKS = 5, MIN_COMMON = 30, DRAWS = 1000, SEED = 20261123;

export function pearson(a, b) {
  const n = a.length; if (n < 2) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}
// returns keyed by the later bar's time: { t: return }
export function barReturns(bars) {
  const s = [...bars].sort((x, y) => Date.parse(x.t) - Date.parse(y.t)), out = new Map();
  for (let i = 1; i < s.length; i++) out.set(s[i].t, s[i].c / s[i - 1].c - 1);
  return out;
}
export function pairCorr(ra, rb, minCommon = MIN_COMMON) {
  const a = [], b = [];
  for (const [t, x] of ra) if (rb.has(t)) { a.push(x); b.push(rb.get(t)); }
  return a.length < minCommon ? null : pearson(a, b);
}
// mean pairwise correlation of a set of return series; skipped pairs counted
export function meanPairwise(series, minCommon = MIN_COMMON) {
  let sum = 0, n = 0, skipped = 0;
  for (let i = 0; i < series.length; i++) for (let j = i + 1; j < series.length; j++) {
    const r = pairCorr(series[i], series[j], minCommon);
    if (r == null) skipped++; else { sum += r; n++; }
  }
  return { r: n ? sum / n : null, pairs: n, skipped };
}
export const effectiveN = (n, r) => (r == null ? null : n / (1 + (n - 1) * r));
export function reading(days) {
  const above = days.filter(d => d.percentile > 95).length;
  return above === days.length && days.length ? 'MUCH MORE CORRELATED' : above === 0 ? 'NO MORE THAN RANDOM' : 'MIXED';
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const show = (rev, f) => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const files = execSync(`git ls-tree --name-only ${SCAN_REV} data/backups/rating_snapshots/`, { cwd: ROOT }).toString().trim().split('\n');
  const scans = files.flatMap(f => show(SCAN_REV, f.replace('data/backups/', '')));
  const ptDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const uni = new Map();
  for (const r of scans) { const d = ptDate(r.captured_at); (uni.get(d) || uni.set(d, { t: new Set(), min: Infinity }).get(d)).t.add(r.ticker); uni.get(d).min = Math.min(uni.get(d).min, r.score); }
  const buys = [...show(TRADE_REV, 'trades_v2.json'), ...show(TRADE_REV, 'portfolio.json')];
  const picksBy = new Map();
  for (const r of buys) { const d = String(r.buy_date).slice(0, 10); (picksBy.get(d) || picksBy.set(d, new Set()).get(d)).add(r.ticker); }
  const days = [...uni].filter(([d, u]) => u.min === 0 && (picksBy.get(d)?.size || 0) >= MIN_PICKS).map(([d]) => d).sort();
  console.log(`SOURCE: rating_snapshots @ ${SCAN_REV} (full scans from 11-12), buys from trades_v2 and portfolio @ ${TRADE_REV}. Days with a full scan and at least ${MIN_PICKS} picks: ${days.join(', ')}.`);
  const out = [];
  for (const d of days) {
    const universe = [...uni.get(d).t], picks = [...picksBy.get(d)].filter(t => uni.get(d).t.has(t));
    const start = new Date(Date.parse(`${d}T06:30:00-08:00`)).toISOString(), end = new Date(Date.parse(`${d}T13:00:00-08:00`)).toISOString();
    const bars = await fetchBars(headers, universe, { timeframe: '5Min', start, end, feed: 'sip' });
    const ret = Object.fromEntries(universe.map(s => [s, barReturns(bars[s] || [])]));
    const pk = meanPairwise(picks.map(s => ret[s]));
    const pool = universe.filter(s => !picks.includes(s)), rand = rng(SEED), draws = [];
    for (let k = 0; k < DRAWS; k++) {
      const p = pool.slice(); for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
      const m = meanPairwise(p.slice(0, picks.length).map(s => ret[s])).r; if (m != null) draws.push(m);
    }
    draws.sort((a, b) => a - b);
    const percentile = pk.r == null ? null : 100 * draws.filter(x => x < pk.r).length / draws.length;
    const med = draws[Math.floor(draws.length / 2)];
    out.push({ d, n: picks.length, universe: universe.length, r: pk.r, skipped: pk.skipped, med, percentile, effPicks: effectiveN(picks.length, pk.r), effRandom: effectiveN(picks.length, med) });
  }
  for (const o of out) console.log(`  ${o.d}: ${o.n} picks of a ${o.universe}-stock scan; picks' mean pairwise r ${o.r?.toFixed(3)} (pairs skipped ${o.skipped}); random draws' median ${o.med?.toFixed(3)}; picks at the ${o.percentile?.toFixed(1)}th percentile; effective independent positions ${o.effPicks?.toFixed(1)} (a random draw of ${o.n}: ${o.effRandom?.toFixed(1)})`);
  console.log(`\nTHE READING (declared: above the 95th percentile on every day = MUCH MORE CORRELATED; on none = NO MORE THAN RANDOM): ${reading(out)}.`);
  console.log('A risk measurement, not a strategy one: it does not touch the score question.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

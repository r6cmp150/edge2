#!/usr/bin/env node
// scripts/score-vs-return.mjs -- does signal_score predict realised return at all? Read only. (2026-11-20, the reviewer.)
// Not a portfolio rule and not a cut of P&L: a property of the scorer, which either ranks trades or does not, and which
// nothing in this project had tested directly. If it does not, it explains the full and the budget-constrained sets
// coming out flat together (scripts/replay-budget-constrained.mjs, 478e142).
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT. Before writing this, only the score's range (30 to 115,
// integers), its coverage (586 of 586) and the return field's definition were read; never score against return.
//   SAMPLE: prereg-pnl.mjs's, all of it: trades_v2 @ 314f6e0, sell_price_unverified false, 586 trades. Coverage is
//     printed; a trade without a score or a return would be excluded and named (none is expected).
//   RETURN: pnl_pct, realised, before costs (equal to 100 x pnl_dollars / (shares x buy_price) on all 586).
//   NO exclusions, no trimming, no winsorizing, no second metric chosen after seeing the first.
//   DESCRIPTIVE: mean return by score bucket, with the count in each, buckets fixed by the score's scale, 10 points
//     wide: below 50, 50-59, 60-69, 70-79, 80-89, 90-99, 100 and up. A bucket under 20 trades is printed with
//     "(too few to read)" beside it, so it cannot tell a story.
//   THE TEST, and the only one: Spearman's rank correlation between signal_score and return over all covered trades
//     (average ranks for ties). Its p-value by permutation, shuffling scores WITHIN EACH BUY DAY ONLY: returns on one
//     day share that day's market, and the scoring formula changed mid-sample (v1 to v2), so a shuffle across days
//     would let a market day or a formula change pose as skill; within a day, a score has to rank trades made under the
//     same conditions. 10,000 permutations, seed 20261120, one-sided (the claim is that a higher score means a higher
//     return). A RELATIONSHIP is shown only if rho > 0 AND p < 0.05.
//   READING, printed with the numbers (the reviewer's sentence, written before they exist): if signal_score shows no
//     relationship to realised return, EDGE as built has no demonstrated edge, and the response is a different
//     foundation, not more instrumentation, and not another cut of this data. A relationship shown here would be one
//     test on one historical sample, frictionless: it would justify a forward test declared in advance, nothing more.
//   node scripts/score-vs-return.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0';
export const BUCKETS = [['below 50', -Infinity, 50], ['50-59', 50, 60], ['60-69', 60, 70], ['70-79', 70, 80], ['80-89', 80, 90], ['90-99', 90, 100], ['100 and up', 100, Infinity]];
export const MIN_BUCKET = 20;
export const PERMUTATIONS = 10000, SEED = 20261120, ALPHA = 0.05;

export function ranks(xs) { // average ranks for ties, 1-based
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
  return r;
}
export function spearman(xs, ys) {
  const rx = ranks(xs), ry = ranks(ys), n = xs.length, mx = (n + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - mx); dx += (rx[i] - mx) ** 2; dy += (ry[i] - mx) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// one-sided p: the share of within-day shuffles whose rho is at least the observed one (the observed counted once)
export function withinDayPermutationP(rows, { permutations = PERMUTATIONS, seed = SEED } = {}) {
  const scores = rows.map(r => r.score), rets = rows.map(r => r.ret), observed = spearman(scores, rets);
  const byDay = new Map(); rows.forEach((r, i) => { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(i); });
  const rand = rng(seed), s = scores.slice();
  let atLeast = 1;
  for (let p = 0; p < permutations; p++) {
    for (const idxs of byDay.values()) for (let k = idxs.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); const a = idxs[k], b = idxs[j]; [s[a], s[b]] = [s[b], s[a]]; }
    if (spearman(s, rets) >= observed) atLeast++;
  }
  return { rho: observed, p: atLeast / (permutations + 1) };
}

// the declared bar, on its own: a relationship needs BOTH a positive rho and p below 0.05
export const decide = (rho, p) => rho > 0 && p < ALPHA;
// one bucket's line; a bucket under MIN_BUCKET trades says so, so it cannot tell a story
export const bucketLine = b => `  ${b.label.padEnd(11)} n ${String(b.n).padStart(3)}  mean ${b.mean == null ? '   -   ' : `${b.mean >= 0 ? '+' : ''}${b.mean.toFixed(2)}%`}${b.n && b.n < MIN_BUCKET ? '  (too few to read)' : ''}`;

export function analyse(sample) {
  // a missing value is MISSING: Number(null) is 0, which would count an unscored trade as scored 0 (caught by the test)
  const present = v => v != null && v !== '' && Number.isFinite(Number(v));
  const covered = sample.filter(r => present(r.signal_score) && present(r.pnl_pct));
  const rows = covered.map(r => ({ score: Number(r.signal_score), ret: Number(r.pnl_pct), day: String(r.buy_date).slice(0, 10) }));
  const buckets = BUCKETS.map(([label, lo, hi]) => { const b = rows.filter(r => r.score >= lo && r.score < hi); return { label, n: b.length, mean: b.length ? b.reduce((a, r) => a + r.ret, 0) / b.length : null }; });
  const test = withinDayPermutationP(rows);
  return { covered: rows.length, excluded: sample.length - covered.length, buckets, ...test, relationship: decide(test.rho, test.p) };
}

async function main() {
  const rev = (i => (i < 0 ? REV : process.argv[i + 1]))(process.argv.indexOf('--rev'));
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const sample = all.filter(r => r.sell_price_unverified === false);
  console.log('A FRICTIONLESS PAPER SIMULATION, not P&L (STATUS): returns before costs, at the displayed price.');
  console.log(`SOURCE: data/backups/trades_v2.json @ ${rev}: ${all.length} rows; the sample (sell_price_unverified false): ${sample.length}.`);
  const a = analyse(sample);
  console.log(`COVERAGE: ${a.covered} of ${sample.length} carry a score and a return${a.excluded ? `; ${a.excluded} excluded for lacking one` : '; none excluded'}.`);
  console.log('\nMEAN REALISED RETURN BY signal_score (before costs):');
  for (const b of a.buckets) console.log(bucketLine(b));
  console.log(`\nTHE TEST: Spearman rho ${a.rho >= 0 ? '+' : ''}${a.rho.toFixed(4)}; one-sided p ${a.p.toFixed(4)} (${PERMUTATIONS} shuffles of scores within each buy day, seed ${SEED}).`);
  console.log(`VERDICT: ${a.relationship ? 'a RELATIONSHIP is shown (rho > 0 and p < 0.05)' : 'NO RELATIONSHIP shown (the declared bar is rho > 0 and p < 0.05)'}.`);
  console.log('\nREADING (declared before the first run): if signal_score shows no relationship to realised return, EDGE as built has');
  console.log('no demonstrated edge, and the response is a different foundation, not more instrumentation, and not another cut of');
  console.log('this data. A relationship shown here is one test on one historical sample, frictionless: it would justify a forward');
  console.log('test declared in advance, nothing more.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

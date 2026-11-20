// tests/score-vs-return.test.js -- 2026-11-20 (the reviewer). The score-vs-return test's machinery on fixtures, written
// and committed with the script BEFORE its first run on the data: Spearman with ties, the within-day permutation (both
// directions: a real within-day ranking passes; a "relationship" carried only by which DAY a score fell on does not),
// the fixed buckets and the too-few flag, coverage, and the declared reading. No data is read here.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/score-vs-return.mjs')).href);

await run('Spearman: +1 for a perfect ranking, -1 for the reverse, average ranks for ties', () => {
  assert.strictEqual(M.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.strictEqual(M.spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.deepStrictEqual(M.ranks([5, 1, 5, 3]), [3.5, 1, 3.5, 2]);
});

await run('a score that ranks trades WITHIN each day passes the declared bar', () => {
  const rows = [];
  for (let d = 0; d < 12; d++) for (let k = 0; k < 6; k++) rows.push({ score: 60 + k * 5, ret: k - 2.5 + (d % 3) * 0.1, day: `D${d}` });
  const r = M.withinDayPermutationP(rows, { permutations: 2000 });
  assert.ok(r.rho > 0.9 && r.p < 0.05, JSON.stringify(r));
});

await run('a "relationship" carried only by WHICH DAY a score fell on is not shown (the market day cannot pose as skill)', () => {
  // high-score days happen to be up days; within each day the score says nothing
  const rows = [];
  for (let d = 0; d < 12; d++) { const dayScore = 50 + d * 4, dayRet = d - 6; for (let k = 0; k < 6; k++) rows.push({ score: dayScore + (k % 2), ret: dayRet + [0.3, -0.2, 0.1, -0.4, 0.2, 0][k], day: `D${d}` }); }
  const r = M.withinDayPermutationP(rows, { permutations: 2000 });
  assert.ok(r.rho > 0.8, 'the pooled correlation is strong: ' + r.rho);
  assert.ok(r.p >= 0.05, 'and the within-day test does not credit it: ' + r.p);
});

await run('analyse: fixed buckets with counts, coverage and exclusions counted, the bar is rho > 0 AND p < 0.05', () => {
  const sample = [{ signal_score: 45, pnl_pct: 1, buy_date: '2026-10-01' }, { signal_score: 72, pnl_pct: -2, buy_date: '2026-10-01' }, { signal_score: 105, pnl_pct: 3, buy_date: '2026-10-01' }, { signal_score: null, pnl_pct: 1, buy_date: '2026-10-02' }];
  const a = M.analyse(sample);
  assert.strictEqual(a.covered, 3); assert.strictEqual(a.excluded, 1);
  assert.deepStrictEqual(a.buckets.map(b => [b.label, b.n]), [['below 50', 1], ['50-59', 0], ['60-69', 0], ['70-79', 1], ['80-89', 0], ['90-99', 0], ['100 and up', 1]]);
  assert.strictEqual(M.MIN_BUCKET, 20); assert.strictEqual(M.ALPHA, 0.05); assert.strictEqual(M.PERMUTATIONS, 10000); assert.strictEqual(M.SEED, 20261120);
  assert.strictEqual(M.REV, '314f6e0');
});

await run('the bar is rho > 0 AND p < 0.05, each half required; a bucket under 20 is flagged, one of 20 is not', () => {
  assert.strictEqual(M.decide(0.2, 0.01), true);
  assert.strictEqual(M.decide(-0.01, 0.01), false, 'a significant NEGATIVE rho is not a relationship');
  assert.strictEqual(M.decide(0.2, 0.05), false, 'p must be below 0.05');
  assert.ok(M.bucketLine({ label: '90-99', n: 19, mean: 1 }).endsWith('(too few to read)'));
  assert.ok(!M.bucketLine({ label: '90-99', n: 20, mean: 1 }).includes('too few'));
  assert.ok(!M.bucketLine({ label: '90-99', n: 0, mean: null }).includes('too few'), 'an empty bucket shows a dash, not a flag');
});

await run('the declared reading and the too-few flag are in the output, and nothing trims or winsorizes', () => {
  const src = readSource('scripts/score-vs-return.mjs');
  assert.ok(/EDGE as built has'\);\n\s*console\.log\('no demonstrated edge, and the response is a different foundation/.test(src));
  assert.ok(src.includes("(too few to read)"));
  assert.ok(!/winsor|trim\(|percentile|quantile|outlier/i.test(src.replace(/^\/\/.*$/gm, '')), 'no trimming in the code');
});
})();

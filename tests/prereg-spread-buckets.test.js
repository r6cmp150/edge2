// tests/prereg-spread-buckets.test.js -- 2026-11-11. The pure parts of scripts/prereg-spread-buckets.mjs, on
// synthetic data only: it never reads the book or calls Alpaca. It pins the fixed spread cuts, the bucketing and
// the per-bucket arithmetic, which were fixed before the first run.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');
const load = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts/prereg-spread-buckets.mjs')).href);

run('the spread cuts are the published quartiles, fixed: 0.11% / 0.20% / 0.36%', async () => {
  const { SPREAD_CUTS } = await load();
  assert.deepStrictEqual(SPREAD_CUTS, [0.0011, 0.0020, 0.0036]);
});

run('buckets: at or below a cut is the lower bucket; above the last cut is the fourth', async () => {
  const { bucketOf, SPREAD_CUTS } = await load();
  assert.deepStrictEqual([0.0005, 0.0011, 0.00111, 0.0020, 0.0030, 0.0036, 0.01].map(x => bucketOf(x, SPREAD_CUTS)), [0, 0, 1, 1, 2, 2, 3]);
});

run('quartile cuts are taken from the values alone (outcome-blind)', async () => {
  const { quartileCuts } = await load();
  assert.deepStrictEqual(quartileCuts([5, 1, 3, 2, 4, 6, 7, 8, 9]), [3, 5, 7]);
});

run('per bucket: frictionless, drag, after, per buy day, win rate, ratio and break-even', async () => {
  const { summarize } = await load();
  const it = (d, pnl, cost) => ({ t: { buy_date: d, pnl_dollars: pnl }, c: { base: cost } });
  const s = summarize([it('2026-11-02', 10, 1), it('2026-11-02', -4, 1), it('2026-11-03', 2, 3)]);
  assert.strictEqual(s.n, 3); assert.strictEqual(s.days, 2);
  assert.strictEqual(s.frictionless, 8); assert.strictEqual(s.drag, 5); assert.strictEqual(s.after, 3);
  assert.strictEqual(s.perDay, 1.5);
  assert.strictEqual(s.winRate, 1 / 3, 'after costs: 9 wins, -5 and -1 lose');
  assert.strictEqual(s.ratio, 9 / 3); assert.strictEqual(s.breakEven, 2);
  assert.deepStrictEqual(s.series, [4, -1]);
});

run('the output says first what the book is and that no verdict is expected', () => {
  const src = require('fs').readFileSync(path.join(REPO_ROOT, 'scripts/prereg-spread-buckets.mjs'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const first = main.indexOf("console.log('WHAT THE BOOK IS:");
  assert.ok(first > 0 && first < main.indexOf('console.log(`SOURCE:'));
  assert.ok(/NOT_KNOWN/.test(main.slice(first, first + 300)) && /no verdict is expected/.test(main.slice(first, first + 300)));
});

// tests/measure-exit-price-gap.test.js -- 2026-11-20 (the reviewer). The exit-price gap and the recomputed P&L, on
// fixtures, written and committed with the script BEFORE its first run on the data: the declared bias bar on both
// sides, the P&L arithmetic on recorded shares, a repriced trade changing cost and P&L and nothing else (so the
// constrained replay sees the corrected cost), the reuse of the entry measurement's reference, and the sentences the
// output must carry. No data is read here.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-exit-price-gap.mjs')).href);
const { replay } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/replay-budget-constrained.mjs')).href);

await run('the declared constants', () => {
  assert.strictEqual(M.REV, '314f6e0'); assert.strictEqual(M.BIAS_PCT, 0.25);
});

await run('BIASED is a mean signed gap of at least 0.25% either way; 0.24 is not; opposite gaps cancel', () => {
  assert.strictEqual(M.isBiased([0.25, 0.25]), true);
  assert.strictEqual(M.isBiased([-0.3, -0.2]), true, 'a negative bias counts');
  assert.strictEqual(M.isBiased([0.24, 0.24]), false);
  assert.strictEqual(M.isBiased([5, -5, 0.1]), false, 'noise around zero is not bias');
  assert.strictEqual(M.isBiased([0.069]), false, "the entry end's measured mean (84d161a) is below the bar");
});

await run('the P&L is recorded shares x (exit - entry); a repriced trade changes cost and P&L and nothing else', () => {
  assert.ok(Math.abs(M.pnlDollars(100, 2.67, 2.11) - (-56)) < 1e-9);
  assert.ok(Math.abs(M.pnlDollars('100', '2.0829', '2.11') - 2.71) < 1e-9, 'strings are numbers');
  const r = { id: 'x', ticker: 'IPST', shares: 100, buy_price: 2.67, sell_price: 2.11, pnl_dollars: -56, signal_score: 55, buy_date: '2026-11-05', buy_time: '08:02' };
  const p = M.repriced(r, 2.0829, 2.1);
  assert.deepStrictEqual({ ...p, pnl_dollars: Math.round(p.pnl_dollars * 100) / 100 }, { ...r, buy_price: 2.0829, sell_price: 2.1, pnl_dollars: 1.71 });
  assert.strictEqual(r.buy_price, 2.67, 'the recorded row is not mutated');
  assert.deepStrictEqual(M.totals([{ pnl_dollars: -1 }, { pnl_dollars: '3' }]), { n: 2, total: 2, perTrade: 1 });
});

await run('the constrained replay sees the corrected cost: a trade that no longer fits the budget is skipped', () => {
  const t = (id, buy, sell, price, shares) => ({ id, buy_date: buy.slice(0, 10), buy_time: buy.slice(11), sell_date: sell.slice(0, 10), sell_time: sell.slice(11), shares, buy_price: price, sell_price: price, pnl_dollars: 0, signal_score: 70, created_at: `${buy}:00Z${id}`, sell_price_unverified: false });
  const rows = [t('a', '2026-10-01T09:00', '2026-10-01T12:00', 7, 100), t('b', '2026-10-01T09:30', '2026-10-01T12:00', 7.9, 100)];
  assert.strictEqual(replay(rows).taken.size, 2, 'recorded: 700 + 790 = 1,490 fits $1,500');
  const corrected = [M.repriced(rows[0], 7.2, 7.2), rows[1]];
  assert.strictEqual(replay(corrected).taken.size, 1, 'corrected: 720 + 790 = 1,510 does not');
});

await run('the reference and the gap are the entry measurement\'s own (one method at both ends)', () => {
  const src = readSource('scripts/measure-exit-price-gap.mjs');
  assert.ok(/import \{ buyMinuteUtc as pacificMinuteUtc, pickReference, gapPct, gapTable, ageTable, latestSipBar, MATERIAL_GAP_PCT \} from '\.\/measure-entry-price-gap\.mjs';/.test(src));
  assert.ok(!/function pickReference|function latestSipBar|const gapPct/.test(src), 'no second copy of the method');
});

await run('the output says it does not bear on the score question, computes nothing on a missing reference, and is frictionless', () => {
  const src = readSource('scripts/measure-exit-price-gap.mjs');
  assert.ok(M.NOT_THE_SCORE_QUESTION.startsWith('This does not bear on the score question'));
  assert.ok(src.includes('console.log(`\\n${NOT_THE_SCORE_QUESTION}`);'));
  assert.ok(src.includes('if (noBuy.length || noSell.length) console.log(`NOT COMPUTED:'));
  assert.ok(src.includes("console.log('A FRICTIONLESS PAPER SIMULATION, not P&L"));
  assert.ok(!/score-vs-return/.test(src.replace(/^\/\/.*$/gm, '')), 'the score test is not imported, so it cannot be re-run here');
});
})();

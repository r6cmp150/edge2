// tests/measure-spread-net.test.js -- 2026-11-20 (the reviewer). The net-at-the-quote accounting, on fixtures, written
// and committed with the script BEFORE its first run on the data: buy at the ask and sell at the bid on recorded
// shares, the mid figure and the spread cost between them, the round-trip spread, a trade missing a quote at either end
// left uncharged with its reason (never a constant), the concentration check, and the replay seeing the ask as cost.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-spread-net.mjs')).href);
const { replay } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/replay-budget-constrained.mjs')).href);
const near = (a, b) => Math.abs(a - b) < 1e-9;

await run('the declared constants', () => { assert.strictEqual(M.REV, '314f6e0'); assert.strictEqual(M.TOP_N, 5); });

await run('net buys at the ask and sells at the bid; mid is mid to mid; the spread cost is the difference', () => {
  const b = { bp: 2.00, ap: 2.02 }, s = { bp: 2.10, ap: 2.14 };
  assert.ok(near(M.netDollars(100, b, s), 100 * (2.10 - 2.02)));
  assert.ok(near(M.midDollars('100', b, s), 100 * (2.12 - 2.01)));
  assert.ok(near(M.midDollars(100, b, s) - M.netDollars(100, b, s), 100 * (0.01 + 0.02)), 'half of each spread');
});

await run('the round-trip spread is half of each side\'s spread over its own mid', () => {
  const b = { bp: 1.98, ap: 2.02 }, s = { bp: 3.97, ap: 4.03 };
  assert.ok(near(M.roundTripSpreadPct(b, s), 100 * (0.02 / 2 + 0.03 / 4)));
});

await run('a trade missing a quote at either end is uncharged, with its reason', () => {
  const q = { bp: 1, ap: 1.01 };
  assert.strictEqual(M.uncharged(q, q), null);
  assert.strictEqual(M.uncharged(null, q), 'no valid quote at the buy');
  assert.strictEqual(M.uncharged(q, null), 'no valid quote at the sale');
  assert.strictEqual(M.uncharged(null, null), 'no valid quote at either end');
});

await run('concentration: the 5 largest by absolute size, either sign, and what the rest net', () => {
  const c = M.concentration([100, -50, 1, 2, -3, 4, 0.5, -0.5]);
  assert.ok(near(c.total, 54)); assert.ok(near(c.top, 100 - 50 + 2 - 3 + 4)); assert.ok(near(c.rest, 1 + 0.5 - 0.5)); assert.strictEqual(c.n, 5);
  assert.strictEqual(M.concentration([1, 2]).n, 2);
});

await run('the replay sees the ask as the entry cost and the net as the P&L', () => {
  const t = (id, buy, price, shares) => ({ id, buy_date: buy.slice(0, 10), buy_time: buy.slice(11), sell_date: buy.slice(0, 10), sell_time: '12:00', shares, buy_price: price, sell_price: price, pnl_dollars: 0, signal_score: 70, created_at: `${buy}:00Z${id}`, sell_price_unverified: false });
  const a = t('a', '2026-10-01T09:00', 7, 100), b = t('b', '2026-10-01T09:30', 7.9, 100);
  assert.strictEqual(replay([a, b]).taken.size, 2, 'at recorded prices 1,490 fits');
  const qa = M.atQuotes(a, { bp: 7.1, ap: 7.2 }, { bp: 7.0, ap: 7.05 });
  assert.strictEqual(qa.buy_price, 7.2); assert.ok(near(qa.pnl_dollars, 100 * (7.0 - 7.2)));
  assert.strictEqual(replay([qa, b]).taken.size, 1, 'at the ask 1,510 does not');
});

await run('moments and quotes are prereg-costs.mjs\'s own; no constant spread; the output says what it is not', () => {
  const src = readSource('scripts/measure-spread-net.mjs');
  assert.ok(src.includes("import { tradeMoments, pickQuote, quotesAt, LOOKBACK_MS } from './prereg-costs.mjs';"));
  assert.ok(!/function pickQuote|function tradeMoments/.test(src), 'no second copy of the method');
  const code = src.replace(/^\/\/.*$/gm, '');
  assert.ok(!/SPREAD_(PCT|ASSUMPTION)|assumedSpread|DEFAULT_SPREAD/i.test(code), 'no constant spread anywhere');
  assert.ok(src.includes('console.log(`\\n${NOT_THE_SCORE_QUESTION}`);'));
  assert.ok(src.includes('LIMIT: the ${out.length - n} unquoted trades are absent from the replay'));
});
})();

// tests/replay-budget-constrained.test.js -- 2026-11-20 (the reviewer). The budget-constrained replay's rules, on
// fixtures, written and committed with the script BEFORE its first run on the data: the app's own Available (budget
// minus open positions at cost, realized P&L not returned), recorded shares never re-sized, exits before entries at the
// same minute, same-minute entries by descending signal_score, an exit recorded before its entry closing at entry, and
// the declared reading printed with the numbers. No data is read here.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

const t = (id, buy, sell, cost, pnl, score = 70) => ({ id, buy_date: buy.slice(0, 10), buy_time: buy.slice(11), sell_date: sell.slice(0, 10), sell_time: sell.slice(11),
  shares: 1, buy_price: cost, pnl_dollars: pnl, signal_score: score, created_at: `${buy}:00Z${id}`, sell_price_unverified: false });

(async () => {
const { replay, BUDGET, REV } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/replay-budget-constrained.mjs')).href);

await run('the declared constants: Roman\'s $1,500 and the pre-registered sample\'s commit', () => {
  assert.strictEqual(BUDGET, 1500);
  assert.strictEqual(REV, '314f6e0');
});

await run('Available is the budget minus open positions at cost; a trade that does not fit is skipped; an exit frees its cost', () => {
  const rows = [t('a', '2026-10-01T09:00', '2026-10-01T12:00', 700, 10), t('b', '2026-10-01T09:30', '2026-10-02T10:00', 700, -5),
    t('c', '2026-10-01T10:00', '2026-10-01T15:00', 700, 20), // 1,400 open: 100 left, skipped
    t('d', '2026-10-01T12:30', '2026-10-01T15:00', 700, 7)]; // a closed at 12:00: 700 free, taken
  const r = replay(rows);
  assert.deepStrictEqual([...r.taken].map(x => x.id).sort(), ['a', 'b', 'd']);
  assert.strictEqual(r.skipped, 1);
  assert.deepStrictEqual(r.constrained, { n: 3, total: 12, perTrade: 4 });
  assert.deepStrictEqual(r.full, { n: 4, total: 32, perTrade: 8 });
  assert.strictEqual(r.maxOpen, 2);
});

await run('realized P&L does not flow back into Available (the app\'s definition): a big win frees only its cost', () => {
  const rows = [t('a', '2026-10-01T09:00', '2026-10-01T10:00', 1000, 900), t('b', '2026-10-01T11:00', '2026-10-01T12:00', 1400, 1), t('c', '2026-10-01T11:01', '2026-10-01T12:00', 600, 1)];
  const r = replay(rows);
  assert.deepStrictEqual([...r.taken].map(x => x.id), ['a', 'b'], 'after a: 1,500 free again, not 2,400; b takes 1,400, c (600) does not fit');
});

await run('same-minute entries are taken in descending signal_score; at the same minute an exit comes first', () => {
  const tie = [t('low', '2026-10-01T10:00', '2026-10-01T11:00', 900, 1, 60), t('high', '2026-10-01T10:00', '2026-10-01T11:00', 900, 1, 90)];
  assert.deepStrictEqual([...replay(tie).taken].map(x => x.id), ['high']);
  const swap = [t('x', '2026-10-01T09:00', '2026-10-01T10:00', 1500, 1), t('y', '2026-10-01T10:00', '2026-10-01T11:00', 1500, 1)];
  assert.deepStrictEqual([...replay(swap).taken].map(x => x.id).sort(), ['x', 'y'], 'x\'s exit at 10:00 frees the cash for y\'s entry at 10:00');
});

await run('recorded shares are never re-sized: a position costing more than the whole budget is always skipped', () => {
  const r = replay([t('big', '2026-10-01T10:00', '2026-10-01T11:00', 3073.5, 100)]);
  assert.strictEqual(r.taken.size, 0); assert.strictEqual(r.skipped, 1);
});

await run('an exit recorded before its entry: taken, and closed at entry (its cost held for no time), and counted', () => {
  const rows = [t('odd', '2026-10-01T10:00', '2026-10-01T09:00', 1500, 2), t('next', '2026-10-01T10:05', '2026-10-01T11:00', 1500, 3)];
  const r = replay(rows);
  assert.deepStrictEqual([...r.taken].map(x => x.id).sort(), ['next', 'odd'], 'the odd row held nothing, so the next fits');
  assert.strictEqual(r.exitBeforeEntry, 1);
});

await run('the declared reading is printed with the numbers, and the output says it is a frictionless simulation', () => {
  const src = readSource('scripts/replay-budget-constrained.mjs');
  assert.ok(src.includes("console.log('A FRICTIONLESS PAPER SIMULATION, not P&L"));
  assert.ok(/one comparison on one historical sample establishes nothing/.test(src) && /FORWARD test, declared in advance, and nothing stronger/.test(src) && /flat at the size Roman intended/.test(src));
  assert.ok(/ordered by ARRIVAL \(time\), which is a weaker test of conviction than a ranking/.test(src));
});
})();

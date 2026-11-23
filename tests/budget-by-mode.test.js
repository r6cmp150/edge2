// tests/budget-by-mode.test.js -- 2026-11-23 (the reviewer: deferred since 11-20, "the number that misled me for two
// days"). The budget bar summed every open position against the budget, paper and live alike. Now: a paper position is
// a simulation, shown apart and never counted; a position whose mode is not recorded might be real money and IS counted,
// and the bar says so; live is counted. Available is the budget minus what could be real money.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { run, readSource } = require('./_lib');

const app = readSource('app.js');
const grab = n => { const i = app.search(new RegExp(`^function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
function load(portfolio, budget = 1500) {
  const el = { innerHTML: '', classList: { add() {}, remove() {} } };
  const ctx = { state: { portfolio, settings: { budget }, activeTab: 'signals' }, document: { getElementById: () => el }, Math, Number };
  vm.createContext(ctx);
  vm.runInContext(readSource('core/orders.js') + '\n' + ['costByMode', 'getAvailableBudget', 'updateBudgetBar'].map(grab).join('\n') + '\n;globalThis.__f = { costByMode, getAvailableBudget, updateBudgetBar };', ctx);
  return { f: ctx.__f, el };
}
const pos = (mode, cost, o = {}) => ({ id: String(Math.random()), shares: 1, buyPrice: cost, executionMode: mode, ...o });

run('paper is never counted against the budget; live and not-recorded are', () => {
  const { f } = load([pos('paper', 20000), pos('live', 300), pos('not_known', 200), pos(null, 100), pos(undefined, 50)]);
  assert.strictEqual(f.getAvailableBudget(), 1500 - 300 - 200 - 100 - 50);
  const c = f.costByMode([pos('paper', 5), pos('live', 7), pos('not_known', 11)]);
  assert.deepStrictEqual([c.paper, c.live, c.unknown, c.n.paper, c.n.live, c.n.unknown], [5, 7, 11, 1, 1, 1]);
});

run('the bar says what each figure is: live, not recorded (counted, and says so), and paper as a simulation, not money', () => {
  const { f, el } = load([pos('paper', 21519.05), pos('not_known', 3245.40)]);
  f.updateBudgetBar();
  const t = el.innerHTML.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.ok(t.includes('Budget: $1500.00') && t.includes('Live: $0.00'));
  assert.ok(t.includes('Mode not recorded: $3245.40 (1 position, counted as real money)'));
  assert.ok(t.includes('Available: $-1745.40'));
  assert.ok(t.includes('Paper, a simulation, not money: $21519.05 in 1 position, not counted against the budget'));
  assert.ok(!/Deployed/.test(t), 'no pooled "Deployed" figure');
});

run('with no paper and nothing unrecorded, the bar shows only what is there', () => {
  const { f, el } = load([pos('live', 500)]);
  f.updateBudgetBar();
  const t = el.innerHTML.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.ok(t.includes('Available: $1000.00') && !/Paper|not recorded/.test(t));
});

run('pending orders are split the same way', () => {
  const { f } = load([pos('paper', 900, { status: 'pending', orderType: 'limit' }), pos('live', 400, { status: 'pending', orderType: 'limit' })]);
  assert.strictEqual(f.getAvailableBudget(), 1500 - 400);
});

// tests/sale-write-outcome.test.js — 2026-10-27. A failed trades_v2 write
// used to be one console.error line: the portfolio row is already deleted
// when it runs, so a failure lost the trade record without anyone knowing.
// Now every outcome is surfaced through the banner machinery a failed
// position save uses: WRITTEN, SALE_DUPLICATE (refused as a second copy
// since db/033's unique position_id, the intended behaviour) and
// SALE_FAILED. A failed sale is kept, persisted, with what Retry needs.
'use strict';
const assert = require('assert');
const { readSource, run: runNow } = require('./_lib');
const queue = []; const run = (n, f) => queue.push([n, f]);

const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`(async )?function ${name}\\(`)); return app.slice(i, app.indexOf('\n}\n', i) + 2); };

function load(insertResult) {
  const persisted = [];
  const el = { style: {}, innerHTML: '' };
  global.document = { getElementById: id => (id === 'market-status' || true ? el : null), querySelector: () => null };
  global.state = { saleWriteFailures: {}, positionSaveFailures: {}, persistFailure: null, activeTab: 'portfolio', sold: [] };
  global.persist = k => persisted.push(k);
  global.scoreLabel = () => 'WATCH';
  global.currentCodeVersion = () => ({ app: 't', scoring: 2, scoring_hash: 'h' });
  global.getMarketStatus = () => ({ color: 'x', label: 'OPEN', countdown: '' });
  global.supabaseClient = { from: () => ({ insert: () => ({ select: async () => { const r = typeof insertResult === 'function' ? insertResult() : insertResult; if (r instanceof Error) throw r; return r; } }) }) };
  // eslint-disable-next-line no-eval
  eval(['writeTradeToSupabase', 'noteSaleWrite', 'retrySaleWrite', 'dismissSaleNotice', 'updateMarketBanner'].map(grab).join('\n') +
    '\nglobal.__w = writeTradeToSupabase; global.__retry = retrySaleWrite; global.__dismiss = dismissSaleNotice; global.__banner = updateMarketBanner;');
  return { persisted, el };
}
const pos = { id: '1761550000000', ticker: 'HUN', company: 'Huntsman', buyDate: '2026-10-28', shares: 10, buyPrice: 9.5, scoreAtBuy: 65, codeVersion: { app: 'a', scoring: 2 } };
const record = { id: 'r1', ticker: 'HUN', sellOrderType: 'market' };
const args = [pos, record, '2026-10-29', 10.1, 6, 6.3];
const quiet = fn => async (...a) => { const e = console.error; console.error = () => {}; try { return await fn(...a); } finally { console.error = e; } };

run('written: no notice, nothing kept', quiet(async () => {
  const { el } = load({ data: [{ id: 'uuid-1' }], error: null });
  assert.strictEqual(await global.__w(...args), 'WRITTEN');
  assert.deepStrictEqual(global.state.saleWriteFailures, {});
  assert.strictEqual(record.supabaseId, 'uuid-1');
  assert.ok(!/sale/.test(el.innerHTML), 'the banner shows the market, not a sale notice');
}));

run('refused for any other reason: red banner, what to do, Retry, and the sale KEPT (persisted)', quiet(async () => {
  const { el, persisted } = load({ data: null, error: { code: '42501', message: 'permission denied' } });
  assert.strictEqual(await global.__w(...args), 'SALE_FAILED');
  const f = global.state.saleWriteFailures[pos.id];
  assert.strictEqual(f.code, 'SALE_FAILED');
  assert.deepStrictEqual(f.args, args, 'the only copy of the sale is kept, with everything Retry needs');
  assert.ok(persisted.includes('saleWriteFailures'), 'persisted: it survives a reload');
  assert.ok(el.innerHTML.includes('HUN sale NOT recorded') && el.innerHTML.includes("Don't re-submit it by hand") && el.innerHTML.includes('check the Sold tab after a refresh'));
  assert.ok(el.innerHTML.includes(`retrySaleWrite('${pos.id}')`));
  assert.strictEqual(el.style.color, 'var(--red)');
}));

run('a thrown error (network, timeout) is SALE_FAILED too, never silent', quiet(async () => {
  const { el } = load(new Error('Failed to fetch'));
  assert.strictEqual(await global.__w(...args), 'SALE_FAILED');
  assert.ok(el.innerHTML.includes('sale NOT recorded'));
}));

run('a duplicate is said as the intended refusal, not as a loss, and only it is dismissable', quiet(async () => {
  const { el } = load({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "trades_v2_position_id_once"', details: 'Key (position_id)=(1761550000000) already exists.' } });
  assert.strictEqual(await global.__w(...args), 'SALE_DUPLICATE');
  assert.ok(el.innerHTML.includes('HUN sale was already recorded') && el.innerHTML.includes('refused, as designed') && el.innerHTML.includes('Nothing is lost'));
  assert.ok(!el.innerHTML.includes('NOT recorded'));
  assert.strictEqual(global.state.saleWriteFailures[pos.id].args, null, 'nothing to retry');
  global.__dismiss(pos.id);
  assert.deepStrictEqual(global.state.saleWriteFailures, {});
  // A 23505 on some OTHER constraint is not "already recorded".
  load({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "trades_v2_pkey"' } });
  assert.strictEqual(await global.__w(...args), 'SALE_FAILED');
  global.__dismiss(pos.id);
  assert.ok(global.state.saleWriteFailures[pos.id], 'a real failure cannot be dismissed away');
}));

run('Retry: lands -> cleared; first write had landed after all -> already recorded', quiet(async () => {
  let n = 0;
  load(() => (++n === 1 ? new Error('timeout') : { data: [{ id: 'uuid-2' }], error: null }));
  assert.strictEqual(await global.__w(...args), 'SALE_FAILED');
  await global.__retry(pos.id);
  assert.deepStrictEqual(global.state.saleWriteFailures, {}, 'cleared once written');
  let m = 0;
  load(() => (++m === 1 ? new Error('timeout') : { data: null, error: { code: '23505', message: 'unique constraint "trades_v2_position_id_once"', details: 'Key (position_id)' } }));
  await global.__w(...args);
  await global.__retry(pos.id);
  assert.strictEqual(global.state.saleWriteFailures[pos.id].code, 'SALE_DUPLICATE', 'safe: the retry cannot make a second copy');
}));

run('an unrecorded sale outranks every other banner, and the state is loaded across reloads', quiet(async () => {
  const { el } = load({ data: null, error: { code: 'x', message: 'y' } });
  global.state.positionSaveFailures = { p2: { ticker: 'CLF', code: 'POSITION_UNWRITABLE' } };
  await global.__w(...args);
  assert.ok(el.innerHTML.includes('HUN sale NOT recorded') && !el.innerHTML.includes('CLF'));
  assert.ok(/'saleWriteFailures'\]\.forEach\(k => \{/.test(app), 'loadState restores it');
  const w = grab('writeTradeToSupabase');
  assert.ok(!/console\.error\('Supabase trade write failed/.test(w), 'no console-only failure path left');
}));

(async () => { for (const [n, f] of queue) await runNow(n, f); })();

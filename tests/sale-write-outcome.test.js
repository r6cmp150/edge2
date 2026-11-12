// tests/sale-write-outcome.test.js — 2026-10-27. A failed trades_v2 write
// used to be one console.error line: the portfolio row is already deleted
// when it runs, so a failure lost the trade record without anyone knowing.
// Now every outcome is surfaced through the banner machinery a failed
// position save uses: WRITTEN, SALE_DUPLICATE (refused as a second copy
// since db/033's unique position_id, the intended behaviour) and
// SALE_FAILED. A failed sale is kept, persisted, with what Retry needs.
'use strict';
const assert = require('assert');
const { readSource, run: runNow, settingLabelsSrc } = require('./_lib');
const queue = []; const run = (n, f) => queue.push([n, f]);

const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`(async )?function ${name}\\(`)); return app.slice(i, app.indexOf('\n}\n', i) + 2); };

// CHANGED 2026-11-12, declared: the eval also carries saleModeColumns (db/042's mode on the sale row).
// CHANGED 2026-11-08, declared: the fake client also answers compareRecordedSale's read-back
// (`stored`: the row it returns, an Error, or null for an empty read), and the eval carries the
// two constants noteSaleWrite and compareRecordedSale use.
const constLine = n => { const m = app.match(new RegExp('^const ' + n + ' = .*$', 'm')); assert.ok(m, n); return m[0]; };
function load(insertResult, stored = { sell_price: 10.1, shares: 10, sell_date: '2026-10-29' }) {
  const persisted = [];
  const el = { style: {}, innerHTML: '' };
  global.document = { getElementById: id => (id === 'market-status' || true ? el : null), querySelector: () => null };
  global.state = { saleWriteFailures: {}, positionSaveFailures: {}, persistFailure: null, activeTab: 'portfolio', sold: [] };
  global.persist = k => persisted.push(k);
  // CHANGED 2026-11-12, declared: the scan price history adds hooks these functions now call; stubbed here, held by tests/scan-history.test.js.
  global.invalidateSessionRead = () => {};
  // CHANGED 2026-11-12, declared: the banner and the mode re-read now redraw the LIVE band; stubbed here, held by tests/live-band.test.js.
  global.renderLiveBand = () => {};
  global.scoreLabel = () => 'WATCH';
  global.currentCodeVersion = () => ({ app: 't', scoring: 2, scoring_hash: 'h' });
  global.getMarketStatus = () => ({ color: 'x', label: 'OPEN', countdown: '' });
  global.__reads = [];
  global.supabaseClient = { from: () => ({
    insert: () => ({ select: async () => { const r = typeof insertResult === 'function' ? insertResult() : insertResult; if (r instanceof Error) throw r; return r; } }),
    select: cols => ({ eq: (c, v) => ({ limit: async n => { global.__reads.push([cols, c, v, n]); if (stored instanceof Error) return { data: null, error: { message: stored.message } }; return { data: stored ? [stored] : [], error: null }; } }) }),
  }) };
  // eslint-disable-next-line no-eval
  eval(settingLabelsSrc() + '\n' + [constLine('MAX_SALE_ATTEMPTS'), constLine('SALE_COMPARED_FIELDS')].join('\n') + '\n' + ['saleVerdictProvenance', 'saleModeColumns', 'writeTradeToSupabase', 'noteSaleWrite', 'compareRecordedSale', 'retrySaleWrite', 'dismissSaleNotice', 'settingsBannerLine', 'updateMarketBanner'].map(grab).join('\n') +
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
  // CHANGED 2026-11-04, declared: detail and buttons sit behind a tap now (tests/banner-one-line.test.js).
  global.state.bannerExpanded = true; global.__banner();
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
  // CHANGED 2026-11-04, declared: detail and buttons sit behind a tap now (tests/banner-one-line.test.js).
  global.state.bannerExpanded = true; global.__banner();
  // CHANGED 2026-11-08, declared: 'Nothing is lost' now only after the read-back matched, and it
  // names what was compared and what was not.
  // CHANGED 2026-11-11, declared: "what you entered" -> "what was submitted this time". The sell form
  // prefills a live quote, so a submitted value is not known to have been typed.
  assert.ok(el.innerHTML.includes('HUN sale was already recorded') && el.innerHTML.includes('refused, as designed') && el.innerHTML.includes('Nothing is lost: the recorded sale matches what was submitted this time on sell price, shares and sale date') && el.innerHTML.includes('recording time is not comparable and was not compared'));
  assert.deepStrictEqual(global.__reads, [['sell_price, shares, sell_date', 'position_id', pos.id, 1]], 'the stored row is read back by position_id, bounded');
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
  // CHANGED 2026-11-02, declared: the restore list gained snapshotWriteFailures
  // and ratingWriteFailures after it (tests/write-failures-surfaced.test.js).
  assert.ok(/'saleWriteFailures'[,\]][^\n]*\]\.forEach\(k => \{/.test(app), 'loadState restores it');
  const w = grab('writeTradeToSupabase');
  assert.ok(!/console\.error\('Supabase trade write failed/.test(w), 'no console-only failure path left');
}));

// ── 2026-11-08: change 2 ──
const dup = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "trades_v2_position_id_once"', details: 'Key (position_id)=(1761550000000) already exists.' } };

run('no error and no row back is NOT a sale recorded: SALE_FAILED, kept for Retry (it used to be WRITTEN)', quiet(async () => {
  for (const body of [{ data: [], error: null }, { data: null, error: null }]) {
    const { el } = load(body);
    assert.strictEqual(await global.__w(...args), 'SALE_FAILED');
    const f = global.state.saleWriteFailures[pos.id];
    assert.ok(/no error and no row: nothing was recorded/.test(f.message), f.message);
    assert.deepStrictEqual(f.args, args, 'kept: Retry is the only way it lands');
    assert.ok(el.innerHTML.includes('sale NOT recorded'));
  }
}));

run('a duplicate whose recorded row DIFFERS: its own red line, both sets of numbers, never "Nothing is lost"', quiet(async () => {
  const { el } = load(dup, { sell_price: '9.80', shares: 10, sell_date: '2026-10-28' });
  assert.strictEqual(await global.__w(...args), 'SALE_DUPLICATE');
  const cmp = global.state.saleWriteFailures[pos.id].attempts.at(-1).comparison;
  assert.strictEqual(cmp.verdict, 'DIFFER'); assert.deepStrictEqual(cmp.differ, ['sell_price', 'sell_date']);
  assert.deepStrictEqual(cmp.compared, ['sell_price', 'shares', 'sell_date'], 'what was compared is recorded');
  assert.ok(/sell_time .* not compared/.test(cmp.note));
  global.state.bannerExpanded = true; global.__banner();
  const h = el.innerHTML;
  assert.ok(h.includes('HUN sale recorded with different numbers') && h.includes('differ on sell price, sell date'), h);
  // CHANGED 2026-11-11, declared: "You entered" -> "Submitted this time", and the line says both
  // copies are quotes the form filled in at different moments (paper trading: there is no fill).
  assert.ok(h.includes('Recorded: $9.8 × 10 on 2026-10-28') && h.includes('Submitted this time: $10.1 × 10 on 2026-10-29') && h.includes('This copy was not saved'));
  assert.ok(h.includes('both are quotes taken at different moments; the record kept the first') && !/your fill|broker/.test(h), h);
  assert.ok(!h.includes('Nothing is lost') && !h.includes('as designed'));
  assert.strictEqual(el.style.color, 'var(--red)');
}));

run('a duplicate whose row cannot be read back: says so, never "Nothing is lost"; an empty read is a read problem', quiet(async () => {
  for (const stored of [new Error('permission denied'), null]) {
    const { el } = load(dup, stored);
    await global.__w(...args);
    const cmp = global.state.saleWriteFailures[pos.id].attempts.at(-1).comparison;
    assert.strictEqual(cmp.verdict, 'COULD_NOT_READ');
    global.state.bannerExpanded = true; global.__banner();
    assert.ok(el.innerHTML.includes("couldn't be read back to compare") && !el.innerHTML.includes('Nothing is lost'), el.innerHTML);
  }
}));

run('shares are compared too, and a price equal to the cent matches', quiet(async () => {
  load(dup, { sell_price: 10.1, shares: 12, sell_date: '2026-10-29' });
  await global.__w(...args);
  assert.deepStrictEqual(global.state.saleWriteFailures[pos.id].attempts.at(-1).comparison.differ, ['shares']);
  load(dup, { sell_price: '10.10', shares: '10', sell_date: '2026-10-29T00:00:00+00:00' });
  await global.__w(...args);
  assert.strictEqual(global.state.saleWriteFailures[pos.id].attempts.at(-1).comparison.verdict, 'MATCH');
}));

run('a later attempt never overwrites the record of an earlier one: Retry refused as a duplicate keeps the first failure', quiet(async () => {
  let m = 0;
  const { el } = load(() => (++m === 1 ? new Error('Failed to fetch') : dup.error && dup));
  await global.__w(...args);
  const first = { ...global.state.saleWriteFailures[pos.id] };
  await global.__retry(pos.id);
  const f = global.state.saleWriteFailures[pos.id];
  assert.strictEqual(f.code, 'SALE_DUPLICATE', 'latest at top level, for the banner');
  assert.strictEqual(f.attempts.length, 2);
  assert.deepStrictEqual([f.attempts[0].code, f.attempts[0].message, f.attempts[0].at], ['SALE_FAILED', 'Failed to fetch', first.at], 'the first attempt survives intact');
  assert.strictEqual(f.attempts[1].code, 'SALE_DUPLICATE');
  global.state.bannerExpanded = true; global.__banner();
  assert.ok(el.innerHTML.includes('2 attempt(s)') && el.innerHTML.includes('#1 at') && el.innerHTML.includes('SALE_FAILED · Failed to fetch') && el.innerHTML.includes('#2 at'), el.innerHTML);
}));

run('an entry from before this build is kept as its first attempt, marked legacy, and its banner claims no comparison', quiet(async () => {
  const { el } = load(dup);
  global.state.saleWriteFailures[pos.id] = { ticker: 'HUN', code: 'SALE_DUPLICATE', message: 'old 23505', at: '2026-11-06T15:40:00.000Z', args: null };
  global.state.bannerExpanded = true; global.__banner();
  assert.ok(el.innerHTML.includes('was not checked (refused before 2026-11-08)') && !el.innerHTML.includes('Nothing is lost'), el.innerHTML);
  await global.__w(...args);
  const f = global.state.saleWriteFailures[pos.id];
  assert.deepStrictEqual(f.attempts[0], { code: 'SALE_DUPLICATE', message: 'old 23505', at: '2026-11-06T15:40:00.000Z', legacy: true });
  assert.strictEqual(f.attempts.length, 2);
}));

run('bounded: the first attempt always kept, then the latest, with the count of those dropped between', quiet(async () => {
  let i = 0;
  load(() => new Error(i++ === 0 ? 'the first failure' : `failure ${i}`));
  for (let j = 0; j < 9; j++) await global.__w(...args);
  const f = global.state.saleWriteFailures[pos.id];
  assert.strictEqual(f.attempts[0].message, 'the first failure', 'the first attempt is never the one dropped');
  assert.strictEqual(f.attempts.at(-1).message, 'failure 9', 'the latest is kept');
  const max = Number(constLine('MAX_SALE_ATTEMPTS').match(/\d+/)[0]);
  assert.strictEqual(f.attempts.length, max); assert.strictEqual(f.attemptsDropped, 9 - max);
  assert.ok(!('row' in f) && JSON.stringify(f.attempts).length < 4000, 'small: no row is ever stored in an attempt');
}));

(async () => { for (const [n, f] of queue) await runNow(n, f); })();

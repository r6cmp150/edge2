// tests/sale-write-order.test.js -- 2026-11-08. confirmMarkSold awaited the portfolio
// delete and RETURNED on any error before the sale record existed: a network blip at
// that second lost the sale with one alert, nothing saved, nothing queued. Now the sale
// is built and saved first, inserted first, and only then is the portfolio row deleted;
// a failed delete is its own line ("still shows as open"), never a sale failure.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = n => { const i = app.search(new RegExp('^(async )?function ' + n + '[(]', 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

function load({ insert = async () => 'WRITTEN', del = async () => 'REMOVED', client, initial = {} } = {}) {
  const log = [];
  global.state = { saleWriteFailures: {}, deletedPositionIds: new Set(), portfolio: [], ...initial };
  global.__log = log;
  global.writeTradeToSupabase = async (...a) => { log.push('insert'); return insert(...a); };
  global.deletePositionFromSupabase = async id => { log.push(`delete ${id}`); return del(id); };
  global.updateMarketBanner = () => log.push('banner');
  global.persist = k => log.push(`persist ${k}`);
  global.noteDataReadProblem = (t, m) => log.push(`readProblem ${t}: ${m}`);
  global.clearDataReadProblem = t => log.push(`clearRead ${t}`);
  global.renderPortfolioTab = () => {}; global.updateNavBadges = () => {};
  global.supabaseClient = client;
  // eslint-disable-next-line no-eval
  eval(['recordSaleThenRemovePosition', 'notePositionStillOpen', 'checkPositionsStillOpen', 'removePositionAgain'].map(grab).join('\n') +
    '\nglobal.__f = { recordSaleThenRemovePosition, checkPositionsStillOpen, removePositionAgain };');
  return { ...global.__f, log };
}
const fail = code => async () => { const e = new Error(`position 7: ${code}`); e.code = code; throw e; };
const pos = { id: '7', ticker: 'UEC' };

run('the sale is inserted BEFORE the portfolio row is deleted', async () => {
  const { recordSaleThenRemovePosition, log } = load();
  await recordSaleThenRemovePosition(pos, {}, '2026-11-06', 1, 0, 0);
  assert.deepStrictEqual(log.filter(x => x === 'insert' || x.startsWith('delete')), ['insert', 'delete 7']);
  assert.ok(!global.state.positionsStillOpen || !global.state.positionsStillOpen['7'], 'a clean delete leaves no line');
});

for (const [sale, code] of [['WRITTEN', 'POSITION_NOT_REMOVED'], ['SALE_DUPLICATE', 'POSITION_UNKNOWN'], ['SALE_FAILED', '08006']]) {
  run(`insert ${sale}, delete throws ${code}: a "still open" entry naming the sale's state; the sale is not touched`, async () => {
    const { recordSaleThenRemovePosition, log } = load({ insert: async () => sale, del: fail(code) });
    await recordSaleThenRemovePosition(pos, {}, '2026-11-06', 1, 0, 0);
    assert.deepStrictEqual(global.state.positionsStillOpen['7'], { ticker: 'UEC', sale, message: `position 7: ${code}` });
    assert.deepStrictEqual(global.state.saleWriteFailures, {}, 'the delete never writes the sale queue');
    assert.ok(!log.some(x => x.startsWith('persist')), 'derived: never persisted');
  });
}

run('an insert that throws unexpectedly still lets the delete run; the line says the sale is not known to be recorded', async () => {
  const { recordSaleThenRemovePosition, log } = load({ insert: async () => { throw new Error('boom'); }, del: fail('POSITION_NOT_REMOVED') });
  await recordSaleThenRemovePosition(pos, {}, '2026-11-06', 1, 0, 0);
  assert.ok(log.includes('delete 7'));
  assert.strictEqual(global.state.positionsStillOpen['7'].sale, 'SALE_FAILED');
});

run('confirmMarkSold: nothing between disabling the button and saving the record can stop the sale', () => {
  const src = grab('confirmMarkSold');
  const a = src.indexOf('if (btn) btn.disabled = true;'), b = src.indexOf('state.sold.unshift(record);');
  assert.ok(a > 0 && b > a, 'both anchors present, in order');
  const between = src.slice(a, b);
  assert.ok(!/\bawait\b/.test(between), 'no await before the record is saved: ' + (between.match(/.*\bawait\b.*/) || [''])[0]);
  // A bare `return;` or an alert is how the old code stopped; the record's own inline
  // helpers (e.g. sellTime's IIFE) return values, which is fine.
  assert.ok(!/\breturn\s*;/.test(between) && !/showAlert/.test(between), 'no bare return, no alert-and-stop, before the record is saved');
  assert.ok(!/deletePositionFromSupabase/.test(src), 'the delete is not in confirmMarkSold at all');
  const after = src.slice(b);
  assert.ok(/persist\('sold'\)/.test(after) && after.indexOf("persist('sold')") < after.indexOf('recordSaleThenRemovePosition('), 'saved on the phone, then sent');
});

// The load check: a fake client for trades_v2.select('position_id').eq('position_id', id).limit(1),
// answering per id from `rows` (ids with a sale), or with `error` for every read.
const client = (rows = [], error = null) => {
  const calls = [];
  return { calls, from: t => ({ select: c => ({ eq: (col, id) => ({ limit: n => { calls.push(`${t}.${c}.${col}=${id}.limit(${n})`); return Promise.resolve(error ? { data: null, error } : { data: rows.includes(id) ? [{ position_id: id }] : [], error: null }); } }) }) }) };
};

run('on load: an open row whose sale is in trades_v2, or queued on this phone, gets the line; others do not', async () => {
  const c = client(['7']);
  const { checkPositionsStillOpen, log } = load({ client: c, initial: {
    portfolio: [{ id: '7', ticker: 'UEC' }, { id: '8', ticker: 'XE' }, { id: '9', ticker: 'SMR' }],
    saleWriteFailures: { 8: { ticker: 'XE', code: 'SALE_FAILED' } },
  } });
  await checkPositionsStillOpen();
  assert.deepStrictEqual(c.calls, ['7', '8', '9'].map(id => `trades_v2.position_id.position_id=${id}.limit(1)`), 'one bounded read per open position');
  const s = global.state.positionsStillOpen;
  assert.strictEqual(s['7'].sale, 'WRITTEN'); assert.strictEqual(s['8'].sale, 'SALE_FAILED'); assert.ok(!s['9']);
  assert.ok(log.includes('clearRead trades_v2 (open positions)') && !log.some(x => x.startsWith('persist')));
});

run('on load: a failed read is reported as a read problem, and invents no line', async () => {
  const { checkPositionsStillOpen, log } = load({ client: client([], { message: 'denied' }), initial: { portfolio: [{ id: '7', ticker: 'UEC' }] } });
  await checkPositionsStillOpen();
  assert.ok(log.some(x => x.startsWith('readProblem trades_v2 (open positions)') && x.includes('denied')));
  assert.deepStrictEqual(global.state.positionsStillOpen, {});
});

run('on load with nothing open: no read at all', async () => {
  const c = client();
  const { checkPositionsStillOpen } = load({ client: c });
  await checkPositionsStillOpen();
  assert.deepStrictEqual(c.calls, []);
});

run('Remove again: success clears the line and the position; failure keeps the line with the new reason', async () => {
  let r = load({ initial: { portfolio: [{ id: '7', ticker: 'UEC' }], positionsStillOpen: { 7: { ticker: 'UEC', sale: 'WRITTEN', message: 'x' } } } });
  await r.removePositionAgain('7');
  assert.ok(!global.state.positionsStillOpen['7'] && global.state.portfolio.length === 0 && global.state.deletedPositionIds.has('7'));
  r = load({ del: fail('POSITION_NOT_REMOVED'), initial: { portfolio: [{ id: '7', ticker: 'UEC' }], positionsStillOpen: { 7: { ticker: 'UEC', sale: 'WRITTEN', message: 'x' } } } });
  await r.removePositionAgain('7');
  assert.strictEqual(global.state.positionsStillOpen['7'].message, 'position 7: POSITION_NOT_REMOVED');
  assert.strictEqual(global.state.portfolio.length, 1);
});

run('the check runs after the app shell renders, not during the loading screen', () => {
  const init = grab('runDataLoadAndInit');
  const shell = init.indexOf('document.body.innerHTML = APP_SHELL_HTML'), chk = init.indexOf('checkPositionsStillOpen()');
  assert.ok(shell > 0 && chk > shell, 'checkPositionsStillOpen after the shell');
  assert.ok(!/positionsStillOpen/.test(app.slice(app.indexOf("['sold','analysisPeriods'"), app.indexOf('.forEach(k =>', app.indexOf("['sold','analysisPeriods'")))), 'not a persisted key');
});

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

// CHANGED 2026-11-18, declared: the delete returns an OUTCOME and never throws (bounded; core/store.js boundedRequest).
function load({ insert = async () => 'WRITTEN', del = async () => ({ outcome: 'OK', removed: 'REMOVED' }), client, initial = {} } = {}) {
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
  // CHANGED 2026-11-18, declared: the sale is queued (SALE_PENDING, with its args) BEFORE the insert (queueSaleBeforeWrite).
  eval(['queueSaleBeforeWrite', 'recordSaleThenRemovePosition', 'notePositionStillOpen', 'checkPositionsStillOpen', 'removePositionAgain'].map(grab).join('\n') +
    '\nglobal.__f = { recordSaleThenRemovePosition, checkPositionsStillOpen, removePositionAgain };');
  return { ...global.__f, log };
}
// a non-OK delete outcome: FAILED (the row is known to be there) or UNKNOWN (no answer: not known whether it went)
const fail = (code, outcome = 'FAILED') => async () => ({ outcome, reason: `position 7: ${code}` });
const pos = { id: '7', ticker: 'UEC' };

run('the sale is inserted BEFORE the portfolio row is deleted', async () => {
  const { recordSaleThenRemovePosition, log } = load();
  await recordSaleThenRemovePosition(pos, {}, '2026-11-06', 1, 0, 0);
  assert.deepStrictEqual(log.filter(x => x === 'insert' || x.startsWith('delete') || x === 'persist saleWriteFailures'), ['persist saleWriteFailures', 'insert', 'delete 7'], 'queued, then inserted, then the row deleted');
  assert.ok(!global.state.positionsStillOpen || !global.state.positionsStillOpen['7'], 'a clean delete leaves no line');
});

// CHANGED 2026-11-18, declared (the reviewer's (b)): the row is deleted only when a sale IS recorded (WRITTEN,
// SALE_DUPLICATE). The SALE_FAILED case moved below: the row is kept, so there is no delete to fail.
for (const [sale, code, outcome, row] of [['WRITTEN', 'POSITION_NOT_REMOVED', 'FAILED', 'STILL_THERE'], ['SALE_DUPLICATE', 'POSITION_UNKNOWN', 'UNKNOWN', 'UNKNOWN']]) {
  run(`insert ${sale}, delete throws ${code}: a "still open" entry naming the sale's state; the sale is not touched`, async () => {
    const { recordSaleThenRemovePosition, log } = load({ insert: async () => sale, del: fail(code, outcome) });
    await recordSaleThenRemovePosition(pos, {}, '2026-11-06', 1, 0, 0);
    assert.deepStrictEqual(global.state.positionsStillOpen['7'], { ticker: 'UEC', sale, message: `position 7: ${code}`, row });
    // CHANGED 2026-11-18, declared: the queue is written ONCE, before the insert (the insert is mocked here, so its
    // outcome never overwrites the pending entry); the delete still never writes it.
    assert.deepStrictEqual(log.filter(x => x.startsWith('persist')), ['persist saleWriteFailures'], 'one queue write, before the insert; the delete writes nothing');
    assert.ok(log.indexOf('persist saleWriteFailures') < log.indexOf('insert'));
  });
}

// CHANGED 2026-11-18, declared (the reviewer's (b)), REVERSING the 11-08 expectation that the delete runs whatever the
// sale's outcome. A sale not recorded (SALE_FAILED), not known (SALE_PENDING: a timeout), or whose write threw outside
// its own handling, KEEPS the position row: deleting it left no position, no trade and one queue entry on one phone.
// The 11-08 ruling's own direction (a failed delete never blocks or loses the sale) is untouched.
for (const [label, insert] of [['SALE_FAILED', async () => 'SALE_FAILED'], ['SALE_PENDING (no answer in time)', async () => 'SALE_PENDING'],
  ['an unexpected throw', async () => { throw new Error('boom'); }]]) {
  run(`insert ${label}: the position row is KEPT (no delete), and the outcome is returned`, async () => {
    const { recordSaleThenRemovePosition, log } = load({ insert });
    const out = await recordSaleThenRemovePosition(pos, {}, '2026-11-06', 1, 0, 0);
    assert.ok(!log.some(x => x.startsWith('delete')), 'no delete: the row is the database\'s own record until the sale lands');
    assert.ok(out === 'SALE_FAILED' || out === 'SALE_PENDING', out);
    if (label === 'an unexpected throw') assert.strictEqual(out, 'SALE_PENDING', 'a throw is "not known", never "failed"');
    assert.ok(!global.state.positionsStillOpen || !global.state.positionsStillOpen['7'], 'not "still shows as open": nothing to remove again');
  });
}

// (the reviewer's (a)) the queue's own save, three states, and the card is told which.
run('the queue cannot be saved: the in-flight card is told NOT_QUEUED (keep the app open); a throw is UNKNOWN', async () => {
  for (const [persistImpl, want] of [[() => false, 'NOT_QUEUED'], [() => { throw new Error('quota'); }, 'UNKNOWN'], [() => true, 'QUEUED']]) {
    const { recordSaleThenRemovePosition } = load({ insert: () => new Promise(() => {}) });
    global.persist = persistImpl;
    global.state.saleInFlight = { 7: 'QUEUING' };
    recordSaleThenRemovePosition(pos, {}, '2026-11-06', 1, 0, 0);
    await new Promise(r => setImmediate(r));
    assert.strictEqual(global.state.saleInFlight['7'], want);
  }
  // the card says it, on its own warning line above a short "Recording sale…" (rendered at 390px, 2026-11-18)
  assert.ok(app.includes("⚠ Keep the app open until this sale finishes: ${state.saleInFlight[p.id] === 'NOT_QUEUED' ? 'it could not be saved on this phone' : 'it is not known whether it was saved on this phone'}, so nothing will remember it if the app closes now."), 'the card says it');
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
  // CHANGED 2026-11-18, declared (write first, then remove): the card stays, marked in flight, until the write returns.
  const inFlight = after.indexOf("state.saleInFlight[posId] = 'QUEUING';");
  const awaited = after.indexOf('await recordSaleThenRemovePosition(');
  const removed = after.indexOf('state.portfolio = state.portfolio.filter(p => p.id !== posId);');
  assert.ok(inFlight > 0 && awaited > inFlight && removed > awaited, 'in flight, then the write AWAITED, then removed from the list');
  // (b) only a RECORDED sale leaves the list; not recorded or not known, the card stays with Retry
  assert.ok(after.includes("if (outcome === 'WRITTEN' || outcome === 'SALE_DUPLICATE') state.portfolio = state.portfolio.filter(p => p.id !== posId);"), 'the removal is conditional on a recorded sale');
  assert.ok(!src.slice(0, src.indexOf('await recordSaleThenRemovePosition(')).includes('state.portfolio = state.portfolio.filter'), 'nothing removes the card before the write');
});

// 2026-11-18 (the reviewer): a queue written only after the call is not a queue. An app closed inside the write's
// round trip used to lose the sale without trace ("path 5").
run('the app dies mid-write: the sale is already queued, SALE_PENDING, with everything Retry needs', async () => {
  const { recordSaleThenRemovePosition, log } = load({ insert: () => new Promise(() => {}) }); // the response never comes
  recordSaleThenRemovePosition(pos, { r: 1 }, '2026-11-06', 1.5, 2, 3); // not awaited: the app is gone
  await new Promise(r => setImmediate(r));
  const q = global.state.saleWriteFailures['7'];
  assert.strictEqual(q.code, 'SALE_PENDING');
  assert.deepStrictEqual(q.args, [pos, { r: 1 }, '2026-11-06', 1.5, 2, 3], 'the full sale, for Retry');
  assert.ok(log.includes('persist saleWriteFailures') && !log.some(x => x.startsWith('delete')), 'persisted; the row not touched');
});

run('the in-flight card reads "Recording sale…" with no Sell button; the banner leaves an in-flight sale to its card', () => {
  assert.ok(app.includes(`'<button class="btn btn-ghost" disabled>Recording sale…</button>'`), 'the card');
  // CHANGED 2026-11-18 (b): a card whose sale is not recorded, or not known, stays, with Retry in place of Sell
  assert.ok(app.includes("'Sale NOT recorded: Retry' : 'Sale not known to be recorded: Retry'"), 'the kept card offers Retry');
  assert.ok(app.includes('.filter(([id]) => !state.saleInFlight?.[id])'), 'the banner skips a sale in flight');
  assert.ok(app.includes("if (f.code === 'SALE_PENDING') {") && app.includes('sale: not known whether it was recorded'), 'an unresolved pending sale is its own red line');
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
  // CHANGED 2026-11-18, declared (b): a queued SALE_FAILED keeps its row ON PURPOSE, so it gets no "still shows as open"
  // line (its "Remove again" would delete the position before the sale is recorded); its sale line covers it.
  assert.strictEqual(s['7'].sale, 'WRITTEN'); assert.ok(!s['8'], 'a queued, unrecorded sale is not "still open"'); assert.ok(!s['9']);
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
  r = load({ del: fail('POSITION_NOT_REMOVED', 'FAILED'), initial: { portfolio: [{ id: '7', ticker: 'UEC' }], positionsStillOpen: { 7: { ticker: 'UEC', sale: 'WRITTEN', message: 'x' } } } });
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

// 2026-11-18 (the reviewer): "a test that a timed-out write is never reported to Roman as 'failed'". The sale's row
// delete, when it got no answer: the line says it is NOT KNOWN whether the row was removed, never that it wasn't, and
// never "failed"; "Remove again" is offered as safe either way. A row KNOWN to be there keeps the old wording.
run('a delete with no answer is shown as not known, never as failed or as "wasn\'t removed"', () => {
  const i = app.indexOf('function updateMarketBanner(');
  const banner = app.slice(i, app.indexOf('\n}\n', i));
  const k = banner.indexOf("for (const [id, g] of Object.entries(state.positionsStillOpen || {})) {");
  const line = banner.slice(k, banner.indexOf('\n  }\n', k));
  assert.ok(line.includes("g.row === 'UNKNOWN' ? `${g.ticker}: not known whether it was removed` : `${g.ticker} still shows as open`"), 'the title');
  const unknownText = line.match(/g\.row === 'UNKNOWN' \? "([^"]+)"/)[1];
  assert.ok(/not known/.test(unknownText) && /safe either way/.test(unknownText), unknownText);
  assert.ok(!/fail|wasn't removed|was not removed/i.test(unknownText.replace("If it wasn't, ", '')), 'never "failed", never "wasn\'t removed": ' + unknownText);
  // every caller of the delete reads its outcome; none wraps it in a catch that would turn UNKNOWN into "failed"
  // IDENTIFIED, 2026-11-18 (the reviewer: this was a count, ">= 4", so a fifth caller satisfied nothing and a replaced
  // one inherited the assertion): the four callers by name, each reading the outcome.
  const { enclosingFunctions } = require('./_lib');
  const re = /deletePositionFromSupabase\(/g;
  const callers = enclosingFunctions(app, re);
  assert.deepStrictEqual([...callers].sort(), ['cancelPendingOrder', 'recordSaleThenRemovePosition', 'removePositionAgain', 'retrySaleWrite']);
  const calls = [...app.matchAll(/(.{0,60})deletePositionFromSupabase\(/g)].map(m => m[1]);
  calls.forEach((c, i) => assert.ok(/const del = await $/.test(c), `${callers[i]}: the call is read as an outcome: ${c}`));
  assert.ok(!/try \{ await deletePositionFromSupabase/.test(app) && !/catch \(e\) \{\s*notePositionStillOpen/.test(app), 'no catch around the delete');
});

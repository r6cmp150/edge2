// tests/add-open-lot-check.test.js -- 2026-11-18. On 2026-11-17 Roman's laptop and phone each held their own portfolio
// list, read at their own start, and 16 adds were made over an open lot of the same ticker that the tapping device could
// not see (appShowedAtBuy, 16 of 16). The Add now asks the DATABASE for open lots of the ticker first:
//   FOUND            -> says what is held, and asks (it warns, never refuses: a second lot is legitimate);
//   NOT_FOUND        -> on, unasked (only after the trades_v2 control vouches that an empty answer is not a denial);
//   COULD_NOT_CHECK  -> says so, with the reason, and asks: never treated as NOT_FOUND.
// And, in the same change, the portfolio LOAD is guarded the same way (it returned [] for any empty answer).
// Run for real: the app's own functions, with the database stubbed at the query.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const store = readSource('core/store.js');

// A database stub at the query: portfolio rows for the ticker, and the trades_v2 control.
function db({ lots = [], lotsError = null, hang = false, control = 906, controlError = null } = {}) {
  const answer = (value, sig) => (hang
    ? new Promise((res) => sig.addEventListener('abort', () => res({ data: null, error: { message: 'AbortError: The operation was aborted.' } })))
    : Promise.resolve(value));
  return { from: t => ({ select: () => (t === 'portfolio'
    ? { eq: () => ({ abortSignal: sig => answer({ data: lotsError ? null : lots, error: lotsError }, sig) }) }
    : { abortSignal: sig => answer({ count: controlError ? null : control, error: controlError }, sig) }) }) };
}
function load(dbOpts = {}) {
  const i = app.indexOf('let _addInFlight = false;');
  const j = app.indexOf('async function addWithMode(');
  const k = app.indexOf('\n}\n', j) + 2;
  const fields = { 'pf-shares': { value: '10' }, 'pf-price': { value: '5' }, 'pf-date': { value: '2026-11-18' } };
  global.document = { getElementById: id => fields[id] || null };
  global.readOrderEntry = () => ({ orderType: 'market', filledAt: 'now' });
  global.showAlert = () => {};
  global.showConfirm = () => { throw new Error('no listing confirm expected'); };
  global.listingWarningText = () => '';
  global.state = { settings: {} };
  global.renderLiveBand = () => {};
  global.readExecutionMode = async () => ({ mode: 'paper', setAt: null });
  const choices = [];
  global.showChoice = (msg, opts, cb, onCancel, extra) => {
    if (opts && opts.some(o => o.value === 'live')) throw new Error('no Live/Paper prompt expected: the mode read agrees');
    choices.push({ msg, opts, cb, onCancel, extra });
  };
  global.showGlobalErrorToast = m => { throw new Error('toast: ' + m); };
  global.fetchHeldListing = async () => new Proxy({}, { get: () => 'listed' }); // every ticker listed: the listing confirm is not under test
  const finals = []; global.finalizeAddPortfolio = async (...a) => { finals.push(a); };
  global.supabaseClient = db(dbOpts);
  // eslint-disable-next-line no-eval
  eval(app.slice(i, j) + app.slice(j, k) + '\nglobal.__add = (t, b) => confirmAddPortfolio(t, b, "paper"); global.__check = checkOpenLotsInDatabase;');
  return { choices, finals };
}
const tick = () => new Promise(r => setImmediate(r));
const btn = () => ({ disabled: false });

run('the three states of the check: FOUND, NOT_FOUND only after the control, COULD_NOT_CHECK for every doubt', async () => {
  const lot = { position_id: '1', shares: 400, buy_price: 1.65, buy_date: '2026-11-17', buy_time: '09:46', order_type: 'market', filled_at: 'x' };
  load({ lots: [lot] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await global.__check('CLNE'))), { state: 'FOUND', lots: [lot] });
  load({});
  assert.deepStrictEqual(await global.__check('CLNE'), { state: 'NOT_FOUND' });
  for (const [opts, re] of [
    [{ lotsError: { message: 'permission denied' } }, /^permission denied$/],
    [{ control: 0 }, /read back empty and so did trades_v2, which never is: a denied read cannot be ruled out/],
    [{ controlError: { message: 'boom' } }, /read back empty, and the check that it was not denied failed \(boom\)/],
  ]) {
    load(opts);
    const r = await global.__check('CLNE');
    assert.strictEqual(r.state, 'COULD_NOT_CHECK', JSON.stringify(opts));
    assert.ok(re.test(r.reason), r.reason);
  }
});

run('no answer: aborted at the bounded wait, COULD_NOT_CHECK with the reason (a hang is a failure, not a wait)', async () => {
  load({ hang: true });
  const real = global.setTimeout;
  global.setTimeout = fn => { setImmediate(fn); return 0; };
  let r, t;
  try {
    r = await Promise.race([global.__check('CLNE'), new Promise((_, rej) => { t = real(() => rej(new Error('the check hung')), 3000); })]);
  } finally { global.setTimeout = real; clearTimeout(t); }
  assert.deepStrictEqual(r, { state: 'COULD_NOT_CHECK', reason: 'no answer within 8 s' });
});

run('FOUND: the Add says what is held (pending included) and asks; "Record another buy" records once, "Don\'t" records nothing', async () => {
  const lots = [{ shares: 400, buy_price: 1.65, buy_date: '2026-11-17', buy_time: '09:46', order_type: 'market', filled_at: 'x' },
    { shares: 50, buy_price: 2, buy_date: '2026-11-18', buy_time: null, order_type: 'limit', filled_at: null }];
  let h = load({ lots });
  const b = btn();
  await global.__add('CLNE', b); await tick();
  assert.strictEqual(h.choices.length, 1, 'it asks');
  assert.deepStrictEqual(h.finals, [], 'nothing recorded before the answer');
  const m = h.choices[0].msg;
  // CHANGED 2026-11-18, declared (the reviewer, after the render): dates as a person reads them, not a log line
  assert.strictEqual(m, 'You already hold CLNE: 2 open positions in the database, possibly added on another device: 400 shares @ $1.65, bought Tue 11/17, 9:46 am; 50 shares @ $2.00, order placed Wed 11/18 (still pending). Record another buy of CLNE?');
  assert.ok(!m.includes('\n'), 'one paragraph: the dialog collapses line breaks (390px render)');
  assert.deepStrictEqual(h.choices[0].opts.map(o => o.label), ['Record another buy', "Don't record it"]);
  // CHANGED 2026-11-18, declared (the reviewer: "Don't record it" above "Cancel" read as synonyms): no separate Cancel
  assert.deepStrictEqual(h.choices[0].extra, { hideCancel: true }, 'two answers, no third button meaning the same as the second');
  assert.ok(b.disabled, 'the button stays disabled while it asks');
  await global.__add('CLNE', b); await tick();
  assert.strictEqual(h.choices.length, 1, 'a second tap while it asks queues nothing');
  h.choices[0].cb('record'); await tick(); await tick();
  assert.strictEqual(h.finals.length, 1, 'recorded once');

  h = load({ lots });
  const b2 = btn();
  await global.__add('CLNE', b2); await tick();
  h.choices[0].cb('cancel'); await tick();
  assert.deepStrictEqual(h.finals, [], "Don't record it: nothing recorded");
  assert.strictEqual(b2.disabled, false, 'and the form is usable again');
  h = load({ lots });
  await global.__add('CLNE', btn()); await tick();
  h.choices[0].onCancel(); await tick();
  assert.deepStrictEqual(h.finals, [], 'a dismissed dialog records nothing');
  await global.__add('CLNE', btn()); await tick();
  assert.strictEqual(h.choices.length, 2, 'and a later Add asks again');
});

run('NOT_FOUND: no question, the add goes ahead; COULD_NOT_CHECK: says so with the reason, and records only if told to', async () => {
  let h = load({});
  await global.__add('ZZZ', btn()); await tick(); await tick();
  assert.deepStrictEqual(h.choices, [], 'no question');
  assert.strictEqual(h.finals.length, 1, 'recorded');
  h = load({ control: 0 });
  await global.__add('ZZZ', btn()); await tick();
  assert.strictEqual(h.choices.length, 1);
  assert.ok(h.choices[0].msg.startsWith('EDGE could not check the database for an open ZZZ position (the portfolio read back empty and so did trades_v2'), h.choices[0].msg);
  assert.ok(h.choices[0].msg.endsWith('Record this buy of ZZZ anyway?'));
  assert.deepStrictEqual(h.choices[0].opts.map(o => o.label), ['Record it anyway', "Don't record it"]);
  assert.deepStrictEqual(h.finals, [], 'never treated as "not found"');
  h.choices[0].cb('record'); await tick(); await tick();
  assert.strictEqual(h.finals.length, 1, 'recorded, deliberately');
});

// The load, guarded in the same change: core/store.js loadPortfolioFromSupabase, for real.
function loadFn({ rows = [], count = rows.length, error = null, control = 906, controlError = null } = {}) {
  const i = store.indexOf('async function loadPortfolioFromSupabase(');
  const body = store.slice(i, store.indexOf('\n}\n', i) + 3);
  const client = { from: t => ({ select: () => (t === 'portfolio'
    ? { order: async () => ({ data: error ? null : rows, error, count }) }
    : Promise.resolve({ count: controlError ? null : control, error: controlError })) }) };
  // eslint-disable-next-line no-new-func
  return new Function('supabaseClient', 'mapSupabasePortfolioRowToPosition', body + '\nreturn loadPortfolioFromSupabase;')(client, r => ({ id: r.position_id }));
}
run('the portfolio load: complete or it throws; empty only after the control; it never returns [] for a doubt', async () => {
  assert.deepStrictEqual(await loadFn({ rows: [{ position_id: 'a' }] })(), [{ id: 'a' }]);
  assert.deepStrictEqual(await loadFn({ rows: [] })(), [], 'genuinely empty, vouched for by the control');
  for (const [opts, re] of [
    [{ rows: [{ position_id: 'a' }], count: 2 }, /read 1 of 2 rows: not complete/],
    [{ rows: [{ position_id: 'a' }], count: null }, /gave no row count/],
    [{ rows: [], control: 0 }, /read back empty and so did trades_v2/],
    [{ rows: [], controlError: { message: 'x' } }, /check that it was not denied failed \(x\)/],
    [{ error: { message: 'denied' } }, /denied/],
  ]) {
    // the database's own error is a plain object (as supabase-js returns it), so the message is what is compared
    let thrown = null;
    try { await loadFn(opts)(); } catch (e) { thrown = e; }
    assert.ok(thrown && re.test(thrown.message), `${JSON.stringify(opts)}: ${thrown && thrown.message}`);
  }
});

// 2026-11-18 (the reviewer, after the render): the dialog's dates as a person reads them. Never an invented date.
run('friendlyBuyWhen: weekday, month/day and a 12-hour time; the date alone without a time; anything else as stored', () => {
  const i = app.indexOf('function friendlyBuyWhen(');
  // eslint-disable-next-line no-new-func
  const f = new Function(app.slice(i, app.indexOf('\n}\n', i) + 3) + '\nreturn friendlyBuyWhen;')();
  assert.strictEqual(f('2026-11-17', '09:46'), 'Tue 11/17, 9:46 am');
  assert.strictEqual(f('2026-11-17T00:00:00+00:00', '13:05'), 'Tue 11/17, 1:05 pm', 'a timestamp-shaped buy_date reads by its date');
  assert.strictEqual(f('2026-11-18', '12:00'), 'Wed 11/18, 12:00 pm');
  assert.strictEqual(f('2026-11-18', '00:30'), 'Wed 11/18, 12:30 am');
  assert.strictEqual(f('2026-11-18', null), 'Wed 11/18', 'no time recorded: the date alone');
  assert.strictEqual(f('2026-11-18', 'not a time'), 'Wed 11/18');
  assert.strictEqual(f('soon', '09:46'), 'soon', 'not a date: shown as stored');
  assert.strictEqual(f(null, null), 'date not recorded');
});

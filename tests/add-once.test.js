// tests/add-once.test.js — 2026-10-28. With the confirm gone from the
// ordinary add, nothing caught an accidental double tap: the button was
// disabled only just before the insert, after two network waits. A second
// tap while the first add is in flight must do nothing.
'use strict';
const assert = require('assert');
const { readSource, run: runNow } = require('./_lib');
const queue = []; const run = (n, f) => queue.push([n, f]);

const app = readSource('app.js');
function load({ listingResult = { X: 'listed' }, shares = '10', price = '5' } = {}) {
  const i = app.indexOf('let _addInFlight = false;');
  const j = app.indexOf('async function confirmAddPortfolio(');
  const k = app.indexOf('\n}\n', j) + 2;
  const fields = { 'pf-shares': { value: shares }, 'pf-price': { value: price }, 'pf-date': { value: '2026-10-28' } };
  global.document = { getElementById: id => fields[id] || null };
  global.readOrderEntry = () => ({ orderType: 'market', filledAt: 'now' });
  const alerts = []; global.showAlert = m => alerts.push(m);
  const confirms = []; global.showConfirm = (m, cb) => confirms.push({ m, cb });
  global.listingWarningText = () => 'not listed';
  let release; const gate = new Promise(r => { release = r; });
  global.fetchHeldListing = async () => { await gate; return listingResult; };
  const finals = []; global.finalizeAddPortfolio = async (...a) => { finals.push(a); };
  // eslint-disable-next-line no-eval
  eval(app.slice(i, j) + app.slice(j, k) + '\nglobal.__add = confirmAddPortfolio;');
  return { alerts, confirms, finals, release };
}

run('two taps while the listing fetch is slow: one add', async () => {
  const t = load(); const btn = { disabled: false };
  const a = global.__add('X', btn), b = global.__add('X', btn);
  assert.strictEqual(btn.disabled, true, 'disabled the moment the add is in flight');
  t.release(); await Promise.all([a, b]);
  assert.strictEqual(t.finals.length, 1, 'the second tap did nothing');
  const c = global.__add('X', btn); t.release(); await c;
  assert.strictEqual(t.finals.length, 2, 'a later, separate add still works');
});

run('a validation error leaves the button usable and nothing in flight', async () => {
  const t = load({ shares: '' }); const btn = { disabled: false };
  await global.__add('X', btn);
  assert.deepStrictEqual(t.alerts, ['Please enter shares and price.']);
  assert.strictEqual(btn.disabled, false);
});

run('the listing confirm releases the add: Cancel leaves a usable button; "Add anyway" finalizes once', async () => {
  const t = load({ listingResult: { X: 'asset_inactive' } }); const btn = { disabled: false };
  const p = global.__add('X', btn); t.release(); await p;
  assert.strictEqual(t.confirms.length, 1);
  assert.strictEqual(btn.disabled, false, 'waiting on Roman, not the network');
  assert.strictEqual(t.finals.length, 0);
  t.confirms[0].cb();
  assert.strictEqual(t.finals.length, 1);
});

run('finalize disables the button at its very start (the spread fetch is a network wait too)', () => {
  const i = app.indexOf('async function finalizeAddPortfolio(');
  assert.ok(app.slice(i, i + 200).includes('  if (btn) btn.disabled = true; // at the very start'));
});

(async () => { for (const [n, f] of queue) await runNow(n, f); })();

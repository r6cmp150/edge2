// tests/add-once.test.js — 2026-10-28. With the confirm gone from the
// ordinary add, nothing caught an accidental double tap: the button was
// disabled only just before the insert, after two network waits. A second
// tap while the first add is in flight must do nothing.
'use strict';
const assert = require('assert');
const { readSource, run: runNow } = require('./_lib');
const queue = []; const run = (n, f) => queue.push([n, f]);

const app = readSource('app.js');
// CHANGED 2026-11-12, declared (db/042's app side): confirm re-reads Live/Paper before the listing check, and the
// listing check moved into addWithMode. The slice runs to addWithMode's end; the mode read is faked to agree with
// the button ('paper' both), so these tests still exercise exactly the double-tap and listing paths.
function load({ listingResult = { X: 'listed' }, shares = '10', price = '5' } = {}) {
  const i = app.indexOf('let _addInFlight = false;');
  const j = app.indexOf('async function addWithMode(');
  const k = app.indexOf('\n}\n', j) + 2;
  const fields = { 'pf-shares': { value: shares }, 'pf-price': { value: price }, 'pf-date': { value: '2026-10-28' } };
  global.document = { getElementById: id => fields[id] || null };
  global.readOrderEntry = () => ({ orderType: 'market', filledAt: 'now' });
  const alerts = []; global.showAlert = m => alerts.push(m);
  const confirms = []; global.showConfirm = (m, cb) => confirms.push({ m, cb });
  global.listingWarningText = () => 'not listed';
  global.state = { settings: {} };
  global.readExecutionMode = async () => ({ mode: 'paper', setAt: null });
  global.showChoice = () => { throw new Error('no prompt expected: the mode read agrees with the button'); };
  let release; const gate = new Promise(r => { release = r; });
  global.fetchHeldListing = async () => { await gate; return listingResult; };
  const finals = []; global.finalizeAddPortfolio = async (...a) => { finals.push(a); };
  // eslint-disable-next-line no-eval
  eval(app.slice(i, j) + app.slice(j, k) + '\nglobal.__add = (t, b) => confirmAddPortfolio(t, b, "paper");');
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

// 2026-11-12 (reviewer's question 1): a Live/Paper prompt QUEUED behind another dialog is not on screen. If the Add
// button were live meanwhile, a second tap would read again and queue a second prompt: two adds from one form.
run('a mode prompt queued behind another dialog: taps do nothing until it is answered or cancelled, then exactly one add', async () => {
  const t = load(); const btn = { disabled: false };
  let reads = 0; global.readExecutionMode = async () => { reads++; return { mode: null, setAt: null }; }; // unset: asks
  const choices = []; global.showChoice = (m, opts, cb, onCancel) => choices.push({ cb, onCancel }); // queued, not shown
  global.writeExecutionMode = async () => ({ settings: null, log: null, at: 'T' }); global.renderSettingsTab = () => {};
  await global.__add('X', btn);
  assert.strictEqual(choices.length, 1);
  assert.strictEqual(btn.disabled, true, 'the button stays disabled while the prompt is outstanding');
  await global.__add('X', btn); await global.__add('X', btn);
  assert.strictEqual(reads, 1, 'a tap while the prompt is outstanding reads nothing');
  assert.strictEqual(choices.length, 1, 'and queues no second prompt');
  choices[0].onCancel();
  assert.strictEqual(btn.disabled, false, 'Cancel releases the form');
  assert.strictEqual(t.finals.length, 0, 'and records nothing');
  await global.__add('X', btn);
  assert.strictEqual(choices.length, 2, 'after Cancel, a tap asks again');
  choices[1].cb('paper'); t.release(); await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(t.finals.length, 1, 'the answer adds once');
  assert.strictEqual(t.finals[0][6], 'paper', 'under the tapped mode');
});

run('finalize disables the button at its very start (the spread fetch is a network wait too)', () => {
  const i = app.indexOf('async function finalizeAddPortfolio(');
  assert.ok(app.slice(i, i + 200).includes('  if (btn) btn.disabled = true; // at the very start'));
});

(async () => { for (const [n, f] of queue) await runNow(n, f); })();

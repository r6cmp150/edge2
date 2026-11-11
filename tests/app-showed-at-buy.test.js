// tests/app-showed-at-buy.test.js -- 2026-11-08. Nothing recorded whether a buy came from
// something the app was advising: "App Signal" is the sale form's defaulted answer and read
// App Signal on 608 of 608, and no buy linked to a signal. So the buy now records, inside its
// snapshot, what the stock screen was showing when Add was tapped: GATE_OPEN, GATE_CLOSED or
// NOT_SHOWN (with why). Captured from the render, never recomputed at the click.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const fnSrc = name => { const i = app.search(new RegExp('^(async )?function ' + name + '\\(', 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
function load(screen) {
  global.state = { appShowedOnScreen: screen };
  // A recompute at the click would call the gate again: make that impossible to miss.
  global.entryGateForSignal = () => { throw new Error('recomputed at the click'); };
  global.isDayTradeSuppressed = () => { throw new Error('recomputed at the click'); };
  // eslint-disable-next-line no-eval
  eval(fnSrc('appShowedAtBuy') + '\nglobal.__f = appShowedAtBuy;');
  return global.__f;
}
const screen = over => ({ ticker: 'UEC', renderedAt: '2026-11-10T14:31:00.000Z', held: false, gate: { gated: false, rule: null, label: null }, daySuppressed: false, score: 81, label: 'BUY', scoreSource: 'scan', ...over });

run('GATE_OPEN: the screen showed no gate banner and no DAY suppression; its fields are copied as rendered', () => {
  const r = load(screen())('UEC');
  assert.deepStrictEqual(r, { state: 'GATE_OPEN', renderedAt: '2026-11-10T14:31:00.000Z', gate: { gated: false, rule: null, label: null }, daySuppressed: false, score: 81, label: 'BUY', scoreSource: 'scan' });
});

run('GATE_CLOSED: a gate banner, or DAY suppression, either one', () => {
  const g = load(screen({ gate: { gated: true, rule: 'STALE_BARS', label: 'Scored on old bars — not buyable' } }))('UEC');
  assert.strictEqual(g.state, 'GATE_CLOSED'); assert.strictEqual(g.gate.rule, 'STALE_BARS');
  assert.strictEqual(load(screen({ daySuppressed: true }))('UEC').state, 'GATE_CLOSED');
});

run('NOT_SHOWN, always with its reason, never absent and never a default of open or closed', () => {
  const cases = [
    [null, /no stock screen had rendered a verdict/],
    [screen({ ticker: 'XE' }), /last verdict rendered was for XE, not UEC/],
    [screen({ held: true }), /held ticker/],
    [screen({ gate: null }), /entry gate was not evaluated/],
  ];
  for (const [s, why] of cases) {
    const r = load(s)('UEC');
    assert.strictEqual(r.state, 'NOT_SHOWN', JSON.stringify(r));
    assert.ok(why.test(r.reason), r.reason);
  }
});

run('the record never names intent: no field or state reads as why Roman bought', () => {
  const src = fnSrc('appShowedAtBuy');
  const keys = ['GATE_OPEN', 'GATE_CLOSED', 'NOT_SHOWN'];
  for (const k of keys) assert.ok(src.includes(`'${k}'`), k);
  assert.ok(!/\b(why|intent|motive|decision|chose|reasonForBuy|boughtBecause)\b/i.test(src.replace(/\/\/.*$/gm, '').replace(/reason: /g, '')), 'no intent vocabulary in the code that writes it');
});

run('openStockModal clears the screen record before anything else, and captures where the Add button is written', () => {
  const m = fnSrc('openStockModal');
  const reset = m.indexOf('state.appShowedOnScreen = null;');
  assert.ok(reset > 0 && reset < m.indexOf('await'), 'cleared before the first await: a previous ticker never carries over');
  const capture = m.indexOf('state.appShowedOnScreen = {'), footer = m.indexOf("document.getElementById('stock-modal-footer').innerHTML");
  assert.ok(capture > 0 && footer > capture, 'captured just before the Add button exists');
  const body = m.indexOf("document.getElementById('stock-modal-body').innerHTML = `");
  assert.ok(body > 0 && body < capture, 'after the banners are on screen');
  const block = m.slice(capture, m.indexOf('};', capture));
  for (const v of ['modalGate', 'daySuppressed', 'modalScoreTotal', 'modalScoreSignal']) assert.ok(block.includes(v), `${v}: the rendered value, not a new one`);
  assert.ok(!/entryGateForSignal|isDayTradeSuppressed|scoreLabel\(|computeScoreBreakdown/.test(block), 'nothing recomputed in the capture');
  const err = m.slice(m.indexOf('} catch(err) {'));
  assert.ok(!/stock-modal-footer|appShowedOnScreen = \{/.test(err), 'the error path writes no Add button and no verdict');
});

run('the buy attaches it to its snapshot before any await, and only when there is a snapshot', () => {
  // Comments blanked to equal length, so "await" in a comment isn't taken for the first await.
  const f = fnSrc('finalizeAddPortfolio').replace(/\/\/.*$/gm, c => ' '.repeat(c.length));
  const att = f.indexOf('if (signalSnapshotAtBuy) signalSnapshotAtBuy.appShowedAtBuy = appShowedAtBuy(ticker);');
  const firstAwait = f.search(/\bawait\s/);
  assert.ok(att > 0 && firstAwait > 0 && att < firstAwait, 'what was on screen at the click, not after');
  assert.ok(att > f.indexOf('const signalSnapshotAtBuy = captureSignalSnapshot(sig);'));
});

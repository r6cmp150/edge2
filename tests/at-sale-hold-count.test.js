// tests/at-sale-hold-count.test.js — phase-10 §7.7 (2026-10-27). The
// verdict stored at a sale (unified_recommendation_at_sale, and the peak-
// risk score) is computed from the sale's price, so its hold must be
// counted to the SALE date, not to the day the sale is recorded. Until this
// change both hold-count reads used today.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = name => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };

run('calcUnifiedRecommendation counts the hold to asOfDate when given, to today otherwise', () => {
  const seen = [];
  const STOP = new Error('stop after the hold count');
  global.holdSpan = (p, end) => { seen.push(end); throw STOP; };
  global.ptDateStr = () => 'TODAY'; global.getPT = () => ({});
  // eslint-disable-next-line no-eval
  eval(grab('calcUnifiedRecommendation') + '\nglobal.__ur = calcUnifiedRecommendation;');
  const pos = { currentPrice: 10, buyPrice: 9, stop: 8, rsi: 50 };
  assert.throws(() => global.__ur(pos, null, null, undefined, '2026-10-30'), e => e === STOP);
  assert.throws(() => global.__ur(pos, null, null), e => e === STOP);
  assert.deepStrictEqual(seen, ['2026-10-30', 'TODAY'], 'the sale date when given; a live card still counts to today');
});

run('the sale passes its own date all the way down, peak risk included', () => {
  const sale = grab('computeUnifiedSaleFields');
  assert.ok(app.includes('function computeUnifiedSaleFields(pos, salePrice, saleDate) {'));
  assert.ok(sale.includes('state.macroContext, undefined, saleDate);'), 'computeUnifiedSaleFields hands saleDate to calcUnifiedRecommendation');
  assert.ok(grab('confirmMarkSold').includes('computeUnifiedSaleFields(pos, salePrice, saleDate)'), 'confirmMarkSold hands it the entered sale date');
  assert.ok(grab('calcUnifiedRecommendation').includes('calcPeakRiskScore(position, currentSignal, snap, asOfDate)'), 'threaded into the peak-risk score, also stored at sale');
  const pr = grab('calcPeakRiskScore');
  assert.ok(app.includes('function calcPeakRiskScore(position, currentSignal, snap, asOfDate = null) {'));
  for (const [name, src] of [['calcUnifiedRecommendation', grab('calcUnifiedRecommendation')], ['calcPeakRiskScore', pr]]) {
    assert.ok(!/holdSpan\(position, ptDateStr\(getPT\(\)\)\)/.test(src), `${name} still counts the hold to today unconditionally`);
  }
  // Behaviourally, through computeUnifiedSaleFields with a spy.
  const calls = [];
  global.getEngine = () => null; global.currentOwnedScore = () => null;
  global.state = { signals: [], macroContext: null, ownedPeakRSI: {} };
  global.calcUnifiedRecommendation = (...a) => { calls.push(a); return { label: 'HOLD', composite: 0, factors: [], hardFloor: false, peakRisk: null }; };
  // eslint-disable-next-line no-eval
  eval(sale + '\nglobal.__sale = computeUnifiedSaleFields;');
  global.__sale({ ticker: 'X', engineSource: 'EDGE', rsiAtBuy: 50 }, 10, '2026-10-30');
  assert.strictEqual(calls[0][4], '2026-10-30');
  assert.strictEqual(calls[0][0].currentPrice, 10, "the sale's price and the sale's date, together");
});

run('the diagnostic for rows before the fix sits next to the field', () => {
  const w = grab('writeTradeToSupabase');
  const i = w.indexOf('unified_recommendation_at_sale:');
  assert.ok(/exact only where sell_date equals the PT\s*\/\/\s*date of created_at/.test(w.slice(Math.max(0, i - 500), i)), 'which pre-fix rows to trust is stated at the field');
});

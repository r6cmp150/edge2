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

// CHANGED 2026-11-02, declared: the sale no longer computes a verdict at
// all (db/035), so there is no sale date to pass down. calcUnifiedRecommendation
// and calcPeakRiskScore keep asOfDate (test above), reserved for a build that
// can compute a sale-moment verdict.
run('the sale computes no verdict; asOfDate stays threaded for a future sale-moment verdict', () => {
  assert.ok(!app.includes('function computeUnifiedSaleFields('), 'the mixed-moment at-sale verdict is gone');
  assert.ok(grab('confirmMarkSold').includes('computeSaleVerdictFields(pos, saleDate, saleFill.at)'));
  assert.ok(grab('calcUnifiedRecommendation').includes('calcPeakRiskScore(position, currentSignal, snap, asOfDate)'));
  assert.ok(app.includes('function calcPeakRiskScore(position, currentSignal, snap, asOfDate = null) {'));
});

run('the diagnostic for rows before the fix sits next to the field', () => {
  const w = grab('writeTradeToSupabase');
  const i = w.indexOf('unified_recommendation_at_sale:');
  assert.ok(/exact only where sell_date equals the PT\s*\/\/\s*date of created_at/.test(w.slice(Math.max(0, i - 500), i)), 'which pre-fix rows to trust is stated at the field');
});

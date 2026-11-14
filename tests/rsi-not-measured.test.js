// tests/rsi-not-measured.test.js -- 2026-11-13. "A fallback that substitutes one measurement for another is a defect,
// not a default" (the reviewer, for §7.7). The Portfolio card's RSI fell back to the buy's RSI, unmarked, whenever a
// holding had fewer than 15 daily closes; the card now says the RSI was not measured, and why, and scores nothing for
// it. The render side (no prev or peak written from it) is held by tests/portfolio-sort.test.js against the real
// renderPortfolioTab; this holds the card's text through the real calcUnifiedRecommendation.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');

function ur() {
  const ctx = { Math, Object, String, Number, Array, JSON, Date, console, isFinite, Infinity, NaN,
    state: { settings: { disableMacroOverlay: true } },
    holdSpan: () => ({ closes: 2 }), ptDateStr: () => '2026-11-13', getPT: () => new Date('2026-11-13T18:00:00Z'),
    calcPeakRiskScore: () => ({ score: 0, factors: [], topFactors: [] }),
  };
  vm.createContext(ctx);
  vm.runInContext(strip(readSource('core/edge-scoring.js')), ctx);
  for (const p of ['const MAX_HOLD_DAYS = ', 'const DEFAULT_MAX_LOSS_PCT = ', 'const DURATION_WINDOW_LABEL = ']) {
    const i = app.indexOf(p); assert.ok(i >= 0, p);
    vm.runInContext(app.slice(i, app.indexOf('\n', i) + 1).replace(/^const /, 'var '), ctx);
  }
  vm.runInContext(grab('calcUnifiedRecommendation') + '\n;globalThis.__ur = calcUnifiedRecommendation;', ctx);
  return ctx.__ur;
}
const POS = { ticker: 'AAA', currentPrice: 10.4, buyPrice: 10, stop: 9, target: 12, duration: 'WEEK', buyDate: '2026-11-11',
  scoreAtBuy: 70, rsiAtBuy: 80, codeVersion: { scoring: 2 } };
const names = r => r.factors.map(f => f.name);

run('an unmeasured RSI is said on the card with its reason, scores 0, and the buy RSI never stands in', () => {
  const calc = ur();
  const r = calc({ ...POS, rsi: null, rsiNotMeasured: 'the price and daily-bar fetch failed' }, null, null);
  const line = r.factors.find(f => /^RSI/.test(f.name));
  assert.ok(line, 'an RSI line is shown: ' + JSON.stringify(names(r)));
  assert.strictEqual(line.name, 'RSI not measured — the price and daily-bar fetch failed');
  assert.strictEqual(line.points, 0, 'it scores nothing');
  assert.ok(!names(r).some(n => /RSI 80|band above 75/.test(n)), 'the buy RSI (80) is not read as the current one');
  // Without a reason it still says so (a caller that never measures, never silently omitted).
  assert.ok(names(calc({ ...POS, rsi: null }, null, null)).includes('RSI not measured'));
  // Positive control: a measured RSI shows its band, and no "not measured".
  const m = calc({ ...POS, rsi: 58 }, null, null);
  assert.ok(names(m).includes('RSI 58 — band 55–65') && !names(m).some(n => /not measured/.test(n)), JSON.stringify(names(m)));
});

run('the source: no reader hands the buy RSI in as a current RSI', () => {
  const code = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/rsi:\s*(p|pos|position)\.rsiAtBuy/.test(code), 'no `rsi: p.rsiAtBuy`');
  assert.ok(!/:\s*(p|pos|position)\.rsiAtBuy;/.test(code.replace(/rsiAtBuy:\s*pos\.rsiAtBuy/g, '')), 'no `? measured : p.rsiAtBuy` fallback');
  assert.ok(code.includes('const rsi = closes.length >= 15 ? calcRSI(closes) : null;'), 'the render measures, or says null');
});

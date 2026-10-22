// tests/view-no-decision-writes.test.js — phase-10 spec §7.7: displaying
// something must never write to state that a decision reads. A view may
// compute fresh values; it may not store them where the scorer, the exit
// engine, or the recorder will find them.
//
// 1. openStockModal (fixed 2026-10-21): it used to assign its own recompute
//    of consUpDays/consUpPts/spyChange/rsVsSPY/relStrengthPts (and
//    livePrice/liveRsi/priceFetchFailed, via _modalStock = stock) onto the
//    live state.signals entry, which the exit engine's exhaustion factor,
//    finalizeAddPortfolio's stored trade fields and the card breakdown all
//    read. Opening a modal could change a held position's sell advice.
// 2. renderPortfolioTab (NOT fixed -- spec §7.7 lists these as open): a
//    ratchet, not a pass. Its known render-time writes are listed exactly;
//    any new one fails here, so the list can only shrink.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
function body(name) {
  const start = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} found`);
  let i = app.indexOf('{', start), depth = 0;
  for (let j = i; j < app.length; j++) {
    if (app[j] === '{') depth++;
    else if (app[j] === '}' && --depth === 0) return app.slice(start, j + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}
const code = src => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
// `x.field = …` / `x.field += …` / `x[k] = …`, excluding comparisons.
const writesTo = (src, root) => [...code(src).matchAll(new RegExp(`\\b${root}((?:\\.[\\w$]+|\\[[^\\]]+\\])+)\\s*(?:=(?!=)|\\+=|-=|\\+\\+|--)`, 'g'))].map(m => root + m[1]);

run('openStockModal writes nothing onto the signal, the stock object or _modalStock', () => {
  const src = body('openStockModal');
  for (const root of ['s', 'stock', '_modalStock']) {
    assert.deepStrictEqual(writesTo(src, root), [], `openStockModal assigns onto ${root}`);
  }
  assert.ok(!/_modalStock\s*=\s*stock\s*;/.test(code(src)), '_modalStock must be a copy, never the shared object');
  // Same rule as the breakdown, so the AI prompt's recommendation gets the
  // same inputs as the card and the modal's recommendation block.
  assert.ok(/_modalStock = \{\s*\.\.\.breakdownStock,/.test(src), '_modalStock is a copy built from breakdownStock');
  assert.ok(!/_modalStock = \{[^}]*\.\.\.modalFresh/.test(src), 'the prompt never gets fresh values a real signal did not score with');
  // A real signal's breakdown reads the signal itself; only the fallback
  // object takes the modal's fresh recompute.
  assert.ok(/const breakdownStock = s \? stock : \{ \.\.\.stock, \.\.\.modalFresh \};/.test(src), 'breakdownStock rule');
  assert.ok(/buildModalScoreBreakdown\(breakdownStock,/.test(src), 'modal breakdown reads breakdownStock');
  assert.ok(!/buildModalScoreBreakdown\(stock,/.test(src) && !/computeScoreBreakdown\(stock\)/.test(src), 'no breakdown reads the bare stock');
});

run('renderPortfolioTab: known render-time writes only (ratchet; spec §7.7 open items)', () => {
  const src = body('renderPortfolioTab');
  const KNOWN = [
    'p.prevRSI',                    // read by calcPeakRiskScore's "RSI declining from peak" (-30)
    'state.ownedPrevRSI[p.ticker]', // the previous render's RSI, which becomes prevRSI
    'state.ownedPeakRSI[p.ticker]', // max over renders -> peakRsiDuringHold on the sale
    'p.liveTarget',                 // -> targetDriftPct on the sale
    'p.peakPrice',                  // max over renders -> exit engine pullback, trailing stop, peak_price
    'p.peakPriceDate',
    'p.momentumProtectionActivated',// set only if a render sees >= +20% -> exit engine mode
    'p.rsiSuspendedAtGainPct',      // first render with RSI >= 72 while protected -> recorded
    'state.portfolioPrices[p.ticker]', // last rendered price -> nav badge sell-warning count
    'state.portfolioPriceFetchFailed',
  ];
  const found = [...new Set(['p', 'state'].flatMap(r => writesTo(src, r)))].sort();
  assert.deepStrictEqual(found, [...KNOWN].sort(), 'a new render-time write appeared (or a known one was fixed -- remove it from KNOWN)');
});
